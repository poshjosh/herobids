#!/usr/bin/env bash
# start-stopped-agents.sh — Start every stopped agent of the logged-in user.
#
# Live-mode agents are skipped unless --include-live is passed, since they may
# hold open positions and starting them can trade.
#
# Usage:
#   scripts/shell/ops/start-stopped-agents.sh [--env dev|staging|prod] [--include-live] [--dry-run]
#
# Options:
#   --env <name>     Target environment (default: staging).
#   --include-live   Also start agents in live execution mode.
#   --dry-run        List the agents that would be started, without starting them.
#
# Required in .env.ops.<env> at the repo root:
#   AUTH_EMAIL       User email address
#   AUTH_PASSWORD    User password
#
# Optional:
#   API_BASE_URL     Direct URL, overrides the environment mapping
#
# Exit codes:
#   0  All stopped agents were started, or none needed starting
#   1  Setup, authentication, or listing failed
#   2  One or more agents could not be started

set -euo pipefail

HEROBIDS_ENV="staging"
INCLUDE_LIVE=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)           HEROBIDS_ENV="${2:-}"; shift 2 ;;
    --include-live)  INCLUDE_LIVE=true; shift ;;
    --dry-run)       DRY_RUN=true; shift ;;
    -h|--help)
      sed -n '2,/^set -/p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Error: Unknown argument: $1" >&2; exit 1 ;;
  esac
done

case "$HEROBIDS_ENV" in
  dev)     DEFAULT_API_URL="http://localhost:3000" ;;
  staging) DEFAULT_API_URL="https://staging.openaidom.com" ;;
  prod)    DEFAULT_API_URL="https://openaidom.com" ;;
  *)
    echo "Error: --env must be dev, staging, or prod. Got '${HEROBIDS_ENV}'" >&2
    exit 1 ;;
esac

API="${API_BASE_URL:-$DEFAULT_API_URL}"
API_ROOT="${API}/api"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.ops.${HEROBIDS_ENV}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: Env file not found: $ENV_FILE" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$ENV_FILE"

if [[ -z "${AUTH_EMAIL:-}" || -z "${AUTH_PASSWORD:-}" ]]; then
  echo "Error: AUTH_EMAIL and AUTH_PASSWORD must be set in $ENV_FILE" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required (brew install jq)" >&2
  exit 1
fi

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ---------------------------------------------------------------------------
# Authenticate
# ---------------------------------------------------------------------------

log "Authenticating as ${AUTH_EMAIL} on ${API_ROOT} ..."

login_payload="$(jq -n --arg email "$AUTH_EMAIL" --arg password "$AUTH_PASSWORD" '{email: $email, password: $password}')"
login_code="$(curl -s -o "$TMP_FILE" -w '%{http_code}' -X POST "${API_ROOT}/auth/login" \
  -H 'Content-Type: application/json' -d "$login_payload")" || {
  echo "Error: Could not reach ${API_ROOT}" >&2
  exit 1
}

if [[ "$login_code" != "200" ]]; then
  echo "Error: Login failed (HTTP ${login_code}): $(cat "$TMP_FILE")" >&2
  exit 1
fi

TOKEN="$(jq -r '.token // empty' "$TMP_FILE")"
if [[ -z "$TOKEN" ]]; then
  echo "Error: No token in login response" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# List stopped agents
# ---------------------------------------------------------------------------

log "Listing agents ..."

agents_code="$(curl -s -o "$TMP_FILE" -w '%{http_code}' "${API_ROOT}/agents" \
  -H "Authorization: Bearer ${TOKEN}")" || {
  echo "Error: Failed to list agents" >&2
  exit 1
}

if [[ "$agents_code" != "200" ]]; then
  echo "Error: Failed to list agents (HTTP ${agents_code}): $(cat "$TMP_FILE")" >&2
  exit 1
fi

if [[ "$INCLUDE_LIVE" == "true" ]]; then
  LIVE_FILTER='true'
else
  LIVE_FILTER='(.executionMode // "") != "live"'
fi

STOPPED_AGENTS="$(jq -r \
  ".[] | select(.status == \"stopped\") | select(${LIVE_FILTER}) | [.id, .name, (.executionMode // \"\")] | @tsv" \
  "$TMP_FILE")"

SKIPPED_LIVE="$(jq -r '[.[] | select(.status == "stopped" and (.executionMode // "") == "live")] | length' "$TMP_FILE")"
if [[ "$INCLUDE_LIVE" == "false" && "$SKIPPED_LIVE" -gt 0 ]]; then
  log "Skipping ${SKIPPED_LIVE} stopped live-mode agent(s). Pass --include-live to start them."
fi

if [[ -z "$STOPPED_AGENTS" ]]; then
  log "No stopped agents to start."
  exit 0
fi

COUNT="$(printf '%s\n' "$STOPPED_AGENTS" | wc -l | tr -d ' ')"
log "Found ${COUNT} stopped agent(s)."

# ---------------------------------------------------------------------------
# Start each agent
# ---------------------------------------------------------------------------

STARTED=0
FAILED=0

while IFS=$'\t' read -r agent_id agent_name agent_mode; do
  label="${agent_name} (${agent_id})"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  - would start ${label}${agent_mode:+ [${agent_mode}]}"
    continue
  fi

  http_code="$(curl -s -o "$TMP_FILE" -w '%{http_code}' -X POST "${API_ROOT}/agents/${agent_id}/start" \
    -H "Authorization: Bearer ${TOKEN}")" || http_code="000"

  if [[ "$http_code" =~ ^2[0-9][0-9]$ ]]; then
    echo "  ✓ started ${label}"
    STARTED=$((STARTED + 1))
  else
    echo "  ✗ ${label}: HTTP ${http_code} $(head -c 300 "$TMP_FILE")"
    FAILED=$((FAILED + 1))
  fi
done <<< "$STOPPED_AGENTS"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

if [[ "$DRY_RUN" == "true" ]]; then
  log "Dry run: ${COUNT} agent(s) would be started. Nothing was changed."
  exit 0
fi

log "Done. Started: ${STARTED}, failed: ${FAILED}."

if [[ "$FAILED" -gt 0 ]]; then
  exit 2
fi
