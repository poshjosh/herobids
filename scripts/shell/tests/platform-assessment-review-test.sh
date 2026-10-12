#!/usr/bin/env bash
# platform-assessment-review-test.sh — Shell wrapper for scripts/ts/platform-assessment-review-test.ts
#
# Validates the data-only platform assessment review screen gating (herobids
# plan 002 H3). The preset assessment itself moved to Traderton (data-only,
# free); herobids keeps the review screen, which gates on the creator's opt-in
# + the agent's capability mode. This test covers ONLY that gating — the
# data-only assessment behaviour is covered by Traderton's unit + integration
# tests and its cross-stack verification.
#
# Scenarios:
#   G1  Non-hybrid agent → eligibility canTrigger=false (hybrid reason);
#       POST /reviews → 403 capability_mode_unsupported.
#   G2  Hybrid agent opted out (platformAssessment.enabled=false) →
#       eligibility canTrigger=false (opt-in reason); POST → 403 agent_not_opted_in.
#   G3  Hybrid + opted-in + active + running session → eligibility canTrigger=true.
#
# Tier 3 (API + DB): no worker, no venue keys, no traderton boundary needed.
#
# Usage:
#   scripts/shell/tests/platform-assessment-review-test.sh
#   scripts/shell/tests/platform-assessment-review-test.sh --scenario G1,G2
#   scripts/shell/tests/platform-assessment-review-test.sh --env /path/to/custom.env
#
# Requires:
#   - tsx or pnpm available
#   - API and DB reachable

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

SCENARIOS="${SCENARIOS:-G1,G2,G3}"

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

# ---------------------------------------------------------------------------
# Check prerequisites
# ---------------------------------------------------------------------------

if ! command -v tsx &>/dev/null && ! command -v pnpm &>/dev/null; then
  die "Neither tsx nor pnpm found. Install pnpm (https://pnpm.io) or tsx (npm i -g tsx)."
fi

check_api_health() {
  curl -sf -o /dev/null "${API_BASE_URL}/health" 2>/dev/null || return 1
}

if ! check_api_health; then
  die "API at ${API_BASE_URL} is not reachable. Start the stack first."
fi

ok "API reachable at ${API_BASE_URL}"

# ---------------------------------------------------------------------------
# Run the test
# ---------------------------------------------------------------------------

log ""
log "=== Platform Assessment Review Gating Test ==="
log "  API: $API_BASE_URL"
log "  Email: $TEST_EMAIL"
log "  Scenarios: $SCENARIOS"
log ""

export API_BASE_URL TEST_EMAIL TEST_PASSWORD SCENARIOS

TS_SCRIPT="$REPO_ROOT/scripts/ts/platform-assessment-review-test.ts"

if command -v tsx &>/dev/null; then
  tsx "$TS_SCRIPT"
else
  pnpm exec tsx "$TS_SCRIPT"
fi