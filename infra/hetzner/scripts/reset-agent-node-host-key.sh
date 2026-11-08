#!/usr/bin/env bash
# reset-agent-node-host-key.sh — Read-only check of a staging agent's host key.
#
# 1. Reads staging Terraform state and shows which server owns the agent IP.
# 2. Shows the host key the network presents, then prints the command to run on
#    the server through the Hetzner console. The fingerprint must come from the
#    server, not the network. The script does not change known_hosts.
#
# Usage: infra/hetzner/scripts/reset-agent-node-host-key.sh [<agent-ip>]

set -euo pipefail

ENV="staging"
AGENT_IP="${1:-91.107.193.127}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${TF_DIR}"

echo "Loading backend credentials"
set -a
# shellcheck disable=SC1091
source .env.backend
set +a

# Same backend key and data dir as terraform_output in _ssh_opts.sh. The default
# .terraform directory points at production, so it is never used here.
export TF_DATA_DIR=".terraform-envs/${ENV}"
unset TF_WORKSPACE
backend_args=(
  -input=false -reconfigure
  "-backend-config=bucket=${TF_BACKEND_BUCKET}"
  "-backend-config=key=herobids/${ENV}/terraform.tfstate"
  "-backend-config=region=${TF_BACKEND_REGION}"
)
if [[ -n "${TF_BACKEND_DYNAMODB_TABLE:-}" ]]; then
  backend_args+=("-backend-config=dynamodb_table=${TF_BACKEND_DYNAMODB_TABLE}")
fi
terraform init "${backend_args[@]}" >/dev/null
terraform workspace select "${ENV}" >/dev/null

echo ""
echo "Server behind ${AGENT_IP} (${ENV} state):"
owner_found=false
while read -r addr; do
  attrs="$(terraform state show "${addr}")"
  if grep -q "ipv4_address *= *\"${AGENT_IP}\"" <<< "${attrs}"; then
    owner_found=true
    grep -E '^\s*(id|name|ipv4_address)\s' <<< "${attrs}" | sed "s/^/  ${addr}  /"
  fi
done < <(terraform state list | grep '^hcloud_server\.agent\[')

if [[ "${owner_found}" != "true" ]]; then
  echo "  No Terraform-managed server has ${AGENT_IP}. Stop: the node is unmanaged." >&2
  exit 1
fi

echo ""
echo "Host key the network presents for ${AGENT_IP} (ED25519):"
presented="$(ssh-keyscan -t ed25519 "${AGENT_IP}" 2>/dev/null | ssh-keygen -lf - || true)"
echo "  ${presented:-<no key returned>}"

echo ""
echo "Step 2 — run on the server, not on this machine:"
echo "  Hetzner Cloud Console → server → Console → log in as root, then run:"
echo "    ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
echo "  Do not reset the root password to get in."
echo "  If the console fingerprint matches the one above, the key is genuine."
echo "  If it differs, stop and do not connect."
echo ""
echo "Step 3 — only after the fingerprints match:"
echo "  ssh-keygen -R ${AGENT_IP}"
