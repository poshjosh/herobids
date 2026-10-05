#!/usr/bin/env bash
# agent-pause-test.sh — Shell wrapper for scripts/ts/agent-pause-test.ts
#
# E2E check for agent pause / resume (bug 2026-10-05/001):
#   - a paused agent emits tick_skipped gate=paused and does no ticks, wakes or
#     LLM calls (a user message sent while paused does not wake it)
#   - a worker restart does not flip the agent back to active
#   - resume runs a forced full evaluation and dispatches the LLM
#
# Usage:
#   scripts/shell/tests/agent-pause-test.sh
#   scripts/shell/tests/agent-pause-test.sh --env /path/to/custom.env
#   PAUSE_TEST_RESTART_WORKER=0 scripts/shell/tests/agent-pause-test.sh   # skip worker restart
#   SKIP_TEARDOWN=1 scripts/shell/tests/agent-pause-test.sh               # keep the agent
#
# Requires:
#   - tsx or pnpm available
#   - API, worker, Postgres and Redis running (DB queried via docker compose exec)
#   - herobids-agent:latest built from the current source; a stale image has no
#     pause support and fails the "paused-tick-emitted" check. Rebuild with:
#       docker build -f docker/Dockerfile.agent -t herobids-agent:latest .
#   - LLM reachable for the final "resumed-llm-dispatch" check (the dispatch event
#     is emitted before the LLM call, so a slow model does not fail it)
#
# Note: the worker-restart step runs `docker compose restart worker` against the
# shared stack. Set PAUSE_TEST_RESTART_WORKER=0 when that is not acceptable.
#
# ─────────────────────────────────────────────────────────────────
# Variables in .env.ops.dev
# ─────────────────────────────────────────────────────────────────
#
# Required
#   API_BASE_URL                 default http://localhost:3000
#   TEST_EMAIL                   default trade-test@local.test
#   TEST_PASSWORD                default TradeTest123!
#
# Optional
#   LLM_PROVIDER                 default ollama
#   LLM_LIGHT_MODEL              default qwen3:8b
#   LLM_HEAVY_MODEL              default qwen3.6:35b-a3b-q4_K_M
#   PAUSE_TEST_TICK_INTERVAL_MS  default 10000
#   PAUSE_TEST_ACTIVE_TIMEOUT_S  default 180
#   PAUSE_TEST_OBSERVE_S         default 40
#   PAUSE_TEST_RESUME_TIMEOUT_S  default 90
#   PAUSE_TEST_RESTART_WORKER    default 1
#   SKIP_TEARDOWN                default 0
#   DOCKER_COMPOSE_UP            1 to auto-start Docker stack when API is unreachable
#   DOCKER_COMPOSE_DOWN          1 to stop the Docker stack on exit (only if started here)
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.ops.dev"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
ok()   { echo "[$(date '+%H:%M:%S')]  ✓ $*"; }
warn() { echo "[$(date '+%H:%M:%S')]  ⚠ $*" >&2; }
die()  { echo "[$(date '+%H:%M:%S')]  ✗ $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_FILE="$2"
      shift 2
      ;;
    --help|-h)
      sed -n '2,/^set -euo/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      die "Unknown argument: $1  (use --help for usage)"
      ;;
  esac
done

if [[ -f "$ENV_FILE" ]]; then
  log "Loading env from $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  warn "Env file not found: $ENV_FILE"
  warn "Continuing with environment variables already set in the shell."
fi

: "${API_BASE_URL:=http://localhost:3000}"
: "${TEST_EMAIL:=trade-test@local.test}"
: "${TEST_PASSWORD:=TradeTest123!}"
: "${DOCKER_COMPOSE_UP:=0}"
: "${DOCKER_COMPOSE_DOWN:=0}"

if ! command -v tsx &>/dev/null && ! command -v pnpm &>/dev/null; then
  die "Neither tsx nor pnpm found. Install pnpm (https://pnpm.io) or tsx (npm i -g tsx)."
fi
command -v docker &>/dev/null || die "docker not found (needed for psql and worker restart)."

stackStartedByUs=0

check_api_health() {
  curl -sf -o /dev/null "${API_BASE_URL}/health" 2>/dev/null || return 1
}

if ! check_api_health; then
  if [[ "$DOCKER_COMPOSE_UP" != "1" ]]; then
    die "API at ${API_BASE_URL} is not reachable. Start the stack or re-run with DOCKER_COMPOSE_UP=1."
  fi
  log "API not reachable — starting Docker stack..."
  (cd "$REPO_ROOT" && docker compose up -d)
  stackStartedByUs=1
  deadline=$(($(date +%s) + 60))
  while [[ $(date +%s) -lt $deadline ]]; do
    sleep 3
    if check_api_health; then
      ok "API is now healthy"
      break
    fi
    log "Waiting for API..."
  done
  check_api_health || die "API did not become healthy within 60 s"
fi

ok "API reachable at ${API_BASE_URL}"

export API_BASE_URL TEST_EMAIL TEST_PASSWORD

TS_SCRIPT="$REPO_ROOT/scripts/ts/agent-pause-test.ts"
EXIT_CODE=0
if command -v tsx &>/dev/null; then
  tsx "$TS_SCRIPT" || EXIT_CODE=$?
else
  (cd "$REPO_ROOT" && pnpm exec tsx "$TS_SCRIPT") || EXIT_CODE=$?
fi

if [[ "$DOCKER_COMPOSE_DOWN" == "1" && "$stackStartedByUs" == "1" ]]; then
  log "Stopping Docker stack (started by this script)..."
  (cd "$REPO_ROOT" && docker compose down)
  ok "Docker stack stopped"
fi

exit $EXIT_CODE
