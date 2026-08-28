#!/usr/bin/env bash
# test-tf-runtime-helpers.sh — Unit tests for the Terraform runtime helpers
# added to scale-common.sh: tf_ensure_env, tf_backend_configured,
# tf_init_backend, tf_select_workspace, tf_ensure_ready, tf_apply_var.
#
# Run: bash infra/hetzner/scripts/tests/test-tf-runtime-helpers.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

# ─── Setup / teardown ─────────────────────────────────────────────────────────

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

# Source scale-common.sh with safe temp paths.
source "${TESTS_DIR}/source-helper.sh"

# Track overall suite failure for final exit code.
SUITE_FAILED=0

# Helper: run a function in a subshell with specific env vars.
# Captures stdout+stderr and exit code.
# Usage: run_in_subshell [ENV_VAR=val...] function_name [args...]
# After calling: $RUN_OUTPUT contains stdout+stderr, $RUN_EXIT the exit code.
RUN_OUTPUT=""
RUN_EXIT=0

run_in_subshell() {
  local env_vars=()
  while [[ "$1" == *=* ]] && [[ "$1" != -* ]]; do
    env_vars+=("$1")
    shift
  done
  local func="$1"
  shift

  # Build a subshell that sources the helpers and calls the function.
  # The 2>&1 must be INSIDE the $() to capture stderr from log()/die().
  RUN_EXIT=0
  RUN_OUTPUT="$(
    {
      # Export env vars
      for ev in "${env_vars[@]+"${env_vars[@]}"}"; do
        export "${ev?}"
      done

      # Re-source to pick up the env vars in the subshell
      export TEST_TMPDIR="${TEST_TMPDIR}"
      source "${TESTS_DIR}/source-helper.sh"

      # Re-apply env overrides after sourcing (source-helper.sh sets defaults)
      for ev in "${env_vars[@]+"${env_vars[@]}"}"; do
        export "${ev?}"
      done

      "${func}" "$@"
    } 2>&1
  )" || RUN_EXIT=$?
}

# ═════════════════════════════════════════════════════════════════════════════
# tf_ensure_env
# ═════════════════════════════════════════════════════════════════════════════

test_begin "tf_ensure_env"

# --- Accepts valid environments ---

run_in_subshell "HEROBIDS_ENV=staging" tf_ensure_env
assert_eq "${RUN_EXIT}" "0" "accepts HEROBIDS_ENV=staging"

run_in_subshell "HEROBIDS_ENV=production" tf_ensure_env
assert_eq "${RUN_EXIT}" "0" "accepts HEROBIDS_ENV=production"

# --- Rejects invalid environments ---

run_in_subshell "HEROBIDS_ENV=dev" tf_ensure_env
assert_neq "${RUN_EXIT}" "0" "rejects HEROBIDS_ENV=dev"
assert_contains "${RUN_OUTPUT}" "HEROBIDS_ENV must be" "error message mentions HEROBIDS_ENV"
assert_contains "${RUN_OUTPUT}" "dev" "error message includes the invalid value"

run_in_subshell "HEROBIDS_ENV=test" tf_ensure_env
assert_neq "${RUN_EXIT}" "0" "rejects HEROBIDS_ENV=test"

run_in_subshell "HEROBIDS_ENV=development" tf_ensure_env
assert_neq "${RUN_EXIT}" "0" "rejects HEROBIDS_ENV=development"

run_in_subshell "HEROBIDS_ENV=" tf_ensure_env
assert_neq "${RUN_EXIT}" "0" "rejects empty HEROBIDS_ENV"
assert_contains "${RUN_OUTPUT}" "<unset>" "error message shows <unset> for empty value"

# Test with HEROBIDS_ENV truly unset
RUN_EXIT=0
RUN_OUTPUT="$(
  {
    unset HEROBIDS_ENV
    export TEST_TMPDIR="${TEST_TMPDIR}"
    source "${TESTS_DIR}/source-helper.sh"
    unset HEROBIDS_ENV
    tf_ensure_env
  } 2>&1
)" || RUN_EXIT=$?
assert_neq "${RUN_EXIT}" "0" "rejects unset HEROBIDS_ENV"

run_in_subshell "HEROBIDS_ENV=STAGING" tf_ensure_env
assert_neq "${RUN_EXIT}" "0" "rejects HEROBIDS_ENV=STAGING (case-sensitive)"

run_in_subshell "HEROBIDS_ENV=Production" tf_ensure_env
assert_neq "${RUN_EXIT}" "0" "rejects HEROBIDS_ENV=Production (case-sensitive)"

run_in_subshell "HEROBIDS_ENV= staging" tf_ensure_env
assert_neq "${RUN_EXIT}" "0" "rejects HEROBIDS_ENV with leading space"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# tf_backend_configured
# ═════════════════════════════════════════════════════════════════════════════

test_begin "tf_backend_configured"

# --- All vars set: success ---

run_in_subshell \
  "TF_BACKEND_BUCKET=my-bucket" \
  "TF_BACKEND_REGION=us-east-1" \
  "AWS_ACCESS_KEY_ID=AKID" \
  "AWS_SECRET_ACCESS_KEY=secret" \
  tf_backend_configured
assert_eq "${RUN_EXIT}" "0" "returns 0 when all backend vars are set"

# --- Missing individual vars ---

run_in_subshell \
  "TF_BACKEND_BUCKET=" \
  "TF_BACKEND_REGION=us-east-1" \
  "AWS_ACCESS_KEY_ID=AKID" \
  "AWS_SECRET_ACCESS_KEY=secret" \
  tf_backend_configured
assert_neq "${RUN_EXIT}" "0" "fails when TF_BACKEND_BUCKET is empty"
assert_contains "${RUN_OUTPUT}" "TF_BACKEND_BUCKET" "error lists missing TF_BACKEND_BUCKET"

run_in_subshell \
  "TF_BACKEND_BUCKET=my-bucket" \
  "TF_BACKEND_REGION=" \
  "AWS_ACCESS_KEY_ID=AKID" \
  "AWS_SECRET_ACCESS_KEY=secret" \
  tf_backend_configured
assert_neq "${RUN_EXIT}" "0" "fails when TF_BACKEND_REGION is empty"
assert_contains "${RUN_OUTPUT}" "TF_BACKEND_REGION" "error lists missing TF_BACKEND_REGION"

run_in_subshell \
  "TF_BACKEND_BUCKET=my-bucket" \
  "TF_BACKEND_REGION=us-east-1" \
  "AWS_ACCESS_KEY_ID=" \
  "AWS_SECRET_ACCESS_KEY=secret" \
  tf_backend_configured
assert_neq "${RUN_EXIT}" "0" "fails when AWS_ACCESS_KEY_ID is empty"
assert_contains "${RUN_OUTPUT}" "AWS_ACCESS_KEY_ID" "error lists missing AWS_ACCESS_KEY_ID"

run_in_subshell \
  "TF_BACKEND_BUCKET=my-bucket" \
  "TF_BACKEND_REGION=us-east-1" \
  "AWS_ACCESS_KEY_ID=AKID" \
  "AWS_SECRET_ACCESS_KEY=" \
  tf_backend_configured
assert_neq "${RUN_EXIT}" "0" "fails when AWS_SECRET_ACCESS_KEY is empty"
assert_contains "${RUN_OUTPUT}" "AWS_SECRET_ACCESS_KEY" "error lists missing AWS_SECRET_ACCESS_KEY"

# --- Multiple vars missing: error lists all of them ---

run_in_subshell \
  "TF_BACKEND_BUCKET=" \
  "TF_BACKEND_REGION=" \
  "AWS_ACCESS_KEY_ID=" \
  "AWS_SECRET_ACCESS_KEY=" \
  tf_backend_configured
assert_neq "${RUN_EXIT}" "0" "fails when all backend vars are empty"
assert_contains "${RUN_OUTPUT}" "TF_BACKEND_BUCKET" "lists TF_BACKEND_BUCKET in multi-missing error"
assert_contains "${RUN_OUTPUT}" "TF_BACKEND_REGION" "lists TF_BACKEND_REGION in multi-missing error"
assert_contains "${RUN_OUTPUT}" "AWS_ACCESS_KEY_ID" "lists AWS_ACCESS_KEY_ID in multi-missing error"
assert_contains "${RUN_OUTPUT}" "AWS_SECRET_ACCESS_KEY" "lists AWS_SECRET_ACCESS_KEY in multi-missing error"

# --- Unset vars (not just empty) ---

RUN_EXIT=0
RUN_OUTPUT="$(
  {
    unset TF_BACKEND_BUCKET TF_BACKEND_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY 2>/dev/null || true
    export TEST_TMPDIR="${TEST_TMPDIR}"
    source "${TESTS_DIR}/source-helper.sh"
    unset TF_BACKEND_BUCKET TF_BACKEND_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY 2>/dev/null || true
    tf_backend_configured
  } 2>&1
)" || RUN_EXIT=$?
assert_neq "${RUN_EXIT}" "0" "fails when all backend vars are unset (not just empty)"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# tf_init_backend (with mock terraform)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "tf_init_backend"

# Create a mock terraform binary that records its arguments
MOCK_BIN_DIR="${TEST_TMPDIR}/mock-bin"
mkdir -p "${MOCK_BIN_DIR}"

cat > "${MOCK_BIN_DIR}/terraform" << 'MOCK_EOF'
#!/usr/bin/env bash
# Mock terraform — records invocations to $TEST_TMPDIR/terraform-calls
echo "$0 $*" >> "${TEST_TMPDIR}/terraform-calls"
# Succeed by default unless MOCK_TF_FAIL is set
if [[ "${MOCK_TF_FAIL:-}" == "true" ]]; then
  exit 1
fi
exit 0
MOCK_EOF
chmod +x "${MOCK_BIN_DIR}/terraform"

# Helper: run tf_init_backend in a subshell with the mock terraform on PATH
run_tf_init() {
  local extra_env=("$@")
  : > "${TEST_TMPDIR}/terraform-calls"  # reset call log

  RUN_EXIT=0
  RUN_OUTPUT="$(
    {
      export PATH="${MOCK_BIN_DIR}:${PATH}"
      export HEROBIDS_ENV="staging"
      export TF_BACKEND_BUCKET="test-bucket"
      export TF_BACKEND_REGION="us-east-1"
      export AWS_ACCESS_KEY_ID="AKID123"
      export AWS_SECRET_ACCESS_KEY="SECRET123"
      export MOCK_TF_FAIL="${MOCK_TF_FAIL:-false}"
      export TEST_TMPDIR="${TEST_TMPDIR}"

      for ev in "${extra_env[@]+"${extra_env[@]}"}"; do
        export "${ev?}"
      done

      source "${TESTS_DIR}/source-helper.sh"

      # Re-apply overrides
      export PATH="${MOCK_BIN_DIR}:${PATH}"
      export HEROBIDS_ENV="staging"
      export TF_BACKEND_BUCKET="test-bucket"
      export TF_BACKEND_REGION="us-east-1"
      export AWS_ACCESS_KEY_ID="AKID123"
      export AWS_SECRET_ACCESS_KEY="SECRET123"
      for ev in "${extra_env[@]+"${extra_env[@]}"}"; do
        export "${ev?}"
      done

      tf_init_backend
    } 2>&1
  )" || RUN_EXIT=$?
}

# --- Successful init with staging ---

run_tf_init
assert_eq "${RUN_EXIT}" "0" "succeeds with valid env and backend vars"

# Check that terraform init was called with correct args
TF_CALLS="$(cat "${TEST_TMPDIR}/terraform-calls" 2>/dev/null || echo "")"
assert_contains "${TF_CALLS}" "init" "calls terraform init"
assert_contains "${TF_CALLS}" "-backend-config=bucket=test-bucket" "passes bucket backend config"
assert_contains "${TF_CALLS}" "-backend-config=key=herobids/staging/terraform.tfstate" "passes state key with staging env"
assert_contains "${TF_CALLS}" "-backend-config=region=us-east-1" "passes region backend config"
assert_contains "${TF_CALLS}" "-reconfigure" "passes -reconfigure flag"
assert_contains "${TF_CALLS}" "-input=false" "passes -input=false flag"

# --- Production environment uses production key ---

run_tf_init "HEROBIDS_ENV=production"
TF_CALLS="$(cat "${TEST_TMPDIR}/terraform-calls" 2>/dev/null || echo "")"
assert_contains "${TF_CALLS}" "-backend-config=key=herobids/production/terraform.tfstate" "production env uses production state key"

# --- DynamoDB table is optional ---

run_tf_init
TF_CALLS="$(cat "${TEST_TMPDIR}/terraform-calls" 2>/dev/null || echo "")"
assert_not_contains "${TF_CALLS}" "dynamodb_table" "omits dynamodb_table when TF_BACKEND_DYNAMODB_TABLE is unset"

run_tf_init "TF_BACKEND_DYNAMODB_TABLE=my-lock-table"
TF_CALLS="$(cat "${TEST_TMPDIR}/terraform-calls" 2>/dev/null || echo "")"
assert_contains "${TF_CALLS}" "-backend-config=dynamodb_table=my-lock-table" "includes dynamodb_table when set"

# --- Fails when terraform init fails ---

# MOCK_TF_FAIL is picked up by run_tf_init's subshell via export MOCK_TF_FAIL="${MOCK_TF_FAIL:-false}"
MOCK_TF_FAIL=true run_tf_init
assert_neq "${RUN_EXIT}" "0" "fails when terraform init returns non-zero"
assert_contains "${RUN_OUTPUT}" "initialization failed" "error message mentions initialization failed"

# --- Fails when env is invalid ---

RUN_EXIT=0
RUN_OUTPUT="$(
  {
    export PATH="${MOCK_BIN_DIR}:${PATH}"
    export HEROBIDS_ENV="dev"
    export TF_BACKEND_BUCKET="test-bucket"
    export TF_BACKEND_REGION="us-east-1"
    export AWS_ACCESS_KEY_ID="AKID"
    export AWS_SECRET_ACCESS_KEY="SECRET"
    export TEST_TMPDIR="${TEST_TMPDIR}"
    source "${TESTS_DIR}/source-helper.sh"
    export HEROBIDS_ENV="dev"
    export PATH="${MOCK_BIN_DIR}:${PATH}"
    tf_init_backend
  } 2>&1
)" || RUN_EXIT=$?
assert_neq "${RUN_EXIT}" "0" "fails when HEROBIDS_ENV is invalid"

# --- Fails when backend vars missing ---

RUN_EXIT=0
RUN_OUTPUT="$(
  {
    export PATH="${MOCK_BIN_DIR}:${PATH}"
    export HEROBIDS_ENV="staging"
    export TF_BACKEND_BUCKET=""
    export TF_BACKEND_REGION=""
    export AWS_ACCESS_KEY_ID=""
    export AWS_SECRET_ACCESS_KEY=""
    export TEST_TMPDIR="${TEST_TMPDIR}"
    source "${TESTS_DIR}/source-helper.sh"
    export HEROBIDS_ENV="staging"
    export TF_BACKEND_BUCKET=""
    export TF_BACKEND_REGION=""
    export AWS_ACCESS_KEY_ID=""
    export AWS_SECRET_ACCESS_KEY=""
    export PATH="${MOCK_BIN_DIR}:${PATH}"
    tf_init_backend
  } 2>&1
)" || RUN_EXIT=$?
assert_neq "${RUN_EXIT}" "0" "fails when S3 backend vars are missing"
assert_contains "${RUN_OUTPUT}" "S3 backend not configured" "error message mentions S3 backend not configured"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# tf_select_workspace (with mock terraform)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "tf_select_workspace"

# Create a more sophisticated mock terraform for workspace tests
WORKSPACE_MOCK_DIR="${TEST_TMPDIR}/ws-mock-bin"
mkdir -p "${WORKSPACE_MOCK_DIR}"

# Helper to create workspace mock with configurable behavior
create_workspace_mock() {
  local current_ws="${1:-default}"
  local select_fails="${2:-false}"
  local new_fails="${3:-false}"

  cat > "${WORKSPACE_MOCK_DIR}/terraform" << WSMOCK
#!/usr/bin/env bash
echo "\$0 \$*" >> "${TEST_TMPDIR}/terraform-calls"
case "\$1" in
  workspace)
    case "\$2" in
      show)  echo "${current_ws}"; exit 0 ;;
      select)
        if [[ "${select_fails}" == "true" ]]; then exit 1; fi
        exit 0
        ;;
      new)
        if [[ "${new_fails}" == "true" ]]; then exit 1; fi
        exit 0
        ;;
    esac
    ;;
esac
exit 0
WSMOCK
  chmod +x "${WORKSPACE_MOCK_DIR}/terraform"
}

run_tf_select_workspace() {
  local env="${1:-staging}"
  : > "${TEST_TMPDIR}/terraform-calls"

  RUN_EXIT=0
  RUN_OUTPUT="$(
    {
      export PATH="${WORKSPACE_MOCK_DIR}:${PATH}"
      export HEROBIDS_ENV="${env}"
      export TEST_TMPDIR="${TEST_TMPDIR}"
      source "${TESTS_DIR}/source-helper.sh"
      export PATH="${WORKSPACE_MOCK_DIR}:${PATH}"
      export HEROBIDS_ENV="${env}"
      tf_select_workspace
    } 2>&1
  )" || RUN_EXIT=$?
}

# --- Already on correct workspace: no select needed ---

create_workspace_mock "staging"
run_tf_select_workspace "staging"
assert_eq "${RUN_EXIT}" "0" "succeeds when already on correct workspace"
assert_contains "${RUN_OUTPUT}" "already set to" "logs that workspace is already set"

# Verify it called workspace show but not workspace select
TF_CALLS="$(cat "${TEST_TMPDIR}/terraform-calls")"
assert_contains "${TF_CALLS}" "workspace show" "calls workspace show to check current"
assert_not_contains "${TF_CALLS}" "workspace select" "does not call workspace select when already correct"

# --- Different workspace: selects the right one ---

create_workspace_mock "default"
run_tf_select_workspace "staging"
assert_eq "${RUN_EXIT}" "0" "succeeds when switching from default to staging"
TF_CALLS="$(cat "${TEST_TMPDIR}/terraform-calls")"
assert_contains "${TF_CALLS}" "workspace select staging" "calls workspace select with staging"

# --- Select fails, falls back to new ---

create_workspace_mock "default" "true" "false"
run_tf_select_workspace "staging"
assert_eq "${RUN_EXIT}" "0" "succeeds by creating new workspace when select fails"
TF_CALLS="$(cat "${TEST_TMPDIR}/terraform-calls")"
assert_contains "${TF_CALLS}" "workspace new staging" "falls back to workspace new"

# --- Both select and new fail ---

create_workspace_mock "default" "true" "true"
run_tf_select_workspace "staging"
assert_neq "${RUN_EXIT}" "0" "fails when both workspace select and new fail"
assert_contains "${RUN_OUTPUT}" "Failed to select or create" "error mentions workspace failure"

# --- Rejects invalid env ---

create_workspace_mock "default"
run_tf_select_workspace "dev"
assert_neq "${RUN_EXIT}" "0" "rejects invalid HEROBIDS_ENV in tf_select_workspace"

# --- Production workspace ---

create_workspace_mock "staging"
run_tf_select_workspace "production"
assert_eq "${RUN_EXIT}" "0" "succeeds switching to production workspace"
TF_CALLS="$(cat "${TEST_TMPDIR}/terraform-calls")"
assert_contains "${TF_CALLS}" "workspace select production" "selects production workspace"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# tf_ensure_ready (integration of all preflight checks)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "tf_ensure_ready"

# Create a comprehensive mock terraform for tf_ensure_ready
READY_MOCK_DIR="${TEST_TMPDIR}/ready-mock-bin"
mkdir -p "${READY_MOCK_DIR}"

create_ready_mock() {
  local init_fails="${1:-false}"
  local ws_show="${2:-default}"

  cat > "${READY_MOCK_DIR}/terraform" << READYMOCK
#!/usr/bin/env bash
echo "\$0 \$*" >> "${TEST_TMPDIR}/terraform-calls"
case "\$1" in
  init)
    if [[ "${init_fails}" == "true" ]]; then exit 1; fi
    exit 0
    ;;
  workspace)
    case "\$2" in
      show)   echo "${ws_show}"; exit 0 ;;
      select) exit 0 ;;
      new)    exit 0 ;;
    esac
    ;;
esac
exit 0
READYMOCK
  chmod +x "${READY_MOCK_DIR}/terraform"
}

run_tf_ensure_ready() {
  local extra_env=("$@")
  : > "${TEST_TMPDIR}/terraform-calls"

  RUN_EXIT=0
  RUN_OUTPUT="$(
    {
      export PATH="${READY_MOCK_DIR}:${PATH}"
      export HEROBIDS_ENV="staging"
      export TF_BACKEND_BUCKET="test-bucket"
      export TF_BACKEND_REGION="us-east-1"
      export AWS_ACCESS_KEY_ID="AKID123"
      export AWS_SECRET_ACCESS_KEY="SECRET123"
      export TEST_TMPDIR="${TEST_TMPDIR}"

      for ev in "${extra_env[@]+"${extra_env[@]}"}"; do
        export "${ev?}"
      done

      source "${TESTS_DIR}/source-helper.sh"

      # Re-apply overrides
      export PATH="${READY_MOCK_DIR}:${PATH}"
      export HEROBIDS_ENV="staging"
      export TF_BACKEND_BUCKET="test-bucket"
      export TF_BACKEND_REGION="us-east-1"
      export AWS_ACCESS_KEY_ID="AKID123"
      export AWS_SECRET_ACCESS_KEY="SECRET123"
      for ev in "${extra_env[@]+"${extra_env[@]}"}"; do
        export "${ev?}"
      done

      tf_ensure_ready
    } 2>&1
  )" || RUN_EXIT=$?
}

# --- Full success path ---

create_ready_mock "false" "default"
run_tf_ensure_ready
assert_eq "${RUN_EXIT}" "0" "succeeds with all prerequisites met"
assert_contains "${RUN_OUTPUT}" "Terraform ready" "logs Terraform ready message"
TF_CALLS="$(cat "${TEST_TMPDIR}/terraform-calls")"
assert_contains "${TF_CALLS}" "init" "calls terraform init during ensure_ready"
assert_contains "${TF_CALLS}" "workspace" "manages workspace during ensure_ready"

# --- Fails when HEROBIDS_ENV is invalid ---

create_ready_mock "false" "default"
run_tf_ensure_ready "HEROBIDS_ENV=invalid"
assert_neq "${RUN_EXIT}" "0" "fails when HEROBIDS_ENV is invalid"

# --- Fails when terraform is not in PATH ---

RUN_EXIT=0
RUN_OUTPUT="$(
  {
    # Use a PATH with no terraform binary
    export PATH="/usr/bin:/bin"
    export HEROBIDS_ENV="staging"
    export TF_BACKEND_BUCKET="test-bucket"
    export TF_BACKEND_REGION="us-east-1"
    export AWS_ACCESS_KEY_ID="AKID123"
    export AWS_SECRET_ACCESS_KEY="SECRET123"
    export NOMAD_AUTOSCALE_LOG_FILE="${TEST_TMPDIR}/autoscale.log"
    export NOMAD_AUTOSCALE_LOCKFILE="${TEST_TMPDIR}/autoscale.lock"
    export NOMAD_AUTOSCALE_COOLDOWN_FILE="${TEST_TMPDIR}/cooldown"
    export NOMAD_AUTOSCALE_NODE_COUNT_FILE="${TEST_TMPDIR}/node-count"
    export TERRAFORM_DIR="${TEST_TMPDIR}/terraform"

    source "${TESTS_DIR}/../scale-common.sh"
    export HEROBIDS_ENV="staging"
    export PATH="/usr/bin:/bin"

    tf_ensure_ready
  } 2>&1
)" || RUN_EXIT=$?
assert_neq "${RUN_EXIT}" "0" "fails when terraform is not in PATH"
assert_contains "${RUN_OUTPUT}" "not found in PATH" "error mentions terraform not found in PATH"

# --- Fails when TERRAFORM_DIR does not exist ---

RUN_EXIT=0
RUN_OUTPUT="$(
  {
    export PATH="${READY_MOCK_DIR}:${PATH}"
    export HEROBIDS_ENV="staging"
    export TF_BACKEND_BUCKET="test-bucket"
    export TF_BACKEND_REGION="us-east-1"
    export AWS_ACCESS_KEY_ID="AKID123"
    export AWS_SECRET_ACCESS_KEY="SECRET123"
    export TERRAFORM_DIR="${TEST_TMPDIR}/nonexistent-dir"
    export NOMAD_AUTOSCALE_LOG_FILE="${TEST_TMPDIR}/autoscale.log"
    export NOMAD_AUTOSCALE_LOCKFILE="${TEST_TMPDIR}/autoscale.lock"
    export NOMAD_AUTOSCALE_COOLDOWN_FILE="${TEST_TMPDIR}/cooldown"
    export NOMAD_AUTOSCALE_NODE_COUNT_FILE="${TEST_TMPDIR}/node-count"

    source "${TESTS_DIR}/../scale-common.sh"
    export HEROBIDS_ENV="staging"
    export TERRAFORM_DIR="${TEST_TMPDIR}/nonexistent-dir"
    export PATH="${READY_MOCK_DIR}:${PATH}"

    tf_ensure_ready
  } 2>&1
)" || RUN_EXIT=$?
assert_neq "${RUN_EXIT}" "0" "fails when TERRAFORM_DIR does not exist"
assert_contains "${RUN_OUTPUT}" "does not exist" "error message mentions dir does not exist"

# --- Fails when terraform init fails ---

create_ready_mock "true" "default"
run_tf_ensure_ready
assert_neq "${RUN_EXIT}" "0" "fails when terraform init fails"

# --- Already on the correct workspace (no switch needed) ---

create_ready_mock "false" "staging"
run_tf_ensure_ready
assert_eq "${RUN_EXIT}" "0" "succeeds when already on correct workspace"
assert_contains "${RUN_OUTPUT}" "already set to" "logs workspace already correct"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# tf_apply_var (with mock terraform)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "tf_apply_var"

APPLY_MOCK_DIR="${TEST_TMPDIR}/apply-mock-bin"
mkdir -p "${APPLY_MOCK_DIR}"

create_apply_mock() {
  local should_fail="${1:-false}"

  cat > "${APPLY_MOCK_DIR}/terraform" << APPLYMOCK
#!/usr/bin/env bash
echo "\$0 \$*" >> "${TEST_TMPDIR}/terraform-calls"
if [[ "${should_fail}" == "true" ]]; then exit 1; fi
exit 0
APPLYMOCK
  chmod +x "${APPLY_MOCK_DIR}/terraform"
}

run_tf_apply_var() {
  : > "${TEST_TMPDIR}/terraform-calls"

  RUN_EXIT=0
  RUN_OUTPUT="$(
    {
      export PATH="${APPLY_MOCK_DIR}:${PATH}"
      export HEROBIDS_ENV="staging"
      export TEST_TMPDIR="${TEST_TMPDIR}"
      source "${TESTS_DIR}/source-helper.sh"
      export PATH="${APPLY_MOCK_DIR}:${PATH}"

      tf_apply_var "$@"
    } 2>&1
  )" || RUN_EXIT=$?
}

# --- Single var ---

create_apply_mock "false"
run_tf_apply_var "agent_node_count=5"
assert_eq "${RUN_EXIT}" "0" "succeeds with single var"
TF_CALLS="$(cat "${TEST_TMPDIR}/terraform-calls")"
assert_contains "${TF_CALLS}" "apply" "calls terraform apply"
assert_contains "${TF_CALLS}" "-auto-approve" "passes -auto-approve"
assert_contains "${TF_CALLS}" "-var" "passes -var flag"
assert_contains "${TF_CALLS}" "agent_node_count=5" "passes the var value"

# --- Multiple vars ---

create_apply_mock "false"
run_tf_apply_var "agent_node_count=3" "server_type=cx21"
TF_CALLS="$(cat "${TEST_TMPDIR}/terraform-calls")"
assert_contains "${TF_CALLS}" "agent_node_count=3" "passes first var"
assert_contains "${TF_CALLS}" "server_type=cx21" "passes second var"

# --- terraform apply failure ---

create_apply_mock "true"
run_tf_apply_var "agent_node_count=5"
assert_neq "${RUN_EXIT}" "0" "fails when terraform apply returns non-zero"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══ All test suites complete ═══"
exit "${SUITE_FAILED}"
