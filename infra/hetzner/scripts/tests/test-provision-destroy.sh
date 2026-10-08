#!/usr/bin/env bash
# test-provision-destroy.sh — Terraform data-dir / workspace handling in
# provision.sh and destroy.sh (bugs 2026-10-08/001, 005, 006).
#
# Runs copies of the scripts in a mock infra tree against a terraform stub that
# models the S3 backend: workspaces are per backend key, init checks the
# selected workspace against the key, and workspace commands need a prior init
# in the same data dir.
#
# Run: bash infra/hetzner/scripts/tests/test-provision-destroy.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "${TESTS_DIR}/.." && pwd)"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT
SUITE_FAILED=0

MOCK_TF_DIR="${TEST_TMPDIR}/infra"
MOCK_BIN="${TEST_TMPDIR}/bin"
TF_MOCK_STATE="${TEST_TMPDIR}/s3"
TF_MOCK_CALLS="${TEST_TMPDIR}/terraform-calls"
mkdir -p "${MOCK_TF_DIR}/scripts" "${MOCK_BIN}"
MOCK_TF_DIR="$(cd "${MOCK_TF_DIR}" && pwd)"  # canonical, as the scripts resolve TF_DIR
cp "${SCRIPTS_DIR}/provision.sh" "${SCRIPTS_DIR}/destroy.sh" "${SCRIPTS_DIR}/_ssh_opts.sh" "${MOCK_TF_DIR}/scripts/"
: > "${MOCK_TF_DIR}/staging.tfvars"
: > "${MOCK_TF_DIR}/production.tfvars"
# The backend file must not be able to reintroduce a workspace override.
cat > "${MOCK_TF_DIR}/.env.backend" <<'EOF'
TF_BACKEND_BUCKET=test-bucket
TF_BACKEND_REGION=eu-central-1
TF_WORKSPACE=production
EOF

cat > "${MOCK_BIN}/terraform" <<'STUB'
#!/usr/bin/env bash
data_dir="${TF_DATA_DIR:-.terraform}"
echo "tf[${data_dir}] $*" >> "${TF_MOCK_CALLS}"
[[ -z "${TF_WORKSPACE:-}${TF_CLI_ARGS:-}" ]] || echo "LEAK TF_WORKSPACE='${TF_WORKSPACE:-}' TF_CLI_ARGS='${TF_CLI_ARGS:-}'" >> "${TF_MOCK_CALLS}"
selected="${TF_WORKSPACE:-$(cat "${data_dir}/environment" 2>/dev/null || echo default)}"
key="$(cat "${data_dir}/key" 2>/dev/null || true)"
ws_file() { printf '%s/%s.workspaces' "${TF_MOCK_STATE}" "${1//\//_}"; }
has_ws() { [[ "$2" == "default" ]] || grep -qx "$2" "$(ws_file "$1")" 2>/dev/null; }
need_init() { [[ -n "${key}" ]] || { echo "Error: Backend initialization required" >&2; exit 1; }; }
case "$1" in
  init)
    for a in "$@"; do [[ "$a" == -backend-config=key=* ]] && key="${a#-backend-config=key=}"; done
    has_ws "${key}" "${selected}" || { echo "Error: Currently selected workspace \"${selected}\" does not exist" >&2; exit 1; }
    mkdir -p "${data_dir}"; printf '%s' "${key}" > "${data_dir}/key" ;;
  workspace)
    need_init
    case "$2" in
      show) echo "${selected}" ;;
      select)
        has_ws "${key}" "$3" || { echo "Error: workspace \"$3\" doesn't exist" >&2; exit 1; }
        printf '%s' "$3" > "${data_dir}/environment" ;;
      new)
        echo "$3" >> "$(ws_file "${key}")"
        printf '%s' "$3" > "${data_dir}/environment" ;;
    esac ;;
  plan|apply|destroy)
    need_init
    echo "ran $1 key=${key} workspace=${selected}" >> "${TF_MOCK_CALLS}" ;;
esac
exit 0
STUB
chmod +x "${MOCK_BIN}/terraform"

# reset_state — S3 has staging under the staging key and production under the
# production key; the shared .terraform/ is left on production (as after a
# production deploy).
reset_state() {
  rm -rf "${TF_MOCK_STATE}" "${MOCK_TF_DIR}/.terraform" "${MOCK_TF_DIR}/.terraform-envs"
  mkdir -p "${TF_MOCK_STATE}" "${MOCK_TF_DIR}/.terraform"
  echo staging > "${TF_MOCK_STATE}/herobids_staging_terraform.tfstate.workspaces"
  echo production > "${TF_MOCK_STATE}/herobids_production_terraform.tfstate.workspaces"
  printf 'production' > "${MOCK_TF_DIR}/.terraform/environment"
  printf 'herobids/production/terraform.tfstate' > "${MOCK_TF_DIR}/.terraform/key"
}

# run_script <script> [args...] — env overrides go before via `env`.
run_script() {
  local script="$1"; shift
  : > "${TF_MOCK_CALLS}"
  RUN_EXIT=0
  RUN_OUTPUT="$(env -u TF_DATA_DIR -u TF_BACKEND_DYNAMODB_TABLE -u HEROBIDS_ENV \
    PATH="${MOCK_BIN}:${PATH}" TF_MOCK_CALLS="${TF_MOCK_CALLS}" TF_MOCK_STATE="${TF_MOCK_STATE}" \
    HEROBIDS_SSH_KEY=/dev/null TF_WORKSPACE=production TF_CLI_ARGS=-lock=false \
    bash "${MOCK_TF_DIR}/scripts/${script}" "$@" </dev/null 2>&1)" || RUN_EXIT=$?
  RUN_CALLS="$(cat "${TF_MOCK_CALLS}")"
}

STAGING_DIR=".terraform-envs/staging"

# ═════════════════════════════════════════════════════════════════════════════
test_begin "provision.sh — init first, per-env data dir"

reset_state
run_script provision.sh --env staging --var-file staging.tfvars --yes
assert_eq "${RUN_EXIT}" "0" "stale shared selection + inherited overrides: provision succeeds"
assert_eq "$(grep -m1 '^tf\[' "${TF_MOCK_CALLS}")" \
  "tf[${STAGING_DIR}] init -input=false -reconfigure -backend-config=bucket=test-bucket -backend-config=key=herobids/staging/terraform.tfstate -backend-config=region=eu-central-1" \
  "first terraform call is init of the staging key in .terraform-envs/staging"
assert_eq "$(grep '^tf\[' "${TF_MOCK_CALLS}" | grep -cv "^tf\[${STAGING_DIR}\] ")" "0" "every terraform call uses .terraform-envs/staging"
assert_contains "${RUN_CALLS}" "tf[${STAGING_DIR}] workspace select staging" "selects the staging workspace"
assert_not_contains "${RUN_CALLS}" "workspace new" "does not create an existing workspace"
assert_contains "${RUN_CALLS}" "plan -var-file=${MOCK_TF_DIR}/staging.tfvars" "plan gets the var-file"
assert_contains "${RUN_CALLS}" "apply -auto-approve -var-file=${MOCK_TF_DIR}/staging.tfvars" "apply gets the var-file"
assert_contains "${RUN_CALLS}" "ran apply key=herobids/staging/terraform.tfstate workspace=staging" "applies the staging key + workspace"
assert_not_contains "${RUN_CALLS}" "LEAK" "inherited TF_WORKSPACE/TF_CLI_ARGS (shell or backend file) never reach terraform"
assert_eq "$(cat "${MOCK_TF_DIR}/.terraform/environment")" "production" "shared .terraform/ is left untouched"
assert_eq "$(cat "${TF_MOCK_STATE}/herobids_production_terraform.tfstate.workspaces")" "production" "no workspace created under the production key"

reset_state
: > "${TF_MOCK_STATE}/herobids_staging_terraform.tfstate.workspaces"
run_script provision.sh --env staging --var-file staging.tfvars --yes
assert_eq "${RUN_EXIT}" "0" "new environment: provision succeeds"
assert_contains "${RUN_CALLS}" "tf[${STAGING_DIR}] workspace new staging" "new environment: creates the workspace"
assert_eq "$(cat "${TF_MOCK_STATE}/herobids_staging_terraform.tfstate.workspaces")" "staging" "new environment: workspace created under the staging key"
assert_eq "$(cat "${TF_MOCK_STATE}/herobids_production_terraform.tfstate.workspaces")" "production" "new environment: production key unchanged (no cross-keyed workspace)"

# Per-env dir remembers "staging", but that workspace's state is gone.
reset_state
: > "${TF_MOCK_STATE}/herobids_staging_terraform.tfstate.workspaces"
mkdir -p "${MOCK_TF_DIR}/${STAGING_DIR}"
printf 'staging' > "${MOCK_TF_DIR}/${STAGING_DIR}/environment"
run_script provision.sh --env staging --var-file staging.tfvars --yes
assert_eq "${RUN_EXIT}" "0" "remembered but missing workspace: init does not abort, workspace is recreated"
assert_contains "${RUN_CALLS}" "workspace new staging" "remembered but missing workspace: creates it"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
test_begin "destroy.sh — per-env data dir, never creates workspaces"

reset_state
run_script destroy.sh --env staging --var-file staging.tfvars --yes
assert_eq "${RUN_EXIT}" "0" "stale shared selection + inherited overrides: destroy succeeds"
assert_eq "$(grep '^tf\[' "${TF_MOCK_CALLS}" | grep -cv "^tf\[${STAGING_DIR}\] ")" "0" "every terraform call uses .terraform-envs/staging"
assert_contains "${RUN_CALLS}" "ran destroy key=herobids/staging/terraform.tfstate workspace=staging" "destroys the staging key + workspace"
assert_contains "${RUN_CALLS}" "destroy -auto-approve -var-file=${MOCK_TF_DIR}/staging.tfvars" "destroy gets the var-file"
assert_not_contains "${RUN_CALLS}" "LEAK" "inherited TF_WORKSPACE/TF_CLI_ARGS never reach terraform"
assert_eq "$(cat "${MOCK_TF_DIR}/.terraform/environment")" "production" "shared .terraform/ is left untouched"
assert_eq "$([[ -f "${MOCK_TF_DIR}/zz_destroy_override.tf" ]] && echo present || echo removed)" "removed" "prevent_destroy override is removed"

reset_state
: > "${TF_MOCK_STATE}/herobids_staging_terraform.tfstate.workspaces"
run_script destroy.sh --env staging --var-file staging.tfvars --yes
assert_neq "${RUN_EXIT}" "0" "missing workspace: exits non-zero"
assert_contains "${RUN_OUTPUT}" "Nothing to destroy" "missing workspace: reports nothing to destroy (init does not abort first)"
assert_not_contains "${RUN_CALLS}" "workspace new" "missing workspace: never creates it"
assert_not_contains "${RUN_CALLS}" "ran destroy" "missing workspace: never runs destroy"

reset_state
run_script destroy.sh --env production --var-file production.tfvars --yes
assert_neq "${RUN_EXIT}" "0" "production without acknowledgement: exits non-zero"
assert_not_contains "${RUN_CALLS}" "tf[" "production without acknowledgement: runs no terraform"

test_end || SUITE_FAILED=1

exit "${SUITE_FAILED}"
