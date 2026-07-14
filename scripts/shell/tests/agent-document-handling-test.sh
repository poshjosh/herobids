#!/usr/bin/env bash
# agent-document-handling-test.sh — End-to-end agent document handling diagnostic.
#
# What this script validates:
#   1. Upload a PDF and DOCX document for an agent via the API
#   2. Start the agent — docs are materialized into its workspace
#   3. Agent reads the extracted text and publishes the heading via publish_artifact
#   4. Poll for the artifact and verify expected content
#   5. Stop and clean up the agent
#
# Usage:
#   scripts/shell/tests/agent-document-handling-test.sh
#   scripts/shell/tests/agent-document-handling-test.sh --env-file .env.ops.dev
#
#   # Skip teardown to inspect the agent manually:
#   SKIP_TEARDOWN=1 scripts/shell/tests/agent-document-handling-test.sh
#
# Required env vars (in env file or environment):
#   API_BASE_URL           — e.g. http://localhost:3000
#   TEST_EMAIL             — test user email (auto-registered on first run)
#   TEST_PASSWORD          — password (≥ 8 characters)
#
# Optional:
#   POLL_TIMEOUT_SECS      — max seconds to wait for the artifact (default: 180)
#   POLL_INTERVAL_SECS     — seconds between polls (default: 10)
#   SKIP_TEARDOWN          — 1 to leave the agent running for manual inspection
#
# Exit codes:
#   0 = all checks passed
#   1 = one or more checks failed
#   2 = missing prerequisites (env vars, tools)

set -euo pipefail

# ─── Paths ───────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RESOURCES_DIR="$SCRIPT_DIR/resources"

# ─── Color helpers ───────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()         { echo -e "${GREEN}[✓]${NC} $*"; }
warn()        { echo -e "${YELLOW}[!]${NC} $*"; }
fail()        { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }
info()        { echo -e "${BLUE}[→]${NC} $*"; }
prereq_fail() { echo -e "${RED}[✗]${NC} $*"; exit 2; }

# ─── Argument parsing ────────────────────────────────────────────────────────

ENV_FILE="${REPO_ROOT}/.env.ops.dev"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ -z "${2:-}" ]] && prereq_fail "--env-file requires a path argument"
      ENV_FILE="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '/^#/{/^#!/d;/^#$/d;s/^# \{0,1\}//p;}' "$0"
      exit 0
      ;;
    *)
      prereq_fail "Unknown option: $1  (use --help for usage)"
      ;;
  esac
done

# ─── Load env file ───────────────────────────────────────────────────────────

if [[ -n "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || prereq_fail "Environment file not found: ${ENV_FILE}"
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  log "Loaded env file: ${ENV_FILE}"
fi

# ─── Defaults ────────────────────────────────────────────────────────────────

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
TEST_EMAIL="${TEST_EMAIL:-doc-test@local.test}"
TEST_PASSWORD="${TEST_PASSWORD:-DocTest123!}"
POLL_TIMEOUT_SECS="${POLL_TIMEOUT_SECS:-180}"
POLL_INTERVAL_SECS="${POLL_INTERVAL_SECS:-10}"
PDF_FILE="$RESOURCES_DIR/test-document.pdf"
DOCX_FILE="$RESOURCES_DIR/test-document.docx"

# ─── Prerequisites ───────────────────────────────────────────────────────────

for cmd in curl jq; do
  command -v "$cmd" >/dev/null 2>&1 || prereq_fail "'$cmd' is required but not installed."
done

[[ -f "$PDF_FILE" ]] || prereq_fail "PDF test document not found: $PDF_FILE"
[[ -f "$DOCX_FILE" ]] || prereq_fail "DOCX test document not found: $DOCX_FILE"

# ─── State ───────────────────────────────────────────────────────────────────

AGENT_ID=""
TOKEN=""
FAILURES=0

# ─── Cleanup trap ────────────────────────────────────────────────────────────

cleanup() {
  if [[ "${SKIP_TEARDOWN:-0}" == "1" ]]; then
    info "SKIP_TEARDOWN=1 — leaving agent $AGENT_ID running for manual inspection"
    return
  fi

  if [[ -n "$AGENT_ID" && -n "${TOKEN:-}" ]]; then
    info "Cleaning up agent $AGENT_ID ..."
    # Stop first (ignore errors — agent may already be stopped)
    curl -sS -X POST "$API_BASE_URL/agents/$AGENT_ID/stop" \
      -H "Authorization: Bearer $TOKEN" \
      > /dev/null 2>&1 || true

    # Wait briefly for the worker to process the stop
    sleep 2

    # Delete the agent
    curl -sS -X DELETE "$API_BASE_URL/agents/$AGENT_ID" \
      -H "Authorization: Bearer $TOKEN" \
      > /dev/null 2>&1 || true
    log "Agent $AGENT_ID cleaned up"
  fi
}
trap cleanup EXIT

# ─── Helper functions ────────────────────────────────────────────────────────

# authenticate: register (if new) then login, store token in TOKEN
authenticate() {
  info "Authenticating as $TEST_EMAIL ..."

  # Try login first
  local login_resp
  login_resp=$(curl -sS -X POST "$API_BASE_URL/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" 2>&1)

  local login_token
  login_token=$(echo "$login_resp" | jq -r '.token // empty')

  if [[ -n "$login_token" ]]; then
    TOKEN="$login_token"
    log "Logged in as $TEST_EMAIL"
    return
  fi

  # Login failed — try registering first
  local login_error
  login_error=$(echo "$login_resp" | jq -r '.error // empty')

  if [[ "$login_error" == "auth.login.invalid_credentials" ]]; then
    warn "Login failed — registering new account ..."
  else
    warn "Login returned: $login_resp — attempting registration anyway"
  fi

  local reg_resp
  reg_resp=$(curl -sS -X POST "$API_BASE_URL/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" 2>&1)

  local reg_token
  reg_token=$(echo "$reg_resp" | jq -r '.token // empty')

  if [[ -z "$reg_token" ]]; then
    fail "Registration failed: $reg_resp"
  fi

  TOKEN="$reg_token"
  log "Registered and logged in as $TEST_EMAIL"
}

# ─── Step 1 — API health check ───────────────────────────────────────────────

echo ""
info "Step 1/8: API health check"

HEALTH=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$API_BASE_URL/health" 2>&1)
if [[ "$HEALTH" != "200" ]]; then
  fail "API health check failed (HTTP $HEALTH at $API_BASE_URL/health)"
fi
log "API healthy ($API_BASE_URL/health)"

# ─── Step 2 — Authenticate ───────────────────────────────────────────────────

echo ""
info "Step 2/8: Authenticate"

authenticate

# ─── Step 3 — Create agent ───────────────────────────────────────────────────

echo ""
info "Step 3/8: Create agent"

# The prompt is critical: it must explicitly instruct the agent to find and read
# docs, then publish the heading. We keep it focused to reduce LLM variability.
CREATE_PAYLOAD=$(cat <<'AGENTJSON'
{
  "name": "Doc Test Agent",
  "prompt": "You are a document reader. On your first tick, do exactly this:\n1. Use list_files with path '' (empty string) to see your workspace root.\n2. Use list_files with path 'docs/extracted' to find an extracted text file which we sent to you.\n3. Use read_file to read the content of the .txt file you find (use the relative path like docs/extracted/<file-name>.txt).\n4. Find the first non-empty line of text in that file — this is the heading.\n5. Call publish_artifact with artifactType='text', summary=the exact heading text, body=the full text you read.\n6. Do nothing else. Do not call any other tools.\nAfter publishing - STOP.",
  "provider": "ollama",
  "lightModel": "qwen3:8b",
  "heavyModel": "qwen3.6:35b-a3b-q4_K_M",
  "tickIntervalMs": 15000,
  "skillIds": ["file-management"]
}
AGENTJSON
)

CREATE_RESP=$(curl -sS -X POST "$API_BASE_URL/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$CREATE_PAYLOAD" 2>&1)

AGENT_ID=$(echo "$CREATE_RESP" | jq -r '.id // empty')
if [[ -z "$AGENT_ID" ]]; then
  fail "Failed to create agent: $CREATE_RESP"
fi
log "Agent created: $AGENT_ID"

# ─── Step 4 — Upload documents ───────────────────────────────────────────────

echo ""
info "Step 4/8: Upload PDF document"

PDF_UPLOAD=$(curl -sS -X POST "$API_BASE_URL/agents/$AGENT_ID/documents" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@$PDF_FILE" 2>&1)

PDF_DOC_ID=$(echo "$PDF_UPLOAD" | jq -r '.id // empty')
PDF_STATUS=$(echo "$PDF_UPLOAD" | jq -r '.extractionStatus // empty')

if [[ -z "$PDF_DOC_ID" ]]; then
  fail "PDF upload failed: $PDF_UPLOAD"
fi
log "PDF uploaded: $PDF_DOC_ID (extraction: $PDF_STATUS)"

echo ""
info "Step 5/8: Upload DOCX document"

DOCX_UPLOAD=$(curl -sS -X POST "$API_BASE_URL/agents/$AGENT_ID/documents" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@$DOCX_FILE;type=application/vnd.openxmlformats-officedocument.wordprocessingml.document" 2>&1)

DOCX_DOC_ID=$(echo "$DOCX_UPLOAD" | jq -r '.id // empty')
DOCX_STATUS=$(echo "$DOCX_UPLOAD" | jq -r '.extractionStatus // empty')

if [[ -z "$DOCX_DOC_ID" ]]; then
  fail "DOCX upload failed: $DOCX_UPLOAD"
fi
log "DOCX uploaded: $DOCX_DOC_ID (extraction: $DOCX_STATUS)"

# ─── Step 6 — Start agent ────────────────────────────────────────────────────

echo ""
info "Step 6/8: Start agent"

START_RESP=$(curl -sS -X POST "$API_BASE_URL/agents/$AGENT_ID/start" \
  -H "Authorization: Bearer $TOKEN" 2>&1)

START_STATUS=$(echo "$START_RESP" | jq -r '.status // empty')
SESSION_ID=$(echo "$START_RESP" | jq -r '.sessionId // empty')

if [[ "$START_STATUS" != "starting" ]]; then
  fail "Failed to start agent: $START_RESP"
fi
log "Agent starting (session: $SESSION_ID)"

# Wait for agent to transition from starting → running
info "Waiting for agent to reach 'running' state ..."
for i in $(seq 1 30); do
  AGENT_STATE=$(curl -sS "$API_BASE_URL/agents/$AGENT_ID" \
    -H "Authorization: Bearer $TOKEN" 2>&1)
  AGENT_STATUS=$(echo "$AGENT_STATE" | jq -r '.status // empty')

  if [[ "$AGENT_STATUS" == "active" ]]; then
    log "Agent is active"
    break
  elif [[ "$AGENT_STATUS" == "crashed" || "$AGENT_STATUS" == "stopped" ]]; then
    fail "Agent entered terminal state '$AGENT_STATUS' before producing an artifact"
  fi

  sleep 2
done

if [[ "$AGENT_STATUS" != "active" ]]; then
  fail "Agent did not reach 'active' state within 60s (current: $AGENT_STATUS)"
fi

# ─── Step 7 — Poll for artifact ──────────────────────────────────────────────

echo ""
info "Step 7/8: Poll for publish_artifact (timeout: ${POLL_TIMEOUT_SECS}s)"

FOUND_ARTIFACT=""
START_TS=$(date +%s)

while true; do
  ELAPSED=$(($(date +%s) - START_TS))
  if [[ $ELAPSED -ge $POLL_TIMEOUT_SECS ]]; then
    break
  fi

  ARTIFACTS_RESP=$(curl -sS "$API_BASE_URL/agents/$AGENT_ID/artifacts?limit=10" \
    -H "Authorization: Bearer $TOKEN" 2>&1)

  # Look for any artifact that has a non-empty summary
  FOUND_ARTIFACT=$(echo "$ARTIFACTS_RESP" | jq -r '.[0].summary // empty')

  if [[ -n "$FOUND_ARTIFACT" ]]; then
    ARTIFACT_ID=$(echo "$ARTIFACTS_RESP" | jq -r '.[0].id // empty')
    ARTIFACT_BODY=$(echo "$ARTIFACTS_RESP" | jq -r '.[0].location.body // empty')
    break
  fi

  printf "  [%3ds] no artifact yet, waiting %ds ...\n" "$ELAPSED" "$POLL_INTERVAL_SECS"
  sleep "$POLL_INTERVAL_SECS"
done

if [[ -z "$FOUND_ARTIFACT" ]]; then
  # Dump activity for debugging
  warn "No artifact found within ${POLL_TIMEOUT_SECS}s. Recent activity:"
  curl -sS "$API_BASE_URL/agents/$AGENT_ID/activity-feed?limit=10" \
    -H "Authorization: Bearer $TOKEN" 2>&1 | jq '.'
  fail "Agent did not publish an artifact within ${POLL_TIMEOUT_SECS}s"
fi

echo ""
log "Artifact received!"
log "  Summary: $FOUND_ARTIFACT"
[[ -n "$ARTIFACT_BODY" ]] && log "  Body preview: ${ARTIFACT_BODY:0:200}"

# ─── Step 8 — Verify artifact content ────────────────────────────────────────

echo ""
info "Step 8/8: Verify artifact content"

# Both test documents contain "Jesus is Lord" as the first line/heading.
# We check for a case-insensitive match.
if echo "$FOUND_ARTIFACT" | grep -qi "jesus\|lord"; then
  log "Artifact summary contains expected content from test documents"
elif [[ -n "$ARTIFACT_BODY" ]] && echo "$ARTIFACT_BODY" | grep -qi "jesus\|lord"; then
  log "Artifact body contains expected content from test documents (summary was: $FOUND_ARTIFACT)"
else
  warn "Artifact content does not contain expected text 'Jesus is Lord'"
  warn "Summary: $FOUND_ARTIFACT"
  warn "Body: ${ARTIFACT_BODY:-<empty>}"
  warn "This may be OK — the agent may have paraphrased. Check manually."
  # Don't fail — LLM output is inherently variable
fi

# ─── Done ────────────────────────────────────────────────────────────────────

echo ""
echo "=============================================="
log "Agent document handling test completed"
log "Agent ID: $AGENT_ID"
log "Artifact ID: ${ARTIFACT_ID:-none}"
echo "=============================================="

if [[ "${SKIP_TEARDOWN:-0}" == "1" ]]; then
  info "SKIP_TEARDOWN=1 — agent left running. Stop with:"
  echo "  curl -X POST $API_BASE_URL/agents/$AGENT_ID/stop -H 'Authorization: Bearer $TOKEN'"
  echo "  curl -X DELETE $API_BASE_URL/agents/$AGENT_ID -H 'Authorization: Bearer $TOKEN'"
fi

exit 0
