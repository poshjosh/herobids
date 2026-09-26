#!/usr/bin/env bash
# Test staging-only provisioning guards with a mocked Terraform CLI.

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "${TESTS_DIR}/.." && pwd)"
JQ_BIN="$(command -v jq)"
TEST_TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

MOCK_INFRA="${TEST_TMPDIR}/infra"
MOCK_BIN="${TEST_TMPDIR}/bin"
mkdir -p "${MOCK_INFRA}/scripts" "${MOCK_BIN}"
cp "${SCRIPTS_DIR}/provision-staging.sh" "${MOCK_INFRA}/scripts/"
: >"${MOCK_INFRA}/staging.tfvars"
printf 'TF_BACKEND_BUCKET=test-bucket\nAWS_ACCESS_KEY_ID=test-key\nAWS_SECRET_ACCESS_KEY=test-secret\n' >"${MOCK_INFRA}/.env.backend"

cat >"${MOCK_BIN}/terraform" <<'MOCK_TERRAFORM'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${TF_WORKSPACE:-}" || -n "${TF_CLI_ARGS:-}" || -n "${TF_CLI_ARGS_plan:-}" ]]; then
  echo "staging provisioner failed to clear inherited Terraform overrides" >&2
  exit 1
fi
printf '%s\n' "$*" >>"${TF_MOCK_CALLS}"

case "$1" in
  init|validate|apply)
    exit 0
    ;;
  workspace)
    [[ "${TF_MOCK_WORKSPACE_FAIL:-false}" != "true" ]]
    ;;
  plan)
    for argument in "$@"; do
      if [[ "${argument}" == -out=* ]]; then
        touch "${argument#-out=}"
      fi
    done
    ;;
  show)
    if [[ "${2:-}" == "-json" ]]; then
      jq -cn \
        --arg environment "${TF_MOCK_ENV:-staging}" \
        --arg server "${TF_MOCK_SERVER:-herobids-staging}" \
        --arg action "${TF_MOCK_ACTION:-create}" \
        --arg extra_address "${TF_MOCK_EXTRA_ADDRESS:-}" \
        --arg nomad "${TF_MOCK_NOMAD_ENABLED:-true}" \
        --argjson network_count "${TF_MOCK_NETWORK_COUNT:-1}" \
        --argjson subnet_count "${TF_MOCK_SUBNET_COUNT:-1}" \
        --argjson attachment_count "${TF_MOCK_ATTACHMENT_COUNT:-1}" \
        --arg network_name "${TF_MOCK_NETWORK_NAME:-herobids-staging-net}" \
        --arg network_cidr "${TF_MOCK_NETWORK_CIDR:-10.77.0.0/16}" \
        --arg subnet_cidr "${TF_MOCK_SUBNET_CIDR:-10.77.1.0/24}" \
        --arg subnet_reference "${TF_MOCK_SUBNET_REFERENCE:-hcloud_network.private[0].id}" \
        --arg attachment_network_reference "${TF_MOCK_ATTACHMENT_NETWORK_REFERENCE:-hcloud_network.private[0].id}" \
        --arg attachment_server_reference "${TF_MOCK_ATTACHMENT_SERVER_REFERENCE:-hcloud_server.default.id}" \
        --arg subnet_network_id "${TF_MOCK_SUBNET_NETWORK_ID:-}" \
        --arg attachment_network_id "${TF_MOCK_ATTACHMENT_NETWORK_ID:-}" \
        --arg attachment_server_id "${TF_MOCK_ATTACHMENT_SERVER_ID:-}" \
        --arg network_id "${TF_MOCK_NETWORK_ID:-}" \
        --arg server_id "${TF_MOCK_SERVER_ID:-}" \
        'def planned($address; $values; $count): [range(0; $count) | {address:$address,values:$values}];
         {configuration:{root_module:{resources:[
           {address:"hcloud_network_subnet.private",expressions:{network_id:{references:[$subnet_reference]}}},
           {address:"hcloud_server_network.control_plane",expressions:{network_id:{references:[$attachment_network_reference]},server_id:{references:[$attachment_server_reference]}}}
         ]}},planned_values:{outputs:{environment:{value:$environment},frontend_url:{value:"https://staging.openaidom.com"},nomad_enabled:{value:($nomad == "true")}},root_module:{resources:
           planned("hcloud_server.default"; {name:$server,id:(if $server_id == "" then null else $server_id end),labels:{environment:$environment}}; 1) +
           planned("hcloud_network.private[0]"; {name:$network_name,ip_range:$network_cidr,id:(if $network_id == "" then null else $network_id end),labels:{environment:$environment}}; $network_count) +
           planned("hcloud_network_subnet.private[0]"; {ip_range:$subnet_cidr,network_id:(if $subnet_network_id == "" then null else $subnet_network_id end)}; $subnet_count) +
           planned("hcloud_server_network.control_plane[0]"; {network_id:(if $attachment_network_id == "" then null else $attachment_network_id end),server_id:(if $attachment_server_id == "" then null else $attachment_server_id end)}; $attachment_count)}},
         resource_changes:([{address:"hcloud_server.default",change:{actions:[$action]}}] + (if $extra_address == "" then [] else [{address:$extra_address,change:{actions:["create"]}}] end))}'
    else
      printf 'Plan: 1 to add, 0 to change, 0 to destroy.\n'
    fi
    ;;
  output)
    case "${3:-}" in
      server_ipv4) printf '192.0.2.10\n' ;;
      private_network_id) printf '12345\n' ;;
      private_subnet_ip_range) printf '10.77.1.0/24\n' ;;
      control_plane_private_ip) printf '10.77.1.10\n' ;;
    esac
    ;;
  *)
    echo "unexpected terraform command: $*" >&2
    exit 2
    ;;
esac
MOCK_TERRAFORM
chmod +x "${MOCK_BIN}/terraform"

export TF_MOCK_CALLS="${TEST_TMPDIR}/terraform-calls.log"
export PATH="${MOCK_BIN}:$(dirname "${JQ_BIN}"):/usr/bin:/bin"

RUN_OUTPUT=""
RUN_EXIT=0
run_script() {
  local input="${1:-}"
  shift || true
  : >"${TF_MOCK_CALLS}"
  RUN_EXIT=0
  RUN_OUTPUT="$(printf '%s\n' "${input}" | "${MOCK_INFRA}/scripts/provision-staging.sh" --backend-env-file .env.backend "$@" 2>&1)" || RUN_EXIT=$?
}

run_script
[[ "${RUN_EXIT}" -eq 0 ]] || { printf '%s\n' "${RUN_OUTPUT}"; exit 1; }
[[ "${RUN_OUTPUT}" == *"Plan only; no infrastructure changes were applied."* ]] || { printf '%s\n' "${RUN_OUTPUT}"; exit 1; }
! grep -q '^apply ' "${TF_MOCK_CALLS}" || { echo "plan-only mode invoked apply" >&2; exit 1; }
grep -q -- '-backend-config=key=herobids/staging/terraform.tfstate' "${TF_MOCK_CALLS}"
grep -q '^workspace select staging$' "${TF_MOCK_CALLS}"

for allowed_action in read no-op; do
  export TF_MOCK_ACTION="${allowed_action}"
  run_script
  [[ "${RUN_EXIT}" -eq 0 ]] || { printf '%s\n' "${RUN_OUTPUT}"; exit 1; }
done
unset TF_MOCK_ACTION

export TF_WORKSPACE=production
export TF_CLI_ARGS_plan=-destroy
run_script
[[ "${RUN_EXIT}" -eq 0 ]] || { printf '%s\n' "${RUN_OUTPUT}"; exit 1; }
unset TF_WORKSPACE TF_CLI_ARGS_plan

run_script 'provision staging' --apply
[[ "${RUN_EXIT}" -eq 0 ]] || { printf '%s\n' "${RUN_OUTPUT}"; exit 1; }
grep -q '^apply -input=false -auto-approve ' "${TF_MOCK_CALLS}"
[[ "${RUN_OUTPUT}" == *"Private network ID: 12345"* ]]
[[ "${RUN_OUTPUT}" == *"Private subnet CIDR: 10.77.1.0/24"* ]]
[[ "${RUN_OUTPUT}" == *"Control-plane private IP: 10.77.1.10"* ]]

export TF_MOCK_ACTION=delete
run_script 'provision staging' --apply
[[ "${RUN_EXIT}" -ne 0 ]] || { echo "destructive plan was not rejected" >&2; exit 1; }
[[ "${RUN_OUTPUT}" == *"unsupported action"* ]]
! grep -q '^apply ' "${TF_MOCK_CALLS}"
unset TF_MOCK_ACTION

export TF_MOCK_EXTRA_ADDRESS=hcloud_server.production
run_script 'provision staging' --apply
[[ "${RUN_EXIT}" -ne 0 ]] || { echo "unexpected resource was not rejected" >&2; exit 1; }
[[ "${RUN_OUTPUT}" == *"unexpected resource"* ]]
! grep -q '^apply ' "${TF_MOCK_CALLS}"
unset TF_MOCK_EXTRA_ADDRESS

export TF_MOCK_ACTION=update
run_script 'provision staging' --apply
[[ "${RUN_EXIT}" -ne 0 ]] || { echo "update action was not rejected" >&2; exit 1; }
! grep -q '^apply ' "${TF_MOCK_CALLS}"
unset TF_MOCK_ACTION

export TF_MOCK_ENV=production
run_script 'provision staging' --apply
[[ "${RUN_EXIT}" -ne 0 ]] || { echo "non-staging plan was not rejected" >&2; exit 1; }
! grep -q '^apply ' "${TF_MOCK_CALLS}"
unset TF_MOCK_ENV

export TF_MOCK_NOMAD_ENABLED=false
run_script 'provision staging' --apply
[[ "${RUN_EXIT}" -ne 0 ]] || { echo "plan without private Nomad networking was not rejected" >&2; exit 1; }
! grep -q '^apply ' "${TF_MOCK_CALLS}"
unset TF_MOCK_NOMAD_ENABLED

export TF_MOCK_SUBNET_CIDR=10.78.1.0/24
run_script 'provision staging' --apply
[[ "${RUN_EXIT}" -ne 0 ]] || { echo "subnet outside network CIDR was not rejected" >&2; exit 1; }
[[ "${RUN_OUTPUT}" == *"invalid private network topology"* ]]
! grep -q '^apply ' "${TF_MOCK_CALLS}"
unset TF_MOCK_SUBNET_CIDR

for resource_kind in NETWORK SUBNET ATTACHMENT; do
  for count in 0 2; do
    export "TF_MOCK_${resource_kind}_COUNT=${count}"
    run_script 'provision staging' --apply
    [[ "${RUN_EXIT}" -ne 0 ]] || { echo "plan with ${count} ${resource_kind} resources was not rejected" >&2; exit 1; }
    [[ "${RUN_OUTPUT}" == *"invalid private network topology"* ]]
    ! grep -q '^apply ' "${TF_MOCK_CALLS}"
    unset "TF_MOCK_${resource_kind}_COUNT"
  done
done

for mismatch in NETWORK_NAME SUBNET_REFERENCE ATTACHMENT_NETWORK_REFERENCE ATTACHMENT_SERVER_REFERENCE; do
  export "TF_MOCK_${mismatch}=wrong-target"
  run_script 'provision staging' --apply
  [[ "${RUN_EXIT}" -ne 0 ]] || { echo "plan with mismatched ${mismatch} was not rejected" >&2; exit 1; }
  ! grep -q '^apply ' "${TF_MOCK_CALLS}"
  unset "TF_MOCK_${mismatch}"
done

export TF_MOCK_NETWORK_ID=network-staging
export TF_MOCK_SERVER_ID=server-staging
export TF_MOCK_SUBNET_NETWORK_ID=network-staging
export TF_MOCK_ATTACHMENT_NETWORK_ID=network-staging
export TF_MOCK_ATTACHMENT_SERVER_ID=server-staging
run_script
[[ "${RUN_EXIT}" -eq 0 ]] || { printf '%s\n' "${RUN_OUTPUT}"; exit 1; }

for mismatch in SUBNET_NETWORK_ID ATTACHMENT_NETWORK_ID ATTACHMENT_SERVER_ID; do
  export "TF_MOCK_${mismatch}=wrong-id"
  run_script 'provision staging' --apply
  [[ "${RUN_EXIT}" -ne 0 ]] || { echo "plan with mismatched ${mismatch} was not rejected" >&2; exit 1; }
  ! grep -q '^apply ' "${TF_MOCK_CALLS}"
  unset "TF_MOCK_${mismatch}"
done
unset TF_MOCK_NETWORK_ID TF_MOCK_SERVER_ID TF_MOCK_SUBNET_NETWORK_ID TF_MOCK_ATTACHMENT_NETWORK_ID TF_MOCK_ATTACHMENT_SERVER_ID

export TF_MOCK_WORKSPACE_FAIL=true
run_script
[[ "${RUN_EXIT}" -ne 0 ]] || { echo "missing staging workspace was not rejected" >&2; exit 1; }
[[ "${RUN_OUTPUT}" == *"refusing to create or mutate workspace state"* ]]
! grep -q '^plan ' "${TF_MOCK_CALLS}"

echo "All staging provisioner tests passed."