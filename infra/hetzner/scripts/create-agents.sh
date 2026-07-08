#!/usr/bin/env bash
# create-agents.sh — Create agents on a HeroBids instance.
#
# Creates:
#   - security-auditor   (system security audit, 24h tick)
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
  # Default: look for .env.setup.remote next to quick-setup.prod.sh
  ENV_FILE="$REPO_ROOT/scripts/shell/ops/.env.setup.remote"
  if [[ ! -f "$ENV_FILE" ]]; then
    die "No --env-file specified and default ${ENV_FILE} not found.
  Create one:
    cp ${REPO_ROOT}/scripts/shell/ops/.env.setup.remote.example ${ENV_FILE}
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
# Agent creation helper
# ═══════════════════════════════════════════════════════════════════════════════

build_agent_payload() {
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

create_agent() {
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

  # Create the agent
  local payload
  payload="$(build_agent_payload "$name" "$prompt" "$skill_ids_json" "$tick_interval_ms")"

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
# Step 2 — Create security-auditor agent
# ═══════════════════════════════════════════════════════════════════════════════

SECURITY_AUDITOR_ID="$(create_agent "security-auditor" "$SECURITY_AUDIT_PROMPT" '["web-access","programming","file-management","task-management"]' "$AGENT_TICK_INTERVAL_MS")"

# ═══════════════════════════════════════════════════════════════════════════════
# Step 3 — Summary
# ═══════════════════════════════════════════════════════════════════════════════

log_section "Agent creation summary"
log_ok "security-auditor  → id=${SECURITY_AUDITOR_ID}  provider=${AGENT_PROVIDER}/${AGENT_LIGHT_MODEL}  tick=24h"
log_info "Agent is in 'stopped' state. Start it via the API or UI when ready."
