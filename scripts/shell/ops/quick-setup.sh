#!/usr/bin/env bash
# quick-setup.sh — Bootstrap a OpenAIdom user account via the REST API.
#
# Reads configuration from .env.ops.dev (or a custom path via --env),
# then runs one of two setup flows:
#
#   Guided mode   (default when one provider + one label can be derived)
#     1. Authenticate   — POST /auth/login
#                         On 401, fall back to POST /auth/register
#     2. Skill          — ensure the Flight Deal Monitoring skill exists
#     3. Provider link  — POST /setup/provider-link
#                         (creates credential + connection + connection)
#     4. Telegram       — PATCH /auth/me { telegramChatId }
#
#   Advanced mode (fallback for separate labels or explicit resource reuse)
#     1. Authenticate   — POST /auth/login
#                         On 401, fall back to POST /auth/register
#     2. Skill          — ensure the Flight Deal Monitoring skill exists
#     3. Credential     — POST /credentials  (encrypt and store venue API keys)
#     4. Connection     — POST /connections  (link credential to a provider)
#     5. Telegram       — PATCH /auth/me { telegramChatId }
#
# Usage:
#   scripts/shell/ops/quick-setup.sh
#   scripts/shell/ops/quick-setup.sh --env /path/to/custom.env
#   scripts/shell/ops/quick-setup.sh --mode guided
#   scripts/shell/ops/quick-setup.sh --mode advanced
#   scripts/shell/ops/quick-setup.sh --dry-run   # validate config, no API calls
#   scripts/shell/ops/quick-setup.sh --help
#
# Setup:
#   cp .env.ops.dev.example .env.ops.dev
#   # fill in the variables, then:
#   chmod +x scripts/shell/ops/quick-setup.sh
#   scripts/shell/ops/quick-setup.sh
#
# ─────────────────────────────────────────────────────────────────
# Required variables in .env.ops.dev
# ─────────────────────────────────────────────────────────────────
#
# API
#   API_BASE_URL          Base URL of the OpenAIdom API
#                         e.g. http://localhost:3000
#
# Auth
#   AUTH_EMAIL           User email address
#   AUTH_PASSWORD        Password (≥ 8 characters)
#   SETUP_DISPLAY_NAME    Display name used when registering a new account
#                         e.g. "Alice"
#
# Setup mode
#   SETUP_MODE            auto | guided | advanced (guide is accepted as an alias)
#                         auto (default) provisions all fully configured
#                         provider secret blocks (HL_*, BYBIT_*, ONEINCH_*)
#                         via guided setup; otherwise it falls back to the
#                         single-provider guided/advanced behavior
#
# Guided setup inputs
#   SETUP_PROVIDER        Optional unified provider identifier
#                         e.g. hyperliquid | bybit | 1inch
#   SETUP_LABEL           Optional unified label used for credential,
#                         connection, and connection
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
#     ONEINCH_PRIVATE_KEY # Wallet private key used by 1inch for swaps on supported EVM chains (e.g Base): 64 hex chars, optional 0x prefix
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
ENV_FILE="$REPO_ROOT/.env.ops.dev"
DRY_RUN=0
SETUP_MODE_CLI=""
SKILLS_DIR="$REPO_ROOT/docs/agents/skills"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log_info()    { echo "[INFO]  $*"; }
log_ok()      { echo "[OK]    $*"; }
log_warn()    { echo "[WARN]  $*" >&2; }
log_error()   { echo "[ERROR] $*" >&2; }
log_section() { echo; echo "=== $* ==="; }

trim_whitespace() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

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
    --mode)
      [[ -z "${2:-}" ]] && die "--mode requires 'guided', 'guide', 'advanced', or 'auto'"
      SETUP_MODE_CLI="$2"
      shift 2
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
# Load .env.ops.dev
# ---------------------------------------------------------------------------

log_section "Loading configuration"

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

if [[ -n "$SETUP_MODE_CLI" ]]; then
  SETUP_MODE="$SETUP_MODE_CLI"
fi

SETUP_MODE="$(trim_whitespace "${SETUP_MODE:-auto}")"
SETUP_MODE="${SETUP_MODE:-auto}"
if [[ "$SETUP_MODE" == "guide" ]]; then
  SETUP_MODE="guided"
fi

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

log_section "Validating variables"

MISSING=0
SETUP_MODE="${SETUP_MODE:-auto}"
EFFECTIVE_SETUP_MODE=""
RUN_MULTI_PROVIDER=0
SETUP_PROVIDER_RESOLVED=""
SETUP_LABEL_RESOLVED=""
ADVANCED_CREDENTIAL_VENUE=""
ADVANCED_CREDENTIAL_LABEL=""
ADVANCED_CONNECTION_PROVIDER=""
ADVANCED_CONNECTION_LABEL=""
CREDENTIAL_ID=""
CONNECTION_ID=""
VENUE_ACCOUNT_ID=""
CONNECTION_ID=""
AUTO_DETECTED_PROVIDERS=()
MULTI_SETUP_SUMMARIES=()

require_var() {
  local var="$1"
  if [[ -z "${!var:-}" ]]; then
    log_error "Required variable not set: $var"
    MISSING=1
  fi
}

resolve_guided_provider() {
  if [[ -n "${SETUP_PROVIDER:-}" ]]; then
    printf '%s' "$SETUP_PROVIDER"
    return 0
  fi

  if [[ -n "${CREDENTIAL_VENUE:-}" && -n "${CONNECTION_PROVIDER:-}" && "$CREDENTIAL_VENUE" != "$CONNECTION_PROVIDER" ]]; then
    return 1
  fi

  printf '%s' "${CREDENTIAL_VENUE:-${CONNECTION_PROVIDER:-}}"
}

resolve_guided_label() {
  if [[ -n "${SETUP_LABEL:-}" ]]; then
    printf '%s' "$SETUP_LABEL"
    return 0
  fi

  if [[ -n "${CREDENTIAL_LABEL:-}" && -n "${CONNECTION_LABEL:-}" && "$CREDENTIAL_LABEL" != "$CONNECTION_LABEL" ]]; then
    return 1
  fi

  printf '%s' "${CREDENTIAL_LABEL:-${CONNECTION_LABEL:-}}"
}

provider_display_name() {
  local provider="$1"
  case "$provider" in
    hyperliquid)
      printf '%s' 'Hyperliquid'
      ;;
    bybit)
      printf '%s' 'Bybit'
      ;;
    1inch)
      printf '%s' '1inch'
      ;;
    *)
      printf '%s' "$provider"
      ;;
  esac
}

provider_required_secret_vars() {
  local provider="$1"
  case "$provider" in
    hyperliquid)
      printf '%s' 'HL_API_KEY HL_SECRET HL_WALLET_ADDRESS'
      ;;
    bybit)
      printf '%s' 'BYBIT_API_KEY BYBIT_SECRET'
      ;;
    1inch)
      printf '%s' 'ONEINCH_API_KEY ONEINCH_PRIVATE_KEY'
      ;;
    *)
      printf '%s' ''
      ;;
  esac
}

provider_secret_block_status() {
  local provider="$1"
  local required_vars
  required_vars="$(provider_required_secret_vars "$provider")"

  if [[ -z "$required_vars" ]]; then
    printf '%s' 'unsupported'
    return 0
  fi

  local -a vars
  read -r -a vars <<< "$required_vars"

  local present_count=0
  local var_name
  for var_name in "${vars[@]}"; do
    if [[ -n "${!var_name:-}" ]]; then
      ((present_count += 1))
    fi
  done

  if (( present_count == 0 )); then
    printf '%s' 'absent'
  elif (( present_count == ${#vars[@]} )); then
    printf '%s' 'complete'
  else
    printf '%s' 'partial'
  fi
}

resolve_multi_provider_label() {
  local provider="$1"
  local provider_name
  provider_name="$(provider_display_name "$provider")"

  printf '%s' "$provider_name"
}

build_provider_secrets_json() {
  local provider="$1"

  case "$provider" in
    hyperliquid)
      jq -n \
        --arg apiKey "$HL_API_KEY" \
        --arg secret "$HL_SECRET" \
        --arg walletAddress "$HL_WALLET_ADDRESS" \
        '{ apiKey: $apiKey, secret: $secret, walletAddress: $walletAddress }'
      ;;
    bybit)
      jq -n \
        --arg apiKey "$BYBIT_API_KEY" \
        --arg secret "$BYBIT_SECRET" \
        '{ apiKey: $apiKey, secret: $secret }'
      ;;
    1inch)
      jq -n \
        --arg apiKey "$ONEINCH_API_KEY" \
        --arg privateKey "$ONEINCH_PRIVATE_KEY" \
        '{ apiKey: $apiKey, privateKey: $privateKey }'
      ;;
    *)
      log_warn "No secret template for '${provider}' — sending empty secrets object"
      printf '%s' '{}'
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Generic skill provisioning — reads YAML frontmatter from markdown files
# ---------------------------------------------------------------------------

# Parse a frontmatter field from a markdown file.
# Usage: parse_frontmatter_field <file> <field>
# Returns the value of a simple scalar field, or a JSON array for list fields.
parse_frontmatter_field() {
  local file="$1"
  local field="$2"
  # Extract frontmatter block (between --- markers)
  local fm
  fm="$(awk '/^---$/{if(n++)exit;next}n' "$file")"
  # Simple scalar field (name, description)
  local value
  value="$(echo "$fm" | grep -E "^${field}:" | head -1 | sed "s/^${field}:[[:space:]]*//")"
  printf '%s' "$value"
}

# Parse a multi-line YAML scalar (>- block) from frontmatter.
parse_frontmatter_block_scalar() {
  local file="$1"
  local field="$2"
  local fm
  fm="$(awk '/^---$/{if(n++)exit;next}n' "$file")"
  # Check if the field uses >- (folded block scalar) — joins lines with spaces
  if echo "$fm" | grep -qE "^${field}:[[:space:]]*>-"; then
    echo "$fm" | awk -v f="^${field}:" '
      $0 ~ f { found=1; next }
      found && /^[a-zA-Z]/ { exit }
      found && /^  / { sub(/^  /, ""); line = (line ? line " " : "") $0 }
      END { print line }
    '
    return
  fi
  # Check if the field uses | (literal block scalar) — preserves newlines
  if echo "$fm" | grep -qE "^${field}:[[:space:]]*\\|"; then
    echo "$fm" | awk -v f="^${field}:" '
      $0 ~ f { found=1; next }
      found && /^[a-zA-Z]/ { exit }
      found && /^  / { sub(/^  /, ""); line = (line ? line "\n" : "") $0 }
      END { print line }
    '
    return
  fi
  # Fallback: single-line value
  parse_frontmatter_field "$file" "$field"
}

# Parse a YAML list field from frontmatter as a JSON array.
# Usage: parse_frontmatter_list <file> <field>
parse_frontmatter_list() {
  local file="$1"
  local field="$2"
  local fm
  fm="$(awk '/^---$/{if(n++)exit;next}n' "$file")"
  # Extract list items (lines starting with "  - " after the field)
  echo "$fm" | awk -v f="^${field}:" '
    $0 ~ f { found=1; next }
    found && /^[a-zA-Z]/ { exit }
    found && /^  - / { sub(/^  - /, ""); items = items (items ? "," : "") "\"" $0 "\"" }
    END { print "[" items "]" }
  '
}

# Extract the body (everything after the frontmatter closing ---) from a markdown file.
parse_skill_body() {
  local file="$1"
  awk 'BEGIN{n=0} /^---$/{n++;next} n>=2{print}' "$file"
}

# Build a skill API payload from a frontmatter-annotated markdown file.
build_skill_payload_from_file() {
  local skill_file="$1"
  local seed_label="${2:-quick-setup}"

  local name description tags_json tools_json capability_families_json instructions promptTemplate
  name="$(parse_frontmatter_field "$skill_file" "name")"
  description="$(parse_frontmatter_block_scalar "$skill_file" "description")"
  tags_json="$(parse_frontmatter_list "$skill_file" "tags")"
  tools_json="$(parse_frontmatter_list "$skill_file" "requiredTools")"
  capability_families_json="$(parse_frontmatter_list "$skill_file" "capabilityFamilies")"
  instructions="$(parse_skill_body "$skill_file")"

  if [[ -z "$name" ]]; then
    log_warn "Skipping ${skill_file}: no 'name' in frontmatter"
    return 1
  fi

  # Parse promptTemplate from frontmatter (block scalar with |)
  local promptTemplate
  promptTemplate="$(parse_frontmatter_block_scalar "$skill_file" "promptTemplate")"

  jq -n \
    --arg name "$name" \
    --arg description "$description" \
    --arg instructions "$instructions" \
    --arg promptTemplate "$promptTemplate" \
    --argjson tags "$tags_json" \
    --argjson requiredTools "$tools_json" \
    --argjson capabilityFamilies "$capability_families_json" \
    --arg changeSummary "Seeded by ${seed_label}" \
    '{
      name: $name,
      description: $description,
      instructions: $instructions,
      promptTemplate: (if $promptTemplate == "" then null else $promptTemplate end),
      requiredTools: $requiredTools,
      capabilityFamilies: $capabilityFamilies,
      publicationStatus: "draft",
      tags: $tags,
      changeSummary: $changeSummary
    }'
}

# Ensure a single skill exists (create if missing).
# Usage: ensure_skill <skill_file>
ensure_skill() {
  local skill_file="$1"
  local skill_name
  skill_name="$(parse_frontmatter_field "$skill_file" "name")"

  if [[ -z "$skill_name" ]]; then
    log_warn "Skipping ${skill_file}: no 'name' in frontmatter"
    return 0
  fi

  log_section "Provision skill: ${skill_name}"

  # Fetch existing skills (reuse cached response if available)
  if [[ -z "${SKILLS_LIST_CACHED:-}" ]]; then
    api_call GET /skills '?scope=mine'
    if [[ "$HTTP_STATUS" -ne 200 ]]; then
      log_error "Failed to list skills (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
      die "Skill provisioning step failed."
    fi
    SKILLS_LIST_CACHED="$RESPONSE_BODY"
  fi

  local existing_id
  existing_id="$(echo "$SKILLS_LIST_CACHED" | jq -r --arg name "$skill_name" '[.skills[] | select(.name == $name) | .id][0] // empty')"
  if [[ -n "$existing_id" && "$existing_id" != "null" ]]; then
    log_info "Skill already exists: ${skill_name} (id=${existing_id})"
    PROVISIONED_SKILL_IDS+=("${existing_id}|${skill_name}")
    return 0
  fi

  local payload
  payload="$(build_skill_payload_from_file "$skill_file" "quick-setup")" || return 0

  api_call POST /skills "$payload"
  if [[ "$HTTP_STATUS" -eq 201 ]]; then
    local new_id
    new_id="$(echo "$RESPONSE_BODY" | jq -r '.id')"
    log_ok "Created skill: ${skill_name} (id=${new_id})"
    PROVISIONED_SKILL_IDS+=("${new_id}|${skill_name}")
    # Invalidate cache so next skill check sees the new one
    SKILLS_LIST_CACHED=""
    return 0
  fi

  log_error "Skill creation failed (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
  die "Skill provisioning step failed for: ${skill_name}"
}

# Ensure all skills in the skills directory exist.
ensure_all_skills() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log_info "Dry-run mode: skipping skill provisioning"
    return 0
  fi

  if [[ ! -d "$SKILLS_DIR" ]]; then
    log_warn "Skills directory not found: ${SKILLS_DIR} — skipping skill provisioning"
    return 0
  fi

  SKILLS_LIST_CACHED=""
  PROVISIONED_SKILL_IDS=()

  local skill_file
  for skill_file in "$SKILLS_DIR"/*.md; do
    [[ ! -f "$skill_file" ]] && continue
    ensure_skill "$skill_file"
  done
}

# Core
require_var API_BASE_URL
require_var AUTH_EMAIL
require_var AUTH_PASSWORD
require_var SETUP_DISPLAY_NAME

case "$SETUP_MODE" in
  auto|guided|advanced)
    ;;
  *)
    log_error "SETUP_MODE must be one of: auto | guided | advanced (got: $(printf '%q' "$SETUP_MODE"))"
    MISSING=1
    ;;
esac

for provider in hyperliquid bybit 1inch; do
  secret_block_status="$(provider_secret_block_status "$provider")"
  case "$secret_block_status" in
    complete)
      AUTO_DETECTED_PROVIDERS+=("$provider")
      ;;
    partial)
      required_vars="$(provider_required_secret_vars "$provider")"
      log_error "Provider ${provider} is partially configured. Set all required vars: ${required_vars}"
      MISSING=1
      ;;
  esac
done

if SETUP_PROVIDER_RESOLVED="$(resolve_guided_provider)"; then
  :
else
  SETUP_PROVIDER_RESOLVED=""
fi

if SETUP_LABEL_RESOLVED="$(resolve_guided_label)"; then
  :
else
  SETUP_LABEL_RESOLVED=""
fi

ADVANCED_CREDENTIAL_VENUE="${CREDENTIAL_VENUE:-${SETUP_PROVIDER:-${CONNECTION_PROVIDER:-}}}"
ADVANCED_CREDENTIAL_LABEL="${CREDENTIAL_LABEL:-${SETUP_LABEL:-${CONNECTION_LABEL:-}}}"
ADVANCED_CONNECTION_PROVIDER="${CONNECTION_PROVIDER:-${SETUP_PROVIDER:-${ADVANCED_CREDENTIAL_VENUE:-}}}"
ADVANCED_CONNECTION_LABEL="${CONNECTION_LABEL:-${SETUP_LABEL:-${CREDENTIAL_LABEL:-}}}"

case "$SETUP_MODE" in
  auto)
    if [[ "${#AUTO_DETECTED_PROVIDERS[@]}" -gt 1 ]]; then
      RUN_MULTI_PROVIDER=1
      EFFECTIVE_SETUP_MODE="guided-multi"
    elif [[ -n "$SETUP_PROVIDER_RESOLVED" && -n "$SETUP_LABEL_RESOLVED" ]]; then
      EFFECTIVE_SETUP_MODE="guided"
    else
      EFFECTIVE_SETUP_MODE="advanced"
    fi
    ;;
  guided)
    EFFECTIVE_SETUP_MODE="guided"
    ;;
  advanced)
    EFFECTIVE_SETUP_MODE="advanced"
    ;;
esac

if [[ "$RUN_MULTI_PROVIDER" -eq 1 ]]; then
  log_info "Auto-detected providers for setup: ${AUTO_DETECTED_PROVIDERS[*]}"
  for provider in "${AUTO_DETECTED_PROVIDERS[@]}"; do
    log_info "Auto-generated label for ${provider}: $(resolve_multi_provider_label "$provider")"
  done
else
  if [[ "$EFFECTIVE_SETUP_MODE" == "guided" ]]; then
    if [[ -z "$SETUP_PROVIDER_RESOLVED" ]]; then
      log_error "Guided mode requires one provider. Set SETUP_PROVIDER or make CREDENTIAL_VENUE and CONNECTION_PROVIDER match."
      MISSING=1
    fi
    if [[ -z "$SETUP_LABEL_RESOLVED" ]]; then
      log_error "Guided mode requires one label. Set SETUP_LABEL or make CREDENTIAL_LABEL and CONNECTION_LABEL match."
      MISSING=1
    fi

    ADVANCED_CREDENTIAL_VENUE="$SETUP_PROVIDER_RESOLVED"
    ADVANCED_CREDENTIAL_LABEL="$SETUP_LABEL_RESOLVED"
    ADVANCED_CONNECTION_PROVIDER="$SETUP_PROVIDER_RESOLVED"
    ADVANCED_CONNECTION_LABEL="$SETUP_LABEL_RESOLVED"
  fi

  # Credential / provider
  require_var ADVANCED_CREDENTIAL_VENUE

  # Venue-specific secrets
  case "${ADVANCED_CREDENTIAL_VENUE:-}" in
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
      : # already caught by require_var ADVANCED_CREDENTIAL_VENUE above
      ;;
    *)
      log_warn "No built-in secret template for venue '${ADVANCED_CREDENTIAL_VENUE}'. Ensure any required secret variables are set."
      ;;
  esac

  if [[ "$EFFECTIVE_SETUP_MODE" == "advanced" ]]; then
    require_var ADVANCED_CREDENTIAL_LABEL
    require_var ADVANCED_CONNECTION_PROVIDER
    require_var ADVANCED_CONNECTION_LABEL
  fi
fi

# Telegram
require_var TELEGRAM_CHAT_ID

if [[ "$MISSING" -eq 1 ]]; then
  die "One or more required variables are missing. Check $ENV_FILE."
fi

log_ok "All required variables present"

if [[ "$SETUP_MODE" == "auto" && "$EFFECTIVE_SETUP_MODE" == "advanced" ]]; then
  log_info "Auto mode selected advanced flow because a single guided provider/label could not be resolved."
elif [[ "$SETUP_MODE" == "auto" && "$RUN_MULTI_PROVIDER" -eq 1 ]]; then
  log_info "Auto mode selected guided multi-provider flow."
elif [[ "$SETUP_MODE" == "auto" ]]; then
  log_info "Auto mode selected guided flow."
else
  log_info "Using ${EFFECTIVE_SETUP_MODE} flow."
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

log_info "Attempting login as ${AUTH_EMAIL} ..."

api_call POST /auth/login "$(jq -n \
  --arg email    "$AUTH_EMAIL" \
  --arg password "$AUTH_PASSWORD" \
  '{ email: $email, password: $password }')"

if [[ "$HTTP_STATUS" -eq 200 ]]; then
  AUTH_TOKEN="$(echo "$RESPONSE_BODY" | jq -r '.token')"
  log_ok "Logged in as ${AUTH_EMAIL}"

elif [[ "$HTTP_STATUS" -eq 401 ]]; then
  log_warn "Login failed (HTTP ${HTTP_STATUS}) — $(echo "$RESPONSE_BODY" | jq -r '.error // "no error field"')"
  log_info "Attempting registration as ${AUTH_EMAIL} ..."

  api_call POST /auth/register "$(jq -n \
    --arg email       "$AUTH_EMAIL" \
    --arg password    "$AUTH_PASSWORD" \
    --arg displayName "$SETUP_DISPLAY_NAME" \
    '{ email: $email, password: $password, displayName: $displayName }')"

  if [[ "$HTTP_STATUS" -eq 201 ]]; then
    AUTH_TOKEN="$(echo "$RESPONSE_BODY" | jq -r '.token')"
    log_ok "Registered and authenticated as ${AUTH_EMAIL}"
  elif [[ "$HTTP_STATUS" -eq 409 ]]; then
    # Account exists but the supplied password was wrong — treat as a hard failure
    # so the operator knows to check their credentials.
    log_error "Account already exists (HTTP 409) but login failed. Check AUTH_PASSWORD."
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
# Step 2 — Ensure flight deal monitoring skill exists
# ---------------------------------------------------------------------------

ensure_all_skills

if [[ "$RUN_MULTI_PROVIDER" -eq 1 ]]; then
  # -------------------------------------------------------------------------
  # Step 3 — Guided provider link setup (multi-provider)
  # -------------------------------------------------------------------------

  log_section "Step 3: Guided provider link setup (multi-provider)"

  for provider in "${AUTO_DETECTED_PROVIDERS[@]}"; do
    provider_label="$(resolve_multi_provider_label "$provider")"
    provider_secrets_json="$(build_provider_secrets_json "$provider")"

    log_info "Linking provider=${provider} label=${provider_label}"

    api_call POST /setup/provider-link "$(jq -n \
      --arg provider "$provider" \
      --arg label "$provider_label" \
      --arg capability trading \
      --argjson secrets "$provider_secrets_json" \
      '{ provider: $provider, label: $label, secrets: $secrets, capability: $capability }')"

    if [[ "$HTTP_STATUS" -eq 201 ]]; then
      multi_credential_id="$(echo "$RESPONSE_BODY" | jq -r '.credential.id')"
      multi_connection_id="$(echo "$RESPONSE_BODY" | jq -r '.connection.id')"
      multi_venue_account_id="$(echo "$RESPONSE_BODY" | jq -r '.venueAccount.id // empty')"
      multi_connection_id="$(echo "$RESPONSE_BODY" | jq -r '.connection.id // empty')"

      MULTI_SETUP_SUMMARIES+=("${provider}|${provider_label}|${multi_credential_id}|${multi_connection_id}|${multi_venue_account_id}|${multi_connection_id}")

      log_ok "Guided setup created provider=${provider} credential=${multi_credential_id} connection=${multi_connection_id}"
      if [[ -n "$multi_venue_account_id" ]]; then
        log_ok "Venue account created: id=${multi_venue_account_id}"
      fi
      if [[ -n "$multi_connection_id" ]]; then
        log_ok "Trading binding created: id=${multi_connection_id}"
      fi
    else
      log_error "Guided setup failed for provider ${provider} (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
      die "Guided multi-provider setup step failed."
    fi
  done
elif [[ "$EFFECTIVE_SETUP_MODE" == "guided" ]]; then
  # -------------------------------------------------------------------------
  # Step 3 — Guided provider link setup
  # -------------------------------------------------------------------------

  SECRETS_JSON="$(build_provider_secrets_json "$SETUP_PROVIDER_RESOLVED")"

  log_section "Step 3: Guided provider link (provider=${SETUP_PROVIDER_RESOLVED})"

  api_call POST /setup/provider-link "$(jq -n \
    --arg provider "$SETUP_PROVIDER_RESOLVED" \
    --arg label "$SETUP_LABEL_RESOLVED" \
    --arg capability trading \
    --argjson secrets "$SECRETS_JSON" \
    '{ provider: $provider, label: $label, secrets: $secrets, capability: $capability }')"

  if [[ "$HTTP_STATUS" -eq 201 ]]; then
    CREDENTIAL_ID="$(echo "$RESPONSE_BODY" | jq -r '.credential.id')"
    CONNECTION_ID="$(echo "$RESPONSE_BODY" | jq -r '.connection.id')"
    VENUE_ACCOUNT_ID="$(echo "$RESPONSE_BODY" | jq -r '.venueAccount.id // empty')"
    CONNECTION_ID="$(echo "$RESPONSE_BODY" | jq -r '.connection.id // empty')"
    log_ok "Guided setup created credential=${CREDENTIAL_ID} connection=${CONNECTION_ID}"
    if [[ -n "$VENUE_ACCOUNT_ID" ]]; then
      log_ok "Venue account created: id=${VENUE_ACCOUNT_ID}"
    fi
    if [[ -n "$CONNECTION_ID" ]]; then
      log_ok "Trading binding created: id=${CONNECTION_ID}"
    fi
  else
    log_error "Guided setup failed (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
    die "Guided setup step failed."
  fi
else
  # -------------------------------------------------------------------------
  # Step 3 — Create credential
  # -------------------------------------------------------------------------

  SECRETS_JSON="$(build_provider_secrets_json "$ADVANCED_CREDENTIAL_VENUE")"

  log_section "Step 3: Create credential (venue=${ADVANCED_CREDENTIAL_VENUE})"

  # Check for an existing credential with the same venue + label before creating.
  api_call GET /credentials
  if [[ "$HTTP_STATUS" -eq 200 ]]; then
    CREDENTIAL_ID="$(echo "$RESPONSE_BODY" | jq -r --arg venue "$ADVANCED_CREDENTIAL_VENUE" --arg label "$ADVANCED_CREDENTIAL_LABEL" \
      '.credentials[] | select(.venue==$venue and .label==$label) | .id' | head -1)"
  fi

  if [[ -n "$CREDENTIAL_ID" ]]; then
    log_info "Credential already exists (id=${CREDENTIAL_ID}) — skipping creation"
  else
    api_call POST /credentials "$(jq -n \
      --arg venue "$ADVANCED_CREDENTIAL_VENUE" \
      --arg label "$ADVANCED_CREDENTIAL_LABEL" \
      --argjson secrets "$SECRETS_JSON" \
      '{ venue: $venue, label: $label, secrets: $secrets }')"

    if [[ "$HTTP_STATUS" -eq 201 ]]; then
      CREDENTIAL_ID="$(echo "$RESPONSE_BODY" | jq -r '.id')"
      log_ok "Credential created: id=${CREDENTIAL_ID}  label=${ADVANCED_CREDENTIAL_LABEL}"
    else
      log_error "Credential creation failed (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
      die "Credential step failed."
    fi
  fi

  # -------------------------------------------------------------------------
  # Step 4 — Create connection
  # -------------------------------------------------------------------------

  log_section "Step 4: Create connection (provider=${ADVANCED_CONNECTION_PROVIDER})"

  # Check for an existing active connection with the same provider + label.
  api_call GET /connections
  if [[ "$HTTP_STATUS" -eq 200 ]]; then
    CONNECTION_ID="$(echo "$RESPONSE_BODY" | jq -r --arg provider "$ADVANCED_CONNECTION_PROVIDER" --arg label "$ADVANCED_CONNECTION_LABEL" \
      '.connections[] | select(.provider==$provider and .label==$label and .status=="active") | .id' | head -1)"
  fi

  if [[ -n "$CONNECTION_ID" ]]; then
    log_info "Connection already exists (id=${CONNECTION_ID}) — skipping creation"
  else
    api_call POST /connections "$(jq -n \
      --arg provider "$ADVANCED_CONNECTION_PROVIDER" \
      --arg label "$ADVANCED_CONNECTION_LABEL" \
      --arg credentialId "$CREDENTIAL_ID" \
      '{ provider: $provider, label: $label, credentialId: $credentialId }')"

    if [[ "$HTTP_STATUS" -eq 201 ]]; then
      CONNECTION_ID="$(echo "$RESPONSE_BODY" | jq -r '.id')"
      log_ok "Connection created: id=${CONNECTION_ID}  label=${ADVANCED_CONNECTION_LABEL}"
    else
      log_error "Connection creation failed (HTTP ${HTTP_STATUS}): $RESPONSE_BODY"
      die "Connection step failed."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Final account setup — Set Telegram chat ID
# ---------------------------------------------------------------------------

if [[ "$EFFECTIVE_SETUP_MODE" == "guided" || "$EFFECTIVE_SETUP_MODE" == "guided-multi" ]]; then
  log_section "Step 4: Set Telegram chat ID"
else
  log_section "Step 5: Set Telegram chat ID"
fi

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
log_ok "Email:       ${AUTH_EMAIL}"
log_ok "Mode:        ${EFFECTIVE_SETUP_MODE}"
for skill_summary in "${PROVISIONED_SKILL_IDS[@]:-}"; do
  [[ -z "$skill_summary" ]] && continue
  IFS='|' read -r sid sname <<< "$skill_summary"
  log_ok "Skill:       ${sid}  (${sname})"
done
if [[ "$RUN_MULTI_PROVIDER" -eq 1 ]]; then
  for summary in "${MULTI_SETUP_SUMMARIES[@]}"; do
    IFS='|' read -r summary_provider summary_label summary_credential_id summary_connection_id summary_venue_account_id summary_binding_id <<< "$summary"
    log_ok "Provider:    ${summary_provider}  (${summary_label})"
    log_ok "Credential:  ${summary_credential_id}"
    log_ok "Connection:  ${summary_connection_id}"
    if [[ -n "$summary_venue_account_id" ]]; then
      log_ok "Venue acct:  ${summary_venue_account_id}"
    fi
    if [[ -n "$summary_binding_id" ]]; then
      log_ok "Binding:     ${summary_binding_id}"
    fi
  done
elif [[ "$EFFECTIVE_SETUP_MODE" == "guided" ]]; then
  log_ok "Credential:  ${CREDENTIAL_ID}  (${SETUP_PROVIDER_RESOLVED} / ${SETUP_LABEL_RESOLVED})"
  log_ok "Connection:  ${CONNECTION_ID}  (${SETUP_PROVIDER_RESOLVED} / ${SETUP_LABEL_RESOLVED})"
  if [[ -n "$VENUE_ACCOUNT_ID" ]]; then
    log_ok "Venue acct:  ${VENUE_ACCOUNT_ID}"
  fi
  if [[ -n "$CONNECTION_ID" ]]; then
    log_ok "Binding:     ${CONNECTION_ID}"
  fi
else
  log_ok "Credential:  ${CREDENTIAL_ID}  (${ADVANCED_CREDENTIAL_VENUE} / ${ADVANCED_CREDENTIAL_LABEL})"
  log_ok "Connection:  ${CONNECTION_ID}  (${ADVANCED_CONNECTION_PROVIDER} / ${ADVANCED_CONNECTION_LABEL})"
  log_warn "Advanced mode only creates or reuses credential + connection. Trading binding provisioning remains a separate guided step."
fi
log_ok "Telegram:    ${TELEGRAM_CHAT_ID}"
