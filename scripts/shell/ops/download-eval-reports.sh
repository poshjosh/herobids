#!/opt/homebrew/bin/bash
#!/usr/bin/env bash
# download-eval-reports.sh — Trigger evaluations and download reports for all
# of a user's trading agents.
#
# Works against dev, staging, or production via HEROBIDS_ENV.
#
# Requires bash >= 4 (for associative arrays).
#
# Usage:
#   HEROBIDS_ENV=dev    scripts/shell/ops/download-eval-reports.sh
#   HEROBIDS_ENV=staging  scripts/shell/ops/download-eval-reports.sh
#   HEROBIDS_ENV=prod     scripts/shell/ops/download-eval-reports.sh
#
# Required in the env file (loaded automatically from .env.ops.{dev,staging,prod} at repo root):
#   AUTH_EMAIL       User email address
#   AUTH_PASSWORD    User password
#
# Optional overrides:
#   API_BASE_URL     Direct URL — overrides HEROBIDS_ENV mapping
#   POLL_INTERVAL_S  Seconds between status polls (default: 5)
#   MAX_WAIT_MIN     Max minutes to wait per evaluation (default: 30)
#   OUTPUT_DIR       Root output directory (default: .ignore/eval)
#
# Output structure:
#   <OUTPUT_DIR>/YYYY/MM/dd/<agent-name>-<runId>.zip
#
# Exit codes:
#   0  All evaluations completed successfully
#   1  Auth failure or unexpected error
#   2  One or more evaluations failed (partial success)

set -euo pipefail

# Bash >= 4 required for associative arrays (declare -A)
if (( ${BASH_VERSINFO[0]:-0} < 4 )); then
  echo "Error: This script requires bash >= 4. Current: ${BASH_VERSION:-unknown}" >&2
  echo "On macOS: brew install bash" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Environment resolution
# ---------------------------------------------------------------------------

HEROBIDS_ENV="${HEROBIDS_ENV:-}"

if [ -z "$HEROBIDS_ENV" ]; then
  echo "Error: HEROBIDS_ENV is required. Set to 'dev', 'staging', or 'prod'." >&2
  exit 1
fi

# Map environment to default URL (overridable via API_BASE_URL)
case "$HEROBIDS_ENV" in
  dev)   DEFAULT_API_URL="http://localhost:3000" ;;
  staging) DEFAULT_API_URL="https://staging.openaidom.com" ;;
  prod)    DEFAULT_API_URL="https://openaidom.com" ;;
  *)
    echo "Error: HEROBIDS_ENV must be 'dev', 'staging', or 'prod'. Got '$HEROBIDS_ENV'" >&2
    exit 1
    ;;
esac

API_BASE_URL="${API_BASE_URL:-$DEFAULT_API_URL}"

# Derive env file path from HEROBIDS_ENV
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.ops.${HEROBIDS_ENV}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: Env file not found: $ENV_FILE" >&2
  echo "Create it with: cp ${REPO_ROOT}/.env.ops.remote.example ${ENV_FILE}" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$ENV_FILE"

AUTH_EMAIL="${AUTH_EMAIL:-}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"

if [ -z "$AUTH_EMAIL" ] || [ -z "$AUTH_PASSWORD" ]; then
  echo "Error: AUTH_EMAIL and AUTH_PASSWORD must be set in $ENV_FILE" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

POLL_INTERVAL_S="${POLL_INTERVAL_S:-5}"
MAX_WAIT_MIN="${MAX_WAIT_MIN:-30}"
OUTPUT_DIR="${OUTPUT_DIR:-.ignore/eval}"
MAX_WAIT_S=$((MAX_WAIT_MIN * 60))

API="$API_BASE_URL"
TOKEN=""
FAIL_COUNT=0
OK_COUNT=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
ok()   { echo "  ✓ $*"; OK_COUNT=$((OK_COUNT + 1)); }
fail() { echo "  ✗ $*"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# Curl wrapper — returns body, sets HTTP_CODE
api() {
  local method="$1" url_path="$2" data="${3:-}"
  local full_url http_code body

  full_url="${API}${url_path}"
  if [ -n "$data" ]; then
    body=$(curl -s -w '\n%{http_code}' -X "$method" "$full_url" \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $TOKEN" \
      -d "$data" 2>/dev/null) || { fail "curl failed for $method $url_path"; return 1; }
  else
    body=$(curl -s -w '\n%{http_code}' -X "$method" "$full_url" \
      -H "Authorization: Bearer $TOKEN" \
      2>/dev/null) || { fail "curl failed for $method $url_path"; return 1; }
  fi

  HTTP_CODE=$(echo "$body" | tail -1)
  BODY=$(echo "$body" | sed '$d')
}

# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------

log "Authenticating as $AUTH_EMAIL ..."

login_resp=$(curl -s -w '\n%{http_code}' -X POST "${API}/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$AUTH_EMAIL\",\"password\":\"$AUTH_PASSWORD\"}" 2>/dev/null) || {
  fail "Failed to connect to $API"
  exit 1
}

login_code=$(echo "$login_resp" | tail -1)
login_body=$(echo "$login_resp" | sed '$d')

if [ "$login_code" != "200" ]; then
  echo "Error: Login failed (HTTP $login_code): $login_body" >&2
  exit 1
fi

TOKEN=$(echo "$login_body" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
  echo "Error: No token in login response: $login_body" >&2
  exit 1
fi

ok "Authenticated successfully"

# ---------------------------------------------------------------------------
# List agents
# ---------------------------------------------------------------------------

log "Listing agents ..."

agents_resp=$(curl -s -w '\n%{http_code}' -X GET "${API}/agents" \
  -H "Authorization: Bearer $TOKEN" 2>/dev/null) || {
  fail "Failed to list agents"
  exit 1
}

agents_code=$(echo "$agents_resp" | tail -1)
agents_body=$(echo "$agents_resp" | sed '$d')

if [ "$agents_code" != "200" ]; then
  echo "Error: Failed to list agents (HTTP $agents_code): $agents_body" >&2
  exit 1
fi

# Parse agent IDs and names from JSON array using grep/sed (no jq dependency)
# Format: id|name per line
agent_lines=$(echo "$agents_body" | grep -o '"id":"[^"]*"[^}]*' | while read -r line; do
  aid=$(echo "$line" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  # Try to get name from the same agent object — look for "name" in surrounding context
  aname=$(echo "$agents_body" | grep -o "\"name\":\"[^\"]*\"" | head -1 | cut -d'"' -f4)
  if [ -n "$aid" ]; then
    echo "${aid}|${aname:-unknown}"
  fi
done)

# Fallback: use python3 for reliable JSON parsing (available on macOS and most Linux)
agent_lines=$(python3 -c "
import json, sys
agents = json.loads('''$agents_body''')
for a in agents:
    aid = a.get('id', '')
    name = a.get('name', 'unknown')
    if aid:
        print(f'{aid}|{name}')
" 2>/dev/null) || agent_lines=$(echo "$agents_body" | python3 -c "
import json, sys
agents = json.loads(sys.stdin.read())
for a in agents:
    aid = a.get('id', '')
    name = a.get('name', 'unknown')
    if aid:
        print(f'{aid}|{name}')
" 2>/dev/null)

agent_count=$(echo "$agent_lines" | grep -c '|' || true)

if [ "$agent_count" -eq 0 ]; then
  log "No agents found for this user."
  exit 0
fi

log "Found $agent_count agent(s)"
echo ""

# ---------------------------------------------------------------------------
# Trigger evaluations (all at once)
# ---------------------------------------------------------------------------

log "Triggering evaluations (scope=latestSession) ..."

declare -A RUN_IDS
declare -A AGENT_NAMES

while IFS='|' read -r aid aname; do
  [ -z "$aid" ] && continue
  AGENT_NAMES["$aid"]="$aname"

  trigger_resp=$(curl -s -w '\n%{http_code}' -X POST "${API}/agents/${aid}/evaluations" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"scope":{"type":"latestSession"},"includeNarrative":true}' 2>/dev/null)

  trigger_code=$(echo "$trigger_resp" | tail -1)
  trigger_body=$(echo "$trigger_resp" | sed '$d')

  if [ "$trigger_code" = "202" ]; then
    run_id=$(echo "$trigger_body" | grep -o '"runId":"[^"]*"' | head -1 | cut -d'"' -f4)
    RUN_IDS["$aid"]="$run_id"
    log "  Triggered: $aname ($aid) → runId=$run_id"
  elif [ "$trigger_code" = "409" ]; then
    # Already running — try to get the existing run id from the response or skip
    log "  Skipped: $aname ($aid) — evaluation already running"
  else
    log "  Error triggering $aname ($aid): HTTP $trigger_code — $trigger_body"
    RUN_IDS["$aid"]=""
  fi
done <<< "$agent_lines"

echo ""

# ---------------------------------------------------------------------------
# Poll for completion
# ---------------------------------------------------------------------------

log "Polling for evaluation completion (interval=${POLL_INTERVAL_S}s, max=${MAX_WAIT_MIN}m) ..."

for aid in "${!RUN_IDS[@]}"; do
  run_id="${RUN_IDS[$aid]}"
  [ -z "$run_id" ] && continue
  aname="${AGENT_NAMES[$aid]}"

  elapsed=0
  status=""

  while [ "$elapsed" -lt "$MAX_WAIT_S" ]; do
    status_resp=$(curl -s -w '\n%{http_code}' -X GET "${API}/agents/${aid}/evaluations/${run_id}" \
      -H "Authorization: Bearer $TOKEN" 2>/dev/null)

    status_code=$(echo "$status_resp" | tail -1)
    status_body=$(echo "$status_resp" | sed '$d')

    if [ "$status_code" = "200" ]; then
      status=$(echo "$status_body" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
    else
      log "  ⚠ $aname: poll error (HTTP $status_code)"
      break
    fi

    case "$status" in
      succeeded)
        ok "$aname completed"
        break
        ;;
      failed|timed_out)
        fail "$aname finished with status: $status"
        break
        ;;
      queued|running)
        if [ $((elapsed % 30)) -eq 0 ]; then
          log "  ... $aname still running (${elapsed}s elapsed)"
        fi
        sleep "$POLL_INTERVAL_S"
        elapsed=$((elapsed + POLL_INTERVAL_S))
        ;;
      *)
        fail "$aname: unknown status '$status'"
        break
        ;;
    esac
  done

  if [ "$status" != "succeeded" ]; then
    log "  ⏱ $aname timed out after ${MAX_WAIT_MIN}m"
  fi
done

echo ""

# ---------------------------------------------------------------------------
# Download reports
# ---------------------------------------------------------------------------

TODAY=$(date '+%Y/%m/%d')
DATE_DIR="${OUTPUT_DIR}/${TODAY}"
mkdir -p "$DATE_DIR"

log "Downloading evaluation reports ..."

for aid in "${!RUN_IDS[@]}"; do
  run_id="${RUN_IDS[$aid]}"
  [ -z "$run_id" ] && continue
  aname="${AGENT_NAMES[$aid]}"
  status_resp=$(curl -s -w '\n%{http_code}' -X GET "${API}/agents/${aid}/evaluations/${run_id}" \
    -H "Authorization: Bearer $TOKEN" 2>/dev/null)
  status_body=$(echo "$status_resp" | sed '$d')
  status=$(echo "$status_body" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

  safe_name=$(echo "${aname}_${run_id}" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9_-')
  output_zip="${DATE_DIR}/${safe_name}.zip"

  if [ "$status" = "succeeded" ]; then
    dl_resp=$(curl -s -X GET "${API}/agents/${aid}/evaluations/${run_id}/artifacts/bundle" \
      -H "Authorization: Bearer $TOKEN" \
      -o "$output_zip" 2>/dev/null)

    dl_code=$?
    if [ $dl_code -eq 0 ] && [ -s "$output_zip" ]; then
      file_size=$(du -h "$output_zip" | cut -f1)
      ok "$aname → $output_zip ($file_size)"

      # Extract the zip alongside it
      extract_dir="${DATE_DIR}/${safe_name}"
      mkdir -p "$extract_dir"
      if unzip -q "$output_zip" -d "$extract_dir" 2>/dev/null; then
        rm "$output_zip"
        ok "$aname → $extract_dir/ (extracted)"
      else
        log "  ⚠ $aname: extraction failed (not a zip?)"
      fi
    else
      fail "$aname: download failed (curl exit=$dl_code)"
    fi
  else
    log "  ⊘ $aname: skipped (status=$status)"
  fi
done

echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

log "Done. Reports saved to $DATE_DIR/"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "  Completed: $OK_COUNT | Failed: $FAIL_COUNT"
  exit 2
else
  echo "  All $OK_COUNT evaluation(s) completed successfully."
  exit 0
fi
