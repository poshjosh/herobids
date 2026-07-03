#!/usr/bin/env bash
# maintenance-restart.sh — Maintenance-window agent container restart.
# push.sh runs on every code push — which might happen several times a day.
# maintenance-restart.sh is for when you actually need agents on the new image — specifically 
# when agent.ts or something in Dockerfile.agent changed. The 2am window is intentional: no 
# one is watching, no active decisions expected.
#
# Stops all running agent containers, optionally deploys the latest code, then
# restarts the agents so they pick up the current herobids-agent image.
#
# Runs ON the server. Suitable for cron at 2am or ad-hoc remote invocation.
#
# Usage:
#   maintenance-restart.sh [--deploy] [--include-live]
#
# Options:
#   --deploy        Pull latest code and rebuild all images before restarting.
#   --include-live  Also restart agents with execution_mode='live'.
#                   Skipped by default — live agents may hold open positions.
#
# Cron (server-side, 2am every Sunday — edit /etc/cron.d/herobids or crontab):
#   0 2 * * 0 root /opt/herobids/infra/hetzner/scripts/maintenance-restart.sh --deploy \
#               >> /var/log/herobids-maintenance.log 2>&1
#
# Remote one-shot:
#   ssh root@<ip> 'bash /opt/herobids/infra/hetzner/scripts/maintenance-restart.sh --deploy'

set -euo pipefail

ROOT="/opt/herobids"
COMPOSE_FILES="-f docker-compose.yaml -f docker-compose.prod.yaml"

# ─── Parse args ──────────────────────────────────────────────────────────────

DO_DEPLOY=false
INCLUDE_LIVE=false

for arg in "$@"; do
  case "$arg" in
    --deploy)       DO_DEPLOY=true ;;
    --include-live) INCLUDE_LIVE=true ;;
    --help|-h)
      sed -n '2,/^set /p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

cd "$ROOT"

# ─── Logging ─────────────────────────────────────────────────────────────────

ts()   { date -u +%Y-%m-%dT%H:%M:%SZ; }
log()  { echo "[$(ts)]      $*"; }
ok()   { echo "[$(ts)] OK   $*"; }
warn() { echo "[$(ts)] WARN $*" >&2; }
die()  { echo "[$(ts)] FAIL $*" >&2; exit 1; }

PG() { docker exec -T herobids-postgres-1 psql -U herobids -d herobids -t -q "$@"; }

# ─── Step 1: Discover running agents ─────────────────────────────────────────

log "Step 1 — Discovering running agents..."

if [[ "${INCLUDE_LIVE}" == "true" ]]; then
  LIVE_FILTER=""
else
  LIVE_FILTER="AND (a.execution_mode IS NULL OR a.execution_mode != 'live')"
fi

mapfile -t AGENT_IDS < <(PG -c \
  "SELECT DISTINCT s.agent_id
   FROM agent_runtime_sessions s
   JOIN agents a ON a.id = s.agent_id
   WHERE s.status NOT IN ('stopped','crashed')
   ${LIVE_FILTER}" \
  | tr -d ' ' | grep -v '^$' || true)

AGENT_COUNT=${#AGENT_IDS[@]}

# Report skipped live agents
if [[ "${INCLUDE_LIVE}" == "false" ]]; then
  mapfile -t LIVE_IDS < <(PG -c \
    "SELECT DISTINCT s.agent_id
     FROM agent_runtime_sessions s
     JOIN agents a ON a.id = s.agent_id
     WHERE s.status NOT IN ('stopped','crashed')
       AND a.execution_mode = 'live'" \
    | tr -d ' ' | grep -v '^$' || true)

  if [[ ${#LIVE_IDS[@]} -gt 0 ]]; then
    warn "${#LIVE_IDS[@]} live-mode agent(s) skipped (pass --include-live to include them):"
    for id in "${LIVE_IDS[@]}"; do warn "  ${id}"; done
  fi
fi

if [[ $AGENT_COUNT -eq 0 ]]; then
  ok "No running agents found."
else
  log "  Found ${AGENT_COUNT} agent(s) to restart."
  for id in "${AGENT_IDS[@]}"; do log "  ${id}"; done
fi

# ─── Step 2: Stop (DB first, then containers) ────────────────────────────────

if [[ $AGENT_COUNT -gt 0 ]]; then
  log "Step 2 — Stopping agents..."

  IN_LIST=$(printf "'%s'," "${AGENT_IDS[@]}" | sed 's/,$//')

  # Update DB first so that any heartbeats arriving while containers are still
  # shutting down are silently dropped (session no longer in an active status).
  PG -c "
    UPDATE agent_runtime_sessions
       SET status = 'stopped', stopped_at = NOW()
     WHERE agent_id IN (${IN_LIST})
       AND status NOT IN ('stopped', 'crashed');

    UPDATE agents
       SET status = 'stopped'
     WHERE id IN (${IN_LIST})
       AND status NOT IN ('stopped', 'crashed');
  "
  ok "DB: sessions and agents marked stopped."

  # Stop containers (SIGTERM, then SIGKILL after 10 s)
  for AGENT_ID in "${AGENT_IDS[@]}"; do
    CONTAINER="herobids-agent-${AGENT_ID}"
    log "  Stopping ${CONTAINER}..."
    docker stop "${CONTAINER}" 2>/dev/null \
      || warn "  ${CONTAINER} not running or already stopped — skipping."
  done
  ok "Containers stopped."
fi

# ─── Step 3: Deploy (optional) ───────────────────────────────────────────────

if [[ "${DO_DEPLOY}" == "true" ]]; then
  log "Step 3 — Deploying latest code..."

  git fetch --all && git reset --hard origin/main
  ok "Code updated to $(git rev-parse --short HEAD)."

  log "  Building agent image..."
  docker build --pull -f docker/Dockerfile.agent -t herobids-agent:latest . 2>&1 | tail -3
  ok "Agent image rebuilt."

  log "  Restarting api / worker / web..."
  # shellcheck disable=SC2086
  docker compose ${COMPOSE_FILES} up -d --build --remove-orphans 2>&1 | tail -6
  ok "Services restarted."
else
  log "Step 3 — Skipping deploy (no --deploy flag)."
fi

# ─── Step 4: Wait for API ────────────────────────────────────────────────────

log "Step 4 — Waiting for API to be healthy..."
for i in $(seq 1 40); do
  if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    ok "API is healthy."
    break
  fi
  [[ $i -eq 40 ]] && die "API did not become healthy after 40 attempts (120 s)."
  log "  Waiting... (${i}/40)"
  sleep 3
done

# ─── Step 5: Restart agents ──────────────────────────────────────────────────

if [[ $AGENT_COUNT -gt 0 ]]; then
  log "Step 5 — Restarting ${AGENT_COUNT} agent(s)..."

  IN_LIST=$(printf "'%s'," "${AGENT_IDS[@]}" | sed 's/,$//')

  RESTARTED=$(PG -c "
    WITH restarted AS (
      UPDATE agents
         SET status = 'starting'
       WHERE id IN (${IN_LIST})
         AND status = 'stopped'
      RETURNING id
    ),
    new_sessions AS (
      INSERT INTO agent_runtime_sessions (id, agent_id, status)
      SELECT gen_random_uuid(), r.id, 'starting'
      FROM restarted r
      RETURNING agent_id
    )
    SELECT count(*) FROM new_sessions;
  " | tr -d ' \n')

  ok "${RESTARTED:-0} agent session(s) queued for restart."
  log "  Worker reconcile launches containers within a few seconds."

  # Brief pause then confirm containers are starting
  sleep 8
  RUNNING=$(docker ps --filter label=herobids.role=agent --format "{{.Names}}" | wc -l | tr -d ' ')
  log "  Running agent containers: ${RUNNING}"
else
  log "Step 5 — No agents to restart."
fi

echo ""
ok "=== Maintenance restart complete ==="
