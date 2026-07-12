#!/usr/bin/env bash
# agent-watch-invariants.sh — Verify watch integrity invariants against Redis
#
# Three modes:
#
#   --smoke        Fully automated smoke test. Starts Redis if needed, inserts
#                  known-violation and known-clean watch records, verifies the
#                  invariant checks catch violations and pass clean data, then
#                  cleans up. No prerequisites except docker and jq.
#
#   --agent-id ID  Audit a single agent's watches. Requires a running Redis
#                  (auto-started if docker compose is available).
#
#   --all-agents   Audit all agents with watches or active sessions. Requires
#                  a running Redis (auto-started if docker compose is available).
#
# Usage:
#   scripts/shell/tests/agent-watch-invariants.sh --smoke
#   scripts/shell/tests/agent-watch-invariants.sh --agent-id <uuid>
#   scripts/shell/tests/agent-watch-invariants.sh --all-agents
#
#   # Override Redis host/port (skips auto-start)
#   REDIS_HOST=10.0.0.5 scripts/shell/tests/agent-watch-invariants.sh --agent-id <uuid>
#
# Exit codes:
#   0 — all invariants hold (smoke: violations correctly detected AND clean data passes)
#   1 — one or more invariant violations found (or smoke: expected violation NOT detected)
#   2 — usage error (missing args, redis unreachable, etc.)
#
# Requirements: docker (with compose), jq; redis-cli auto-installed if needed.
#
# ─────────────────────────────────────────────────────────────────
# Background
# ─────────────────────────────────────────────────────────────────
#
# These invariants were established by the protective-watch contract closure
# feature (docs/features/2026/07/12/004-agent-direct-protection-alignment/).
#
# Invariant 1 (protective linkage):
#   Every watch with purpose=stop_loss|take_profit|exit MUST carry either
#   instrument.instrumentId OR coverage.positionKey. A protective watch
#   without linkage can never count as protective coverage.
#
# Invariant 2 (structured contract):
#   Every watch with schemaVersion >= 2 MUST carry a purpose field.
#   The parser no longer repairs missing purpose — such records are discarded.
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Paths ────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.yaml"

# ─── Helpers ──────────────────────────────────────────────────────────────────

REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"

# redis-cli may not be installed locally — fall back to docker exec against the compose redis container
if command -v redis-cli &>/dev/null; then
  REDIS_CLI=(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT")
else
  REDIS_CLI=(docker compose -f "$COMPOSE_FILE" exec -T redis redis-cli)
fi

log()    { echo "[$(date '+%H:%M:%S')] $*"; }
ok()     { echo "[$(date '+%H:%M:%S')]  ✓ $*"; }
warn()   { echo "[$(date '+%H:%M:%S')]  ⚠ $*" >&2; }
die()    { echo "[$(date '+%H:%M:%S')]  ✗ $*" >&2; exit 2; }
viol()   { echo "[$(date '+%H:%M:%S')]  ✗ VIOLATION: $*" >&2; }

usage() {
  sed -n '2,/^set -euo/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
  exit 2
}

# ─── Argument parsing (must come before prerequisite checks so --help works) ──

AGENT_ID=""
ALL_AGENTS=0
SMOKE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-id)
      AGENT_ID="$2"
      shift 2
      ;;
    --all-agents)
      ALL_AGENTS=1
      shift
      ;;
    --smoke)
      SMOKE=1
      shift
      ;;
    --help|-h)
      usage
      ;;
    *)
      die "Unknown argument: $1  (use --help for usage)"
      ;;
  esac
done

if [[ "$SMOKE" -eq 0 && "$ALL_AGENTS" -eq 0 && -z "$AGENT_ID" ]]; then
  die "One of --smoke, --agent-id <uuid>, or --all-agents is required.  Use --help for usage."
fi

# ─── Prerequisite checks ─────────────────────────────────────────────────────

command -v jq &>/dev/null || die "'jq' is required but not found in PATH."
command -v docker &>/dev/null || die "'docker' is required but not found in PATH."
docker compose version &>/dev/null || die "'docker compose' is required but not available."

# ─── Infrastructure: ensure Redis is accessible ──────────────────────────────

REDIS_WAS_RUNNING=false
INFRA_STARTED=false

redis_ping() {
  "${REDIS_CLI[@]}" PING &>/dev/null
}

service_healthy() {
  local service="$1"
  local state
  state=$(docker compose -f "$COMPOSE_FILE" ps --format json "$service" 2>/dev/null \
    | grep -o '"Health":"[^"]*"' | head -1 | cut -d'"' -f4)
  [[ "$state" == "healthy" ]]
}

wait_healthy() {
  local service="$1"
  local retries=30
  log "Waiting for ${service} to be healthy…"
  while [[ $retries -gt 0 ]]; do
    if service_healthy "$service"; then
      ok "${service} is healthy."
      return 0
    fi
    sleep 2
    (( retries-- ))
  done
  die "${service} did not become healthy in time."
}

start_redis_if_needed() {
  if redis_ping; then
    REDIS_WAS_RUNNING=true
    ok "Redis is already reachable at ${REDIS_HOST}:${REDIS_PORT}"
    return 0
  fi

  # Only attempt docker compose start if we're connecting to localhost
  if [[ "$REDIS_HOST" != "localhost" && "$REDIS_HOST" != "127.0.0.1" ]]; then
    die "Redis unreachable at ${REDIS_HOST}:${REDIS_PORT} and REDIS_HOST is not localhost — cannot auto-start."
  fi

  if service_healthy redis; then
    ok "Redis container is healthy — waiting for port…"
    sleep 2
    if redis_ping; then
      REDIS_WAS_RUNNING=true
      return 0
    fi
  fi

  log "Starting Redis via docker compose…"
  docker compose -f "$COMPOSE_FILE" up -d redis
  INFRA_STARTED=true
  wait_healthy redis

  if ! redis_ping; then
    die "Redis started but still unreachable at ${REDIS_HOST}:${REDIS_PORT}"
  fi
  ok "Redis is ready."
}

stop_redis_if_started() {
  if [[ "$INFRA_STARTED" == "true" ]]; then
    log "Stopping Redis (started by this script)…"
    docker compose -f "$COMPOSE_FILE" stop redis 2>/dev/null || true
    docker compose -f "$COMPOSE_FILE" rm -f redis 2>/dev/null || true
  fi
}

trap stop_redis_if_started EXIT

# ─── Core: run invariant checks against a list of agent IDs ──────────────────

VIOLATIONS=0
CHECKED_AGENTS=0
CHECKED_WATCHES=0

check_agent() {
  local agent_id="$1"
  local watch_key="agent:watches:${agent_id}"
  local field_count

  field_count=$("${REDIS_CLI[@]}" --raw HLEN "$watch_key" 2>/dev/null || echo 0)
  if [[ "$field_count" -eq 0 ]]; then
    return 0
  fi

  CHECKED_AGENTS=$((CHECKED_AGENTS + 1))

  local watches_json
  watches_json=$("${REDIS_CLI[@]}" --raw HGETALL "$watch_key" 2>/dev/null)
  if [[ -z "$watches_json" ]]; then
    return 0
  fi

  local idx=0
  local watch_id=""
  while IFS= read -r line; do
    if [[ $((idx % 2)) -eq 0 ]]; then
      watch_id="$line"
    else
      local watch_json="$line"
      CHECKED_WATCHES=$((CHECKED_WATCHES + 1))

      # ── Invariant 1: protective watches must have linkage ──────────────
      local purpose
      purpose=$(echo "$watch_json" | jq -r '.purpose // empty' 2>/dev/null)
      if [[ "$purpose" == "stop_loss" || "$purpose" == "take_profit" || "$purpose" == "exit" ]]; then
        local has_instrument
        local has_position_key
        has_instrument=$(echo "$watch_json" | jq -r '.instrument.instrumentId // empty' 2>/dev/null)
        has_position_key=$(echo "$watch_json" | jq -r '.coverage.positionKey // empty' 2>/dev/null)

        if [[ -z "$has_instrument" && -z "$has_position_key" ]]; then
          viol "Agent ${agent_id} watch ${watch_id}: protective purpose=${purpose} but no instrument.instrumentId or coverage.positionKey"
          VIOLATIONS=$((VIOLATIONS + 1))
        fi
      fi

      # ── Invariant 2: structured watches must have purpose ──────────────
      local schema_ver
      schema_ver=$(echo "$watch_json" | jq -r '.schemaVersion // 0' 2>/dev/null)
      if [[ "$schema_ver" -ge 2 ]]; then
        local has_purpose
        has_purpose=$(echo "$watch_json" | jq -r '.purpose // empty' 2>/dev/null)
        if [[ -z "$has_purpose" ]]; then
          viol "Agent ${agent_id} watch ${watch_id}: schemaVersion=${schema_ver} but purpose is missing"
          VIOLATIONS=$((VIOLATIONS + 1))
        fi
      fi
    fi
    idx=$((idx + 1))
  done <<< "$watches_json"

  log "  Agent ${agent_id}: ${field_count} watch(es) checked"
}

run_checks() {
  VIOLATIONS=0
  CHECKED_AGENTS=0
  CHECKED_WATCHES=0
  for agent_id in "$@"; do
    check_agent "$agent_id"
  done

  echo ""
  log "=== Watch Invariant Report ==="
  log "  Agents checked:  ${CHECKED_AGENTS}"
  log "  Watches checked: ${CHECKED_WATCHES}"
  log "  Violations:      ${VIOLATIONS}"
  echo ""
}

# ─── Smoke test data ─────────────────────────────────────────────────────────

# Generate a deterministic test agent ID so repeated runs don't accumulate cruft.
SMOKE_AGENT_ID="watch-smoke-$(date +%Y%m%d)"
SMOKE_WATCH_KEY="agent:watches:${SMOKE_AGENT_ID}"

# A valid v2 watch with canonical instrument identity and coverage linkage.
# This passes both invariants.
VALID_WATCH_JSON=$(cat <<'EOF'
{"watchId":"00000000-0000-0000-0000-000000000001","symbol":"BTC-USD","chain":"hyperliquid","thresholdPrice":70000,"condition":"above","purpose":"stop_loss","createdAt":"2026-07-12T00:00:00.000Z","lastConditionMet":false,"schemaVersion":2,"instrument":{"venue":"hyperliquid","instrumentId":"BTC-USD","symbol":"BTC-USD"},"coverage":{"positionKey":"hyperliquid::BTC-USD::long"}}
EOF
)

# Violation 1: protective watch (stop_loss) without instrument.instrumentId
# or coverage.positionKey. Invariant 1 should flag this.
VIOLATION_NO_LINKAGE_JSON=$(cat <<'EOF'
{"watchId":"00000000-0000-0000-0000-000000000002","symbol":"ETH-USD","chain":"hyperliquid","thresholdPrice":3500,"condition":"below","purpose":"stop_loss","createdAt":"2026-07-12T00:00:00.000Z","lastConditionMet":false,"schemaVersion":2}
EOF
)

# Violation 2: structured watch (schemaVersion >= 2) without purpose.
# Invariant 2 should flag this.
VIOLATION_NO_PURPOSE_JSON=$(cat <<'EOF'
{"watchId":"00000000-0000-0000-0000-000000000003","symbol":"SOL","chain":"solana","thresholdPrice":200,"condition":"above","createdAt":"2026-07-12T00:00:00.000Z","lastConditionMet":false,"schemaVersion":2}
EOF
)

smoke_cleanup() {
  "${REDIS_CLI[@]}" DEL "$SMOKE_WATCH_KEY" 2>/dev/null || true
}

# ─── Mode: smoke test ────────────────────────────────────────────────────────

run_smoke() {
  log ""
  log "=== Smoke Test: Watch Invariants ==="
  log "Agent ID: ${SMOKE_AGENT_ID}"

  start_redis_if_needed
  smoke_cleanup  # ensure clean state

  # ── Phase 1: insert violation records, expect violations ──────────────

  log ""
  log "── Phase 1: Violation records ──"

  log "Inserting watch with no linkage (invariant 1 should fire)…"
  "${REDIS_CLI[@]}" HSET "$SMOKE_WATCH_KEY" "watch-002" "$VIOLATION_NO_LINKAGE_JSON" >/dev/null

  log "Inserting watch with no purpose (invariant 2 should fire)…"
  "${REDIS_CLI[@]}" HSET "$SMOKE_WATCH_KEY" "watch-003" "$VIOLATION_NO_PURPOSE_JSON" >/dev/null

  run_checks "$SMOKE_AGENT_ID"

  if [[ "$VIOLATIONS" -ne 2 ]]; then
    warn "Expected 2 violations, got ${VIOLATIONS}."
    warn "The invariant checker failed to detect known-bad records."
    smoke_cleanup
    exit 1
  fi
  ok "Both violations correctly detected (${VIOLATIONS} violations)"

  # ── Phase 2: insert clean record, expect zero violations ──────────────

  log ""
  log "── Phase 2: Clean record ──"
  smoke_cleanup

  log "Inserting valid watch with instrument identity and coverage linkage…"
  "${REDIS_CLI[@]}" HSET "$SMOKE_WATCH_KEY" "watch-001" "$VALID_WATCH_JSON" >/dev/null

  run_checks "$SMOKE_AGENT_ID"

  if [[ "$VIOLATIONS" -ne 0 ]]; then
    warn "Expected 0 violations for clean record, got ${VIOLATIONS}."
    warn "The invariant checker flagged a known-good record."
    smoke_cleanup
    exit 1
  fi
  ok "Clean record passes all invariants (0 violations)"

  # ── Phase 3: mixed — clean + violation, expect exactly 1 violation ────

  log ""
  log "── Phase 3: Mixed records ──"
  smoke_cleanup

  "${REDIS_CLI[@]}" HSET "$SMOKE_WATCH_KEY" "watch-001" "$VALID_WATCH_JSON" >/dev/null
  "${REDIS_CLI[@]}" HSET "$SMOKE_WATCH_KEY" "watch-002" "$VIOLATION_NO_LINKAGE_JSON" >/dev/null

  run_checks "$SMOKE_AGENT_ID"

  if [[ "$VIOLATIONS" -ne 1 ]]; then
    warn "Expected 1 violation for mixed records, got ${VIOLATIONS}."
    smoke_cleanup
    exit 1
  fi
  ok "Mixed records: 1 violation correctly isolated (clean record not flagged)"

  smoke_cleanup

  echo ""
  ok "Smoke test PASSED — both invariants detect violations and pass clean data."
}

# ─── Mode: audit specific agent ──────────────────────────────────────────────

run_audit_agent() {
  start_redis_if_needed
  log "Auditing agent: ${AGENT_ID}"
  run_checks "$AGENT_ID"

  if [[ "$VIOLATIONS" -gt 0 ]]; then
    warn "${VIOLATIONS} watch invariant violation(s) detected."
    warn "See: docs/features/2026/07/12/004-agent-direct-protection-alignment/002-protective-watch-contract-closure.md"
    exit 1
  fi

  if [[ "$CHECKED_WATCHES" -gt 0 ]]; then
    ok "All watch invariants hold (${CHECKED_WATCHES} watch(es))."
  else
    ok "No watches found — nothing to verify."
  fi
}

# ─── Mode: audit all agents ──────────────────────────────────────────────────

run_audit_all() {
  start_redis_if_needed

  local AGENT_IDS=()
  while IFS= read -r id; do
    [[ -n "$id" ]] && AGENT_IDS+=("$id")
  done < <("${REDIS_CLI[@]}" --raw SMEMBERS agent:sessions:active 2>/dev/null || true)

  while IFS= read -r key; do
    local local_id="${key#agent:watches:}"
    [[ "$local_id" == summary:* ]] && continue
    [[ "$local_id" == notified:* ]] && continue
    [[ -z "$local_id" ]] && continue
    if [[ ! " ${AGENT_IDS[*]:-} " =~ " ${local_id} " ]]; then
      AGENT_IDS+=("$local_id")
    fi
  done < <("${REDIS_CLI[@]}" --raw KEYS 'agent:watches:*' 2>/dev/null | grep -vE ':(summary|notified):' || true)

  if [[ ${#AGENT_IDS[@]} -eq 0 ]]; then
    ok "No agents found with active sessions or watches — nothing to check."
    exit 0
  fi

  log "Auditing ${#AGENT_IDS[@]} agent(s)"
  run_checks "${AGENT_IDS[@]}"

  if [[ "$VIOLATIONS" -gt 0 ]]; then
    warn "${VIOLATIONS} watch invariant violation(s) detected across ${CHECKED_AGENTS} agent(s)."
    warn "See: docs/features/2026/07/12/004-agent-direct-protection-alignment/002-protective-watch-contract-closure.md"
    exit 1
  fi

  if [[ "$CHECKED_WATCHES" -gt 0 ]]; then
    ok "All watch invariants hold (${CHECKED_WATCHES} watch(es) across ${CHECKED_AGENTS} agent(s))."
  else
    ok "No watches found across ${CHECKED_AGENTS} agent(s) — nothing to verify."
  fi
}

# ─── Dispatch ─────────────────────────────────────────────────────────────────

if [[ "$SMOKE" -eq 1 ]]; then
  run_smoke
elif [[ -n "$AGENT_ID" ]]; then
  run_audit_agent
else
  run_audit_all
fi
