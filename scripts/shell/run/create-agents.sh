#!/usr/bin/env bash
# create-agents.sh — Create trading agents via the REST API.
#
# Creates two agents:
#   - thyper   (Hyperliquid perpetuals, shadow mode)
#   - t1inch   (1inch DEX swaps, shadow mode)
#
# Prerequisites:
#   - The API must be healthy.
#   - quick-setup.sh must have run first to provision trading bindings.
#   - .env.ops.dev must contain valid credentials.
#
# Usage:
#   scripts/shell/run/create-agents.sh
#   scripts/shell/run/create-agents.sh --dry-run   # validate config, no API calls
#   scripts/shell/run/create-agents.sh --help

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.ops.dev"
DRY_RUN=0

# ---------------------------------------------------------------------------
# Agent definitions
# ---------------------------------------------------------------------------

AGENT_PROMPT="Grow this portfolio aggressively"
AGENT_PROVIDER="ollama"
AGENT_LIGHT_MODEL="qwen3:8b"
AGENT_HEAVY_MODEL="qwen3.6:35b-a3b-q4_K_M"
AGENT_EXECUTION_MODE="shadow"
AGENT_TICK_INTERVAL_MS="900000"   # 15 minutes
AGENT_CAPITAL="1000"
AGENT_DAILY_LOSS_LIMIT="100"
AGENT_MAX_SLIPPAGE_BPS="25"

# Security audit agent (non-trading)
SECURITY_AUDIT_NAME="security-auditor"
SECURITY_AUDIT_TICK_INTERVAL_MS="86400000"  # 24 hours
SECURITY_AUDIT_SKILL_IDS='["web-access","programming","file-management","task-management"]'
SECURITY_AUDIT_PROMPT_FILE="${REPO_ROOT}/docs/skills/security-audit-prompt.md"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log_info()    { echo "[INFO]  $*"; }
log_ok()      { echo "[OK]    $*"; }
log_warn()    { echo "[WARN]  $*" >&2; }
log_error()   { echo "[ERROR] $*" >&2; }
log_section() { echo; echo "=== $* ==="; }

die() {
  log_error "$*"
  exit 1
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      awk '/^[^#]/{exit} /^#/{sub(/^# ?/,""); print}' "$0"
      exit 0
      ;;
    *)
      die "Unknown argument: $1  (use --help for usage)"
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Load .env.ops.dev
# ---------------------------------------------------------------------------

if [[ ! -f "$ENV_FILE" ]]; then
  die "$ENV_FILE not found.
  Copy the example and fill in your values:
    cp .env.ops.dev.example .env.ops.dev"
fi

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

log_info "Loaded: $ENV_FILE"

# ---------------------------------------------------------------------------
# Validate required variables
# ---------------------------------------------------------------------------

MISSING=0

require_var() {
  local var="$1"
  if [[ -z "${!var:-}" ]]; then
    log_error "Required variable not set: $var"
    MISSING=1
  fi
}

require_var API_BASE_URL
require_var SETUP_EMAIL
require_var SETUP_PASSWORD

if [[ "$MISSING" -eq 1 ]]; then
  die "One or more required variables are missing. Check $ENV_FILE."
fi

log_ok "All required variables present"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log_info "Dry-run mode: validation passed, skipping API calls"
  exit 0
fi

# ---------------------------------------------------------------------------
# Dependency check
# ---------------------------------------------------------------------------

for cmd in curl jq; do
  command -v "$cmd" &>/dev/null || die "'$cmd' is required but not installed."
done

# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------

HTTP_STATUS=""
RESPONSE_BODY=""
AUTH_TOKEN=""

api_call() {
  local method="$1"
  local path="$2"
  local body="${3:-}"

  local tmp_file
  tmp_file="$(mktemp)"
  # Ensure temp file is removed on exit even if the script aborts
  trap 'rm -f "$tmp_file"' EXIT

  local curl_args=(
    --silent
    --output "$tmp_file"
    --write-out '%{http_code}'
    --request "$method"
    --url "${API_BASE_URL}${path}"
    --header 'Content-Type: application/json'
  )

  if [[ -n "${AUTH_TOKEN:-}" ]]; then
    curl_args+=(--header "Authorization: Bearer ${AUTH_TOKEN}")
  fi

  if [[ -n "$body" ]]; then
    curl_args+=(--data "$body")
  fi

  HTTP_STATUS="$(curl "${curl_args[@]}")"
  RESPONSE_BODY="$(cat "$tmp_file")"
  rm -f "$tmp_file"
  trap - EXIT
}

# ---------------------------------------------------------------------------
# Step 1 — Authenticate
# ---------------------------------------------------------------------------

log_section "Step 1: Authenticate"

log_info "Logging in as ${SETUP_EMAIL} ..."

api_call POST /auth/login "$(jq -n \
  --arg email    "$SETUP_EMAIL" \
  --arg password "$SETUP_PASSWORD" \
  '{ email: $email, password: $password }')"

if [[ "$HTTP_STATUS" -eq 200 ]]; then
  AUTH_TOKEN="$(echo "$RESPONSE_BODY" | jq -r '.token')"
  log_ok "Logged in as ${SETUP_EMAIL}"
else
  log_error "Login failed (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
  die "Authentication failed. Make sure quick-setup.sh has run first."
fi

# ---------------------------------------------------------------------------
# Step 2 — Look up trading connections
# ---------------------------------------------------------------------------

log_section "Step 2: Look up trading connections"

api_call GET /capabilities/trading/connections

if [[ "$HTTP_STATUS" -ne 200 ]]; then
  log_error "Failed to list trading connections (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
  die "Connection lookup failed."
fi

HYPERLIQUID_CONNECTION_ID="$(echo "$RESPONSE_BODY" | jq -r '.connections[] | select(.label == "Hyperliquid") | .connectionId' | head -1)"
ONEINCH_CONNECTION_ID="$(echo "$RESPONSE_BODY" | jq -r '.connections[] | select(.label == "1inch") | .connectionId' | head -1)"

if [[ -z "$HYPERLIQUID_CONNECTION_ID" || "$HYPERLIQUID_CONNECTION_ID" == "null" ]]; then
  die "No connection found with label 'Hyperliquid'.
  Run quick-setup.sh first to provision Hyperliquid credentials."
fi

if [[ -z "$ONEINCH_CONNECTION_ID" || "$ONEINCH_CONNECTION_ID" == "null" ]]; then
  die "No connection found with label '1inch'.
  Run quick-setup.sh first to provision 1inch credentials."
fi

log_ok "Found Hyperliquid connection: ${HYPERLIQUID_CONNECTION_ID}"
log_ok "Found 1inch connection: ${ONEINCH_CONNECTION_ID}"

# ---------------------------------------------------------------------------
# Agent creation helper
# ---------------------------------------------------------------------------

build_agent_payload() {
  local name="$1"
  local connection_id="$2"
  jq -n \
    --arg name "$name" \
    --arg prompt "$AGENT_PROMPT" \
    --arg provider "$AGENT_PROVIDER" \
    --arg lightModel "$AGENT_LIGHT_MODEL" \
    --arg heavyModel "$AGENT_HEAVY_MODEL" \
    --arg executionMode "$AGENT_EXECUTION_MODE" \
    --arg tickIntervalMs "$AGENT_TICK_INTERVAL_MS" \
    --arg capital "$AGENT_CAPITAL" \
    --arg dailyLossLimit "$AGENT_DAILY_LOSS_LIMIT" \
    --argjson maxSlippageBps "$AGENT_MAX_SLIPPAGE_BPS" \
    --arg connectionId "$connection_id" \
    '{
      name: $name,
      prompt: $prompt,
      provider: $provider,
      lightModel: $lightModel,
      heavyModel: $heavyModel,
      skillIds: ["trading"],
      executionMode: $executionMode,
      tickIntervalMs: ($tickIntervalMs | tonumber),
      capital: $capital,
      dailyLossLimit: $dailyLossLimit,
      maxSlippageBps: $maxSlippageBps,
      connectionIds: [$connectionId]
    }'
}

grant_trading_capability() {
  local agent_id="$1"
  local connection_id="$2"
  local agent_name="$3"

  log_info "Granting trading capability for ${agent_name} (connectionId=${connection_id})..."

  api_call PATCH "/agents/${agent_id}" \
    "$(jq -n --arg connectionId "$connection_id" '{ connectionIds: [$connectionId] }')"

  if [[ "$HTTP_STATUS" -eq 200 ]]; then
    log_ok "Trading capability granted for ${agent_name}"
    return 0
  else
    log_error "Failed to grant trading capability for ${agent_name} (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
    return 1
  fi
}

create_and_bind_agent() {
  local name="$1"
  local connection_id="$2"

  log_section "Creating agent: ${name}"

  # Check if agent already exists (idempotent)
  api_call GET /agents
  if [[ "$HTTP_STATUS" -eq 200 ]]; then
    local existing_id
    existing_id="$(echo "$RESPONSE_BODY" | jq -r --arg name "$name" '.[] | select(.name == $name) | .id' | head -1)"
    if [[ -n "$existing_id" && "$existing_id" != "null" ]]; then
      log_info "Agent '${name}' already exists (id=${existing_id}) — granting trading capability"

      # Check if already granted
      api_call GET "/agents/${existing_id}/capabilities/trading/connections"
      if [[ "$HTTP_STATUS" -eq 200 ]]; then
        local already_granted
        already_granted="$(echo "$RESPONSE_BODY" | jq -r --arg cid "$connection_id" '.connections[] | select(.connectionId == $cid and .grantStatus == "active") | .connectionId' | head -1)"
        if [[ -n "$already_granted" && "$already_granted" != "null" ]]; then
          log_ok "Trading capability already granted for ${name}"
          echo "$existing_id"
          return 0
        fi
      fi

      grant_trading_capability "$existing_id" "$connection_id" "$name" || die "Failed to grant trading capability"
      echo "$existing_id"
      return 0
    fi
  fi

  # Create the agent (connectionIds in payload auto-creates the capability grant)
  local payload
  payload="$(build_agent_payload "$name" "$connection_id")"

  api_call POST /agents "$payload"

  if [[ "$HTTP_STATUS" -ne 201 ]]; then
    log_error "Failed to create agent '${name}' (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
    die "Agent creation failed."
  fi

  local agent_id
  agent_id="$(echo "$RESPONSE_BODY" | jq -r '.id')"
  log_ok "Created agent '${name}' (id=${agent_id})"

  echo "$agent_id"
}

# ---------------------------------------------------------------------------
# Non-trading agent helper (no binding, no execution mode)
# ---------------------------------------------------------------------------

build_non_trading_agent_payload() {
  local name="$1"
  local prompt="$2"
  local skill_ids_json="$3"
  local tick_interval_ms="$4"
  jq -n \
    --arg name "$name" \
    --arg prompt "$prompt" \
    --arg provider "$AGENT_PROVIDER" \
    --arg lightModel "$AGENT_LIGHT_MODEL" \
    --arg heavyModel "$AGENT_HEAVY_MODEL" \
    --arg tickIntervalMs "$tick_interval_ms" \
    --argjson skillIds "$skill_ids_json" \
    '{
      name: $name,
      prompt: $prompt,
      provider: $provider,
      lightModel: $lightModel,
      heavyModel: $heavyModel,
      skillIds: $skillIds,
      tickIntervalMs: ($tickIntervalMs | tonumber),
      runtimePolicyOverrides: { maxHoldDurationMs: 0 }
    }'
}

create_non_trading_agent() {
  local name="$1"
  local prompt="$2"
  local skill_ids_json="$3"
  local tick_interval_ms="$4"

  log_section "Creating agent: ${name}"

  # Check if agent already exists (idempotent)
  api_call GET /agents
  if [[ "$HTTP_STATUS" -eq 200 ]]; then
    local existing_id
    existing_id="$(echo "$RESPONSE_BODY" | jq -r --arg name "$name" '.[] | select(.name == $name) | .id' | head -1)"
    if [[ -n "$existing_id" && "$existing_id" != "null" ]]; then
      log_info "Agent '${name}' already exists (id=${existing_id}) — skipping creation"
      echo "$existing_id"
      return 0
    fi
  fi

  local payload
  payload="$(build_non_trading_agent_payload "$name" "$prompt" "$skill_ids_json" "$tick_interval_ms")"

  api_call POST /agents "$payload"

  if [[ "$HTTP_STATUS" -ne 201 ]]; then
    log_error "Failed to create agent '${name}' (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
    die "Agent creation failed."
  fi

  local agent_id
  agent_id="$(echo "$RESPONSE_BODY" | jq -r '.id')"
  log_ok "Created agent '${name}' (id=${agent_id})"

  echo "$agent_id"
}

# ---------------------------------------------------------------------------
# Step 3 — Create trading agents
# ---------------------------------------------------------------------------

THYPER_ID="$(create_and_bind_agent "thyper" "$HYPERLIQUID_CONNECTION_ID")"
T1INCH_ID="$(create_and_bind_agent "t1inch" "$ONEINCH_CONNECTION_ID")"

# ---------------------------------------------------------------------------
# Step 4 — Create security-auditor agent
# ---------------------------------------------------------------------------

if [[ ! -f "$SECURITY_AUDIT_PROMPT_FILE" ]]; then
  log_warn "Security audit prompt not found at ${SECURITY_AUDIT_PROMPT_FILE} — skipping security-auditor"
  SECURITY_AUDITOR_ID="(skipped)"
else
  SECURITY_AUDIT_PROMPT="$(<"$SECURITY_AUDIT_PROMPT_FILE")"
  SECURITY_AUDITOR_ID="$(create_non_trading_agent "$SECURITY_AUDIT_NAME" "$SECURITY_AUDIT_PROMPT" "$SECURITY_AUDIT_SKILL_IDS" "$SECURITY_AUDIT_TICK_INTERVAL_MS")"
fi

# ---------------------------------------------------------------------------
# Step 5 — Summary
# ---------------------------------------------------------------------------

log_section "Agent creation summary"
log_ok "thyper           → id=${THYPER_ID}  connection=Hyperliquid (${HYPERLIQUID_CONNECTION_ID})"
log_ok "t1inch           → id=${T1INCH_ID}  connection=1inch (${ONEINCH_CONNECTION_ID})"
log_ok "security-auditor → id=${SECURITY_AUDITOR_ID}  tick=24h (non-trading)"
log_info "All agents are in 'stopped' state. Start them via the API or UI when ready."
