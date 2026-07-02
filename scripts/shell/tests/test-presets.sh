#!/usr/bin/env bash
# test-presets.sh — Assert all expected strategy presets are served by the API.
#
# Checks every expected preset key across all three style tiers (economy,
# standard, premium). Exits 0 only when all assertions pass.
#
# Environment:
#   API_BASE_URL   Base URL of the API (default: http://localhost:3000)
#   ADMIN_EMAIL    Admin login email     (loaded from .env.local if not set)
#   ADMIN_PASSWORD Admin login password  (loaded from .env.local if not set)
#
# Usage:
#   scripts/shell/tests/test-presets.sh
#   API_BASE_URL=http://localhost:3000 scripts/shell/tests/test-presets.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.local"
API_BASE="${API_BASE_URL:-http://localhost:3000}"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log_info()  { echo "[INFO]  $*"; }
log_ok()    { echo "[OK]    $*"; }
log_error() { echo "[ERROR] $*" >&2; }

die() { log_error "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Load .env.local (only for credentials not already in the environment)
# ---------------------------------------------------------------------------

if [[ -z "${ADMIN_EMAIL:-}" || -z "${ADMIN_PASSWORD:-}" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    die "$ENV_FILE not found and ADMIN_EMAIL/ADMIN_PASSWORD not set.
  Copy the example and fill in your values:
    cp .env.local.example .env.local"
  fi
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  log_info "Loaded: $ENV_FILE"
fi

# ---------------------------------------------------------------------------
# Authenticate
# ---------------------------------------------------------------------------

TOKEN=$(curl -s -X POST "$API_BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | jq -r '.token // empty')

[[ -n "$TOKEN" ]] || die "Login failed — could not obtain a token from $API_BASE"

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------

# All 7 preset keys that must appear in every style tier.
EXPECTED_KEYS=(
  momentum
  momentum-position
  dca
  range
  swing
  scalper
  contrarian
)

STYLES=(economy standard premium)

PASS=0
FAIL=0

for style in "${STYLES[@]}"; do
  response=$(curl -s "$API_BASE/blueprints/presets?style=$style" \
    -H "Authorization: Bearer $TOKEN")

  http_err=$(echo "$response" | jq -r '.error // empty' 2>/dev/null || true)
  if [[ -n "$http_err" ]]; then
    log_error "[$style] API returned an error: $http_err"
    (( FAIL += ${#EXPECTED_KEYS[@]} ))
    continue
  fi

  for key in "${EXPECTED_KEYS[@]}"; do
    if echo "$response" | jq -e ".presets[] | select(.key == \"$key\")" > /dev/null 2>&1; then
      log_ok   "[$style] $key — present"
      (( PASS++ ))
    else
      log_error "[$style] $key — MISSING"
      (( FAIL++ ))
    fi
  done
done

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

echo ""
if [[ $FAIL -gt 0 ]]; then
  log_error "Preset checks: $FAIL failed, $PASS passed."
  exit 1
fi

log_ok "Preset checks: all $PASS passed."
exit 0
