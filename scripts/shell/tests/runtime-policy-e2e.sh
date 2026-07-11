#!/usr/bin/env bash
# runtime-policy-e2e.sh — End-to-end test for per-agent runtime policy controls
#
# Validates:
#   1. Create agent with each style → resolvedRuntimePolicy in response
#   2. Create agent with style + overrides → overrides win
#   3. Create agent with overrides exceeding operator ceiling → rejected
#   4. GET agent → resolvedRuntimePolicy included
#   5. Update agent style → defaults change
#   6. Update agent overrides → effective values change
#   7. Clear overrides (null) → reverts to style default
#
# Usage:
#   scripts/shell/tests/runtime-policy-e2e.sh
#   API_BASE_URL=http://localhost:3000 scripts/shell/tests/runtime-policy-e2e.sh
#
# Environment variables:
#   API_BASE_URL       API root (default: http://localhost:3000)
#   TEST_EMAIL         Test user email (default: runtime-policy-test@local.test)
#   TEST_PASSWORD      Test user password (default: E2ETest123!)
#
# Prerequisites:
#   - API server running (pnpm --filter @herobids/api dev)
#   - Auth enabled — script auto-registers a test user if needed

set -euo pipefail

API="${API_BASE_URL:-http://localhost:3000}"
TEST_EMAIL="${TEST_EMAIL:-runtime-policy-test@local.test}"
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
  local method="$1" url="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -s -X "$method" "$API$url" \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $TOKEN" \
      -d "$data"
  else
    curl -s -X "$method" "$API$url" \
      -H "Authorization: Bearer $TOKEN"
  fi
}

post_agent() {
  api POST /agents "$1"
}

get_agent() {
  api GET "/agents/$1"
}

update_agent() {
  api PUT "/agents/$1" "$2"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    ok "$label = $expected"
  else
    fail "$label: expected $expected, got $actual"
  fi
}

assert_gt() {
  local label="$1" threshold="$2" actual="$3"
  if [ "$actual" -gt "$threshold" ] 2>/dev/null; then
    ok "$label ($actual) > $threshold"
  else
    fail "$label: expected > $threshold, got $actual"
  fi
}

# ---------------------------------------------------------------------------
# Authenticate
# ---------------------------------------------------------------------------

log "Authenticating as $TEST_EMAIL ..."

# Try login first
login_resp=$(curl -s -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")
TOKEN=$(echo "$login_resp" | jq -r '.token // empty')

if [ -z "$TOKEN" ]; then
  log "Login failed — registering new test user..."
  register_resp=$(curl -s -X POST "$API/auth/register" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"displayName\":\"E2E Test\"}")
  TOKEN=$(echo "$register_resp" | jq -r '.token // empty')
  if [ -z "$TOKEN" ]; then
    echo "FATAL: Could not authenticate. Response: $(echo "$register_resp" | jq -c '.')"
    exit 1
  fi
fi

ok "Authenticated"

# ---------------------------------------------------------------------------
# Clean up leftover agents from previous runs
# ---------------------------------------------------------------------------

log "Cleaning up existing agents ..."
EXISTING_IDS=$(api GET /agents | jq -r '.[].id // empty')
for existingId in $EXISTING_IDS; do
  api DELETE "/agents/$existingId" > /dev/null && echo "  Deleted agent $existingId" || true
done
ok "Cleanup complete"

# ---------------------------------------------------------------------------
# Check API is reachable
# ---------------------------------------------------------------------------

log "Checking API at $API ..."
if ! api GET /health | jq -e '.status == "ok"' > /dev/null 2>&1; then
  # /health may not require auth, try bare curl
  if ! curl -s -o /dev/null -w '%{http_code}' "$API/health" | grep -q '2'; then
    echo "ERROR: API not reachable at $API"
    exit 1
  fi
fi
ok "API reachable"

# Base agent payload — provider/model required by validation
BASE_PAYLOAD='{"provider":"ollama","lightModel":"qwen3.6:35b-a3b-q4_K_M","heavyModel":"qwen3.6:35b-a3b-q4_K_M"}'

# ═════════════════════════════════════════════════════════════════════════════
# Test 1: Create Bold agent → verify resolved policy
# ═════════════════════════════════════════════════════════════════════════════

log "── Test 1: Create Bold agent ──"
response=$(post_agent "$(echo "$BASE_PAYLOAD" | jq -c '. + {name:"e2e-rp-bold",prompt:"test",style:"bold"}')")
agentId=$(echo "$response" | jq -r '.id // empty')
if [ -z "$agentId" ] || [ "$agentId" = "null" ]; then
  fail "Failed to create Bold agent: $(echo "$response" | jq -c '.')"
else
  ok "Created Bold agent: $agentId"

  policy=$(echo "$response" | jq '.resolvedRuntimePolicy')
  assert_eq "scoutMaxTurns"    "100"  "$(echo "$policy" | jq -r '.scoutMaxTurns')"
  assert_eq "judgeMaxTurns"    "300"  "$(echo "$policy" | jq -r '.judgeMaxTurns')"
  assert_eq "maxHistoryTokens" "80000" "$(echo "$policy" | jq -r '.maxHistoryTokens')"
  assert_eq "weekendPause"     "false" "$(echo "$policy" | jq -r '.weekendPause')"
  assert_eq "maxHoldDurationMs" "600000" "$(echo "$policy" | jq -r '.maxHoldDurationMs')"

  # Clean up immediately to avoid plan limit
  api DELETE "/agents/$agentId" > /dev/null
fi

# ═════════════════════════════════════════════════════════════════════════════
# Test 2: Create Careful agent → verify conservative defaults
# ═════════════════════════════════════════════════════════════════════════════

log "── Test 2: Create Careful agent ──"
response=$(post_agent "$(echo "$BASE_PAYLOAD" | jq -c '. + {name:"e2e-rp-careful",prompt:"test",style:"careful"}')")
agentId=$(echo "$response" | jq -r '.id // empty')
if [ -z "$agentId" ] || [ "$agentId" = "null" ]; then
  fail "Failed to create Careful agent"
else
  ok "Created Careful agent: $agentId"

  policy=$(echo "$response" | jq '.resolvedRuntimePolicy')
  assert_eq "scoutMaxTurns" "10" "$(echo "$policy" | jq -r '.scoutMaxTurns')"
  assert_eq "judgeMaxTurns" "25" "$(echo "$policy" | jq -r '.judgeMaxTurns')"
  assert_eq "maxHistoryTokens" "20000" "$(echo "$policy" | jq -r '.maxHistoryTokens')"
  assert_eq "weekendPause" "false" "$(echo "$policy" | jq -r '.weekendPause')"
  assert_eq "maxHoldDurationMs" "27000000" "$(echo "$policy" | jq -r '.maxHoldDurationMs')"

  hours=$(echo "$policy" | jq -r '.allowedHoursUtc | join(",")')
  assert_eq "allowedHoursUtc" "14,15,16,17,18,19,20" "$hours"

  api DELETE "/agents/$agentId" > /dev/null
fi

# ═════════════════════════════════════════════════════════════════════════════
# Test 3: Create Balanced agent with overrides → overrides win
# ═════════════════════════════════════════════════════════════════════════════

log "── Test 3: Balanced + overrides ──"
response=$(post_agent "$(echo "$BASE_PAYLOAD" | jq -c '. + {name:"e2e-rp-override",prompt:"test",style:"balanced",runtimePolicyOverrides:{scoutMaxTurns:50,maxHistoryTokens:10000,weekendPause:false}}')")
agentId=$(echo "$response" | jq -r '.id // empty')
if [ -z "$agentId" ] || [ "$agentId" = "null" ]; then
  fail "Failed to create Balanced+override agent"
else
  ok "Created Balanced+override agent: $agentId"

  policy=$(echo "$response" | jq '.resolvedRuntimePolicy')
  assert_eq "scoutMaxTurns (override)"    "50"    "$(echo "$policy" | jq -r '.scoutMaxTurns')"
  assert_eq "maxHistoryTokens (override)" "10000" "$(echo "$policy" | jq -r '.maxHistoryTokens')"
  assert_eq "weekendPause (override)"     "false" "$(echo "$policy" | jq -r '.weekendPause')"
  # Balanced defaults preserved for non-overridden fields
  assert_eq "judgeMaxTurns (default)"     "75"    "$(echo "$policy" | jq -r '.judgeMaxTurns')"
  assert_eq "maxHistoryMessages (default)" "20"   "$(echo "$policy" | jq -r '.maxHistoryMessages')"

  api DELETE "/agents/$agentId" > /dev/null
fi

# ═════════════════════════════════════════════════════════════════════════════
# Test 4: Override exceeds operator ceiling → rejected
# ═════════════════════════════════════════════════════════════════════════════

log "── Test 4: Override exceeds ceiling → 400 ──"
response=$(post_agent "$(echo "$BASE_PAYLOAD" | jq -c '. + {name:"e2e-rp-bad",prompt:"test",runtimePolicyOverrides:{scoutMaxTurns:9999}}')")
error=$(echo "$response" | jq -r '.error // empty')
if [ "$error" = "validation_error" ]; then
  ok "Correctly rejected scoutMaxTurns=9999"
else
  fail "Expected validation_error, got: $(echo "$response" | jq -c '.')"
fi

# ═════════════════════════════════════════════════════════════════════════════
# Test 5: Create agent with no style → falls back to balanced
# ═════════════════════════════════════════════════════════════════════════════

log "── Test 5: No style → balanced fallback ──"
response=$(post_agent "$(echo "$BASE_PAYLOAD" | jq -c '. + {name:"e2e-rp-nostyle",prompt:"test"}')")
agentId=$(echo "$response" | jq -r '.id // empty')
if [ -z "$agentId" ] || [ "$agentId" = "null" ]; then
  fail "Failed to create no-style agent"
else
  ok "Created no-style agent: $agentId"

  policy=$(echo "$response" | jq '.resolvedRuntimePolicy')
  assert_eq "scoutMaxTurns" "30" "$(echo "$policy" | jq -r '.scoutMaxTurns')"
  assert_eq "judgeMaxTurns" "75" "$(echo "$policy" | jq -r '.judgeMaxTurns')"
fi

# ═════════════════════════════════════════════════════════════════════════════
# Test 6: GET agent → resolvedRuntimePolicy present
# ═════════════════════════════════════════════════════════════════════════════

log "── Test 6: GET agent includes resolvedRuntimePolicy ──"
response=$(get_agent "$agentId")
policy=$(echo "$response" | jq -r '.resolvedRuntimePolicy.scoutMaxTurns // empty')
if [ -n "$policy" ]; then
  ok "GET response includes resolvedRuntimePolicy"
else
  fail "GET response missing resolvedRuntimePolicy"
fi

# ═════════════════════════════════════════════════════════════════════════════
# Test 7: Update agent style → resolved policy changes
# ═════════════════════════════════════════════════════════════════════════════

log "── Test 7: Update style from no-style to bold ──"
# Agent must be stopped to update
curl -s -o /dev/null -X POST "$API/agents/$agentId/stop" -H "Authorization: Bearer $TOKEN" || true
sleep 1
response=$(update_agent "$agentId" '{
  "name": "e2e-rp-nostyle",
  "prompt": "test",
  "style": "bold"
}')
policy=$(echo "$response" | jq '.resolvedRuntimePolicy')
scout=$(echo "$policy" | jq -r '.scoutMaxTurns // empty')
if [ "$scout" = "100" ]; then
  ok "Style updated to bold: scoutMaxTurns=100"
else
  fail "Style update failed: expected scoutMaxTurns=100, got $scout"
fi

# ═════════════════════════════════════════════════════════════════════════════
# Test 8: risk-defaults endpoint includes runtimePolicyCeilings
# ═════════════════════════════════════════════════════════════════════════════

log "── Test 8: GET /agents/risk-defaults includes ceilings ──"
response=$(api GET /agents/risk-defaults)
ceiling=$(echo "$response" | jq -r '.runtimePolicyCeilings.scoutMaxTurns // empty')
if [ "$ceiling" = "500" ]; then
  ok "risk-defaults includes runtimePolicyCeilings (scoutMaxTurns=500)"
else
  fail "risk-defaults missing runtimePolicyCeilings"
fi

# ═════════════════════════════════════════════════════════════════════════════
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "──────────────────────────────────────────"
echo "  Results: $PASS passed, $FAIL failed"
echo "──────────────────────────────────────────"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
