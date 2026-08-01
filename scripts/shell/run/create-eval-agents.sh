#!/usr/bin/env bash
# create-eval-agents.sh — Create 6 evaluation agents (one per strategy preset).
#
# Creates agents for calibration/evaluation:
#   mo-day   (momentum)
#   mo-pos   (momentum-position)
#   range    (range)
#   swing    (swing)
#   scalper  (scalper)
#   cont     (contrarian)
#
# Prerequisites:
#   - The API must be healthy.
#   - quick-setup.sh must have run first to provision a Hyperliquid connection.
#   - The appropriate .env.ops.* file must exist with valid credentials.
#
# Usage:
#   scripts/shell/run/create-eval-agents.sh [--env dev|staging|production]
#   scripts/shell/run/create-eval-agents.sh --dry-run
#   scripts/shell/run/create-eval-agents.sh --help
#
# Environment overrides:
#   AGENT_PROVIDER         LLM provider (dev: ollama, non-dev: openrouter)
#   AGENT_LIGHT_MODEL      Scout model (dev: qwen3:8b, non-dev: deepseek/deepseek-v4-flash)
#   AGENT_HEAVY_MODEL      Judge model (dev: qwen3.6:35b-a3b-q4_K_M, non-dev: deepseek/deepseek-v4-pro)
#   SCOUT_REASONING        Scout reasoning level (non-dev only, default: medium)
#   JUDGE_REASONING        Judge reasoning level (non-dev only, default: high)

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DRY_RUN=0
TARGET_ENV="dev"

# ---------------------------------------------------------------------------
# Agent definitions — shared across all 6 eval agents
# ---------------------------------------------------------------------------

AGENT_PROMPT="Grow this portfolio aggressively"
AGENT_EXECUTION_MODE="shadow"
AGENT_CAPITAL="1000"
AGENT_TELEGRAM_CHAT_ID="6846862012"
AGENT_SKILL_IDS='["trading"]'

# Wake preferences — all notices enabled
#   watch_threshold  → Price alerts
#   discovery_delta  → Newly trending tokens
#   regime_change    → Market regime shifts
AGENT_WAKE_PREFERENCES='{"subscribedSources":["watch_threshold","discovery_delta","regime_change"]}'

# ---------------------------------------------------------------------------
# Model defaults — env-specific
# ---------------------------------------------------------------------------

# Dev defaults match the existing create-agents.sh Ollama setup.
DEFAULT_DEV_PROVIDER="ollama"
DEFAULT_DEV_LIGHT_MODEL="qwen3:8b"
DEFAULT_DEV_HEAVY_MODEL="qwen3.6:35b-a3b-q4_K_M"

# Non-dev defaults use OpenRouter-qualified DeepSeek models
# (consistent with infra/hetzner/scripts/create-agents.sh and config/staging.yaml).
DEFAULT_NONDEV_PROVIDER="openrouter"
DEFAULT_NONDEV_LIGHT_MODEL="deepseek/deepseek-v4-flash"
DEFAULT_NONDEV_HEAVY_MODEL="deepseek/deepseek-v4-pro"
DEFAULT_SCOUT_REASONING="medium"
DEFAULT_JUDGE_REASONING="high"

# ---------------------------------------------------------------------------
# Agent name → strategy preset mapping (order matters for idempotent creation)
# ---------------------------------------------------------------------------

# Ordered list so iteration is deterministic
AGENT_NAMES=("mo-day" "mo-pos" "range" "swing" "scalper" "cont")

preset_for() {
  case "$1" in
    mo-day) echo "momentum" ;;
    mo-pos) echo "momentum-position" ;;
    range)  echo "range" ;;
    swing)  echo "swing" ;;
    scalper) echo "scalper" ;;
    cont)   echo "contrarian" ;;
    *)      die "Unknown agent name: $1" ;;
  esac
}

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
    --env)
      [[ -z "${2:-}" ]] && die "--env requires a value (dev, staging, or production)"
      TARGET_ENV="$2"
      shift 2
      ;;
    --env=*)
      TARGET_ENV="${1#*=}"
      shift
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

# Normalise env name
case "$TARGET_ENV" in
  dev|development) TARGET_ENV="dev" ;;
  staging)         TARGET_ENV="staging" ;;
  production|prod) TARGET_ENV="production" ;;
  *)
    die "Unknown environment: ${TARGET_ENV}. Valid values: dev, staging, production"
    ;;
esac

# ---------------------------------------------------------------------------
# Resolve env-specific defaults
# ---------------------------------------------------------------------------

IS_DEV=0
if [[ "$TARGET_ENV" == "dev" ]]; then
  IS_DEV=1
fi

AGENT_PROVIDER="${AGENT_PROVIDER:-}"
AGENT_LIGHT_MODEL="${AGENT_LIGHT_MODEL:-}"
AGENT_HEAVY_MODEL="${AGENT_HEAVY_MODEL:-}"
SCOUT_REASONING="${SCOUT_REASONING:-}"
JUDGE_REASONING="${JUDGE_REASONING:-}"

if [[ "$IS_DEV" -eq 1 ]]; then
  # Dev: use Ollama defaults (overridable via env vars)
  AGENT_PROVIDER="${AGENT_PROVIDER:-$DEFAULT_DEV_PROVIDER}"
  AGENT_LIGHT_MODEL="${AGENT_LIGHT_MODEL:-$DEFAULT_DEV_LIGHT_MODEL}"
  AGENT_HEAVY_MODEL="${AGENT_HEAVY_MODEL:-$DEFAULT_DEV_HEAVY_MODEL}"
  # No reasoning overrides in dev
  SCOUT_REASONING=""
  JUDGE_REASONING=""
else
  # Non-dev (staging/production): use OpenRouter + DeepSeek
  AGENT_PROVIDER="${AGENT_PROVIDER:-$DEFAULT_NONDEV_PROVIDER}"
  AGENT_LIGHT_MODEL="${AGENT_LIGHT_MODEL:-$DEFAULT_NONDEV_LIGHT_MODEL}"
  AGENT_HEAVY_MODEL="${AGENT_HEAVY_MODEL:-$DEFAULT_NONDEV_HEAVY_MODEL}"
  SCOUT_REASONING="${SCOUT_REASONING:-$DEFAULT_SCOUT_REASONING}"
  JUDGE_REASONING="${JUDGE_REASONING:-$DEFAULT_JUDGE_REASONING}"
fi

# ---------------------------------------------------------------------------
# Resolve env file
# ---------------------------------------------------------------------------

ENV_FILE="$REPO_ROOT/.env.ops.${TARGET_ENV}"

if [[ ! -f "$ENV_FILE" ]]; then
  die "${ENV_FILE} not found.
  Create it:
    cp .env.ops.dev.example ${ENV_FILE}
    # edit and fill in values"
fi

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

log_info "Environment : ${TARGET_ENV}"
log_info "Env file    : ${ENV_FILE}"

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
require_var AUTH_EMAIL
require_var AUTH_PASSWORD

if [[ "$MISSING" -eq 1 ]]; then
  die "One or more required variables are missing. Check ${ENV_FILE}."
fi

log_ok "All required variables present"
log_info "API          : ${API_BASE_URL}"
log_info "Provider     : ${AGENT_PROVIDER}"
log_info "Light model  : ${AGENT_LIGHT_MODEL}"
log_info "Heavy model  : ${AGENT_HEAVY_MODEL}"
if [[ -n "$SCOUT_REASONING" ]]; then
  log_info "Scout reasoning : ${SCOUT_REASONING}"
fi
if [[ -n "$JUDGE_REASONING" ]]; then
  log_info "Judge reasoning : ${JUDGE_REASONING}"
fi

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
  die "Authentication failed. Make sure quick-setup.sh has run first."
fi

# ---------------------------------------------------------------------------
# Step 2 — Look up Hyperliquid connection
# ---------------------------------------------------------------------------

log_section "Step 2: Look up Hyperliquid connection"

api_call GET /capabilities/trading/connections

if [[ "$HTTP_STATUS" -ne 200 ]]; then
  log_error "Failed to list trading connections (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
  die "Connection lookup failed."
fi

HYPERLIQUID_CONNECTION_ID="$(echo "$RESPONSE_BODY" | jq -r '.connections[] | select(.label == "Hyperliquid") | .connectionId' | head -1)"

if [[ -z "$HYPERLIQUID_CONNECTION_ID" || "$HYPERLIQUID_CONNECTION_ID" == "null" ]]; then
  die "No connection found with label 'Hyperliquid'.
  Run quick-setup.sh first to provision Hyperliquid credentials."
fi

log_ok "Found Hyperliquid connection: ${HYPERLIQUID_CONNECTION_ID}"

# ---------------------------------------------------------------------------
# Agent creation helpers
# ---------------------------------------------------------------------------

build_agent_payload() {
  local name="$1"
  local strategy_preset="$2"

  # Build a jq filter for the optional runtimePolicyOverrides
  local rpo_filter="null"
  if [[ -n "$SCOUT_REASONING" || -n "$JUDGE_REASONING" ]]; then
    local rpo_parts=()
    if [[ -n "$SCOUT_REASONING" ]]; then
      rpo_parts+=("scoutReasoning: \"${SCOUT_REASONING}\"")
    fi
    if [[ -n "$JUDGE_REASONING" ]]; then
      rpo_parts+=("judgeReasoning: \"${JUDGE_REASONING}\"")
    fi
    local rpo_inner
    rpo_inner="$(printf '%s, ' "${rpo_parts[@]}")"
    rpo_inner="${rpo_inner%, }"
    rpo_filter="{ ${rpo_inner} }"
  fi

  jq -n \
    --arg name "$name" \
    --arg prompt "$AGENT_PROMPT" \
    --arg provider "$AGENT_PROVIDER" \
    --arg lightModel "$AGENT_LIGHT_MODEL" \
    --arg heavyModel "$AGENT_HEAVY_MODEL" \
    --arg executionMode "$AGENT_EXECUTION_MODE" \
    --arg capital "$AGENT_CAPITAL" \
    --arg telegramChatId "$AGENT_TELEGRAM_CHAT_ID" \
    --arg strategyPreset "$strategy_preset" \
    --argjson skillIds "$AGENT_SKILL_IDS" \
    --argjson wakePreferences "$AGENT_WAKE_PREFERENCES" \
    --arg connectionId "$HYPERLIQUID_CONNECTION_ID" \
    --argjson runtimePolicyOverrides "${rpo_filter}" \
    '{
      name: $name,
      prompt: $prompt,
      provider: $provider,
      lightModel: $lightModel,
      heavyModel: $heavyModel,
      skillIds: $skillIds,
      executionDefaults: {
        mode: $executionMode
      },
      capital: $capital,
      telegramChatId: $telegramChatId,
      strategyPreset: $strategyPreset,
      wakePreferences: $wakePreferences,
      connectionIds: [$connectionId]
    }
    | if $runtimePolicyOverrides != null then . + { runtimePolicyOverrides: $runtimePolicyOverrides } else . end'
}

# ---------------------------------------------------------------------------
# Step 3 — Create all 6 eval agents
# ---------------------------------------------------------------------------

log_section "Step 3: Creating evaluation agents"

CREATED=0
SKIPPED=0

for name in "${AGENT_NAMES[@]}"; do
  preset="$(preset_for "$name")"

  log_section "Creating agent: ${name} (preset=${preset})"

  # Check if agent already exists (idempotent)
  api_call GET /agents
  if [[ "$HTTP_STATUS" -eq 200 ]]; then
    existing_id="$(echo "$RESPONSE_BODY" | jq -r --arg name "$name" '.[] | select(.name == $name) | .id' | head -1)"
    if [[ -n "$existing_id" && "$existing_id" != "null" ]]; then
      log_ok "Agent '${name}' already exists (id=${existing_id}) — skipping creation"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi
  fi

  # Create the agent
  payload="$(build_agent_payload "$name" "$preset")"

  api_call POST /agents "$payload"

  if [[ "$HTTP_STATUS" -ne 201 ]]; then
    log_error "Failed to create agent '${name}' (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
    die "Agent creation failed."
  fi

  agent_id="$(echo "$RESPONSE_BODY" | jq -r '.id')"
  log_ok "Created agent '${name}' (id=${agent_id})"
  CREATED=$((CREATED + 1))
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

log_section "Agent creation summary"
log_ok "Created: ${CREATED}  Skipped: ${SKIPPED}  Total: ${#AGENT_NAMES[@]}"
log_info "All agents share:"
log_info "  execution mode : ${AGENT_EXECUTION_MODE}"
log_info "  capital        : ${AGENT_CAPITAL}"
log_info "  connection     : Hyperliquid (${HYPERLIQUID_CONNECTION_ID})"
log_info "  telegram       : ${AGENT_TELEGRAM_CHAT_ID}"
log_info "  provider       : ${AGENT_PROVIDER}"
log_info "  light model    : ${AGENT_LIGHT_MODEL}"
log_info "  heavy model    : ${AGENT_HEAVY_MODEL}"
if [[ -n "$SCOUT_REASONING" ]]; then
  log_info "  scout reasoning: ${SCOUT_REASONING}"
fi
if [[ -n "$JUDGE_REASONING" ]]; then
  log_info "  judge reasoning: ${JUDGE_REASONING}"
fi
log_info "All agents are in 'stopped' state. Start them via the API or UI when ready."
