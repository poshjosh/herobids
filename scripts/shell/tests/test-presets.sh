#!/usr/bin/env bash
# test-presets.sh — Assert all expected strategy presets are served by the API.
#
# Checks every expected preset key across all three style tiers (economy,
# standard, premium). Exits 0 only when all assertions pass.
#
# Environment:
#   API_BASE_URL   Base URL of the API (default: http://localhost:3000)
#   TEST_EMAIL     Test user email     (default: preset-test@local.test)
#   TEST_PASSWORD  Test user password  (default: TestPreset123!)
#
# Usage:
#   scripts/shell/tests/test-presets.sh
#   API_BASE_URL=http://localhost:3000 scripts/shell/tests/test-presets.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

API_BASE="${API_BASE_URL:-http://localhost:3000}"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log_info()  { echo "[INFO]  $*"; }
log_ok()    { echo "[OK]    $*"; }
log_error() { echo "[ERROR] $*" >&2; }

die() { log_error "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Test user credentials (defaults work for local dev; override via env or .env.ops.dev)
# ---------------------------------------------------------------------------

TEST_EMAIL="${TEST_EMAIL:-preset-test@local.test}"
TEST_PASSWORD="${TEST_PASSWORD:-TestPreset123!}"

# ---------------------------------------------------------------------------
# Authenticate (login first, register on first run)
# ---------------------------------------------------------------------------

log_info "Authenticating as $TEST_EMAIL ..."

login_resp=$(curl -s -X POST "$API_BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")
TOKEN=$(echo "$login_resp" | jq -r '.token // empty')

if [[ -z "$TOKEN" ]]; then
  log_info "Login failed — registering new test user ..."
  register_resp=$(curl -s -X POST "$API_BASE/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"displayName\":\"Preset Test\"}")
  TOKEN=$(echo "$register_resp" | jq -r '.token // empty')
  [[ -n "$TOKEN" ]] || die "Registration failed: $(echo "$register_resp" | jq -c '.')"
  log_ok "Test user registered"
else
  log_ok "Authenticated"
fi

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
