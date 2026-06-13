#!/usr/bin/env bash
# agent-trade-test.sh — Shell wrapper for scripts/ts/agent-trade-test.ts
#
# Loads credentials from an env file (default: scripts/.env.trade-test),
# validates required vars are present, then runs the TypeScript smoke test.
#
# Usage:
#   scripts/shell/tests/agent-trade-test.sh
#   scripts/shell/tests/agent-trade-test.sh --env /path/to/custom.env
#   scripts/shell/tests/agent-trade-test.sh --dry-run
#   scripts/shell/tests/agent-trade-test.sh --help
#
# Setup:
#   cp scripts/.env.trade-test.example scripts/.env.trade-test
#   # fill in your credentials, then:
#   chmod +x scripts/shell/tests/agent-trade-test.sh
#   scripts/shell/tests/agent-trade-test.sh
#
# ─────────────────────────────────────────────────────────────────
# Variables in .env.trade-test
# ─────────────────────────────────────────────────────────────────
#
# Required
#   API_BASE_URL          Base URL of the Herobids API
#                         Default: http://localhost:3000
#
#   TEST_EMAIL            Test user email (created automatically on first run)
#                         Default: trade-test@local.test
#   TEST_PASSWORD         Password (≥ 8 characters)
#                         Default: TradeTest123!
#
#   VENUE                 hyperliquid (default) | bybit
#
#   Hyperliquid secrets   (required when VENUE=hyperliquid)
#     HL_API_KEY
#     HL_SECRET
#     HL_WALLET_ADDRESS   EVM address: 0x + 40 hex chars
#
#   Bybit secrets         (required when VENUE=bybit)
#     BYBIT_API_KEY
#     BYBIT_SECRET
#
# Optional
#   EXECUTION_MODE        paper (default) | shadow | live
#   TICK_INTERVAL_MS      Tick interval in ms. Default: 60000 (1 min)
#   TIMEOUT_MS            Total watch timeout in ms. Default: 600000 (10 min)
#   DOCKER_COMPOSE_UP     1 to auto-start Docker stack when API is unreachable
#   DOCKER_COMPOSE_DOWN   1 to stop the Docker stack on exit (only if started here)
#   SKIP_TEARDOWN         1 to leave the agent running for manual inspection
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/scripts/.env.trade-test"
DRY_RUN=0

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
    --dry-run)
      DRY_RUN=1
      shift
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
# CLI-provided env vars take precedence over values in the env file.
# Capture them before sourcing so we can restore them afterward.
# (Uses individual variables for bash 3.x compat — no associative arrays.)
# ---------------------------------------------------------------------------

# Snapshot: <VAR>_ISSET=1 if the var was already in the environment
_PRE_DOCKER_COMPOSE_UP_SET="${DOCKER_COMPOSE_UP+1}"
_PRE_DOCKER_COMPOSE_UP_VAL="${DOCKER_COMPOSE_UP:-}"
_PRE_DOCKER_COMPOSE_DOWN_SET="${DOCKER_COMPOSE_DOWN+1}"
_PRE_DOCKER_COMPOSE_DOWN_VAL="${DOCKER_COMPOSE_DOWN:-}"
_PRE_SKIP_TEARDOWN_SET="${SKIP_TEARDOWN+1}"
_PRE_SKIP_TEARDOWN_VAL="${SKIP_TEARDOWN:-}"
_PRE_EXECUTION_MODE_SET="${EXECUTION_MODE+1}"
_PRE_EXECUTION_MODE_VAL="${EXECUTION_MODE:-}"
_PRE_VENUE_SET="${VENUE+1}"
_PRE_VENUE_VAL="${VENUE:-}"

if [[ -f "$ENV_FILE" ]]; then
  log "Loading env from $ENV_FILE"
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
else
  warn "Env file not found: $ENV_FILE"
  warn "Continuing with environment variables already set in the shell."
  warn "To create the file: cp scripts/.env.trade-test.example scripts/.env.trade-test"
fi

# Restore CLI overrides so they take precedence over env file values
[[ "$_PRE_DOCKER_COMPOSE_UP_SET"   == "1" ]] && export DOCKER_COMPOSE_UP="$_PRE_DOCKER_COMPOSE_UP_VAL"
[[ "$_PRE_DOCKER_COMPOSE_DOWN_SET" == "1" ]] && export DOCKER_COMPOSE_DOWN="$_PRE_DOCKER_COMPOSE_DOWN_VAL"
[[ "$_PRE_SKIP_TEARDOWN_SET"       == "1" ]] && export SKIP_TEARDOWN="$_PRE_SKIP_TEARDOWN_VAL"
[[ "$_PRE_EXECUTION_MODE_SET"      == "1" ]] && export EXECUTION_MODE="$_PRE_EXECUTION_MODE_VAL"
[[ "$_PRE_VENUE_SET"               == "1" ]] && export VENUE="$_PRE_VENUE_VAL"
unset _PRE_DOCKER_COMPOSE_UP_SET _PRE_DOCKER_COMPOSE_UP_VAL \
      _PRE_DOCKER_COMPOSE_DOWN_SET _PRE_DOCKER_COMPOSE_DOWN_VAL \
      _PRE_SKIP_TEARDOWN_SET _PRE_SKIP_TEARDOWN_VAL \
      _PRE_EXECUTION_MODE_SET _PRE_EXECUTION_MODE_VAL \
      _PRE_VENUE_SET _PRE_VENUE_VAL

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

: "${API_BASE_URL:=http://localhost:3000}"
: "${TEST_EMAIL:=trade-test@local.test}"
: "${TEST_PASSWORD:=TradeTest123!}"
: "${VENUE:=hyperliquid}"
: "${EXECUTION_MODE:=paper}"
: "${TICK_INTERVAL_MS:=60000}"
: "${TIMEOUT_MS:=600000}"
: "${DOCKER_COMPOSE_UP:=0}"
: "${DOCKER_COMPOSE_DOWN:=0}"
: "${SKIP_TEARDOWN:=0}"

# ---------------------------------------------------------------------------
# Validate required secrets per venue
# ---------------------------------------------------------------------------

validate_secrets() {
  local venue="$1"
  case "$venue" in
    hyperliquid)
      [[ -n "${HL_API_KEY:-}"       ]] || die "HL_API_KEY is required for venue=hyperliquid"
      [[ -n "${HL_SECRET:-}"        ]] || die "HL_SECRET is required for venue=hyperliquid"
      [[ -n "${HL_WALLET_ADDRESS:-}" ]] || die "HL_WALLET_ADDRESS is required for venue=hyperliquid"
      ok "Hyperliquid credentials present"
      ;;
    bybit)
      [[ -n "${BYBIT_API_KEY:-}" ]] || die "BYBIT_API_KEY is required for venue=bybit"
      [[ -n "${BYBIT_SECRET:-}"  ]] || die "BYBIT_SECRET is required for venue=bybit"
      ok "Bybit credentials present"
      ;;
    *)
      die "Unsupported VENUE: $venue. Supported: hyperliquid, bybit"
      ;;
  esac
}

validate_secrets "$VENUE"

# ---------------------------------------------------------------------------
# Validate tsx is available
# ---------------------------------------------------------------------------

if ! command -v tsx &>/dev/null && ! command -v pnpm &>/dev/null; then
  die "Neither tsx nor pnpm found. Install pnpm (https://pnpm.io) or tsx (npm i -g tsx)."
fi

# ---------------------------------------------------------------------------
# Summary / dry-run
# ---------------------------------------------------------------------------

log ""
log "=== Agent Trade Test ==="
log "  API:            $API_BASE_URL"
log "  Venue:          $VENUE"
log "  Execution mode: $EXECUTION_MODE"
log "  Tick interval:  $((TICK_INTERVAL_MS / 1000))s"
log "  Timeout:        $((TIMEOUT_MS / 1000))s"
log "  Env file:       $ENV_FILE"
log ""

if [[ "$DRY_RUN" -eq 1 ]]; then
  ok "Dry run — config validated, no API calls made."
  exit 0
fi

# ---------------------------------------------------------------------------
# Export vars so the TS script picks them up
# ---------------------------------------------------------------------------

export API_BASE_URL TEST_EMAIL TEST_PASSWORD VENUE EXECUTION_MODE \
       TICK_INTERVAL_MS TIMEOUT_MS DOCKER_COMPOSE_UP DOCKER_COMPOSE_DOWN SKIP_TEARDOWN

# Pass through venue-specific secrets that are already exported via the source above.
# (set -a / set +a above ensures they're exported, but be explicit for clarity.)
if [[ "$VENUE" == "hyperliquid" ]]; then
  export HL_API_KEY HL_SECRET HL_WALLET_ADDRESS
elif [[ "$VENUE" == "bybit" ]]; then
  export BYBIT_API_KEY BYBIT_SECRET
fi

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

TS_SCRIPT="$REPO_ROOT/scripts/ts/agent-trade-test.ts"

if command -v pnpm &>/dev/null; then
  exec pnpm --filter @herobids/scripts exec tsx "$TS_SCRIPT"
else
  exec tsx "$TS_SCRIPT"
fi
