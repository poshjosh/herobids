#!/usr/bin/env bash
# agent-config-persistence-test.sh — Shell wrapper for scripts/ts/agent-config-persistence-test.ts
#
# Verifies that API create and PATCH endpoints correctly persist technical
# configuration to the database, and that strict invalid configurations are
# rejected at write time.
#
# Scenarios:
#   1. Complete technical config persisted for scanner_gated agent
#   2. Incomplete config rejected by API
#   3. Mixed-mode hybrid defaults applied
#   4. PATCH preserves existing technical fields
#   5. Intelligence-mode agent unaffected (no technical block)
#   6. Invalid PATCH rejected
#
# This test requires only the API and DB. No worker, connection, candles,
# signals, or live market data are needed.
#
# Usage:
#   scripts/shell/tests/agent-config-persistence-test.sh
#   scripts/shell/tests/agent-config-persistence-test.sh --env /path/to/custom.env
#
# Requires:
#   - tsx or pnpm available
#   - API and DB reachable
#
# Stack lifecycle:
#   - Start:  scripts/shell/run/build-and-run.sh
#   - Stop:   scripts/shell/run/shutdown.sh
#
# Setup:
#   cp .env.ops.dev.example .env.ops.dev
#   # fill in TEST_EMAIL and TEST_PASSWORD, then:
#   chmod +x scripts/shell/tests/agent-config-persistence-test.sh
#   scripts/shell/tests/agent-config-persistence-test.sh
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
#   DOCKER_COMPOSE_UP     1 to auto-start the stack via build-and-run.sh when API
#                         is unreachable (default: 1)
#   DOCKER_COMPOSE_DOWN   1 to stop the stack via shutdown.sh on exit (only if
#                         started by this script; default: 1)
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
: "${DOCKER_COMPOSE_UP:=1}"
: "${DOCKER_COMPOSE_DOWN:=1}"

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
  log "API not reachable — starting stack via build-and-run.sh..."
  bash "$SCRIPT_DIR/../run/build-and-run.sh" || die "build-and-run.sh failed"
  stackStartedByUs=1

  # Wait up to 60 s for the API to become healthy.
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
# Run the persistence test
# ---------------------------------------------------------------------------

log ""
log "=== Agent Config Persistence Test ==="
log "  API: $API_BASE_URL"
log "  Email: $TEST_EMAIL"
log ""

export API_BASE_URL TEST_EMAIL TEST_PASSWORD

TS_SCRIPT="$REPO_ROOT/scripts/ts/agent-config-persistence-test.ts"

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
  log "Stopping stack via shutdown.sh..."
  bash "$SCRIPT_DIR/../run/shutdown.sh" || warn "shutdown.sh completed with warnings"
  ok "Stack stopped"
fi

exit $EXIT_CODE
