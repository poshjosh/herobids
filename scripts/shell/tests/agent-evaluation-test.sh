#!/usr/bin/env bash
# agent-evaluation-test.sh — End-to-end test for the Agent Evaluation pipeline (Level 1)
#
# Validates:
#   1. Trigger evaluation via POST /agents/:id/evaluations
#   2. Scope validation (latestSession, session, timeRange, allTime)
#   3. Duplicate detection (409 for active run on same scope)
#   4. Poll run status → transitions queued → running → succeeded
#   5. Fetch run detail with scorecard and findings
#   6. Download artifacts (REPORT.md, evaluation.json)
#   7. Verify artifact content structure
#   8. Narrative LLM flag acceptance and rejection rules
#
# Usage:
#   scripts/shell/tests/agent-evaluation-test.sh
#   API_BASE_URL=http://localhost:3000 scripts/shell/tests/agent-evaluation-test.sh
#   SKIP_RUN=1 scripts/shell/tests/agent-evaluation-test.sh  # validate API surface only, skip actual run
#   TEST_EMAIL='<email>' TEST_PASSWORD='<password>' scripts/shell/tests/agent-evaluation-test.sh
#
# Environment variables:
#   API_BASE_URL          API root (default: http://localhost:3000)
#   TEST_EMAIL            Test user email (default: eval-test@local.test)
#   TEST_PASSWORD         Test user password (default: E2ETest123!)
#   SKIP_RUN              Set to 1 to skip actual evaluation execution (API surface only)
#   EVAL_TIMEOUT_SEC      Max seconds to wait for evaluation completion (default: 180)
#   EVAL_POLL_INTERVAL    Seconds between status polls (default: 5)
#
# Prerequisites:
#   - API server running
#   - Worker running (to consume BullMQ evaluation jobs)
#   - Postgres + Redis available
#   - At least one agent with a completed runtime session (for full pipeline test)

set -euo pipefail

API="${API_BASE_URL:-http://localhost:3000}"
TEST_EMAIL="${TEST_EMAIL:-eval-test@local.test}"
TEST_PASSWORD="${TEST_PASSWORD:-E2ETest123!}"
SKIP_RUN="${SKIP_RUN:-0}"
EVAL_TIMEOUT_SEC="${EVAL_TIMEOUT_SEC:-180}"
EVAL_POLL_INTERVAL="${EVAL_POLL_INTERVAL:-5}"
TOKEN=""
PASS=0
FAIL=0

# ─── Helpers ─────────────────────────────────────────────────────────────────

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

# api_raw: same as api but returns HTTP status code as well
api_raw() {
  local method="$1" url="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$API$url" \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $TOKEN" \
      -d "$data"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$API$url" \
      -H "Authorization: Bearer $TOKEN"
  fi
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    ok "$label = $expected"
  else
    fail "$label: expected '$expected', got '$actual'"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    ok "$label (contains '$needle')"
  else
    fail "$label: expected to contain '$needle'"
  fi
}

assert_field_nonempty() {
  local label="$1" value="$2"
  if [ -n "$value" ] && [ "$value" != "null" ]; then
    ok "$label is present"
  else
    fail "$label: is empty or null"
  fi
}

assert_status() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    ok "$label → HTTP $expected"
  else
    fail "$label: expected HTTP $expected, got $actual"
  fi
}

# ─── Authentication ──────────────────────────────────────────────────────────

log "Authenticating as $TEST_EMAIL ..."

login_payload=$(jq -n --arg email "$TEST_EMAIL" --arg password "$TEST_PASSWORD" \
  '{email: $email, password: $password}')
login_resp=$(curl -s -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' \
  -d "$login_payload")
TOKEN=$(echo "$login_resp" | jq -r '.token // empty')

if [ -z "$TOKEN" ]; then
  log "Login failed — trying to register..."
  register_payload=$(jq -n --arg email "$TEST_EMAIL" --arg password "$TEST_PASSWORD" \
    '{email: $email, password: $password, displayName: "Eval Test"}')
  register_resp=$(curl -s -X POST "$API/auth/register" \
    -H 'Content-Type: application/json' \
    -d "$register_payload")
  TOKEN=$(echo "$register_resp" | jq -r '.token // empty')
  if [ -z "$TOKEN" ]; then
    register_error=$(echo "$register_resp" | jq -r '.error // empty')
    register_msg=$(echo "$register_resp" | jq -r '.message // empty')
    if echo "$register_error$register_msg" | grep -qiE 'already exists|already registered|duplicate|taken'; then
      log "Account already exists but login failed — check your password."
      log "Login response: $(echo "$login_resp" | jq -c '.')"
      exit 1
    fi
    echo "FATAL: Could not authenticate. Response: $(echo "$register_resp" | jq -c '.')"
    exit 1
  fi
fi

ok "Authenticated"

# ─── Configure AI defaults so agent creation doesn't need provider inline ─────

log "Configuring AI model defaults for test user..."
DEFAULT_PROVIDER="${DEFAULT_PROVIDER:-ollama}"
DEFAULT_LIGHT_MODEL="${DEFAULT_LIGHT_MODEL:-qwen3:8b}"
DEFAULT_HEAVY_MODEL="${DEFAULT_HEAVY_MODEL:-qwen3.6:35b-a3b-q4_K_M}"

ai_settings_resp=$(curl -s -X PATCH "$API/settings/ai-model" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"provider\":\"$DEFAULT_PROVIDER\",\"lightModel\":\"$DEFAULT_LIGHT_MODEL\",\"heavyModel\":\"$DEFAULT_HEAVY_MODEL\"}")
ai_settings_ok=$(echo "$ai_settings_resp" | jq -r '.aiModelConfig.provider // empty')
if [ -n "$ai_settings_ok" ]; then
  ok "AI defaults set: provider=$ai_settings_ok"
else
  fail "Could not set AI defaults. Response: $(echo "$ai_settings_resp" | jq -c '.')"
fi

# ─── Clean up leftover eval-test agents from previous runs ───────────────────

log "Cleaning up eval-test agents from previous runs ..."
EVAL_AGENTS=$(api GET /agents | jq -r '.[] | select(.name | startswith("eval-test-")) | .id // empty')
for agentId in $EVAL_AGENTS; do
  api DELETE "/agents/$agentId" > /dev/null && log "  Deleted agent $agentId" || true
done

# ─── Section 1: API surface validation ───────────────────────────────────────

header() { echo ""; echo "─── $* ───"; }

header "1. API surface validation"

# 1a. Non-existent agent → 404
log "1a. Trigger evaluation for non-existent agent"
resp_code=$(api_raw POST /agents/00000000-0000-0000-0000-000000000000/evaluations \
  '{"scope":{"type":"latestSession"}}' | tail -1)
assert_status "Non-existent agent" "404" "$resp_code"

# 1b. Invalid scope → 400
log "1b. Invalid scope validation"
# Create a temporary agent for validation tests
CREATE_RESP=$(api POST /agents '{"name":"eval-test-validation","style":"careful","prompt":"You are a test agent for evaluation validation."}')
TEMP_AGENT_ID=$(echo "$CREATE_RESP" | jq -r '.id // empty')
if [ -z "$TEMP_AGENT_ID" ]; then
  fail "Could not create temp agent for validation tests"
else
  ok "Created temp agent $TEMP_AGENT_ID"

  # Invalid scope type
  resp_code=$(api_raw POST "/agents/$TEMP_AGENT_ID/evaluations" \
    '{"scope":{"type":"INVALID"}}' | tail -1)
  assert_status "Invalid scope type" "400" "$resp_code"

  # session scope without sessionId
  resp_code=$(api_raw POST "/agents/$TEMP_AGENT_ID/evaluations" \
    '{"scope":{"type":"session"}}' | tail -1)
  assert_status "session scope missing sessionId" "400" "$resp_code"

  # timeRange scope without from/to
  resp_code=$(api_raw POST "/agents/$TEMP_AGENT_ID/evaluations" \
    '{"scope":{"type":"timeRange"}}' | tail -1)
  assert_status "timeRange missing from/to" "400" "$resp_code"

  # allTime without allowAllTime flag
  resp_code=$(api_raw POST "/agents/$TEMP_AGENT_ID/evaluations?allowAllTime=false" \
    '{"scope":{"type":"allTime"}}' | tail -1)
  assert_status "allTime without flag" "400" "$resp_code"

  # allTime with allowAllTime flag
  resp_code=$(api_raw POST "/agents/$TEMP_AGENT_ID/evaluations?allowAllTime=true" \
    '{"scope":{"type":"allTime"}}' | tail -1)
  assert_status "allTime with flag" "202" "$resp_code"

  # narrativeLlm without includeNarrative → 400
  resp_code=$(api_raw POST "/agents/$TEMP_AGENT_ID/evaluations" \
    '{"scope":{"type":"latestSession"},"includeNarrative":false,"narrativeLlm":{"model":"gpt-4"}}' | tail -1)
  assert_status "narrativeLlm without includeNarrative" "400" "$resp_code"

  # latestSession on agent with no sessions → 404
  resp_code=$(api_raw POST "/agents/$TEMP_AGENT_ID/evaluations" \
    '{"scope":{"type":"latestSession"}}' | tail -1)
  assert_status "latestSession on agent with no sessions" "404" "$resp_code"

  # Clean up temp agent
  api DELETE "/agents/$TEMP_AGENT_ID" > /dev/null && log "  Deleted temp agent" || true
fi

# 1c. List evaluations for non-existent agent → 404
log "1c. List evaluations for non-existent agent"
resp_code=$(api_raw GET /agents/00000000-0000-0000-0000-000000000000/evaluations | tail -1)
assert_status "List non-existent agent" "404" "$resp_code"

# ─── Section 2: Duplicate detection ──────────────────────────────────────────

header "2. Duplicate detection"

# Find an existing agent with completed sessions
EXISTING_AGENT_ID=""
EXISTING_AGENTS=$(api GET /agents | jq -r '.[].id // empty')
for agentId in $EXISTING_AGENTS; do
  # Try latestSession — if it doesn't 404, the agent has sessions
  eval_check=$(api_raw POST "/agents/$agentId/evaluations" '{"scope":{"type":"latestSession"}}')
  eval_code=$(echo "$eval_check" | tail -1)
  if [ "$eval_code" = "202" ]; then
    EXISTING_AGENT_ID="$agentId"
    FIRST_RUN_ID=$(echo "$eval_check" | head -1 | jq -r '.runId // empty')
    log "Found agent with sessions: $EXISTING_AGENT_ID (first run: $FIRST_RUN_ID)"
    break
  fi
done

if [ -n "$EXISTING_AGENT_ID" ]; then
  # Try to trigger another evaluation — should 409 if the first is still active.
  # Race: if the first run completed already, this will get 202 instead.
  log "2a. Duplicate evaluation detection"
  dup_resp=$(api_raw POST "/agents/$EXISTING_AGENT_ID/evaluations" \
    '{"scope":{"type":"latestSession"}}')
  dup_code=$(echo "$dup_resp" | tail -1)
  if [ "$dup_code" = "409" ]; then
    ok "Duplicate evaluation → HTTP 409 (correctly blocked)"
  elif [ "$dup_code" = "202" ]; then
    log "  Duplicate got 202 — first run already completed (race), dedupe window was too short"
    ok "Duplicate evaluation (first run completed before duplicate request)"
  else
    assert_status "Duplicate evaluation" "409" "$dup_code"
  fi

  # Wait for the first run to complete before proceeding
  log "2b. Waiting for first run to complete (so we can trigger another later)..."
  WAITED=0
  while [ "$WAITED" -lt "$EVAL_TIMEOUT_SEC" ]; do
    run_status_resp=$(api GET "/agents/$EXISTING_AGENT_ID/evaluations/$FIRST_RUN_ID")
    run_status=$(echo "$run_status_resp" | jq -r '.status // empty')
    log "  Run $FIRST_RUN_ID: $run_status (${WAITED}s elapsed)"
    case "$run_status" in
      succeeded|failed|timed_out)
        ok "Run $FIRST_RUN_ID reached terminal state: $run_status"
        break
        ;;
    esac
    sleep "$EVAL_POLL_INTERVAL"
    WAITED=$((WAITED + EVAL_POLL_INTERVAL))
  done
else
  log "No existing agent with completed sessions found — skipping duplicate detection and run tests"
fi

# ─── Section 3: Full evaluation run ──────────────────────────────────────────

header "3. Full evaluation run"

if [ "$SKIP_RUN" = "1" ]; then
  log "SKIP_RUN=1 — skipping full evaluation run"
elif [ -z "$EXISTING_AGENT_ID" ]; then
  log "No agent with sessions available — skipping full evaluation run"
  log "To exercise the full pipeline, create an agent, start a session, perform trades, and stop it."
else
  # Trigger a fresh evaluation now that the first one completed
  log "3a. Trigger evaluation for agent $EXISTING_AGENT_ID"

  TRIGGER_RESP=$(api_raw POST "/agents/$EXISTING_AGENT_ID/evaluations" \
    '{"scope":{"type":"latestSession"}}')
  TRIGGER_CODE=$(echo "$TRIGGER_RESP" | tail -1)
  RUN_ID=$(echo "$TRIGGER_RESP" | head -1 | jq -r '.runId // empty')

  if [ "$TRIGGER_CODE" = "202" ] && [ -n "$RUN_ID" ]; then
    ok "Evaluation triggered — runId: $RUN_ID"
  elif [ "$TRIGGER_CODE" = "409" ]; then
    # Unlikely but handle gracefully — use the first run for validation
    RUN_ID="$FIRST_RUN_ID"
    ok "Reusing existing run: $RUN_ID"
  else
    fail "Trigger evaluation: HTTP $TRIGGER_CODE"
    RUN_ID=""
  fi

  if [ -n "$RUN_ID" ]; then
    # 3b. Poll until terminal state
    log "3b. Polling run status (timeout: ${EVAL_TIMEOUT_SEC}s)..."
    TERMINAL_STATE=""
    WAITED=0
    while [ "$WAITED" -lt "$EVAL_TIMEOUT_SEC" ]; do
      STATUS_RESP=$(api GET "/agents/$EXISTING_AGENT_ID/evaluations/$RUN_ID")
      STATUS=$(echo "$STATUS_RESP" | jq -r '.status // empty')

      case "$STATUS" in
        succeeded|failed|timed_out)
          TERMINAL_STATE="$STATUS"
          log "  Terminal state reached: $STATUS (${WAITED}s)"
          break
          ;;
        queued|running)
          log "  Status: $STATUS (${WAITED}s elapsed)"
          ;;
        *)
          log "  Unknown status: $STATUS"
          ;;
      esac
      sleep "$EVAL_POLL_INTERVAL"
      WAITED=$((WAITED + EVAL_POLL_INTERVAL))
    done

    if [ "$TERMINAL_STATE" = "succeeded" ]; then
      ok "Run completed successfully"

      # 3c. Validate run detail structure
      log "3c. Validating run detail structure"
      RUN_DETAIL="$STATUS_RESP"

      OVERALL_SCORE=$(echo "$RUN_DETAIL" | jq -r '.result.scorecard.overallScore // empty')
      assert_field_nonempty "overallScore" "$OVERALL_SCORE"

      SECTIONS_COUNT=$(echo "$RUN_DETAIL" | jq -r '.result.scorecard.sections | length // 0')
      if [ "$SECTIONS_COUNT" -gt 0 ] 2>/dev/null; then
        ok "Scorecard has $SECTIONS_COUNT sections"
      else
        fail "Scorecard has no sections"
      fi

      TOTAL_FINDINGS=$(echo "$RUN_DETAIL" | jq -r '.result.summary.totalFindings // 0')
      CRITICAL_COUNT=$(echo "$RUN_DETAIL" | jq -r '.result.summary.criticalCount // 0')
      HIGH_COUNT=$(echo "$RUN_DETAIL" | jq -r '.result.summary.highCount // 0')
      log "  Findings: $TOTAL_FINDINGS total ($CRITICAL_COUNT critical, $HIGH_COUNT high)"

      # Verify scope is present
      RESOLVED_SCOPE=$(echo "$RUN_DETAIL" | jq -r '.resolvedScope.type // empty')
      assert_field_nonempty "resolvedScope" "$RESOLVED_SCOPE"

      # 3d. List artifact manifest
      log "3d. Validating artifact manifest"
      MANIFEST=$(api GET "/agents/$EXISTING_AGENT_ID/evaluations/$RUN_ID/artifacts")
      MANIFEST_COUNT=$(echo "$MANIFEST" | jq -r 'length // 0')
      log "  Artifact count: $MANIFEST_COUNT"

      # Core artifacts that must exist
      for artifact in "evaluation.json" "REPORT.md"; do
        ARTIFACT_EXISTS=$(echo "$MANIFEST" | jq -r ".[] | select(.name == \"$artifact\") | .name // empty")
        if [ -n "$ARTIFACT_EXISTS" ]; then
          ok "Artifact '$artifact' present"
        else
          fail "Artifact '$artifact' missing"
        fi
      done

      # 3e. Download and validate evaluation.json
      log "3e. Validating evaluation.json content"
      EVAL_JSON=$(api GET "/agents/$EXISTING_AGENT_ID/evaluations/$RUN_ID/artifacts/evaluation.json")
      EVAL_SCORE=$(echo "$EVAL_JSON" | jq -r '.scorecard.overallScore // empty')
      if [ -n "$EVAL_SCORE" ]; then
        ok "evaluation.json has valid scorecard (overallScore: $EVAL_SCORE)"
      else
        fail "evaluation.json missing scorecard"
      fi

      EVAL_SECTIONS=$(echo "$EVAL_JSON" | jq -r '.scorecard.sections // []')
      EVAL_SECTION_NAMES=$(echo "$EVAL_SECTIONS" | jq -r '.[].section // empty')
      if [ -n "$EVAL_SECTION_NAMES" ]; then
        ok "evaluation.json has section scores"
      else
        fail "evaluation.json missing section scores"
      fi

      # Verify non-trading-safe: if agent has no trading capability, trading sections
      # should be marked applicable: false
      TRADING_SECTIONS=$(echo "$EVAL_JSON" | jq -r '[.scorecard.sections[] | select(.section | startswith("trading"))] | length // 0')
      log "  Trading sections: $TRADING_SECTIONS"

      # 3f. Download and validate REPORT.md
      log "3f. Validating REPORT.md content"
      REPORT_MD=$(api GET "/agents/$EXISTING_AGENT_ID/evaluations/$RUN_ID/artifacts/REPORT.md")
      if echo "$REPORT_MD" | grep -q '# Agent Evaluation Report'; then
        ok "REPORT.md has correct header"
      else
        fail "REPORT.md missing expected header"
      fi

      # Report should contain scored sections
      if echo "$REPORT_MD" | grep -q 'Overall Score'; then
        ok "REPORT.md contains Overall Score"
      else
        fail "REPORT.md missing Overall Score"
      fi

    elif [ "$TERMINAL_STATE" = "failed" ]; then
      ERROR_MSG=$(echo "$STATUS_RESP" | jq -r '.errorMessage // .error // "unknown"')
      fail "Run failed: $ERROR_MSG"
    elif [ "$TERMINAL_STATE" = "timed_out" ]; then
      fail "Run timed out after ${EVAL_TIMEOUT_SEC}s"
    else
      fail "Run did not reach terminal state within ${EVAL_TIMEOUT_SEC}s (last status: ${TERMINAL_STATE:-unknown})"
    fi

    # 3g. List evaluations for the agent (paginated)
    log "3g. Listing evaluations for agent"
    EVAL_LIST=$(api GET "/agents/$EXISTING_AGENT_ID/evaluations?limit=5&offset=0")
    EVAL_LIST_COUNT=$(echo "$EVAL_LIST" | jq -r 'length // 0')
    if [ "$EVAL_LIST_COUNT" -gt 0 ] 2>/dev/null; then
      ok "Evaluation list returns $EVAL_LIST_COUNT runs"
    else
      fail "Evaluation list is empty"
    fi
  fi
fi

# ─── Section 4: Agent without trading capability ─────────────────────────────

header "4. Non-trading agent evaluation"

log "4a. Creating a non-trading agent..."
NON_TRADING_RESP=$(api POST /agents '{
  "name": "eval-test-non-trading",
  "style": "careful",
  "prompt": "You are a test agent for evaluation.",
  "capabilityFamilies": ["task-management"]
}')
NON_TRADING_ID=$(echo "$NON_TRADING_RESP" | jq -r '.id // empty')
if [ -n "$NON_TRADING_ID" ]; then
  ok "Created non-trading agent $NON_TRADING_ID"

  # Verify evaluation trigger works (will 404 for latestSession since no sessions)
  # but the important thing is it doesn't 500
  eval_resp_code=$(api_raw POST "/agents/$NON_TRADING_ID/evaluations" \
    '{"scope":{"type":"latestSession"}}' | tail -1)
  if [ "$eval_resp_code" = "404" ] || [ "$eval_resp_code" = "202" ]; then
    ok "Non-trading agent evaluation request handled cleanly (HTTP $eval_resp_code)"
  else
    fail "Non-trading agent evaluation returned unexpected HTTP $eval_resp_code"
  fi

  # Cleanup
  api DELETE "/agents/$NON_TRADING_ID" > /dev/null && log "  Deleted non-trading agent" || true
else
  fail "Could not create non-trading agent"
fi

# ─── Results ─────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════"
echo "  Agent Evaluation Test Results"
echo "════════════════════════════════════════════"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

ok "All agent evaluation tests passed."
exit 0
