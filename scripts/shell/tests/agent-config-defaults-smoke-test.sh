#!/usr/bin/env bash
# agent-config-defaults-smoke-test.sh — Shell wrapper for scripts/ts/agent-config-defaults-smoke-test.ts
#
# Smoke test verifying the full API → DB → worker → logs pipeline for
# TechnicalConfigSchema defaults (scanBatchSize, scanIntervalMs, etc.)
# after the applyConfigDefaults() fix.
#
# Scenarios:
#   1. Minimal config produces signals (defaults applied at DB read boundary)
#   2. Explicit values preserved in DB
#   3. Intelligence-mode agent unaffected (no technical block)
#   4. PATCH preserves defaults (partial update doesn't strip schema defaults)
#
# Usage:
#   scripts/shell/tests/agent-config-defaults-smoke-test.sh
#   scripts/shell/tests/agent-config-defaults-smoke-test.sh --env /path/to/custom.env
#
# Requires:
#   - tsx or pnpm available
#   - API and DB reachable (uses docker compose exec for DB queries)
#
# Setup:
#   cp .env.ops.dev.example .env.ops.dev
#   # fill in TEST_EMAIL and TEST_PASSWORD, then:
#   chmod +x scripts/shell/tests/agent-config-defaults-smoke-test.sh
#   scripts/shell/tests/agent-config-defaults-smoke-test.sh
#
# ─────────────────────────────────────────────────────────────────
# Variables in .env.ops.dev
# ─────────────────────────────────────────────────────────────────
#
# Required
#   API_BASE_URL          default http://localhost:3000
#   TEST_EMAIL            default trade-test@local.test
#   TEST_PASSWORD         default TradeTest123!
#
# Optional
#   DOCKER_COMPOSE_UP     1 to auto-start Docker stack when API is unreachable
#   DOCKER_COMPOSE_DOWN   1 to stop the Docker stack on exit (only if started here)
#   LLM_PROVIDER          default ollama
#   LLM_LIGHT_MODEL       default qwen3:8b
#   LLM_HEAVY_MODEL       default qwen3.6:35b-a3b-q4_K_M
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.ops.dev"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
ok()   { echo "[$(date '+%H:%M:%S')]  ✓ $*"; }
warn() { echo "[$(date '+%H:%M:%S')]  ⚠ $*" >&2; }
die()  { echo "[$(date '+%H:%M:%S')]  ✗ $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Load env file
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

: "${API_BASE_URL:=http://localhost:3000}"
: "${TEST_EMAIL:=trade-test@local.test}"
: "${TEST_PASSWORD:=TradeTest123!}"
: "${DOCKER_COMPOSE_UP:=0}"
: "${DOCKER_COMPOSE_DOWN:=0}"

# ---------------------------------------------------------------------------
# Check prerequisites
# ---------------------------------------------------------------------------

if ! command -v tsx &>/dev/null && ! command -v pnpm &>/dev/null; then
  die "Neither tsx nor pnpm found. Install pnpm (https://pnpm.io) or tsx (npm i -g tsx)."
fi

# ---------------------------------------------------------------------------
# Auto-start stack if needed
# ---------------------------------------------------------------------------

stackStartedByUs=0

check_api_health() {
  curl -sf -o /dev/null "${API_BASE_URL}/health" 2>/dev/null || return 1
}

if ! check_api_health; then
  if [[ "$DOCKER_COMPOSE_UP" != "1" ]]; then
    die "API at ${API_BASE_URL} is not reachable. Start the stack or re-run with DOCKER_COMPOSE_UP=1."
  fi
  log "API not reachable — starting Docker stack..."
  docker compose up -d
  stackStartedByUs=1

  # Wait up to 60 s
  deadline=$(($(date +%s) + 60))
  while [[ $(date +%s) -lt $deadline ]]; do
    sleep 3
    if check_api_health; then
      ok "API is now healthy"
      break
    fi
    log "Waiting for API..."
  done
  if ! check_api_health; then
    die "API did not become healthy within 60 s"
  fi
fi

ok "API reachable at ${API_BASE_URL}"

# ---------------------------------------------------------------------------
# Run the smoke test
# ---------------------------------------------------------------------------

log ""
log "=== Agent Config Defaults Smoke Test ==="
log "  API: $API_BASE_URL"
log "  Email: $TEST_EMAIL"
log ""

export API_BASE_URL TEST_EMAIL TEST_PASSWORD

TS_SCRIPT="$REPO_ROOT/scripts/ts/agent-config-defaults-smoke-test.ts"

if command -v tsx &>/dev/null; then
  tsx "$TS_SCRIPT"
else
  pnpm exec tsx "$TS_SCRIPT"
fi

EXIT_CODE=$?

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

if [[ "$DOCKER_COMPOSE_DOWN" == "1" && "$stackStartedByUs" == "1" ]]; then
  log "Stopping Docker stack (started by this script)..."
  docker compose down
  ok "Docker stack stopped"
fi

exit $EXIT_CODE
