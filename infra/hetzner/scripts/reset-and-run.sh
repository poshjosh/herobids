#!/usr/bin/env bash
# reset-and-run.sh — Nuclear reset + full provision for the Hetzner server.
#
# Chains the complete bootstrap sequence:
#   1. reset.sh           — wipe DB, Redis; restart services; seed admin
#   2. quick-setup-remote.sh — provision user, credentials, venue connections, skills
#   3. create-agents.sh   — create security-auditor agent
#
# Usage:
#   infra/hetzner/scripts/reset-and-run.sh --env-file <path> [--env <staging|production>] [<server-ip>]
#   infra/hetzner/scripts/reset-and-run.sh --env staging --env-file .env.ops.staging
#   ADMIN_EMAIL=... ADMIN_PASSWORD=... ./reset-and-run.sh --env-file .env.ops.staging
#
# Environment:
#   HEROBIDS_ENV       Deployment environment: staging | production (default: production).
#   ADMIN_EMAIL        Admin user email for seeding (required).
#   ADMIN_PASSWORD     Admin user password for seeding (required).
#   AGENT_PROVIDER     LLM provider override (default: openrouter).
#   AGENT_LIGHT_MODEL  Fast model override (default: deepseek/deepseek-v4-flash via OpenRouter).
#   AGENT_HEAVY_MODEL  Capable model override (default: deepseek/deepseek-v4-pro via OpenRouter).
#   AGENT_TICK_INTERVAL_MS  Agent reasoning loop interval in ms (default: 86400000 = 24h).
#
# WARNING: This destroys ALL data on the server. Do not run against a live
#          environment with real funds.

set -euo pipefail

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$(dirname "${BASH_SOURCE[0]}")/_ssh_opts.sh"

# ─── Parse environment flag first ────────────────────────────────────────────

parse_env_flag "$@"
shift $((HEROBIDS_ENV_SHIFT)) 2>/dev/null || true

# ─── Defaults ────────────────────────────────────────────────────────────────

ENV_FILE="${REPO_ROOT}/.env.ops.staging"
SERVER_IP=""

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

# ─── Parse arguments ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ -z "${2:-}" ]] && die "--env-file requires a path argument"
      ENV_FILE="$2"
      shift 2
      ;;
    -h|--help)
      awk '/^[^#]/{exit} /^#/{sub(/^# ?/,""); print}' "$0"
      exit 0
      ;;
    -*)
      die "Unknown option: $1  (use --help for usage)"
      ;;
    *)
      SERVER_IP="$1"
      shift
      ;;
  esac
done

# ─── Validate env file ───────────────────────────────────────────────────────

if [[ -z "$ENV_FILE" ]]; then
  # Default: look for .env.ops.staging at repo root
  ENV_FILE="$REPO_ROOT/.env.ops.staging"
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

# ─── Validate required vars ──────────────────────────────────────────────────

MISSING=0

require_var() {
  local var="$1"
  if [[ -z "${!var:-}" ]]; then
    log_error "Required variable not set: $var"
    MISSING=1
  fi
}

# Admin seeding (can come from env file or be passed as env vars)
require_var ADMIN_EMAIL
require_var ADMIN_PASSWORD

# User setup
require_var AUTH_EMAIL
require_var AUTH_PASSWORD
require_var SETUP_DISPLAY_NAME

if [[ "$MISSING" -eq 1 ]]; then
  die "One or more required variables are missing. Check ${ENV_FILE} and environment."
fi

# ─── Determine server IP ─────────────────────────────────────────────────────

if [[ -z "${SERVER_IP}" ]]; then
  if command -v terraform &>/dev/null; then
    SERVER_IP="$(terraform_output -raw server_ipv4 2>/dev/null || true)"
  fi
fi

if [[ -z "${SERVER_IP}" ]]; then
  die "No server IP provided.
  Usage: $0 --env-file <path> [<server-ip>]
  Or run provision.sh first: infra/hetzner/scripts/provision.sh --env ${HEROBIDS_ENV}"
fi

# ─── Confirmation ────────────────────────────────────────────────────────────

echo "================================================"
echo " DESTRUCTIVE RESET + FULL PROVISION"
echo "================================================"
echo " Server:      ${SERVER_IP}"
echo " Environment: ${HEROBIDS_ENV}"
echo " Env file:    ${ENV_FILE}"
echo " Admin user:  ${ADMIN_EMAIL}"
echo " Setup user:  ${AUTH_EMAIL}"
echo ""
echo "This will:"
echo "  1. WIPE Postgres, Redis (Caddy TLS certs preserved)"
echo "  2. Seed admin user (${ADMIN_EMAIL})"
echo "  3. Provision user account + venue credentials + connections"
echo "  4. Create security-auditor agent"
echo ""
echo "ALL data on the server will be lost."
echo ""

# Prompt 1 — simple confirmation
read -rp "This will destroy all data. Continue? [y/N] " CONFIRM
if [[ "${CONFIRM}" != "y" && "${CONFIRM}" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

# Prompt 2 — explicit active deployment deletion acknowledgement
read -rp "Type 'I agree to delete active deployment' to proceed: " CONFIRM
if [[ "${CONFIRM}" != "I agree to delete active deployment" ]]; then
  echo "Aborted."
  exit 0
fi

# ─── Pre-flight: verify SSH connectivity ─────────────────────────────────────

log_section "Pre-flight: SSH connectivity"

if ! ssh ${SSH_OPTS} "root@${SERVER_IP}" 'echo ok' > /dev/null 2>&1; then
  die "Cannot connect to server via SSH. Check that the server is running and reachable.
  Try: ssh root@${SERVER_IP}"
fi

log_ok "SSH connectivity verified"

# ─── Pre-flight: verify local dependencies ───────────────────────────────────

for cmd in curl jq; do
  command -v "$cmd" &>/dev/null || die "'$cmd' is required but not installed."
done

# ─── Pre-flight: verify remote dependencies ──────────────────────────────────

log_info "Checking remote dependencies..."
for cmd in jq; do
  if ! ssh ${SSH_OPTS} "root@${SERVER_IP}" "command -v $cmd &>/dev/null" 2>/dev/null; then
    log_warn "'$cmd' is not installed on the remote server. Auto-installing..."
    ssh ${SSH_OPTS} "root@${SERVER_IP}" "apt-get update -qq && apt-get install -y -qq $cmd" || \
      die "Failed to install '$cmd' on the remote server.
  Install it manually: ssh root@${SERVER_IP} 'apt-get update && apt-get install -y $cmd'"
    log_ok "'$cmd' installed on remote server."
  fi
done
log_ok "Remote dependencies verified"

# ═══════════════════════════════════════════════════════════════════════════════
# Step 1 — Reset (wipe everything + seed admin)
# ═══════════════════════════════════════════════════════════════════════════════

log_section "Step 1/3: Reset server (wipe + seed admin)"

ADMIN_EMAIL="${ADMIN_EMAIL}" ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
  "${SCRIPT_DIR}/reset.sh" --env "${HEROBIDS_ENV}" --yes --seed "${SERVER_IP}" || \
  die "reset.sh failed. Aborting."

log_ok "Reset complete — server is fresh, admin seeded."

# ═══════════════════════════════════════════════════════════════════════════════
# Step 2 — Prepare server-side env file
# ═══════════════════════════════════════════════════════════════════════════════

log_section "Step 2/3: Provision user + credentials + connections"

# Build a server-side env file with API_BASE_URL pointing at the Docker
# internal network (http://api:3000). Scripts running on the server must
# use the Docker service name, not the public HTTPS URL — especially
# after a reset when Caddy TLS certs may still be provisioning.
SERVER_ENV="$(mktemp)"
trap 'rm -f "$SERVER_ENV"' EXIT

cat > "$SERVER_ENV" << EOF
# Server-side env generated by reset-and-run.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ)
# API_BASE_URL uses localhost — quick-setup-remote.sh runs on the host OS via SSH,
# not inside Docker. Port 3000 is exposed to the host (3000:3000 in compose).
API_BASE_URL=http://localhost:3000
AUTH_EMAIL=${AUTH_EMAIL}
AUTH_PASSWORD=${AUTH_PASSWORD}
SETUP_DISPLAY_NAME=${SETUP_DISPLAY_NAME}
SETUP_MODE=${SETUP_MODE:-auto}
SETUP_PROVIDER=${SETUP_PROVIDER:-}
SETUP_LABEL=${SETUP_LABEL:-}
CREDENTIAL_VENUE=${CREDENTIAL_VENUE:-}
CREDENTIAL_LABEL=${CREDENTIAL_LABEL:-}
CONNECTION_PROVIDER=${CONNECTION_PROVIDER:-}
CONNECTION_LABEL=${CONNECTION_LABEL:-}
HL_API_KEY=${HL_API_KEY:-}
HL_SECRET=${HL_SECRET:-}
HL_WALLET_ADDRESS=${HL_WALLET_ADDRESS:-}
ONEINCH_API_KEY=${ONEINCH_API_KEY:-}
ONEINCH_PRIVATE_KEY=${ONEINCH_PRIVATE_KEY:-}
TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-}
EOF

# Upload env file to server
log_info "Uploading server-side env file..."
scp ${SSH_OPTS} "$SERVER_ENV" "root@${SERVER_IP}:/tmp/herobids-setup.env" || \
  die "Failed to upload env file to server."

log_ok "Server-side env file uploaded to /tmp/herobids-setup.env"

# ─── Run quick-setup-remote.sh on the server ───────────────────────────────────

log_info "Running quick-setup-remote.sh on server (this may take a minute)..."

ssh ${SSH_OPTS} "root@${SERVER_IP}" bash -s << 'REMOTE_SETUP'
set -euo pipefail
cd /opt/herobids

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Running quick-setup-remote.sh..."
bash scripts/shell/ops/quick-setup-remote.sh --env-file /tmp/herobids-setup.env --yes || {
  echo "ERROR: quick-setup-remote.sh failed."
  exit 1
}

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Quick-setup complete."
REMOTE_SETUP

exit_code=$?
if [[ $exit_code -ne 0 ]]; then
  die "quick-setup-remote.sh failed on server (exit code: ${exit_code})."
fi

log_ok "User account, credentials, and venue connections provisioned."

# ═══════════════════════════════════════════════════════════════════════════════
# Step 3 — Create agents
# ═══════════════════════════════════════════════════════════════════════════════

log_section "Step 3/3: Create agents"

# Upload create-agents.sh to the server (it may not be in the deployed commit)
log_info "Uploading create-agents.sh to server..."
scp ${SSH_OPTS} "${SCRIPT_DIR}/create-agents.sh" "root@${SERVER_IP}:/tmp/create-agents.sh" || \
  die "Failed to upload create-agents.sh to server."

# Upload the security audit prompt file (not in the deployed commit either)
log_info "Uploading security-audit-prompt.md to server..."
scp ${SSH_OPTS} "${REPO_ROOT}/docs/agents/prompts/security-audit-prompt.md" "root@${SERVER_IP}:/tmp/security-audit-prompt.md" || \
  die "Failed to upload security-audit-prompt.md to server."

# Build agent env overrides
AGENT_ENV_VARS=(
  "AGENT_PROVIDER=${AGENT_PROVIDER:-openrouter}"
  "AGENT_LIGHT_MODEL=${AGENT_LIGHT_MODEL:-deepseek/deepseek-v4-flash}"
  "AGENT_HEAVY_MODEL=${AGENT_HEAVY_MODEL:-deepseek/deepseek-v4-pro}"
  "AGENT_TICK_INTERVAL_MS=${AGENT_TICK_INTERVAL_MS:-86400000}"
  "SECURITY_AUDIT_PROMPT_FILE=/tmp/security-audit-prompt.md"
)

log_info "Running create-agents.sh on server..."

ssh ${SSH_OPTS} "root@${SERVER_IP}" bash -s << REMOTE_AGENTS
set -euo pipefail

# Export agent config overrides
$(for var in "${AGENT_ENV_VARS[@]}"; do echo "export ${var}"; done)

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Running create-agents.sh..."
bash /tmp/create-agents.sh --env-file /tmp/herobids-setup.env || {
  echo "ERROR: create-agents.sh failed."
  exit 1
}

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Agent creation complete."
REMOTE_AGENTS

exit_code=$?
if [[ $exit_code -ne 0 ]]; then
  die "create-agents.sh failed on server (exit code: ${exit_code})."
fi

log_ok "Agent created."

# ─── Cleanup server temp files ───────────────────────────────────────────────

log_info "Cleaning up server temp files..."
ssh ${SSH_OPTS} "root@${SERVER_IP}" 'rm -f /tmp/herobids-setup.env /tmp/create-agents.sh /tmp/security-audit-prompt.md' || true

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════

log_section "Reset + Provision Complete"

FRONTEND_URL="$(terraform_output -raw frontend_url 2>/dev/null || echo "http://${SERVER_IP}")"

echo ""
echo "========================================"
echo " Reset + Run Complete"
echo "========================================"
echo ""
echo "  Server:       ${SERVER_IP}"
echo "  Admin user:   ${ADMIN_EMAIL}"
echo "  Setup user:   ${AUTH_EMAIL}"
echo "  Agents:       security-auditor"
echo "  Agent LLM:    ${AGENT_PROVIDER:-openrouter} / ${AGENT_LIGHT_MODEL:-deepseek/deepseek-v4-flash}"
echo "  Exec mode:    N/A (non-trading agent)"
echo ""
echo "  Frontend:     ${FRONTEND_URL}"
echo "  API health:   http://${SERVER_IP}:3000/health"
echo "  SSH:          ssh root@${SERVER_IP}"
echo "  Logs:         ${SCRIPT_DIR}/logs.sh ${SERVER_IP}"
echo ""
echo "Agents are in 'stopped' state. Start them via the API or UI when ready."
echo "========================================"

# Clean up local temp file
rm -f "$SERVER_ENV"
trap - EXIT
