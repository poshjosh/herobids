#!/usr/bin/env bash
# setup-autoscale-env.sh — Upload autoscale secrets to /etc/herobids/autoscale.env.
#
# Reads AWS/Terraform backend credentials and optional Nomad ACL token from the
# operator's environment, generates a systemd EnvironmentFile, uploads it to the
# server, and restarts the systemd daemon so units referencing the file pick up
# the new values.
#
# If NOMAD_ACL_TOKEN is set, also writes it to /etc/nomad.d/acl-token.
#
# Usage:
#   infra/hetzner/scripts/setup-autoscale-env.sh [--env <staging|production>] [--dry-run] [<server-ip>]
#
# Environment:
#   TF_BACKEND_BUCKET          (required) S3 bucket for terraform state.
#   TF_BACKEND_REGION          (optional) AWS region, defaults to us-east-1.
#   TF_BACKEND_DYNAMODB_TABLE  (optional) DynamoDB table for state locking.
#   AWS_ACCESS_KEY_ID          (required) AWS access key.
#   AWS_SECRET_ACCESS_KEY      (required) AWS secret key.
#   NOMAD_ACL_TOKEN            (optional) Nomad ACL token.
#   HEROBIDS_ENV               Deployment environment: staging | production (default: production).

set -euo pipefail

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(dirname "$SCRIPT_DIR")"
source "$(dirname "${BASH_SOURCE[0]}")/_ssh_opts.sh"

# ─── Parse environment flag first ────────────────────────────────────────────

parse_env_flag "$@"
shift $((HEROBIDS_ENV_SHIFT)) 2>/dev/null || true

# ─── Parse arguments ─────────────────────────────────────────────────────────

SERVER_IP=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--env <staging|production>] [--dry-run] [<server-ip>]" >&2
      echo "" >&2
      echo "Options:" >&2
      echo "  --env <name>      Target environment: staging or production (default: production)." >&2
      echo "  --dry-run         Print what would be uploaded without actually uploading." >&2
      echo "  <server-ip>       Server IP address (auto-detected from terraform if omitted)." >&2
      echo "" >&2
      echo "Required environment variables:" >&2
      echo "  TF_BACKEND_BUCKET        S3 bucket for terraform state." >&2
      echo "  AWS_ACCESS_KEY_ID        AWS access key." >&2
      echo "  AWS_SECRET_ACCESS_KEY    AWS secret key." >&2
      echo "" >&2
      echo "Optional environment variables:" >&2
      echo "  TF_BACKEND_REGION        AWS region (default: us-east-1)." >&2
      echo "  TF_BACKEND_DYNAMODB_TABLE DynamoDB table for state locking." >&2
      echo "  NOMAD_ACL_TOKEN          Nomad ACL token." >&2
      exit 0
      ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2
      exit 1
      ;;
    *)
      SERVER_IP="$1"
      shift
      ;;
  esac
done

# ─── Validate required environment variables ─────────────────────────────────

MISSING=()
[[ -z "${TF_BACKEND_BUCKET:-}" ]]      && MISSING+=("TF_BACKEND_BUCKET")
[[ -z "${AWS_ACCESS_KEY_ID:-}" ]]       && MISSING+=("AWS_ACCESS_KEY_ID")
[[ -z "${AWS_SECRET_ACCESS_KEY:-}" ]]   && MISSING+=("AWS_SECRET_ACCESS_KEY")

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "ERROR: Missing required environment variables:" >&2
  for var in "${MISSING[@]}"; do
    echo "  - ${var}" >&2
  done
  exit 1
fi

# ─── Apply defaults ──────────────────────────────────────────────────────────

TF_BACKEND_REGION="${TF_BACKEND_REGION:-us-east-1}"
TF_BACKEND_DYNAMODB_TABLE="${TF_BACKEND_DYNAMODB_TABLE:-}"
NOMAD_ACL_TOKEN="${NOMAD_ACL_TOKEN:-}"

# ─── Generate env file content ───────────────────────────────────────────────

ENV_CONTENT="AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
TF_BACKEND_BUCKET=${TF_BACKEND_BUCKET}
TF_BACKEND_REGION=${TF_BACKEND_REGION}
TF_BACKEND_DYNAMODB_TABLE=${TF_BACKEND_DYNAMODB_TABLE}
NOMAD_TOKEN=${NOMAD_ACL_TOKEN}"

# ─── Dry-run mode ────────────────────────────────────────────────────────────

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[dry-run] Would upload to /etc/herobids/autoscale.env:"
  echo "---"
  echo "${ENV_CONTENT}"
  echo "---"
  echo "[dry-run] Would set permissions to 0600 on /etc/herobids/autoscale.env"
  echo "[dry-run] Would run systemctl daemon-reload"
  if [[ -n "${NOMAD_ACL_TOKEN}" ]]; then
    echo "[dry-run] Would write NOMAD_ACL_TOKEN to /etc/nomad.d/acl-token (0600)"
  else
    echo "[dry-run] NOMAD_ACL_TOKEN not set — would skip acl-token file"
  fi
  exit 0
fi

# ─── Determine server IP (if not provided explicitly) ────────────────────────

if [[ -z "${SERVER_IP}" ]]; then
  if command -v terraform &>/dev/null; then
    SERVER_IP="$(terraform_output -raw server_ipv4 2>/dev/null || true)"
  fi
fi

if [[ -z "${SERVER_IP}" ]]; then
  echo "ERROR: No server IP provided." >&2
  echo "" >&2
  echo "Usage: $0 [--env <staging|production>] [--dry-run] [<server-ip>]" >&2
  echo "  Or run provision.sh first to provision the server:" >&2
  echo "    infra/hetzner/scripts/provision.sh --env ${HEROBIDS_ENV}" >&2
  echo "" >&2
  echo "terraform not found in PATH; provide server IP as argument: $0 <ip>" >&2
  exit 1
fi

# ─── Upload autoscale.env ────────────────────────────────────────────────────

echo "==> [${HEROBIDS_ENV}] Ensuring target directory exists on ${SERVER_IP}..."
ssh ${SSH_OPTS} "root@${SERVER_IP}" 'mkdir -p /etc/herobids' || {
  echo "ERROR: Cannot create /etc/herobids on server." >&2
  exit 1
}

TMPFILE="$(mktemp)"
trap 'rm -f "${TMPFILE}"' EXIT
echo "${ENV_CONTENT}" > "${TMPFILE}"

echo "==> Uploading autoscale.env to root@${SERVER_IP}:/etc/herobids/autoscale.env ..."
scp ${SSH_OPTS} "${TMPFILE}" "root@${SERVER_IP}:/etc/herobids/autoscale.env"

echo "==> Setting restrictive permissions (chmod 0600)..."
ssh ${SSH_OPTS} "root@${SERVER_IP}" 'chmod 0600 /etc/herobids/autoscale.env'

# ─── Write Nomad ACL token file (T4) ─────────────────────────────────────────

if [[ -n "${NOMAD_ACL_TOKEN}" ]]; then
  echo "==> Writing Nomad ACL token to /etc/nomad.d/acl-token ..."
  ssh ${SSH_OPTS} "root@${SERVER_IP}" 'mkdir -p /etc/nomad.d'
  printf '%s' "${NOMAD_ACL_TOKEN}" | ssh ${SSH_OPTS} "root@${SERVER_IP}" 'cat > /etc/nomad.d/acl-token && chmod 0600 /etc/nomad.d/acl-token'
else
  echo "WARNING: NOMAD_ACL_TOKEN not set — Nomad ACL token was not deployed."
fi

# ─── Reload systemd ──────────────────────────────────────────────────────────

echo "==> Running systemctl daemon-reload ..."
ssh ${SSH_OPTS} "root@${SERVER_IP}" 'systemctl daemon-reload'

echo ""
echo "==> Done. autoscale.env uploaded and permissions set."
echo "    Path on server: /etc/herobids/autoscale.env"
echo "    Permissions:    0600 (owner read/write only)"
if [[ -n "${NOMAD_ACL_TOKEN}" ]]; then
  echo "    Nomad ACL:      /etc/nomad.d/acl-token (0600)"
fi
