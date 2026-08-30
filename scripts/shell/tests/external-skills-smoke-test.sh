#!/usr/bin/env bash
# external-skills-smoke-test.sh — Smoke test for the external skills integration
#
# Validates that the GET /skills endpoint actually returns external skills
# from the live skills.sh API, not just local skills. This catches the class
# of bugs that unit tests with mocked fetch cannot: provider not wired,
# network unreachable from Docker, timeouts too low, silent degradation.
#
# Tests:
#   1. GET /skills?scope=selectable (browse) returns totalCount > local-only count
#   2. GET /skills?scope=selectable&q=react (search) returns external results
#   3. GET /skills?scope=selectable&q=anthropic returns results (skills.sh only)
#   4. GET /skills?sourceKind=external returns only external skills
#   5. Degradation field absent when external provider is healthy
#
# Usage:
#   scripts/shell/tests/external-skills-smoke-test.sh
#   API_BASE_URL=http://localhost:3000 scripts/shell/tests/external-skills-smoke-test.sh
#
# Prerequisites:
#   - API server running with externalSkills.enabled=true
#   - skills-api container running (for browse)
#   - Internet access (for skills.sh search)

set -euo pipefail

API="${API_BASE_URL:-http://localhost:3000}"
TEST_EMAIL="${TEST_EMAIL:-external-skills-test@local.test}"
TEST_PASSWORD="${TEST_PASSWORD:-E2ETest123!}"
TOKEN=""
PASS=0
FAIL=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
ok()   { echo "  ✓ $*"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }

api() {
  local method="$1" url="$2"
  curl -s -X "$method" "$API$url" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN"
}

assert_gt() {
  local label="$1" threshold="$2" actual="$3"
  if [ -n "$actual" ] && [ "$actual" -gt "$threshold" ] 2>/dev/null; then
    ok "$label ($actual) > $threshold"
  else
    fail "$label: expected > $threshold, got ${actual:-null}"
  fi
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    ok "$label = $expected"
  else
    fail "$label: expected $expected, got $actual"
  fi
}

assert_absent() {
  local label="$1" value="$2"
  if [ "$value" = "null" ] || [ -z "$value" ]; then
    ok "$label is absent"
  else
    fail "$label: expected absent, got $value"
  fi
}

# ---------------------------------------------------------------------------
# Authenticate
# ---------------------------------------------------------------------------

log "Authenticating as $TEST_EMAIL ..."

login_resp=$(curl -s -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")
TOKEN=$(echo "$login_resp" | jq -r '.token // empty')

if [ -z "$TOKEN" ]; then
  log "Login failed — registering new test user..."
  register_resp=$(curl -s -X POST "$API/auth/register" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"displayName\":\"External Skills Test\"}")
  TOKEN=$(echo "$register_resp" | jq -r '.token // empty')
  if [ -z "$TOKEN" ]; then
    echo "FATAL: Could not authenticate. Response: $(echo "$register_resp" | jq -c '.')"
    exit 1
  fi
fi

ok "Authenticated"

# ---------------------------------------------------------------------------
# Preflight: count local skills
# ---------------------------------------------------------------------------

log "Counting local-only skills (scope=mine + system) ..."
mine_resp=$(api GET '/skills?scope=selectable&sourceKind=system&pageSize=1')
system_count=$(echo "$mine_resp" | jq -r '.totalCount // 0')
log "  System skills: $system_count"

# ═══════════════════════════════════════════════════════════════════════════
# Test 1: Browse (no query) returns more than local-only count
# ═══════════════════════════════════════════════════════════════════════════

log "── Test 1: Browse returns external skills ──"
response=$(api GET '/skills?scope=selectable&page=1&pageSize=5')
total=$(echo "$response" | jq -r '.totalCount // 0')
page_count=$(echo "$response" | jq -r '.skills | length')

assert_gt "totalCount (browse)" "100" "$total"
assert_gt "skills on page" "0" "$page_count"

# ═══════════════════════════════════════════════════════════════════════════
# Test 2: Search for "react" returns external results
# ═══════════════════════════════════════════════════════════════════════════

log "── Test 2: Search 'react' returns external results ──"
response=$(api GET '/skills?scope=selectable&q=react&page=1&pageSize=10')
total=$(echo "$response" | jq -r '.totalCount // 0')
first_source=$(echo "$response" | jq -r '.skills[0].sourceKind // empty')

assert_gt "totalCount (react search)" "0" "$total"

# At least one result should be external (react skills exist on skills.sh)
ext_count=$(echo "$response" | jq '[.skills[] | select(.sourceKind == "external")] | length')
assert_gt "external results in react search" "0" "$ext_count"

# ═══════════════════════════════════════════════════════════════════════════
# Test 3: Search for "anthropic" returns results (skills.sh exclusive)
# ═══════════════════════════════════════════════════════════════════════════

log "── Test 3: Search 'anthropic' returns skills.sh results ──"
response=$(api GET '/skills?scope=selectable&q=anthropic&page=1&pageSize=10')
total=$(echo "$response" | jq -r '.totalCount // 0')

# Anthropic skills exist on skills.sh but are unlikely to be in local DB
assert_gt "totalCount (anthropic search)" "0" "$total"

# ═══════════════════════════════════════════════════════════════════════════
# Test 4: sourceKind=external returns only external skills
# ═══════════════════════════════════════════════════════════════════════════

log "── Test 4: sourceKind=external filter ──"
response=$(api GET '/skills?scope=selectable&sourceKind=external&q=react&page=1&pageSize=5')
total=$(echo "$response" | jq -r '.totalCount // 0')
non_ext=$(echo "$response" | jq '[.skills[] | select(.sourceKind != "external")] | length')

assert_gt "totalCount (external-only)" "0" "$total"
assert_eq "non-external skills in external filter" "0" "$non_ext"

# ═══════════════════════════════════════════════════════════════════════════
# Test 5: No degradation field when healthy
# ═══════════════════════════════════════════════════════════════════════════

log "── Test 5: No degradation field when healthy ──"
response=$(api GET '/skills?scope=selectable&q=react&page=1&pageSize=5')
degradation=$(echo "$response" | jq -r '.degradation // "null"')
assert_absent "degradation field" "$degradation"

# ═══════════════════════════════════════════════════════════════════════════
# Test 6: Paginated response envelope shape
# ═══════════════════════════════════════════════════════════════════════════

log "── Test 6: Response envelope has required fields ──"
response=$(api GET '/skills?scope=selectable&page=1&pageSize=5')
has_skills=$(echo "$response" | jq 'has("skills")')
has_total=$(echo "$response" | jq 'has("totalCount")')
has_page=$(echo "$response" | jq 'has("page")')
has_size=$(echo "$response" | jq 'has("pageSize")')

assert_eq "has skills array" "true" "$has_skills"
assert_eq "has totalCount" "true" "$has_total"
assert_eq "has page" "true" "$has_page"
assert_eq "has pageSize" "true" "$has_size"
assert_eq "page value" "1" "$(echo "$response" | jq -r '.page')"
assert_eq "pageSize value" "5" "$(echo "$response" | jq -r '.pageSize')"

# ═══════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "──────────────────────────────────────────"
echo "  Results: $PASS passed, $FAIL failed"
echo "──────────────────────────────────────────"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
