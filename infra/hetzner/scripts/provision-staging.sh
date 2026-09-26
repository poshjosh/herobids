#!/usr/bin/env bash
# provision-staging.sh — plan or explicitly provision Herobids staging.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VAR_FILE="${TF_DIR}/staging.tfvars"
BACKEND_ENV_FILE="${TF_DIR}/.env.backend"
APPLY=false

usage() {
  cat <<'USAGE'
Usage: provision-staging.sh [--backend-env-file PATH] [--apply]

By default, builds and displays a staging-only Terraform plan without applying it.
Pass --apply to review the plan and explicitly confirm provisioning.

The script always uses staging.tfvars, the existing staging workspace, and
the S3 key herobids/staging/terraform.tfstate. It never changes DNS or deploys
Traderton.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend-env-file)
      [[ $# -ge 2 && -n "$2" ]] || { echo "ERROR: --backend-env-file requires a path." >&2; exit 2; }
      BACKEND_ENV_FILE="$2"
      shift 2
      ;;
    --apply)
      APPLY=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "${BACKEND_ENV_FILE}" != /* ]]; then
  BACKEND_ENV_FILE="${TF_DIR}/${BACKEND_ENV_FILE}"
fi

for command_name in terraform jq; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "ERROR: ${command_name} is required." >&2
    exit 1
  fi
done

[[ -f "${VAR_FILE}" ]] || { echo "ERROR: staging.tfvars not found at ${VAR_FILE}." >&2; exit 1; }
[[ -f "${BACKEND_ENV_FILE}" ]] || { echo "ERROR: Backend env file not found at ${BACKEND_ENV_FILE}." >&2; exit 1; }

set -a
# shellcheck source=/dev/null
source "${BACKEND_ENV_FILE}"
set +a

for variable_name in TF_BACKEND_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "ERROR: ${variable_name} is required in ${BACKEND_ENV_FILE} or the environment." >&2
    exit 1
  fi
done
TF_BACKEND_REGION="${TF_BACKEND_REGION:-us-east-1}"

# Do not allow inherited Terraform environment settings to redirect this
# staging-only command or inject unreviewed CLI arguments.
unset TF_WORKSPACE TF_CLI_ARGS TF_CLI_ARGS_init TF_CLI_ARGS_workspace
unset TF_CLI_ARGS_validate TF_CLI_ARGS_plan TF_CLI_ARGS_show TF_CLI_ARGS_apply
unset TF_CLI_ARGS_output

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/herobids-staging.XXXXXX")"
trap 'rm -rf "${WORK_DIR}"' EXIT
export TF_DATA_DIR="${WORK_DIR}/terraform-data"
mkdir -p "${TF_DATA_DIR}"
PLAN_FILE="${WORK_DIR}/staging.tfplan"

cd "${TF_DIR}"

INIT_ARGS=(
  -input=false
  -reconfigure
  -lockfile=readonly
  "-backend-config=bucket=${TF_BACKEND_BUCKET}"
  "-backend-config=key=herobids/staging/terraform.tfstate"
  "-backend-config=region=${TF_BACKEND_REGION}"
)
if [[ -n "${TF_BACKEND_DYNAMODB_TABLE:-}" ]]; then
  INIT_ARGS+=("-backend-config=dynamodb_table=${TF_BACKEND_DYNAMODB_TABLE}")
fi

terraform init "${INIT_ARGS[@]}"
if ! terraform workspace select staging; then
  echo "ERROR: The staging workspace does not exist; refusing to create or mutate workspace state." >&2
  exit 1
fi
terraform validate -no-color
terraform plan -input=false -no-color -var-file="${VAR_FILE}" -out="${PLAN_FILE}"

PLAN_JSON="$(terraform show -json "${PLAN_FILE}")"
if ! jq -e '
  def allowed_address($address):
    [
      "hcloud_firewall.default",
      "hcloud_firewall.agent[0]",
      "hcloud_network.private[0]",
      "hcloud_network_subnet.private[0]",
      "hcloud_server.agent[0]",
      "hcloud_server.default",
      "hcloud_server_network.agent[0]",
      "hcloud_server_network.control_plane[0]",
      "hcloud_ssh_key.default"
    ] | index($address) != null;

  def one_resource($address):
    [.planned_values.root_module.resources[]? | select(.address == $address)] | length == 1;

  def references($resource; $field; $target):
    [.configuration.root_module.resources[]? | select(.address == $resource) |
      ((.expressions[$field].references // []) | index($target) != null)] == [true];

  def ids_match($resource; $field; $target):
    [.planned_values.root_module.resources[]? | select(.address == $resource) | .values[$field]] as $ids |
    [.planned_values.root_module.resources[]? | select(.address == $target) | .values.id] as $target_ids |
    ($ids | length == 1) and ($target_ids | length == 1) and
    ($ids[0] == null or $target_ids[0] == null or $ids[0] == $target_ids[0]);

  def cidr_parts:
    capture("^(?<address>[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+)/(?<prefix>[0-9]+)$") as $cidr |
    ($cidr.address | split(".") | map(tonumber)) as $octets |
    ($cidr.prefix | tonumber) as $prefix |
    if ($octets | all(. >= 0 and . <= 255)) and $prefix <= 32 then
      {address: ($octets | reduce .[] as $octet (0; . * 256 + $octet)), prefix: $prefix}
    else error("invalid IPv4 CIDR") end;

  def subnet_within_network:
    try (
      ([.planned_values.root_module.resources[]? | select(.address == "hcloud_network.private[0]") | .values.ip_range] | .[0] | cidr_parts) as $network |
      ([.planned_values.root_module.resources[]? | select(.address == "hcloud_network_subnet.private[0]") | .values.ip_range] | .[0] | cidr_parts) as $subnet |
      $subnet.prefix >= $network.prefix and
      (($subnet.address / pow(2; 32 - $network.prefix) | floor) ==
       ($network.address / pow(2; 32 - $network.prefix) | floor))
    ) catch false;

  .planned_values.outputs.environment.value == "staging" and
  .planned_values.outputs.frontend_url.value == "https://staging.openaidom.com" and
  .planned_values.outputs.nomad_enabled.value == true and
  ([.planned_values.root_module.resources[]? | select(.address == "hcloud_server.default") | .values.name] == ["herobids-staging"]) and
  (one_resource("hcloud_network.private[0]")) and
  (one_resource("hcloud_network_subnet.private[0]")) and
  (one_resource("hcloud_server_network.control_plane[0]")) and
  subnet_within_network and
  ([.planned_values.root_module.resources[]? | select(.address == "hcloud_network.private[0]") | .values.name] == ["herobids-staging-net"]) and
  (references("hcloud_network_subnet.private"; "network_id"; "hcloud_network.private[0].id")) and
  (references("hcloud_server_network.control_plane"; "network_id"; "hcloud_network.private[0].id")) and
  (references("hcloud_server_network.control_plane"; "server_id"; "hcloud_server.default.id")) and
  (ids_match("hcloud_network_subnet.private[0]"; "network_id"; "hcloud_network.private[0]")) and
  (ids_match("hcloud_server_network.control_plane[0]"; "network_id"; "hcloud_network.private[0]")) and
  (ids_match("hcloud_server_network.control_plane[0]"; "server_id"; "hcloud_server.default")) and
  ([.planned_values.root_module.resources[]? | select((allowed_address(.address) | not))] | length == 0) and
  ([.planned_values.root_module.resources[]? | select(.values.labels.environment? != null) | .values.labels.environment] | all(. == "staging")) and
  ([.resource_changes[]? | select((allowed_address(.address) | not) or any(.change.actions[]?; . != "create" and . != "read" and . != "no-op"))] | length == 0)
' <<<"${PLAN_JSON}" >/dev/null; then
  echo "ERROR: Plan contains an unexpected resource, non-staging identity, invalid private network topology, or unsupported action; refusing to apply." >&2
  exit 1
fi

echo ""
echo "==> Reviewed plan for Herobids staging (no DNS or Traderton changes):"
terraform show -no-color "${PLAN_FILE}"

if [[ "${APPLY}" != "true" ]]; then
  echo ""
  echo "Plan only; no infrastructure changes were applied. Re-run with --apply to request provisioning."
  exit 0
fi

echo ""
read -r -p "Type 'provision staging' to apply this exact plan: " CONFIRMATION
if [[ "${CONFIRMATION}" != "provision staging" ]]; then
  echo "Aborted; no infrastructure changes were applied."
  exit 1
fi

terraform apply -input=false -auto-approve "${PLAN_FILE}"

SERVER_IPV4="$(terraform output -raw server_ipv4)"
PRIVATE_NETWORK_ID="$(terraform output -raw private_network_id)"
PRIVATE_SUBNET_CIDR="$(terraform output -raw private_subnet_ip_range)"
CONTROL_PLANE_PRIVATE_IP="$(terraform output -raw control_plane_private_ip)"
printf '\nHerobids staging provisioned.\n'
printf 'Server IPv4: %s\n' "${SERVER_IPV4}"
printf 'Private network ID: %s\n' "${PRIVATE_NETWORK_ID}"
printf 'Private subnet CIDR: %s\n' "${PRIVATE_SUBNET_CIDR}"
printf 'Control-plane private IP: %s\n' "${CONTROL_PLANE_PRIVATE_IP}"
printf 'Public URL (verify DNS ownership before changing records): https://staging.openaidom.com\n'
printf 'Traderton is not provisioned by this script.\n'