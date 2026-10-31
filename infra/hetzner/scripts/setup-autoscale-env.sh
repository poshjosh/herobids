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
#   HCLOUD_TOKEN               (required) Hetzner API token. Falls back to the hcloud_token
#                              line in ${HEROBIDS_ENV}.tfvars, the same source provision.sh uses.
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
      echo "  HCLOUD_TOKEN             Hetzner API token (or hcloud_token in <env>.tfvars)." >&2
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

# ─── Resolve HCLOUD_TOKEN ────────────────────────────────────────────────────

# The autoscale units read HCLOUD_TOKEN from autoscale.env (EnvironmentFile), so it
# must be written here. Only the Hetzner token is taken from the tfvars file; the
# settings allowlist (render-autoscale-settings.sh) never carries it.
HCLOUD_TOKEN="${HCLOUD_TOKEN:-}"
if [[ -z "${HCLOUD_TOKEN}" && -f "${TF_DIR}/${HEROBIDS_ENV}.tfvars" ]]; then
  HCLOUD_TOKEN="$(sed -nE 's/^[[:space:]]*hcloud_token[[:space:]]*=[[:space:]]*"([^"]*)".*$/\1/p' \
    "${TF_DIR}/${HEROBIDS_ENV}.tfvars" | head -n 1)"
fi
if [[ -z "${HCLOUD_TOKEN}" ]]; then
  echo "ERROR: HCLOUD_TOKEN is not set and ${HEROBIDS_ENV}.tfvars has no hcloud_token." >&2
  exit 1
fi
# Restrict to a charset that is safe as a bare EnvironmentFile value. Do not echo the value.
if [[ ! "${HCLOUD_TOKEN}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "ERROR: HCLOUD_TOKEN contains characters that cannot be written to autoscale.env safely." >&2
  exit 1
fi

# Values are written unquoted into an EnvironmentFile, so whitespace, quotes, newlines and
# '$' are refused. The error names the variable and never echoes its value.
check_env_value() {
  local name="$1" value="$2"
  if [[ -n "${value}" && ! "${value}" =~ ^[A-Za-z0-9._/+=-]+$ ]]; then
    echo "ERROR: ${name} contains characters that cannot be written to autoscale.env safely." >&2
    exit 1
  fi
}
check_env_value AWS_ACCESS_KEY_ID "${AWS_ACCESS_KEY_ID}"
check_env_value AWS_SECRET_ACCESS_KEY "${AWS_SECRET_ACCESS_KEY}"
check_env_value TF_BACKEND_BUCKET "${TF_BACKEND_BUCKET}"
check_env_value TF_BACKEND_REGION "${TF_BACKEND_REGION}"
check_env_value TF_BACKEND_DYNAMODB_TABLE "${TF_BACKEND_DYNAMODB_TABLE}"
check_env_value NOMAD_ACL_TOKEN "${NOMAD_ACL_TOKEN}"

# ─── Generate env file content ───────────────────────────────────────────────

ENV_CONTENT="AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
TF_BACKEND_BUCKET=${TF_BACKEND_BUCKET}
TF_BACKEND_REGION=${TF_BACKEND_REGION}
TF_BACKEND_DYNAMODB_TABLE=${TF_BACKEND_DYNAMODB_TABLE}
NOMAD_TOKEN=${NOMAD_ACL_TOKEN}
HCLOUD_TOKEN=${HCLOUD_TOKEN}"

# ─── Dry-run mode ────────────────────────────────────────────────────────────

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[dry-run] Would upload to /etc/herobids/autoscale.env:"
  echo "---"
  printf '%s\n' "${ENV_CONTENT}" | sed -E 's/^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|NOMAD_TOKEN|HCLOUD_TOKEN)=.*/\1=<redacted>/'
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
printf '%s\n' "${ENV_CONTENT}" > "${TMPFILE}"

echo "==> Uploading autoscale.env to root@${SERVER_IP}:/etc/herobids/autoscale.env (0600) ..."
# Write a private tmp file under umask 077, then rename it over the target. Truncating the
# target in place would expose HCLOUD_TOKEN if it already existed with a looser mode. A stale
# tmp is removed first because cat > keeps the mode of an existing file.
ssh ${SSH_OPTS} "root@${SERVER_IP}" 'rm -f /etc/herobids/autoscale.env.tmp && umask 077 && cat > /etc/herobids/autoscale.env.tmp && chmod 0600 /etc/herobids/autoscale.env.tmp && mv -f /etc/herobids/autoscale.env.tmp /etc/herobids/autoscale.env || { rm -f /etc/herobids/autoscale.env.tmp; false; }' < "${TMPFILE}"

# ─── Write Nomad ACL token file (T4) ─────────────────────────────────────────

if [[ -n "${NOMAD_ACL_TOKEN}" ]]; then
  echo "==> Writing Nomad ACL token to /etc/nomad.d/acl-token ..."
  ssh ${SSH_OPTS} "root@${SERVER_IP}" 'mkdir -p /etc/nomad.d'
  printf '%s' "${NOMAD_ACL_TOKEN}" | ssh ${SSH_OPTS} "root@${SERVER_IP}" 'umask 077 && rm -f /etc/nomad.d/acl-token && cat > /etc/nomad.d/acl-token && chmod 0600 /etc/nomad.d/acl-token'
else
  echo "WARNING: NOMAD_ACL_TOKEN not set — Nomad ACL token was not deployed."
fi

# ─── Reload systemd ──────────────────────────────────────────────────────────

echo "==> Running systemctl daemon-reload ..."
ssh ${SSH_OPTS} "root@${SERVER_IP}" 'systemctl daemon-reload'

# ─── Upload tfvars file (required for terraform apply on the server) ──────────

# The autoscale scripts use tf_apply_var which reads the environment-specific
# tfvars file for required Terraform input variables (hcloud_token, deploy_ssh_private_key, etc.).
TFVARS_FILE="${TF_DIR}/${HEROBIDS_ENV}.tfvars"
if [[ -f "${TFVARS_FILE}" ]]; then
  echo "==> Uploading ${HEROBIDS_ENV}.tfvars to server..."
  # Streamed under umask 077 so the file never exists with a looser mode (scp would create it
  # under the default umask before chmod runs).
  REMOTE_TFVARS="/opt/herobids/infra/hetzner/${HEROBIDS_ENV}.tfvars"
  ssh ${SSH_OPTS} "root@${SERVER_IP}" "rm -f ${REMOTE_TFVARS}.tmp && umask 077 && cat > ${REMOTE_TFVARS}.tmp && chmod 0600 ${REMOTE_TFVARS}.tmp && mv -f ${REMOTE_TFVARS}.tmp ${REMOTE_TFVARS} || { rm -f ${REMOTE_TFVARS}.tmp; false; }" < "${TFVARS_FILE}"

  # Fix ssh_public_key_path: replace ~ with /root on the server-side copy.
  # The file() function in Terraform doesn't expand ~ on the server.
  ssh ${SSH_OPTS} "root@${SERVER_IP}" "sed -i 's|~/.ssh|/root/.ssh|g' /opt/herobids/infra/hetzner/${HEROBIDS_ENV}.tfvars"

  # Upload the SSH public key if the tfvars references one.
  SSH_PUB_KEY_PATH="$(grep -m1 'ssh_public_key_path' "${TFVARS_FILE}" 2>/dev/null | sed 's/.*"\(.*\)".*/\1/' | sed "s|~|${HOME}|")"
  if [[ -n "${SSH_PUB_KEY_PATH}" && -f "${SSH_PUB_KEY_PATH}" ]]; then
    echo "==> Uploading SSH public key to server..."
    ssh ${SSH_OPTS} "root@${SERVER_IP}" 'mkdir -p /root/.ssh'
    scp ${SSH_OPTS} "${SSH_PUB_KEY_PATH}" "root@${SERVER_IP}:/root/.ssh/$(basename "${SSH_PUB_KEY_PATH}")"
  fi

  echo "    Uploaded: /opt/herobids/infra/hetzner/${HEROBIDS_ENV}.tfvars (0600)"
else
  echo "WARNING: ${TFVARS_FILE} not found locally — terraform apply on the server may fail."
  echo "  The autoscale scripts need this file for required Terraform variables."
fi

echo ""
echo "==> Done. autoscale.env uploaded and permissions set."
echo "    Path on server: /etc/herobids/autoscale.env"
echo "    Permissions:    0600 (owner read/write only)"
if [[ -n "${NOMAD_ACL_TOKEN}" ]]; then
  echo "    Nomad ACL:      /etc/nomad.d/acl-token (0600)"
fi
