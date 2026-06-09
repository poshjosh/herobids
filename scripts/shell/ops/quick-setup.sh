#!/usr/bin/env bash
# quick-setup.sh — Bootstrap a Herobids user account via the REST API.
#
# Reads configuration from scripts/.env.setup (or a custom path via --env),
# then runs the following steps in sequence:
#
#   1. Authenticate   — POST /auth/login
#                       On 401, fall back to POST /auth/register
#   2. Credential     — POST /credentials  (encrypt and store venue API keys)
#   3. Connection     — POST /connections  (link credential to a provider,
#                       creates a companion venue account automatically)
#   4. Telegram       — PATCH /auth/me { telegramChatId }
#
# Usage:
#   scripts/shell/ops/quick-setup.sh
#   scripts/shell/ops/quick-setup.sh --env /path/to/custom.env.setup
#   scripts/shell/ops/quick-setup.sh --dry-run   # validate config, no API calls
#   scripts/shell/ops/quick-setup.sh --help
#
# Setup:
#   cp scripts/.env.setup.example scripts/.env.setup
#   # fill in the variables, then:
#   chmod +x scripts/shell/ops/quick-setup.sh
#   scripts/shell/ops/quick-setup.sh
#
# ─────────────────────────────────────────────────────────────────
# Required variables in .env.setup
# ─────────────────────────────────────────────────────────────────
#
# API
#   API_BASE_URL          Base URL of the Herobids API
#                         e.g. http://localhost:3000
#
# Auth
#   SETUP_EMAIL           User email address
#   SETUP_PASSWORD        Password (≥ 8 characters)
#   SETUP_DISPLAY_NAME    Display name used when registering a new account
#                         e.g. "Alice"
#
# Credential  (venue API keys, stored encrypted)
#   CREDENTIAL_VENUE      Venue identifier: hyperliquid | bybit | 1inch
#   CREDENTIAL_LABEL      Human-readable name, e.g. "Main account"
#
#   Hyperliquid secrets   (required when CREDENTIAL_VENUE=hyperliquid)
#     HL_API_KEY
#     HL_SECRET
#     HL_WALLET_ADDRESS   EVM address: 0x + 40 hex chars
#
#   Bybit secrets         (required when CREDENTIAL_VENUE=bybit)
#     BYBIT_API_KEY
#     BYBIT_SECRET
#
#   1inch secrets         (required when CREDENTIAL_VENUE=1inch)
#     ONEINCH_API_KEY     1inch developer portal key
#     ONEINCH_PRIVATE_KEY EVM private key: 64 hex chars, optional 0x prefix
#
# Connection  (links the credential to a provider)
#   CONNECTION_PROVIDER   Provider identifier, typically matches CREDENTIAL_VENUE
#   CONNECTION_LABEL      Human-readable name, e.g. "Main connection"
#
# Notifications
#   TELEGRAM_CHAT_ID      Telegram chat ID for alert notifications
#                         e.g. 123456789
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.setup"
DRY_RUN=0

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
      [[ -z "${2:-}" ]] && die "--env requires a file path argument"
      ENV_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      # Print only the leading comment block (stop at the first non-comment line)
      awk '/^[^#]/{exit} /^#/{sub(/^# ?/,""); print}' "$0"
      exit 0
      ;;
    *)
      die "Unknown argument: $1  (use --help for usage)"
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Load .env.setup
# ---------------------------------------------------------------------------

log_section "Loading configuration"

if [[ ! -f "$ENV_FILE" ]]; then
  die "$ENV_FILE not found.
  Copy the example and fill in your values:
    cp scripts/.env.setup.example scripts/.env.setup"
fi

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

log_info "Loaded: $ENV_FILE"

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

log_section "Validating variables"

MISSING=0

require_var() {
  local var="$1"
  if [[ -z "${!var:-}" ]]; then
    log_error "Required variable not set: $var"
    MISSING=1
  fi
}

# Core
require_var API_BASE_URL
require_var SETUP_EMAIL
require_var SETUP_PASSWORD
require_var SETUP_DISPLAY_NAME

# Credential
require_var CREDENTIAL_VENUE
require_var CREDENTIAL_LABEL

# Venue-specific secrets
case "${CREDENTIAL_VENUE:-}" in
  hyperliquid)
    require_var HL_API_KEY
    require_var HL_SECRET
    require_var HL_WALLET_ADDRESS
    ;;
  bybit)
    require_var BYBIT_API_KEY
    require_var BYBIT_SECRET
    ;;
  1inch)
    require_var ONEINCH_API_KEY
    require_var ONEINCH_PRIVATE_KEY
    ;;
  "")
    : # already caught by require_var CREDENTIAL_VENUE above
    ;;
  *)
    log_warn "No built-in secret template for venue '${CREDENTIAL_VENUE}'. Ensure any required secret variables are set."
    ;;
esac

# Connection
require_var CONNECTION_PROVIDER
require_var CONNECTION_LABEL

# Telegram
require_var TELEGRAM_CHAT_ID

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
# API helper
# Writes response body to RESPONSE_BODY and HTTP status to HTTP_STATUS.
# Uses a temp file so that multi-line JSON bodies are handled correctly.
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

log_info "Attempting login as ${SETUP_EMAIL} ..."

api_call POST /auth/login "$(jq -n \
  --arg email    "$SETUP_EMAIL" \
  --arg password "$SETUP_PASSWORD" \
  '{ email: $email, password: $password }')"

if [[ "$HTTP_STATUS" -eq 200 ]]; then
  AUTH_TOKEN="$(echo "$RESPONSE_BODY" | jq -r '.token')"
  log_ok "Logged in as ${SETUP_EMAIL}"

elif [[ "$HTTP_STATUS" -eq 401 ]]; then
  log_warn "Login failed (HTTP ${HTTP_STATUS}) — $(echo "$RESPONSE_BODY" | jq -r '.error // "no error field"')"
  log_info "Attempting registration as ${SETUP_EMAIL} ..."

  api_call POST /auth/register "$(jq -n \
    --arg email       "$SETUP_EMAIL" \
    --arg password    "$SETUP_PASSWORD" \
    --arg displayName "$SETUP_DISPLAY_NAME" \
    '{ email: $email, password: $password, displayName: $displayName }')"

  if [[ "$HTTP_STATUS" -eq 201 ]]; then
    AUTH_TOKEN="$(echo "$RESPONSE_BODY" | jq -r '.token')"
    log_ok "Registered and authenticated as ${SETUP_EMAIL}"
  elif [[ "$HTTP_STATUS" -eq 409 ]]; then
    # Account exists but the supplied password was wrong — treat as a hard failure
    # so the operator knows to check their credentials.
    log_error "Account already exists (HTTP 409) but login failed. Check SETUP_PASSWORD."
    die "Authentication step failed."
  else
    log_error "Registration failed (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
    die "Authentication step failed."
  fi

else
  log_error "Unexpected login response (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
  die "Authentication step failed."
fi

# ---------------------------------------------------------------------------
# Step 2 — Create credential
# ---------------------------------------------------------------------------

log_section "Step 2: Create credential (venue=${CREDENTIAL_VENUE})"

case "$CREDENTIAL_VENUE" in
  hyperliquid)
    SECRETS_JSON="$(jq -n \
      --arg apiKey        "$HL_API_KEY" \
      --arg secret        "$HL_SECRET" \
      --arg walletAddress "$HL_WALLET_ADDRESS" \
      '{ apiKey: $apiKey, secret: $secret, walletAddress: $walletAddress }')"
    ;;
  bybit)
    SECRETS_JSON="$(jq -n \
      --arg apiKey "$BYBIT_API_KEY" \
      --arg secret "$BYBIT_SECRET" \
      '{ apiKey: $apiKey, secret: $secret }')"
    ;;
  1inch)
    SECRETS_JSON="$(jq -n \
      --arg apiKey     "$ONEINCH_API_KEY" \
      --arg privateKey "$ONEINCH_PRIVATE_KEY" \
      '{ apiKey: $apiKey, privateKey: $privateKey }')"
    ;;
  *)
    SECRETS_JSON="{}"
    log_warn "No secret template for '${CREDENTIAL_VENUE}' — sending empty secrets object"
    ;;
esac

# Check for an existing credential with the same venue + label before creating.
api_call GET /credentials
if [[ "$HTTP_STATUS" -eq 200 ]]; then
  CREDENTIAL_ID="$(echo "$RESPONSE_BODY" | jq -r --arg venue "$CREDENTIAL_VENUE" --arg label "$CREDENTIAL_LABEL" \
    '.credentials[] | select(.venue==$venue and .label==$label) | .id' | head -1)"
fi

if [[ -n "${CREDENTIAL_ID:-}" ]]; then
  log_info "Credential already exists (id=${CREDENTIAL_ID}) — skipping creation"
else
  api_call POST /credentials "$(jq -n \
    --arg venue   "$CREDENTIAL_VENUE" \
    --arg label   "$CREDENTIAL_LABEL" \
    --argjson secrets "$SECRETS_JSON" \
    '{ venue: $venue, label: $label, secrets: $secrets }')"

  if [[ "$HTTP_STATUS" -eq 201 ]]; then
    CREDENTIAL_ID="$(echo "$RESPONSE_BODY" | jq -r '.id')"
    log_ok "Credential created: id=${CREDENTIAL_ID}  label=${CREDENTIAL_LABEL}"
  else
    log_error "Credential creation failed (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
    die "Credential step failed."
  fi
fi

# ---------------------------------------------------------------------------
# Step 3 — Create connection
# ---------------------------------------------------------------------------

log_section "Step 3: Create connection (provider=${CONNECTION_PROVIDER})"

# Check for an existing active connection with the same provider + label.
api_call GET /connections
if [[ "$HTTP_STATUS" -eq 200 ]]; then
  CONNECTION_ID="$(echo "$RESPONSE_BODY" | jq -r --arg provider "$CONNECTION_PROVIDER" --arg label "$CONNECTION_LABEL" \
    '.connections[] | select(.provider==$provider and .label==$label and .status=="active") | .id' | head -1)"
fi

if [[ -n "${CONNECTION_ID:-}" ]]; then
  log_info "Connection already exists (id=${CONNECTION_ID}) — skipping creation"
else
  api_call POST /connections "$(jq -n \
    --arg provider     "$CONNECTION_PROVIDER" \
    --arg label        "$CONNECTION_LABEL" \
    --arg credentialId "$CREDENTIAL_ID" \
    '{ provider: $provider, label: $label, credentialId: $credentialId }')"

  if [[ "$HTTP_STATUS" -eq 201 ]]; then
    CONNECTION_ID="$(echo "$RESPONSE_BODY" | jq -r '.id')"
    log_ok "Connection created: id=${CONNECTION_ID}  label=${CONNECTION_LABEL}"
  else
    log_error "Connection creation failed (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
    die "Connection step failed."
  fi
fi

# ---------------------------------------------------------------------------
# Step 4 — Set Telegram chat ID
# ---------------------------------------------------------------------------

log_section "Step 4: Set Telegram chat ID"

# Check current value before patching — skip the write if already set.
api_call GET /auth/me
CURRENT_CHAT_ID=""
if [[ "$HTTP_STATUS" -eq 200 ]]; then
  CURRENT_CHAT_ID="$(echo "$RESPONSE_BODY" | jq -r '.telegramChatId // ""')"
fi

if [[ "$CURRENT_CHAT_ID" == "$TELEGRAM_CHAT_ID" ]]; then
  log_info "Telegram chat ID already set to ${TELEGRAM_CHAT_ID} — skipping"
else
  api_call PATCH /auth/me "$(jq -n \
    --arg chatId "$TELEGRAM_CHAT_ID" \
    '{ telegramChatId: $chatId }')"

  if [[ "$HTTP_STATUS" -eq 200 ]]; then
    log_ok "Telegram chat ID set: ${TELEGRAM_CHAT_ID}"
  else
    log_error "Telegram update failed (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
    die "Telegram step failed."
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

log_section "Setup complete"
log_ok "Email:       ${SETUP_EMAIL}"
log_ok "Credential:  ${CREDENTIAL_ID}  (${CREDENTIAL_VENUE} / ${CREDENTIAL_LABEL})"
log_ok "Connection:  ${CONNECTION_ID}  (${CONNECTION_PROVIDER} / ${CONNECTION_LABEL})"
log_ok "Telegram:    ${TELEGRAM_CHAT_ID}"
