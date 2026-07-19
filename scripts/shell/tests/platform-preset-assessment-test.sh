#!/usr/bin/env bash
# platform-preset-assessment-test.sh — Shell wrapper for scripts/ts/platform-preset-assessment-test.ts
#
# Validates operator-config and agent-config gating for the platform preset
# assessment feature.  Covers the config-propagation scenarios (S1–S3, S19)
# from 017-api-like-e2e-scenario-matrix-for-platform-preset-assessment.
#
# Scenarios:
#   S1  Operator disables platform assessor globally — request path blocked
#   S2  Agent opts out (platformAssessment.enabled=false) — request blocked
#   S3  Both enabled — request allowed to proceed
#   S19 Operator freshness config changes artifact-reuse behaviour
#
# Usage:
#   scripts/shell/tests/platform-preset-assessment-test.sh
#   scripts/shell/tests/platform-preset-assessment-test.sh --scenario S1,S2
#   scripts/shell/tests/platform-preset-assessment-test.sh --env /path/to/custom.env
#
# Requires:
#   - tsx or pnpm available
#   - API and DB reachable
#   - Worker running with agent runtime support
#
# Setup:
#   cp .env.ops.dev.example .env.ops.dev
#   # fill in TEST_EMAIL, TEST_PASSWORD, HL_API_KEY, HL_SECRET, HL_WALLET_ADDRESS
#   chmod +x scripts/shell/tests/platform-preset-assessment-test.sh
#   scripts/shell/tests/platform-preset-assessment-test.sh

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

SCENARIOS="${SCENARIOS:-S1,S2,S3,S19}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_FILE="$2"
      shift 2
      ;;
    --scenario)
      SCENARIOS="$2"
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
: "${VENUE:=hyperliquid}"
: "${EXECUTION_MODE:=paper}"
: "${LLM_PROVIDER:=ollama}"
: "${LLM_LIGHT_MODEL:=qwen3:8b}"
: "${LLM_HEAVY_MODEL:=qwen3.6:35b-a3b-q4_K_M}"
: "${DOCKER_COMPOSE_UP:=0}"
: "${DOCKER_COMPOSE_DOWN:=0}"
: "${PLATFORM_ASSESSOR_ENABLED:=true}"

# ---------------------------------------------------------------------------
# Check prerequisites
# ---------------------------------------------------------------------------

if ! command -v tsx &>/dev/null && ! command -v pnpm &>/dev/null; then
  die "Neither tsx nor pnpm found. Install pnpm (https://pnpm.io) or tsx (npm i -g tsx)."
fi

# ---------------------------------------------------------------------------
# Build docker-compose override to inject platform assessor env vars
# ---------------------------------------------------------------------------

COMPOSE_OVERRIDE_FILE="$(mktemp "${TMPDIR:-/tmp}/herobids-assessment-override.XXXXXX.yml")"
cleanup_override() { rm -f "${COMPOSE_OVERRIDE_FILE}"; }
trap cleanup_override EXIT

cat > "${COMPOSE_OVERRIDE_FILE}" <<EOF
services:
  worker:
    environment:
      PLATFORM_ASSESSOR_ENABLED: "${PLATFORM_ASSESSOR_ENABLED}"
EOF

log "Compose override: PLATFORM_ASSESSOR_ENABLED=${PLATFORM_ASSESSOR_ENABLED}"
COMPOSE_ARGS="-f docker-compose.yaml -f docker-compose.dev.yaml -f ${COMPOSE_OVERRIDE_FILE}"

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
  docker compose ${COMPOSE_ARGS} up -d --build
  stackStartedByUs=1

  # Wait up to 90 s for API + worker
  deadline=$(($(date +%s) + 90))
  while [[ $(date +%s) -lt $deadline ]]; do
    sleep 3
    if check_api_health; then
      ok "API is now healthy"
      break
    fi
    log "Waiting for API..."
  done
  if ! check_api_health; then
    die "API did not become healthy within 90 s"
  fi
fi

ok "API reachable at ${API_BASE_URL}"

# ---------------------------------------------------------------------------
# Run the test
# ---------------------------------------------------------------------------

log ""
log "=== Platform Preset Assessment E2E Test ==="
log "  API: $API_BASE_URL"
log "  Email: $TEST_EMAIL"
log "  Venue: $VENUE"
log "  Scenarios: $SCENARIOS"
log "  PLATFORM_ASSESSOR_ENABLED: $PLATFORM_ASSESSOR_ENABLED"
log ""

export API_BASE_URL TEST_EMAIL TEST_PASSWORD VENUE EXECUTION_MODE
export LLM_PROVIDER LLM_LIGHT_MODEL LLM_HEAVY_MODEL
export PLATFORM_ASSESSOR_ENABLED SCENARIOS

TS_SCRIPT="$REPO_ROOT/scripts/ts/platform-preset-assessment-test.ts"

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
  docker compose ${COMPOSE_ARGS} down -v
  ok "Docker stack stopped"
fi

exit $EXIT_CODE
