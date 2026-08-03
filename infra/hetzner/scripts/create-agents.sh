#!/usr/bin/env bash
# create-agents.sh — Create agents on a OpenAIdom instance.
#
# Creates:
#   - thyper            (Hyperliquid, contrarian, hybrid scanner-gated)
#   - t1inch            (1inch DEX, range, hybrid scanner-gated)
#   - tplaybook         (Hyperliquid, ICT swing trading, intelligence mode)
#   - security-auditor  (system security audit, 24h tick)
#
# Prerequisites:
#   - The API must be healthy.
#   - The env file must contain valid credentials and API_BASE_URL.
#
# Usage:
#   infra/hetzner/scripts/create-agents.sh --env-file <path> [--env <staging|production>]
#   infra/hetzner/scripts/create-agents.sh --env-file <path> --api-url <url>
#   infra/hetzner/scripts/create-agents.sh --env-file <path> --dry-run
#   infra/hetzner/scripts/create-agents.sh --help
#
# Environment:
#   HEROBIDS_ENV          Deployment environment: staging | production (default: production).
#   AGENT_PROVIDER        LLM provider (default: openrouter)
#   AGENT_LIGHT_MODEL     Fast/cheap model (default: deepseek/deepseek-v4-flash via OpenRouter)
#   AGENT_HEAVY_MODEL     Capable model for conviction (default: deepseek/deepseek-v4-pro via OpenRouter)
#   AGENT_TICK_INTERVAL_MS  Agent reasoning loop interval in ms (default: 86400000 = 24h)

set -euo pipefail

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# ─── Environment selection (minimal — this script does not use docker-compose) ─

HEROBIDS_ENV="${HEROBIDS_ENV:-production}"

# ─── Agent defaults ──────────────────────────────────────────────────────────

AGENT_PROVIDER="${AGENT_PROVIDER:-openrouter}"
AGENT_LIGHT_MODEL="${AGENT_LIGHT_MODEL:-deepseek/deepseek-v4-flash}"
AGENT_HEAVY_MODEL="${AGENT_HEAVY_MODEL:-deepseek/deepseek-v4-pro}"
AGENT_TICK_INTERVAL_MS="${AGENT_TICK_INTERVAL_MS:-86400000}"

# Security audit prompt loaded from docs (path overridable via env for remote execution)
SECURITY_AUDIT_PROMPT_FILE="${SECURITY_AUDIT_PROMPT_FILE:-${REPO_ROOT}/docs/skills/security-audit-prompt.md}"
if [[ ! -f "$SECURITY_AUDIT_PROMPT_FILE" ]]; then
  die "Security audit prompt not found: ${SECURITY_AUDIT_PROMPT_FILE}"
fi
SECURITY_AUDIT_PROMPT="$(<"$SECURITY_AUDIT_PROMPT_FILE")"

# ─── Trading agent definitions ───────────────────────────────────────────────

PLATFORM_ASSESSMENT_3H='{"enabled":true,"reviewIntervalMs":10800000}'

# thyper — Hyperliquid contrarian mean-reversion
THYPER_AGENT_NAME="thyper"
THYPER_AGENT_PROMPT="Scan Hyperliquid for overbought/oversold conditions. Use contrarian mean-reversion signals to enter positions against prevailing sentiment when extreme readings are detected. Submit long decisions on oversold bounces and short decisions on overbought rejections."

# t1inch — 1inch range-bound mean-reversion
T1INCH_AGENT_NAME="t1inch"
T1INCH_AGENT_PROMPT="Scan 1inch for tokens trading in well-defined ranges. Identify range support and resistance levels. Submit long decisions near support and short decisions near resistance. Use range-bound mean-reversion with tight stop-losses on range breaks."

# tplaybook — ICT swing trading
TPLAYBOOK_AGENT_NAME="tplaybook"
TPLAYBOOK_AGENT_PROMPT="Follow the ICT trading playbook. Use the ICT Bearish Swing and ICT Bullish Swing skills to identify high-probability swing trade setups. Execute only when daily bias aligns with the trade direction. Manage positions with structured stop-loss and profit-taking rules."

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
    --env)
      [[ -z "${2:-}" ]] && die "--env requires a value (staging or production)"
      HEROBIDS_ENV="$2"
      shift 2
      ;;
    --env=*)
      HEROBIDS_ENV="${1#*=}"
      shift
      ;;
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
  # Default: look for .env.ops.prod at repo root
  ENV_FILE="$REPO_ROOT/.env.ops.prod"
  if [[ ! -f "$ENV_FILE" ]]; then
    die "No --env-file specified and default ${ENV_FILE} not found.
  Create one:
    cp ${REPO_ROOT}/.env.ops.remote.example ${ENV_FILE}
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
require_var AUTH_EMAIL
require_var AUTH_PASSWORD

if [[ "$MISSING" -eq 1 ]]; then
  die "One or more required variables are missing. Check ${ENV_FILE}."
fi

log_ok "API:  ${API_BASE_URL}"
log_ok "User: ${AUTH_EMAIL}"

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

log_info "Logging in as ${AUTH_EMAIL} ..."

api_call POST /auth/login "$(jq -n \
  --arg email    "$AUTH_EMAIL" \
  --arg password "$AUTH_PASSWORD" \
  '{ email: $email, password: $password }')"

if [[ "$HTTP_STATUS" -eq 200 ]]; then
  AUTH_TOKEN="$(echo "$RESPONSE_BODY" | jq -r '.token')"
  log_ok "Logged in as ${AUTH_EMAIL}"
else
  log_error "Login failed (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
  die "Authentication failed. Make sure quick-setup-remote.sh has run first."
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Step 2 — Look up trading connections
# ═══════════════════════════════════════════════════════════════════════════════

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
  Run quick-setup-remote.sh first to provision Hyperliquid credentials."
fi

if [[ -z "$ONEINCH_CONNECTION_ID" || "$ONEINCH_CONNECTION_ID" == "null" ]]; then
  die "No connection found with label '1inch'.
  Run quick-setup-remote.sh first to provision 1inch credentials."
fi

log_ok "Found Hyperliquid connection: ${HYPERLIQUID_CONNECTION_ID}"
log_ok "Found 1inch connection: ${ONEINCH_CONNECTION_ID}"

# ═══════════════════════════════════════════════════════════════════════════════
# Step 3 — Look up skill IDs for tplaybook
# ═══════════════════════════════════════════════════════════════════════════════

log_section "Step 3: Look up skill IDs"

ICT_BEARISH_SKILL_ID=""
ICT_BULLISH_SKILL_ID=""

api_call GET /skills '?scope=selectable'
if [[ "$HTTP_STATUS" -eq 200 ]]; then
  ICT_BEARISH_SKILL_ID="$(echo "$RESPONSE_BODY" | jq -r --arg name "ICT Bearish Swing" '.skills[]? | select(.name == $name) | .id' | head -1)"
  ICT_BULLISH_SKILL_ID="$(echo "$RESPONSE_BODY" | jq -r --arg name "ICT Bullish Swing" '.skills[]? | select(.name == $name) | .id' | head -1)"
fi

if [[ -n "$ICT_BEARISH_SKILL_ID" && "$ICT_BEARISH_SKILL_ID" != "null" ]]; then
  log_ok "Found ICT Bearish Swing skill: ${ICT_BEARISH_SKILL_ID}"
else
  log_warn "ICT Bearish Swing skill not found — tplaybook will be created without skill bindings"
fi

if [[ -n "$ICT_BULLISH_SKILL_ID" && "$ICT_BULLISH_SKILL_ID" != "null" ]]; then
  log_ok "Found ICT Bullish Swing skill: ${ICT_BULLISH_SKILL_ID}"
else
  log_warn "ICT Bullish Swing skill not found — tplaybook will be created without skill bindings"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Agent payload builders
# ═══════════════════════════════════════════════════════════════════════════════

build_thyper_agent_payload() {
  local connection_id="$1"
  jq -n \
    --arg name "$THYPER_AGENT_NAME" \
    --arg prompt "$THYPER_AGENT_PROMPT" \
    --arg provider "$AGENT_PROVIDER" \
    --arg lightModel "$AGENT_LIGHT_MODEL" \
    --arg heavyModel "$AGENT_HEAVY_MODEL" \
    --arg capabilityMode "hybrid" \
    --arg hybridMode "scanner_gated" \
    --arg strategyPreset "contrarian" \
    --arg executionVenue "hyperliquid" \
    --arg authorizationMode "direct" \
    --argjson platformAssessment "$PLATFORM_ASSESSMENT_3H" \
    --arg connectionId "$connection_id" \
    --arg telegramChatId "${TELEGRAM_CHAT_ID:-}" \
    '{
      name: $name,
      prompt: $prompt,
      provider: $provider,
      lightModel: $lightModel,
      heavyModel: $heavyModel,
      skillIds: ["trading"],
      capabilityMode: $capabilityMode,
      hybridMode: $hybridMode,
      strategyPreset: $strategyPreset,
      executionVenue: $executionVenue,
      authorizationMode: $authorizationMode,
      platformAssessment: $platformAssessment,
      connectionIds: [$connectionId],
      executionDefaults: { mode: "shadow" },
      telegramChatId: $telegramChatId
    }'
}

build_t1inch_agent_payload() {
  local connection_id="$1"
  jq -n \
    --arg name "$T1INCH_AGENT_NAME" \
    --arg prompt "$T1INCH_AGENT_PROMPT" \
    --arg provider "$AGENT_PROVIDER" \
    --arg lightModel "$AGENT_LIGHT_MODEL" \
    --arg heavyModel "$AGENT_HEAVY_MODEL" \
    --arg capabilityMode "hybrid" \
    --arg hybridMode "scanner_gated" \
    --arg strategyPreset "range" \
    --arg executionVenue "1inch" \
    --arg authorizationMode "approval_required" \
    --argjson platformAssessment "$PLATFORM_ASSESSMENT_3H" \
    --arg connectionId "$connection_id" \
    --arg telegramChatId "${TELEGRAM_CHAT_ID:-}" \
    '{
      name: $name,
      prompt: $prompt,
      provider: $provider,
      lightModel: $lightModel,
      heavyModel: $heavyModel,
      skillIds: ["trading"],
      capabilityMode: $capabilityMode,
      hybridMode: $hybridMode,
      strategyPreset: $strategyPreset,
      executionVenue: $executionVenue,
      authorizationMode: $authorizationMode,
      platformAssessment: $platformAssessment,
      connectionIds: [$connectionId],
      executionDefaults: { mode: "shadow" },
      telegramChatId: $telegramChatId
    }'
}

build_tplaybook_agent_payload() {
  local connection_id="$1"
  local skill_id1="$2"
  local skill_id2="$3"
  if [[ -n "$skill_id1" && -n "$skill_id2" ]]; then
    jq -n \
      --arg name "$TPLAYBOOK_AGENT_NAME" \
      --arg prompt "$TPLAYBOOK_AGENT_PROMPT" \
      --arg provider "$AGENT_PROVIDER" \
      --arg lightModel "$AGENT_LIGHT_MODEL" \
      --arg heavyModel "$AGENT_HEAVY_MODEL" \
      --arg capabilityMode "intelligence" \
      --arg executionVenue "hyperliquid" \
      --arg authorizationMode "direct" \
      --arg connectionId "$connection_id" \
      --arg skillId1 "$skill_id1" \
      --arg skillId2 "$skill_id2" \
      --arg telegramChatId "${TELEGRAM_CHAT_ID:-}" \
      '{
        name: $name,
        prompt: $prompt,
        provider: $provider,
        lightModel: $lightModel,
        heavyModel: $heavyModel,
        capabilityMode: $capabilityMode,
        executionVenue: $executionVenue,
        authorizationMode: $authorizationMode,
        connectionIds: [$connectionId],
        skillIds: ["trading", $skillId1, $skillId2],
        executionDefaults: { mode: "shadow" },
        telegramChatId: $telegramChatId
      }'
  else
    jq -n \
      --arg name "$TPLAYBOOK_AGENT_NAME" \
      --arg prompt "$TPLAYBOOK_AGENT_PROMPT" \
      --arg provider "$AGENT_PROVIDER" \
      --arg lightModel "$AGENT_LIGHT_MODEL" \
      --arg heavyModel "$AGENT_HEAVY_MODEL" \
      --arg capabilityMode "intelligence" \
      --arg executionVenue "hyperliquid" \
      --arg authorizationMode "direct" \
      --arg connectionId "$connection_id" \
      --arg telegramChatId "${TELEGRAM_CHAT_ID:-}" \
      '{
        name: $name,
        prompt: $prompt,
        provider: $provider,
        lightModel: $lightModel,
        heavyModel: $heavyModel,
        capabilityMode: $capabilityMode,
        executionVenue: $executionVenue,
        authorizationMode: $authorizationMode,
        connectionIds: [$connectionId],
        skillIds: ["trading"],
        executionDefaults: { mode: "shadow" },
        telegramChatId: $telegramChatId
      }'
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Agent creation helper
# ═══════════════════════════════════════════════════════════════════════════════

create_agent() {
  local name="$1"
  local payload="$2"

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

# ═══════════════════════════════════════════════════════════════════════════════
# Step 4 — Create trading agents
# ═══════════════════════════════════════════════════════════════════════════════

THYPER_ID="$(create_agent "$THYPER_AGENT_NAME" "$(build_thyper_agent_payload "$HYPERLIQUID_CONNECTION_ID")")"
T1INCH_ID="$(create_agent "$T1INCH_AGENT_NAME" "$(build_t1inch_agent_payload "$ONEINCH_CONNECTION_ID")")"
TPLAYBOOK_ID="$(create_agent "$TPLAYBOOK_AGENT_NAME" "$(build_tplaybook_agent_payload "$HYPERLIQUID_CONNECTION_ID" "${ICT_BEARISH_SKILL_ID:-}" "${ICT_BULLISH_SKILL_ID:-}")")"

# ═══════════════════════════════════════════════════════════════════════════════
# Step 5 — Create security-auditor agent
# ═══════════════════════════════════════════════════════════════════════════════

SECURITY_AUDITOR_ID="$(create_agent "security-auditor" "$(jq -n \
    --arg name "security-auditor" \
    --arg prompt "$SECURITY_AUDIT_PROMPT" \
    --arg provider "$AGENT_PROVIDER" \
    --arg lightModel "$AGENT_LIGHT_MODEL" \
    --arg heavyModel "$AGENT_HEAVY_MODEL" \
    --arg tickIntervalMs "$AGENT_TICK_INTERVAL_MS" \
    '{
      name: $name,
      prompt: $prompt,
      provider: $provider,
      lightModel: $lightModel,
      heavyModel: $heavyModel,
      skillIds: ["web-access","programming","file-management","task-management"],
      tickIntervalMs: ($tickIntervalMs | tonumber),
      runtimePolicyOverrides: { maxHoldDurationMs: 0 }
    }')")"

# ═══════════════════════════════════════════════════════════════════════════════
# Step 6 — Summary
# ═══════════════════════════════════════════════════════════════════════════════

log_section "Agent creation summary"
log_ok "thyper           → id=${THYPER_ID}  connection=Hyperliquid (${HYPERLIQUID_CONNECTION_ID})"
log_ok "t1inch           → id=${T1INCH_ID}  connection=1inch (${ONEINCH_CONNECTION_ID})"
log_ok "tplaybook        → id=${TPLAYBOOK_ID}  connection=Hyperliquid (${HYPERLIQUID_CONNECTION_ID})"
log_ok "security-auditor → id=${SECURITY_AUDITOR_ID}  tick=24h (non-trading)"
log_info "All agents are in 'stopped' state. Start them via the API or UI when ready."
