#!/usr/bin/env bash
# reset-and-run-xstack.sh — Clean-slate bring-up of herobids AND traderton side
# by side on one machine, on deconflicted host ports, for durable multi-day
# cross-stack local testing. The cross-stack equivalent of reset-and-run.sh.
#
# BUILDS BOTH: traderton via its compose build (migrate + boundary images);
# herobids via reset-and-run.sh → build-and-run.sh (pnpm build + lint + agent
# image). RESETS BOTH: traderton `down -v` (clean DB/redis) then rebuild;
# herobids reset-and-run (down -v + prune + reseed admin/agents). So every run
# is a genuine clean slate on both sides — the repeated-testing flow.
#
# WHY THIS EXISTS
#   herobids no longer executes trades in-process; its trading tools call the
#   traderton REST boundary at http://localhost:8080 (herobids config default
#   `boundary.baseUrl`). The plain `reset-and-run.sh` / `build-and-run.sh` bring
#   up ONLY herobids and do NOT start the boundary, so trading paths fail-closed
#   (503) with no boundary. This script brings both stacks up together.
#
#   This is an ADDITIONAL path — it deliberately does NOT replace
#   reset-and-run.sh. herobids must still be runnable standalone (non-trading
#   dev, CI, the test tiers). Use this only when you want a trading-capable
#   cross-stack stack up for a while.
#
# PORT DECONFLICTION (the whole reason a plain `docker compose up` on both
# stacks collides — they share 5432/6379, and herobids' dev web takes 8080):
#   herobids : postgres 5432 · redis 6379 · api 3000 · web 8090 (WEB_PORT)
#   traderton: boundary 8080 · postgres 5433 · redis 6380
#   → 8080 is reserved for the traderton BOUNDARY (herobids' consume contract);
#     herobids web is moved to 8090 via WEB_PORT (which also moves
#     AUTH_FRONTEND_ORIGIN — they are coupled in docker-compose.dev.yaml, and
#     that origin is load-bearing for CORS + OAuth callbacks, so they MUST move
#     together; WEB_PORT does exactly that).
#   The traderton pg/redis remap reuses the committed, proven test overlay
#   docker/traderton-xstack.override.yml (host ports only; traderton's internal
#   service-name wiring postgres:5432 / redis:6379 is untouched).
#
# CREDS: herobids' TRADERTON_BOUNDARY_{HMAC_SECRET,CONSUMER_ID,KEY_ID} in
#   herobids/.env MUST match traderton's BOUNDARY_{SIGNING_SECRET,CONSUMER_ID,
#   KEY_ID} in traderton/.env, or signed calls connect but get rejected. Both
#   stacks read their own `.env`.
#
# USAGE
#   scripts/shell/run/reset-and-run-xstack.sh              # clean-slate bring both up
#   scripts/shell/run/reset-and-run-xstack.sh --skip-setup # skip herobids quick-setup/agents
#   scripts/shell/run/reset-and-run-xstack.sh --down       # tear BOTH stacks down
#   WEB_PORT=8091 scripts/shell/run/reset-and-run-xstack.sh # override herobids web port
#
# WARNING: the default (non---down) path DESTROYS local data volumes on BOTH
#   stacks (traderton `down -v`; herobids reset-and-run). Do not run against
#   anything you want to keep.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEROBIDS_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TRADERTON_ROOT="$(cd "$HEROBIDS_ROOT/../traderton" && pwd)"

# herobids web port (also drives AUTH_FRONTEND_ORIGIN via docker-compose.dev.yaml).
# Default 8090 so it does NOT collide with the traderton boundary on 8080.
export WEB_PORT="${WEB_PORT:-8090}"

# traderton compose invocation: its own compose + the herobids-side host-port
# remap overlay, under a dedicated project name so it never fights herobids.
TRADERTON_PROJECT="traderton_xstack"
TRADERTON_OVERLAY="$HEROBIDS_ROOT/docker/traderton-xstack.override.yml"
TRADERTON_COMPOSE=(docker compose -p "$TRADERTON_PROJECT"
  -f "$TRADERTON_ROOT/docker-compose.yml"
  -f "$TRADERTON_OVERLAY")

BOUNDARY_URL="http://localhost:8080"

log()        { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }
error_exit() { log "ERROR: $1"; exit "${2:-1}"; }

DO_DOWN=0
PASSTHROUGH=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --down)        DO_DOWN=1; shift ;;
    --skip-setup)  PASSTHROUGH+=("--skip-setup"); shift ;;
    -h|--help)     awk '/^[^#]/{exit} /^#/{sub(/^# ?/,""); print}' "$0"; exit 0 ;;
    *)             error_exit "Unknown argument: $1  (use --help for usage)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || error_exit "docker not found"
[[ -f "$TRADERTON_ROOT/docker-compose.yml" ]] || error_exit "traderton compose not found at $TRADERTON_ROOT/docker-compose.yml"
[[ -f "$TRADERTON_OVERLAY" ]] || error_exit "traderton xstack overlay not found at $TRADERTON_OVERLAY"

# ---------------------------------------------------------------------------
# --down: tear BOTH stacks down and exit
# ---------------------------------------------------------------------------
if [[ "$DO_DOWN" -eq 1 ]]; then
  log "Tearing down herobids stack..."
  bash "$SCRIPT_DIR/shutdown.sh" 2>&1 | sed 's/^/  /' || log "WARNING: herobids shutdown reported errors"
  log "Tearing down traderton xstack (project $TRADERTON_PROJECT)..."
  "${TRADERTON_COMPOSE[@]}" down -v --remove-orphans 2>&1 | sed 's/^/  /' || log "WARNING: traderton down reported errors"
  log "Cross-stack teardown complete."
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 1 — traderton FIRST (herobids' trading paths need the boundary at boot).
#   Reset semantics: tear traderton down WITH volumes before rebuilding, so each
#   run is a genuine clean slate (traderton defines no named volumes — its
#   Postgres/Redis data is anonymous container storage, wiped by `down -v`).
#   Without this, herobids resets but traderton keeps stale trading state across
#   runs, defeating repeatable multi-day testing.
# ---------------------------------------------------------------------------
log "Step 1a: Tearing down any prior traderton xstack (clean slate)..."
"${TRADERTON_COMPOSE[@]}" down -v --remove-orphans 2>&1 | sed 's/^/  /' || log "WARNING: prior traderton teardown reported errors (continuing)"

log "Step 1b: Bringing up traderton (boundary :8080, postgres :5433, redis :6380)..."
"${TRADERTON_COMPOSE[@]}" up -d --build || error_exit "traderton stack failed to start"

# ---------------------------------------------------------------------------
# Step 2 — wait for the boundary to be READY before starting herobids.
# ---------------------------------------------------------------------------
log "Step 2: Waiting for the traderton boundary at $BOUNDARY_URL/health/ready ..."
MAX_WAIT=120
ELAPSED=0
until curl -sf "$BOUNDARY_URL/health/ready" >/dev/null 2>&1; do
  if [[ $ELAPSED -ge $MAX_WAIT ]]; then
    log "Recent boundary logs:"
    "${TRADERTON_COMPOSE[@]}" logs --tail 40 boundary 2>&1 | sed 's/^/  /' || true
    error_exit "boundary did not become ready within ${MAX_WAIT}s"
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done
log "Boundary ready after ~${ELAPSED}s."

# ---------------------------------------------------------------------------
# Step 3 — herobids (web on WEB_PORT so 8080 stays free for the boundary).
#          Delegates to the standard reset-and-run.sh (unchanged).
# ---------------------------------------------------------------------------
log "Step 3: Bringing up herobids (web on :$WEB_PORT; reaches boundary at :8080)..."
bash "$SCRIPT_DIR/reset-and-run.sh" "${PASSTHROUGH[@]}" || error_exit "reset-and-run.sh failed"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
cat <<EOF
[$(date '+%Y-%m-%d %H:%M:%S')] Cross-stack up.
  herobids web : http://localhost:${WEB_PORT}
  herobids api : http://localhost:3000
  traderton    : boundary http://localhost:8080 (pg :5433, redis :6380)
Tear down BOTH with: scripts/shell/run/reset-and-run-xstack.sh --down
EOF
