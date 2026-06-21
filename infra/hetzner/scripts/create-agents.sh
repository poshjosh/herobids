#!/usr/bin/env bash
# create-agents.sh — Create trading agents on a HeroBids instance.
#
# Creates two agents:
#   - thyper   (Hyperliquid perpetuals, shadow mode)
#   - t1inch   (1inch DEX swaps, shadow mode)
#
# Prerequisites:
#   - The API must be healthy.
#   - quick-setup.prod.sh must have run first to provision trading bindings.
#   - The env file must contain valid credentials and API_BASE_URL.
#
# Usage:
#   infra/hetzner/scripts/create-agents.sh --env-file <path>
#   infra/hetzner/scripts/create-agents.sh --env-file <path> --api-url <url>
#   infra/hetzner/scripts/create-agents.sh --env-file <path> --dry-run
#   infra/hetzner/scripts/create-agents.sh --help
#
# Environment overrides (all optional — sensible production defaults):
#   AGENT_PROVIDER        LLM provider (default: deepseek)
#   AGENT_LIGHT_MODEL     Fast/cheap model (default: deepseek-v4-flash)
#   AGENT_HEAVY_MODEL     Capable model for conviction (default: deepseek-v4-pro)
#   AGENT_EXECUTION_MODE  paper | shadow | live (default: shadow)
#   AGENT_TICK_INTERVAL_MS  Agent reasoning loop interval in ms (default: 900000)
#   AGENT_CAPITAL         Starting capital (default: 1000)
#   AGENT_DAILY_LOSS_LIMIT  Daily loss limit (default: 100)
#   AGENT_MAX_SLIPPAGE_BPS  Max slippage in basis points (default: 25)
#   AGENT_PROMPT          Agent goal text (default: "Grow this portfolio aggressively")

set -euo pipefail

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# ─── Agent defaults (production) ─────────────────────────────────────────────

AGENT_PROVIDER="${AGENT_PROVIDER:-deepseek}"
AGENT_LIGHT_MODEL="${AGENT_LIGHT_MODEL:-deepseek-v4-flash}"
AGENT_HEAVY_MODEL="${AGENT_HEAVY_MODEL:-deepseek-v4-pro}"
AGENT_EXECUTION_MODE="${AGENT_EXECUTION_MODE:-shadow}"
AGENT_TICK_INTERVAL_MS="${AGENT_TICK_INTERVAL_MS:-900000}"
AGENT_CAPITAL="${AGENT_CAPITAL:-1000}"
AGENT_DAILY_LOSS_LIMIT="${AGENT_DAILY_LOSS_LIMIT:-100}"
AGENT_MAX_SLIPPAGE_BPS="${AGENT_MAX_SLIPPAGE_BPS:-25}"
AGENT_PROMPT="${AGENT_PROMPT:-Grow this portfolio aggressively}"

# ─── Logging ─────────────────────────────────────────────────────────────────

log_info()    { echo "[INFO]  $*"; }
log_ok()      { echo "[OK]    $*"; }
log_warn()    { echo "[WARN]  $*" >&2; }
log_error()   { echo "[ERROR] $*" >&2; }
log_section() { echo; echo "=== $* ==="; }

die() {
  log_error "$*"
  exit 1
}

# ─── Defaults ────────────────────────────────────────────────────────────────

ENV_FILE=""
API_URL=""
DRY_RUN=0

# ─── Parse arguments ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ -z "${2:-}" ]] && die "--env-file requires a path argument"
      ENV_FILE="$2"
      shift 2
      ;;
    --api-url)
      [[ -z "${2:-}" ]] && die "--api-url requires a URL argument"
      API_URL="$2"
      shift 2
      ;;
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

# ─── Resolve env file ────────────────────────────────────────────────────────

if [[ -z "$ENV_FILE" ]]; then
  # Default: look for .env.setup.prod next to quick-setup.prod.sh
  ENV_FILE="$REPO_ROOT/scripts/shell/ops/.env.setup.prod"
  if [[ ! -f "$ENV_FILE" ]]; then
    die "No --env-file specified and default ${ENV_FILE} not found.
  Create one:
    cp ${REPO_ROOT}/scripts/shell/ops/.env.setup.prod.example ${ENV_FILE}
    # edit and fill in values"
  fi
fi

if [[ ! -f "$ENV_FILE" ]]; then
  die "Environment file not found: ${ENV_FILE}"
fi

# ─── Load env file ───────────────────────────────────────────────────────────

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

log_info "Loaded: ${ENV_FILE}"

# ─── Resolve API URL ─────────────────────────────────────────────────────────

if [[ -n "$API_URL" ]]; then
  API_BASE_URL="$API_URL"
fi

API_BASE_URL="${API_BASE_URL:-}"
if [[ -z "$API_BASE_URL" ]]; then
  die "API_BASE_URL is not set. Provide it via --api-url or in the env file."
fi

# Strip trailing slash
API_BASE_URL="${API_BASE_URL%/}"

# ─── Validate required variables ─────────────────────────────────────────────

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
  die "One or more required variables are missing. Check ${ENV_FILE}."
fi

log_ok "API:  ${API_BASE_URL}"
log_ok "User: ${SETUP_EMAIL}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log_info "Dry-run mode: validation passed, skipping API calls"
  exit 0
fi

# ─── Dependency check ────────────────────────────────────────────────────────

for cmd in curl jq; do
  command -v "$cmd" &>/dev/null || die "'$cmd' is required but not installed."
done

# ─── API helpers ─────────────────────────────────────────────────────────────

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

# ═══════════════════════════════════════════════════════════════════════════════
# Step 1 — Authenticate
# ═══════════════════════════════════════════════════════════════════════════════

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
  die "Authentication failed. Make sure quick-setup.prod.sh has run first."
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Step 2 — Look up trading bindings
# ═══════════════════════════════════════════════════════════════════════════════

log_section "Step 2: Look up trading bindings"

api_call GET /capabilities/trading/bindings

if [[ "$HTTP_STATUS" -ne 200 ]]; then
  log_error "Failed to list trading bindings (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
  die "Binding lookup failed."
fi

HYPERLIQUID_BINDING_ID="$(echo "$RESPONSE_BODY" | jq -r '.bindings[] | select(.label == "Hyperliquid") | .bindingId' | head -1)"
ONEINCH_BINDING_ID="$(echo "$RESPONSE_BODY" | jq -r '.bindings[] | select(.label == "1inch") | .bindingId' | head -1)"

if [[ -z "$HYPERLIQUID_BINDING_ID" || "$HYPERLIQUID_BINDING_ID" == "null" ]]; then
  die "No trading binding found with label 'Hyperliquid'.
  Run quick-setup.prod.sh first to provision Hyperliquid credentials."
fi

if [[ -z "$ONEINCH_BINDING_ID" || "$ONEINCH_BINDING_ID" == "null" ]]; then
  die "No trading binding found with label '1inch'.
  Run quick-setup.prod.sh first to provision 1inch credentials."
fi

log_ok "Found Hyperliquid binding: ${HYPERLIQUID_BINDING_ID}"
log_ok "Found 1inch binding: ${ONEINCH_BINDING_ID}"

# ═══════════════════════════════════════════════════════════════════════════════
# Agent creation helper
# ═══════════════════════════════════════════════════════════════════════════════

build_agent_payload() {
  local name="$1"
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
      maxSlippageBps: $maxSlippageBps
    }'
}

bind_trading_capability() {
  local agent_id="$1"
  local binding_id="$2"
  local agent_name="$3"

  log_info "Binding trading capability for ${agent_name} (bindingId=${binding_id})..."

  api_call POST "/agents/${agent_id}/capabilities/trading/actions/bind" \
    "$(jq -n --arg bindingId "$binding_id" '{ bindingId: $bindingId }')"

  if [[ "$HTTP_STATUS" -eq 201 || "$HTTP_STATUS" -eq 200 ]]; then
    log_ok "Trading capability bound for ${agent_name}"
    return 0
  else
    log_error "Failed to bind trading capability for ${agent_name} (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
    return 1
  fi
}

create_and_bind_agent() {
  local name="$1"
  local binding_id="$2"

  log_section "Creating agent: ${name}"

  # Check if agent already exists (idempotent)
  api_call GET /agents
  if [[ "$HTTP_STATUS" -eq 200 ]]; then
    local existing_id
    existing_id="$(echo "$RESPONSE_BODY" | jq -r --arg name "$name" '.[] | select(.name == $name) | .id' | head -1)"
    if [[ -n "$existing_id" && "$existing_id" != "null" ]]; then
      log_info "Agent '${name}' already exists (id=${existing_id}) — binding trading capability"

      # Check if already bound
      api_call GET "/agents/${existing_id}/capabilities/trading/bindings"
      if [[ "$HTTP_STATUS" -eq 200 ]]; then
        local already_bound
        already_bound="$(echo "$RESPONSE_BODY" | jq -r --arg bid "$binding_id" '.bindings[] | select(.bindingId == $bid and .grantStatus == "active") | .bindingId' | head -1)"
        if [[ -n "$already_bound" && "$already_bound" != "null" ]]; then
          log_ok "Trading capability already bound for ${name}"
          echo "$existing_id"
          return 0
        fi
      fi

      bind_trading_capability "$existing_id" "$binding_id" "$name" || die "Failed to bind trading capability"
      echo "$existing_id"
      return 0
    fi
  fi

  # Create the agent
  local payload
  payload="$(build_agent_payload "$name")"

  api_call POST /agents "$payload"

  if [[ "$HTTP_STATUS" -ne 201 ]]; then
    log_error "Failed to create agent '${name}' (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
    die "Agent creation failed."
  fi

  local agent_id
  agent_id="$(echo "$RESPONSE_BODY" | jq -r '.id')"
  log_ok "Created agent '${name}' (id=${agent_id})"

  # Bind trading capability
  bind_trading_capability "$agent_id" "$binding_id" "$name" || die "Failed to bind trading capability"

  echo "$agent_id"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Step 3 — Create agents
# ═══════════════════════════════════════════════════════════════════════════════

THYPER_ID="$(create_and_bind_agent "thyper" "$HYPERLIQUID_BINDING_ID")"
T1INCH_ID="$(create_and_bind_agent "t1inch" "$ONEINCH_BINDING_ID")"

# ═══════════════════════════════════════════════════════════════════════════════
# Step 4 — Summary
# ═══════════════════════════════════════════════════════════════════════════════

log_section "Agent creation summary"
log_ok "thyper  → id=${THYPER_ID}  provider=${AGENT_PROVIDER}/${AGENT_LIGHT_MODEL}  binding=Hyperliquid (${HYPERLIQUID_BINDING_ID})"
log_ok "t1inch  → id=${T1INCH_ID}  provider=${AGENT_PROVIDER}/${AGENT_LIGHT_MODEL}  binding=1inch (${ONEINCH_BINDING_ID})"
log_info "Both agents are in 'stopped' state. Start them via the API or UI when ready."
