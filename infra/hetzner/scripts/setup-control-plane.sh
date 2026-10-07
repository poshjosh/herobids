#!/usr/bin/env bash
# setup-control-plane.sh — Converge an existing control plane with the committed
# cloud-init (Nomad advertise via nomad-private-ip.service + UFW rules).
#
# Uploads converge-control-plane.sh to the server and runs it there. Existing
# control planes never receive cloud-init changes (hcloud_server.default ignores
# user_data changes), so deploy.sh runs this on every deploy. Idempotent.
#
# Usage:
#   infra/hetzner/scripts/setup-control-plane.sh [--env <staging|production>] [<server-ip>]
#
# Environment:
#   HEROBIDS_ENV              Deployment environment: staging | production (default: production).
#   HEROBIDS_NOMAD_ENABLED    Override terraform output nomad_enabled (true | false).
#   HEROBIDS_PRIVATE_SUBNET   Override the private subnet CIDR (default: terraform output
#                             private_subnet_ip_range).
#
# Without usable Terraform state (e.g. no local workspace), pass the server IP and set
# both overrides:
#   HEROBIDS_NOMAD_ENABLED=true HEROBIDS_PRIVATE_SUBNET=10.0.0.0/24 \
#     infra/hetzner/scripts/setup-control-plane.sh --env staging <server-ip>

set -euo pipefail

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_ssh_opts.sh"

# ─── Parse environment flag first ────────────────────────────────────────────

parse_env_flag "$@"
shift $((HEROBIDS_ENV_SHIFT)) 2>/dev/null || true

# Must match docker-compose.yaml networks.default.ipam.config[0].subnet
# (asserted by scripts/tests/test-converge-control-plane.sh).
DOCKER_BRIDGE_SUBNET="172.18.0.0/16"
REMOTE_SCRIPT="/usr/local/sbin/herobids-converge-control-plane.sh"
CIDR_REGEX='^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$'

# ─── Parse arguments ─────────────────────────────────────────────────────────

SERVER_IP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      echo "Usage: $0 [--env <staging|production>] [<server-ip>]" >&2
      echo "" >&2
      echo "Converges the control plane's Nomad advertise config and UFW rules" >&2
      echo "with infra/hetzner/cloud-init.yaml. Restarts Nomad only if needed." >&2
      echo "" >&2
      echo "Options:" >&2
      echo "  --env <name>   Target environment: staging or production (default: production)." >&2
      echo "  <server-ip>    Server IP address (auto-detected from terraform if omitted)." >&2
      echo "" >&2
      echo "Environment variables:" >&2
      echo "  HEROBIDS_NOMAD_ENABLED   true|false; overrides terraform output nomad_enabled." >&2
      echo "  HEROBIDS_PRIVATE_SUBNET  Private subnet CIDR (default: terraform output private_subnet_ip_range)." >&2
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

# ─── Skip when Nomad is not provisioned ──────────────────────────────────────
# Skip ONLY on a literal "false". A Terraform error (missing workspace, creds or
# binary) must fail loudly, not look like "Nomad disabled" and skip convergence.

NOMAD_ENABLED_SOURCE="terraform output nomad_enabled (workspace ${HEROBIDS_ENV})"
TF_ERROR_FILE="$(mktemp)"
trap 'rm -f "${TF_ERROR_FILE}"' EXIT
if [[ -n "${HEROBIDS_NOMAD_ENABLED:-}" ]]; then
  NOMAD_ENABLED="${HEROBIDS_NOMAD_ENABLED}"
  NOMAD_ENABLED_SOURCE="HEROBIDS_NOMAD_ENABLED"
else
  NOMAD_ENABLED="$(terraform_output -raw nomad_enabled 2>"${TF_ERROR_FILE}" || true)"
fi

case "${NOMAD_ENABLED}" in
  true) ;;
  false)
    echo "Nomad not enabled for ${HEROBIDS_ENV} (${NOMAD_ENABLED_SOURCE} = false) — skipping control-plane convergence."
    exit 0
    ;;
  *)
    echo "ERROR: Could not determine whether Nomad is enabled for ${HEROBIDS_ENV} (${NOMAD_ENABLED_SOURCE} = '${NOMAD_ENABLED}')." >&2
    if [[ -s "${TF_ERROR_FILE}" ]]; then
      echo "  terraform said:" >&2
      sed 's/^/    /' "${TF_ERROR_FILE}" | head -5 >&2
    fi
    echo "  Fix Terraform access for workspace '${HEROBIDS_ENV}', or set" >&2
    echo "  HEROBIDS_NOMAD_ENABLED=true HEROBIDS_PRIVATE_SUBNET=<cidr> and pass <server-ip>." >&2
    exit 1
    ;;
esac

# ─── Resolve inputs ──────────────────────────────────────────────────────────

if [[ -z "${SERVER_IP}" ]]; then
  SERVER_IP="$(terraform_output -raw server_ipv4 2>/dev/null || true)"
fi
if [[ -z "${SERVER_IP}" ]]; then
  echo "ERROR: No server IP provided and none found in terraform output server_ipv4." >&2
  echo "Usage: $0 [--env <staging|production>] [<server-ip>]" >&2
  exit 1
fi

# HEROBIDS_-prefixed so a stray exported PRIVATE_SUBNET can't override Terraform.
if [[ -n "${HEROBIDS_PRIVATE_SUBNET:-}" ]]; then
  PRIVATE_SUBNET="${HEROBIDS_PRIVATE_SUBNET}"
  PRIVATE_SUBNET_SOURCE="HEROBIDS_PRIVATE_SUBNET"
else
  PRIVATE_SUBNET="$(terraform_output -raw private_subnet_ip_range 2>/dev/null || true)"
  PRIVATE_SUBNET_SOURCE="terraform output private_subnet_ip_range (workspace ${HEROBIDS_ENV})"
fi
if [[ ! "${PRIVATE_SUBNET}" =~ ${CIDR_REGEX} ]]; then
  echo "ERROR: Could not determine the private subnet CIDR from ${PRIVATE_SUBNET_SOURCE} (got '${PRIVATE_SUBNET}')." >&2
  echo "  Run 'terraform apply' (or refresh) for workspace ${HEROBIDS_ENV}, or set HEROBIDS_PRIVATE_SUBNET=<cidr>." >&2
  exit 1
fi

# ─── Upload and run ──────────────────────────────────────────────────────────

echo "==> [${HEROBIDS_ENV}] Converging control plane ${SERVER_IP} (private ${PRIVATE_SUBNET} from ${PRIVATE_SUBNET_SOURCE}; bridge ${DOCKER_BRIDGE_SUBNET})..."

scp ${SSH_OPTS} "${SCRIPT_DIR}/converge-control-plane.sh" "root@${SERVER_IP}:${REMOTE_SCRIPT}"
ssh ${SSH_OPTS} "root@${SERVER_IP}" "chmod 0755 ${REMOTE_SCRIPT}"

# Inputs are validated CIDRs above, so plain interpolation is safe here.
RC=0
ssh ${SSH_OPTS} "root@${SERVER_IP}" \
  "PRIVATE_SUBNET=${PRIVATE_SUBNET} DOCKER_BRIDGE_SUBNET=${DOCKER_BRIDGE_SUBNET} ${REMOTE_SCRIPT}" || RC=$?

if [[ ${RC} -ne 0 ]]; then
  echo "ERROR: control-plane convergence failed on ${SERVER_IP} (exit ${RC})." >&2
fi
exit "${RC}"
