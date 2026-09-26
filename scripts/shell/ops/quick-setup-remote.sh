#!/usr/bin/env bash
# quick-setup-remote.sh — Bootstrap a OpenAIdom user account on remote servers.
#
# Production variant of quick-setup.sh with hardened defaults:
#   - HTTPS-first (TLS validation on by default)
#   - SSH-based remote execution support
#   - Non-interactive mode for post-deploy automation
#   - Secrets redacted from all log output
#   - Exponential backoff retry on transient API failures
#   - Audit log to file alongside stderr
#   - Confirmation prompt unless --yes is passed
#
# Two primary execution modes:
#
#   Local (pointing at a remote API):
#     scripts/shell/ops/quick-setup-remote.sh --env-file .env.ops.production
#     scripts/shell/ops/quick-setup-remote.sh --env-file .env.ops.production --mode guided
#
#   Remote (pipe over SSH, run against local docker compose API):
#     ssh root@<server-ip> 'bash -s' < scripts/shell/ops/quick-setup-remote.sh \
#       --env-file - --yes <<'ENV'
#     API_BASE_URL=http://api:3000
#     AUTH_EMAIL=user@example.com
#     AUTH_PASSWORD=...
#     ...
#     ENV
#
#   Post-deploy (run as a deploy.sh step):
#     scripts/shell/ops/quick-setup-remote.sh --ssh <server-ip> --env-file .env.ops.production
#
# Usage:
#   scripts/shell/ops/quick-setup-remote.sh --env-file .env.ops.production
#   scripts/shell/ops/quick-setup-remote.sh --env-file .env.ops.production --mode guided
#   scripts/shell/ops/quick-setup-remote.sh --env-file .env.ops.production --yes
#   scripts/shell/ops/quick-setup-remote.sh --ssh 1.2.3.4 --env-file .env.ops.production
#   scripts/shell/ops/quick-setup-remote.sh --help
#
# Setup:
#   cp .env.ops.environment.example .env.ops.prod
#   # fill in the variables, then:
#   scripts/shell/ops/quick-setup-remote.sh --env-file .env.ops.prod
#
# Required env vars — see .env.ops.environment.example for the full list:
#   API_BASE_URL, AUTH_EMAIL, AUTH_PASSWORD, SETUP_DISPLAY_NAME,
#   TELEGRAM_CHAT_ID, venue secrets (HL_*, BYBIT_*, ONEINCH_*)

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SKILLS_DIR="$REPO_ROOT/docs/agents/skills"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

AUDIT_LOG=""
LOG_TIMESTAMP=""

log_info()    { echo "[INFO]  $*"; log_audit "INFO" "$*"; }
log_ok()      { echo "[OK]    $*"; log_audit "OK" "$*"; }
log_warn()    { echo "[WARN]  $*" >&2; log_audit "WARN" "$*"; }
log_error()   { echo "[ERROR] $*" >&2; log_audit "ERROR" "$*"; }
log_section() { echo; echo "=== $* ==="; log_audit "SECTION" "$*"; }

log_audit() {
  [[ -z "$AUDIT_LOG" ]] && return 0
  local level="$1"
  shift
  printf '[%s] [%s] %s\n' "$LOG_TIMESTAMP" "$level" "$*" >> "$AUDIT_LOG"
}

# Mask a secret value for safe logging — shows first 4 + last 4 chars.
mask_secret() {
  local val="${1:-}"
  local len="${#val}"
  if (( len <= 12 )); then
    printf '****'
    return 0
  fi
  local prefix="${val:0:4}"
  local suffix="${val:$((len-4)):4}"
  printf '%s****%s' "$prefix" "$suffix"
}

# Mask an entire JSON value by key name (recursive).
# Usage: echo "$json" | mask_json_value ".secrets"
mask_json_value() {
  local key="$1"
  jq "$key = \"<redacted>\"" 2>/dev/null || cat
}

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
# Retry helper — exponential backoff for transient API failures
# ---------------------------------------------------------------------------

retry_api_call() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local max_attempts="${4:-3}"
  local attempt=1
  local delay=2

  while true; do
    api_call "$method" "$path" "$body"
    # 2xx or 4xx (client errors other than 429) are terminal
    if [[ "$HTTP_STATUS" =~ ^2[0-9][0-9]$ ]]; then
      return 0
    fi
    if [[ "$HTTP_STATUS" =~ ^4[0-9][0-9]$ ]] && [[ "$HTTP_STATUS" != "429" ]]; then
      return 0
    fi
    # 429 or 5xx → retry
    if (( attempt >= max_attempts )); then
      log_warn "Giving up after ${max_attempts} attempts (last status: ${HTTP_STATUS})"
      return 0
    fi
    log_warn "Transient API error (HTTP ${HTTP_STATUS}) — retry ${attempt}/${max_attempts} in ${delay}s"
    sleep "$delay"
    ((attempt++))
    delay=$(( delay * 2 ))
    # Cap at 30s
    (( delay > 30 )) && delay=30
  done
}

# ---------------------------------------------------------------------------
# Paths & defaults
# ---------------------------------------------------------------------------

ENV_FILE=""
DRY_RUN=0
SETUP_MODE_CLI=""
SKIP_SKILL=0
SKIP_CONFIRM=0
SSH_HOST=""
INSECURE=0

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ -z "${2:-}" ]] && die "--env-file requires a file path argument (or '-' for stdin)"
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
    --skip-skill)
      SKIP_SKILL=1
      shift
      ;;
    --yes|-y)
      SKIP_CONFIRM=1
      shift
      ;;
    --ssh)
      [[ -z "${2:-}" ]] && die "--ssh requires a server IP or hostname"
      SSH_HOST="$2"
      shift 2
      ;;
    --insecure|-k)
      INSECURE=1
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
# SSH mode — re-invoke the script on the remote server
# ---------------------------------------------------------------------------

if [[ -n "$SSH_HOST" ]]; then
  if [[ "$ENV_FILE" != "-" && ! -f "$ENV_FILE" ]]; then
    die "When using --ssh, --env-file must be '-' (stdin) or a valid local path (got: ${ENV_FILE})"
  fi

  log_info "SSH mode: forwarding quick-setup-remote.sh to ${SSH_HOST} ..."

  # Build forwarded args (strip --ssh and --env-file, add back --env-file - for stdin)
  FORWARD_ARGS=()
  SKIP_NEXT=0
  for arg in "$@"; do
    if [[ "$SKIP_NEXT" -eq 1 ]]; then
      SKIP_NEXT=0
      continue
    fi
    if [[ "$arg" == "--ssh" ]]; then
      SKIP_NEXT=1
      continue
    fi
    FORWARD_ARGS+=("$arg")
  done
  FORWARD_ARGS+=(--env-file -)

  if [[ "$ENV_FILE" == "-" ]]; then
    # Read env from stdin, pipe both the script and the env data
    ENV_DATA="$(cat)"
    # shellcheck disable=SC2029
    echo "$ENV_DATA" | ssh "root@${SSH_HOST}" "cat > /tmp/prod-setup.env && bash -s" "${FORWARD_ARGS[@]}" < "$0"
  else
    # Read env from local file, pipe script + file content
    # shellcheck disable=SC2029
    ssh "root@${SSH_HOST}" "bash -s" "${FORWARD_ARGS[@]}" < "$0" < <(cat "$ENV_FILE")
  fi

  exit $?
fi

# ---------------------------------------------------------------------------
# Load env file
# ---------------------------------------------------------------------------

log_section "Loading configuration"

if [[ "$ENV_FILE" == "-" ]]; then
  log_info "Reading environment from stdin ..."
  # Read stdin into a temp file so we can source it
  ENV_FILE="$(mktemp)"
  cat > "$ENV_FILE"
  # shellcheck disable=SC2064
  trap 'rm -f "$ENV_FILE"' EXIT
elif [[ -z "$ENV_FILE" ]]; then
  # Default: look for .env.ops.prod next to the script
  ENV_FILE="$REPO_ROOT/.env.ops.prod"
  if [[ ! -f "$ENV_FILE" ]]; then
    die "No --env-file specified and default ${ENV_FILE} not found.
  Create one:
    cp ${REPO_ROOT}/.env.ops.environment.example ${ENV_FILE}
    # edit and fill in values"
  fi
elif [[ ! -f "$ENV_FILE" ]]; then
  die "Environment file not found: ${ENV_FILE}"
fi

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

log_info "Loaded: ${ENV_FILE}"
if [[ "$ENV_FILE" == "/dev/stdin" || "$ENV_FILE" == "-" ]]; then
  :  # already loaded from stdin temp file
fi

# Set up audit log
LOG_TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
AUDIT_LOG="/tmp/prod-setup-${LOG_TIMESTAMP}.log"
log_info "Audit log: ${AUDIT_LOG}"

# Override mode from CLI
if [[ -n "$SETUP_MODE_CLI" ]]; then
  SETUP_MODE="$SETUP_MODE_CLI"
fi

SETUP_MODE="$(trim_whitespace "${SETUP_MODE:-auto}")"
SETUP_MODE="${SETUP_MODE:-auto}"
if [[ "$SETUP_MODE" == "guide" ]]; then
  SETUP_MODE="guided"
fi

# ---------------------------------------------------------------------------
# TLS validation
# ---------------------------------------------------------------------------

CURL_TLS_FLAGS=()
if [[ "$INSECURE" -eq 1 ]]; then
  CURL_TLS_FLAGS+=(--insecure)
  log_warn "TLS certificate validation disabled (--insecure)"
fi

# ---------------------------------------------------------------------------
# Pre-flight safety checks
# ---------------------------------------------------------------------------

log_section "Pre-flight checks"

# Warn about localhost / plain HTTP in production context
API_BASE_URL="$(trim_whitespace "${API_BASE_URL:-}")"
if [[ -z "$API_BASE_URL" ]]; then
  die "API_BASE_URL is not set. Point this at the production API."
fi

if [[ "$API_BASE_URL" =~ ^http://localhost ]] || [[ "$API_BASE_URL" =~ ^http://127\. ]]; then
  log_warn "API_BASE_URL points to localhost (${API_BASE_URL}). Is this really production?"
fi

if [[ "$API_BASE_URL" =~ ^http:// ]] && [[ "$INSECURE" -eq 0 ]]; then
  log_warn "API_BASE_URL uses plain HTTP (${API_BASE_URL}). Consider HTTPS for production."
fi

# Confirmation prompt (skip in non-interactive / --yes / dry-run)
if [[ "$SKIP_CONFIRM" -eq 0 && "$DRY_RUN" -eq 0 ]]; then
  echo ""
  echo "About to bootstrap a user on:"
  echo "  API:       ${API_BASE_URL}"
  echo "  Email:     ${AUTH_EMAIL:-<not set>}"
  echo "  Mode:      ${SETUP_MODE}"
  echo ""
  read -rp "Continue? [y/N] " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

log_section "Validating variables"

MISSING=0
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
    hyperliquid) printf '%s' 'Hyperliquid' ;;
    bybit)       printf '%s' 'Bybit' ;;
    1inch)       printf '%s' '1inch' ;;
    *)           printf '%s' "$provider" ;;
  esac
}

provider_required_secret_vars() {
  local provider="$1"
  case "$provider" in
    hyperliquid) printf '%s' 'HL_API_KEY HL_SECRET HL_WALLET_ADDRESS' ;;
    bybit)       printf '%s' 'BYBIT_API_KEY BYBIT_SECRET' ;;
    1inch)       printf '%s' 'ONEINCH_API_KEY ONEINCH_PRIVATE_KEY' ;;
    *)           printf '%s' '' ;;
  esac
}

provider_secret_block_status() {
  local provider="$1"
  local required_vars
  required_vars="$(provider_required_secret_vars "$provider")"
  [[ -z "$required_vars" ]] && { printf '%s' 'unsupported'; return 0; }

  local -a vars
  read -r -a vars <<< "$required_vars"
  local present_count=0 var_name
  for var_name in "${vars[@]}"; do
    [[ -n "${!var_name:-}" ]] && ((present_count++))
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
  provider_display_name "$1"
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

parse_frontmatter_field() {
  local file="$1" field="$2"
  local fm
  fm="$(awk '/^---$/{if(n++)exit;next}n' "$file")"
  echo "$fm" | grep -E "^${field}:" | head -1 | sed "s/^${field}:[[:space:]]*//"
}

parse_frontmatter_block_scalar() {
  local file="$1" field="$2"
  local fm
  fm="$(awk '/^---$/{if(n++)exit;next}n' "$file")"
  if echo "$fm" | grep -qE "^${field}:[[:space:]]*>-"; then
    echo "$fm" | awk -v f="^${field}:" '
      $0 ~ f { found=1; next }
      found && /^[a-zA-Z]/ { exit }
      found && /^  / { sub(/^  /, ""); line = (line ? line " " : "") $0 }
      END { print line }
    '
    return
  fi
  if echo "$fm" | grep -qE "^${field}:[[:space:]]*\\|"; then
    echo "$fm" | awk -v f="^${field}:" '
      $0 ~ f { found=1; next }
      found && /^[a-zA-Z]/ { exit }
      found && /^  / { sub(/^  /, ""); line = (line ? line "\n" : "") $0 }
      END { print line }
    '
    return
  fi
  parse_frontmatter_field "$file" "$field"
}

parse_frontmatter_list() {
  local file="$1" field="$2"
  local fm
  fm="$(awk '/^---$/{if(n++)exit;next}n' "$file")"
  echo "$fm" | awk -v f="^${field}:" '
    $0 ~ f { found=1; next }
    found && /^[a-zA-Z]/ { exit }
    found && /^  - / { sub(/^  - /, ""); items = items (items ? "," : "") "\"" $0 "\"" }
    END { print "[" items "]" }
  '
}

parse_skill_body() {
  local file="$1"
  awk 'BEGIN{n=0} /^---$/{n++;next} n>=2{print}' "$file"
}

build_skill_payload_from_file() {
  local skill_file="$1"
  local seed_label="${2:-prod-setup}"

  local name description tags_json tools_json instructions promptTemplate
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

ensure_skill() {
  local skill_file="$1"
  local skill_name
  skill_name="$(parse_frontmatter_field "$skill_file" "name")"

  if [[ -z "$skill_name" ]]; then
    log_warn "Skipping ${skill_file}: no 'name' in frontmatter"
    return 0
  fi

  log_section "Provision skill: ${skill_name}"

  if [[ -z "${SKILLS_LIST_CACHED:-}" ]]; then
    retry_api_call GET /skills '?scope=mine'
    if [[ "$HTTP_STATUS" -ne 200 ]]; then
      log_error "Failed to list skills (HTTP ${HTTP_STATUS})"
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
  payload="$(build_skill_payload_from_file "$skill_file" "prod-setup")" || return 0

  retry_api_call POST /skills "$payload"
  if [[ "$HTTP_STATUS" -eq 201 ]]; then
    local new_id
    new_id="$(echo "$RESPONSE_BODY" | jq -r '.id')"
    log_ok "Created skill: ${skill_name} (id=${new_id})"
    PROVISIONED_SKILL_IDS+=("${new_id}|${skill_name}")
    SKILLS_LIST_CACHED=""
    return 0
  fi

  log_error "Skill creation failed (HTTP ${HTTP_STATUS})"
  die "Skill provisioning step failed for: ${skill_name}"
}

ensure_all_skills() {
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

# Core required vars
require_var API_BASE_URL
require_var AUTH_EMAIL
require_var AUTH_PASSWORD
require_var SETUP_DISPLAY_NAME

case "$SETUP_MODE" in
  auto|guided|advanced) ;;
  *)
    log_error "SETUP_MODE must be one of: auto | guided | advanced (got: $(printf '%q' "$SETUP_MODE"))"
    MISSING=1
    ;;
esac

# Auto-detect providers from populated secret blocks
for provider in hyperliquid bybit 1inch; do
  secret_block_status="$(provider_secret_block_status "$provider")"
  case "$secret_block_status" in
    complete) AUTO_DETECTED_PROVIDERS+=("$provider") ;;
    partial)
      required_vars="$(provider_required_secret_vars "$provider")"
      log_error "Provider ${provider} is partially configured. Set all required vars: ${required_vars}"
      MISSING=1
      ;;
  esac
done

SETUP_PROVIDER_RESOLVED="$(resolve_guided_provider || true)"
SETUP_LABEL_RESOLVED="$(resolve_guided_label || true)"

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
  guided)  EFFECTIVE_SETUP_MODE="guided" ;;
  advanced) EFFECTIVE_SETUP_MODE="advanced" ;;
esac

if [[ "$RUN_MULTI_PROVIDER" -eq 1 ]]; then
  log_info "Auto-detected providers: ${AUTO_DETECTED_PROVIDERS[*]}"
else
  if [[ "$EFFECTIVE_SETUP_MODE" == "guided" ]]; then
    [[ -z "$SETUP_PROVIDER_RESOLVED" ]] && { log_error "Guided mode requires one provider. Set SETUP_PROVIDER or make CREDENTIAL_VENUE and CONNECTION_PROVIDER match."; MISSING=1; }
    [[ -z "$SETUP_LABEL_RESOLVED" ]] && { log_error "Guided mode requires one label. Set SETUP_LABEL or make CREDENTIAL_LABEL and CONNECTION_LABEL match."; MISSING=1; }
    ADVANCED_CREDENTIAL_VENUE="$SETUP_PROVIDER_RESOLVED"
    ADVANCED_CREDENTIAL_LABEL="$SETUP_LABEL_RESOLVED"
    ADVANCED_CONNECTION_PROVIDER="$SETUP_PROVIDER_RESOLVED"
    ADVANCED_CONNECTION_LABEL="$SETUP_LABEL_RESOLVED"
  fi

  require_var ADVANCED_CREDENTIAL_VENUE

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
      : ;;
    *)
      log_warn "No built-in secret template for venue '${ADVANCED_CREDENTIAL_VENUE}'."
      ;;
  esac

  if [[ "$EFFECTIVE_SETUP_MODE" == "advanced" ]]; then
    require_var ADVANCED_CREDENTIAL_LABEL
    require_var ADVANCED_CONNECTION_PROVIDER
    require_var ADVANCED_CONNECTION_LABEL
  fi
fi

require_var TELEGRAM_CHAT_ID

if [[ "$MISSING" -eq 1 ]]; then
  die "One or more required variables are missing."
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
  trap 'rm -f "$tmp_file"' RETURN

  local curl_args=(
    --silent
    --output "$tmp_file"
    --write-out '%{http_code}'
    --request "$method"
    --url "${API_BASE_URL}${path}"
    --header 'Content-Type: application/json'
    ${CURL_TLS_FLAGS[@]+"${CURL_TLS_FLAGS[@]}"}
  )

  if [[ -n "${AUTH_TOKEN:-}" ]]; then
    curl_args+=(--header "Authorization: Bearer ${AUTH_TOKEN}")
  fi

  if [[ -n "$body" ]]; then
    curl_args+=(--data "$body")
  fi

  local curl_exit=0
  HTTP_STATUS="$(curl "${curl_args[@]}")" || curl_exit=$?
  RESPONSE_BODY="$(cat "$tmp_file")"
  if [[ $curl_exit -ne 0 ]]; then
    log_error "curl failed (exit ${curl_exit}) connecting to ${API_BASE_URL}${path}"
    HTTP_STATUS="000"
    RESPONSE_BODY=""
  fi
  rm -f "$tmp_file"
  trap - RETURN
}

# ---------------------------------------------------------------------------
# Step 1 — Authenticate
# ---------------------------------------------------------------------------

log_section "Step 1: Authenticate"

log_info "Attempting login as ${AUTH_EMAIL} ..."

retry_api_call POST /auth/login "$(jq -n \
  --arg email    "$AUTH_EMAIL" \
  --arg password "$AUTH_PASSWORD" \
  '{ email: $email, password: $password }')"

if [[ "$HTTP_STATUS" -eq 200 ]]; then
  AUTH_TOKEN="$(echo "$RESPONSE_BODY" | jq -r '.token')"
  log_ok "Logged in as ${AUTH_EMAIL}"

elif [[ "$HTTP_STATUS" -eq 401 ]]; then
  log_warn "Login failed (HTTP ${HTTP_STATUS}) — attempting registration ..."

  retry_api_call POST /auth/register "$(jq -n \
    --arg email       "$AUTH_EMAIL" \
    --arg password    "$AUTH_PASSWORD" \
    --arg displayName "$SETUP_DISPLAY_NAME" \
    '{ email: $email, password: $password, displayName: $displayName }')"

  if [[ "$HTTP_STATUS" -eq 201 ]]; then
    AUTH_TOKEN="$(echo "$RESPONSE_BODY" | jq -r '.token')"
    log_ok "Registered and authenticated as ${AUTH_EMAIL}"
  elif [[ "$HTTP_STATUS" -eq 409 ]]; then
    log_error "Account already exists (HTTP 409) but login failed. Check AUTH_PASSWORD."
    die "Authentication step failed."
  else
    log_error "Registration failed (HTTP ${HTTP_STATUS})"
    die "Authentication step failed."
  fi

else
  log_error "Unexpected login response (HTTP ${HTTP_STATUS})"
  die "Authentication step failed."
fi

# ---------------------------------------------------------------------------
# Step 2 — Ensure Flight Deal Monitoring skill (optional in prod)
# ---------------------------------------------------------------------------

if [[ "$SKIP_SKILL" -eq 1 ]]; then
  log_info "Skipping skill provisioning (--skip-skill)"
else
  ensure_all_skills
fi

# ---------------------------------------------------------------------------
# Step 3 — Provider link(s)
# ---------------------------------------------------------------------------

if [[ "$RUN_MULTI_PROVIDER" -eq 1 ]]; then
  # ── Multi-provider guided setup ──────────────────────────────────────────

  log_section "Step 3: Guided provider link setup (multi-provider)"

  for provider in "${AUTO_DETECTED_PROVIDERS[@]}"; do
    provider_label="$(resolve_multi_provider_label "$provider")"
    provider_secrets_json="$(build_provider_secrets_json "$provider")"

    log_info "Linking provider=${provider} label=${provider_label}"

    retry_api_call POST /setup/provider-link "$(jq -n \
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
    else
      log_error "Guided setup failed for provider ${provider} (HTTP ${HTTP_STATUS})"
      die "Guided multi-provider setup step failed."
    fi
  done

elif [[ "$EFFECTIVE_SETUP_MODE" == "guided" ]]; then
  # ── Single-provider guided setup ─────────────────────────────────────────

  SECRETS_JSON="$(build_provider_secrets_json "$SETUP_PROVIDER_RESOLVED")"

  log_section "Step 3: Guided provider link (provider=${SETUP_PROVIDER_RESOLVED})"

  retry_api_call POST /setup/provider-link "$(jq -n \
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
  else
    log_error "Guided setup failed (HTTP ${HTTP_STATUS})"
    die "Guided setup step failed."
  fi

else
  # ── Advanced mode: credential + connection separately ────────────────────

  SECRETS_JSON="$(build_provider_secrets_json "$ADVANCED_CREDENTIAL_VENUE")"

  log_section "Step 3: Create credential (venue=${ADVANCED_CREDENTIAL_VENUE})"

  retry_api_call GET /credentials
  if [[ "$HTTP_STATUS" -eq 200 ]]; then
    CREDENTIAL_ID="$(echo "$RESPONSE_BODY" | jq -r --arg venue "$ADVANCED_CREDENTIAL_VENUE" --arg label "$ADVANCED_CREDENTIAL_LABEL" \
      '.credentials[] | select(.venue==$venue and .label==$label) | .id' | head -1)"
  fi

  if [[ -n "$CREDENTIAL_ID" ]]; then
    log_info "Credential already exists (id=${CREDENTIAL_ID}) — skipping creation"
  else
    retry_api_call POST /credentials "$(jq -n \
      --arg venue "$ADVANCED_CREDENTIAL_VENUE" \
      --arg label "$ADVANCED_CREDENTIAL_LABEL" \
      --argjson secrets "$SECRETS_JSON" \
      '{ venue: $venue, label: $label, secrets: $secrets }')"

    if [[ "$HTTP_STATUS" -eq 201 ]]; then
      CREDENTIAL_ID="$(echo "$RESPONSE_BODY" | jq -r '.id')"
      log_ok "Credential created: id=${CREDENTIAL_ID}  label=${ADVANCED_CREDENTIAL_LABEL}"
    else
      log_error "Credential creation failed (HTTP ${HTTP_STATUS})"
      die "Credential step failed."
    fi
  fi

  log_section "Step 4: Create connection (provider=${ADVANCED_CONNECTION_PROVIDER})"

  retry_api_call GET /connections
  if [[ "$HTTP_STATUS" -eq 200 ]]; then
    CONNECTION_ID="$(echo "$RESPONSE_BODY" | jq -r --arg provider "$ADVANCED_CONNECTION_PROVIDER" --arg label "$ADVANCED_CONNECTION_LABEL" \
      '.connections[] | select(.provider==$provider and .label==$label and .status=="active") | .id' | head -1)"
  fi

  if [[ -n "$CONNECTION_ID" ]]; then
    log_info "Connection already exists (id=${CONNECTION_ID}) — skipping creation"
  else
    retry_api_call POST /connections "$(jq -n \
      --arg provider "$ADVANCED_CONNECTION_PROVIDER" \
      --arg label "$ADVANCED_CONNECTION_LABEL" \
      --arg credentialId "$CREDENTIAL_ID" \
      '{ provider: $provider, label: $label, credentialId: $credentialId }')"

    if [[ "$HTTP_STATUS" -eq 201 ]]; then
      CONNECTION_ID="$(echo "$RESPONSE_BODY" | jq -r '.id')"
      log_ok "Connection created: id=${CONNECTION_ID}  label=${ADVANCED_CONNECTION_LABEL}"
    else
      log_error "Connection creation failed (HTTP ${HTTP_STATUS})"
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

retry_api_call GET /auth/me
CURRENT_CHAT_ID=""
if [[ "$HTTP_STATUS" -eq 200 ]]; then
  CURRENT_CHAT_ID="$(echo "$RESPONSE_BODY" | jq -r '.telegramChatId // ""')"
fi

if [[ "$CURRENT_CHAT_ID" == "$TELEGRAM_CHAT_ID" ]]; then
  log_info "Telegram chat ID already set to ${TELEGRAM_CHAT_ID} — skipping"
else
  retry_api_call PATCH /auth/me "$(jq -n \
    --arg chatId "$TELEGRAM_CHAT_ID" \
    '{ telegramChatId: $chatId }')"

  if [[ "$HTTP_STATUS" -eq 200 ]]; then
    log_ok "Telegram chat ID set: ${TELEGRAM_CHAT_ID}"
  else
    log_error "Telegram update failed (HTTP ${HTTP_STATUS})"
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
    log_ok "  Credential:  ${summary_credential_id}"
    log_ok "  Connection:  ${summary_connection_id}"
    [[ -n "$summary_venue_account_id" ]] && log_ok "  Venue acct:  ${summary_venue_account_id}"
    [[ -n "$summary_binding_id" ]] && log_ok "  Binding:     ${summary_binding_id}"
  done
elif [[ "$EFFECTIVE_SETUP_MODE" == "guided" ]]; then
  log_ok "Credential:  ${CREDENTIAL_ID}  (${SETUP_PROVIDER_RESOLVED} / ${SETUP_LABEL_RESOLVED})"
  log_ok "Connection:  ${CONNECTION_ID}  (${SETUP_PROVIDER_RESOLVED} / ${SETUP_LABEL_RESOLVED})"
  [[ -n "$VENUE_ACCOUNT_ID" ]] && log_ok "Venue acct:  ${VENUE_ACCOUNT_ID}"
  [[ -n "$CONNECTION_ID" ]] && log_ok "Binding:     ${CONNECTION_ID}"
else
  log_ok "Credential:  ${CREDENTIAL_ID}  (${ADVANCED_CREDENTIAL_VENUE} / ${ADVANCED_CREDENTIAL_LABEL})"
  log_ok "Connection:  ${CONNECTION_ID}  (${ADVANCED_CONNECTION_PROVIDER} / ${ADVANCED_CONNECTION_LABEL})"
  log_warn "Advanced mode only creates or reuses credential + connection. Trading binding provisioning remains a separate guided step."
fi
log_ok "Telegram:    ${TELEGRAM_CHAT_ID}"
log_ok "Audit log:   ${AUDIT_LOG}"
