#!/usr/bin/env bash
# test-alert-context.sh — Unit tests for the S3 backend section in
# build_alert_context() (alert-common.sh).
#
# Run: bash infra/hetzner/scripts/tests/test-alert-context.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

# ─── Setup / teardown ─────────────────────────────────────────────────────────

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

# Track overall suite failure for final exit code.
SUITE_FAILED=0

# ═════════════════════════════════════════════════════════════════════════════
# build_alert_context — S3 backend info section
# ═════════════════════════════════════════════════════════════════════════════

test_begin "build_alert_context — S3 backend info"

# Helper: run build_alert_context in a subshell with specific env vars
run_build_context() {
  local extra_env=("$@")

  RUN_EXIT=0
  RUN_OUTPUT="$(
    # Set base vars
    export TEST_TMPDIR="${TEST_TMPDIR}"
    export NOMAD_AUTOSCALE_LOG_FILE="${TEST_TMPDIR}/autoscale.log"
    export NOMAD_AUTOSCALE_LOCKFILE="${TEST_TMPDIR}/autoscale.lock"
    export NOMAD_AUTOSCALE_COOLDOWN_FILE="${TEST_TMPDIR}/cooldown"
    export NOMAD_AUTOSCALE_NODE_COUNT_FILE="${TEST_TMPDIR}/node-count"
    export NOMAD_AUTOSCALE_FAILURE_COUNT_FILE="${TEST_TMPDIR}/failure-count"
    export NOMAD_AUTOSCALE_LAST_ALERT_FILE="${TEST_TMPDIR}/last-alert"
    export TERRAFORM_DIR="${TEST_TMPDIR}/terraform"
    export HEROBIDS_ENV="staging"
    export NOMAD_ADDR=""

    mkdir -p "${TERRAFORM_DIR}"
    touch "${NOMAD_AUTOSCALE_LOG_FILE}"

    for ev in "${extra_env[@]+"${extra_env[@]}"}"; do
      export "${ev?}"
    done

    source "${TESTS_DIR}/../scale-common.sh"
    source "${TESTS_DIR}/../alert-common.sh"

    # Re-apply env overrides after sourcing
    for ev in "${extra_env[@]+"${extra_env[@]}"}"; do
      export "${ev?}"
    done

    build_alert_context "test_failure" "test reason"
  )" 2>&1 || RUN_EXIT=$?
}

# --- Shows S3 backend label ---

run_build_context \
  "TF_BACKEND_BUCKET=my-state-bucket" \
  "TF_BACKEND_REGION=eu-central-1"
assert_eq "${RUN_EXIT}" "0" "build_alert_context succeeds"
assert_contains "${RUN_OUTPUT}" "S3 (remote)" "context shows S3 (remote) backend label"
assert_contains "${RUN_OUTPUT}" "Terraform Backend" "context has Terraform Backend header"

# --- Shows bucket name ---

assert_contains "${RUN_OUTPUT}" "my-state-bucket" "context shows the configured bucket name"

# --- Shows region ---

assert_contains "${RUN_OUTPUT}" "eu-central-1" "context shows the configured region"

# --- Shows state key derived from env ---

assert_contains "${RUN_OUTPUT}" "herobids/staging/terraform.tfstate" "context shows state key for staging"

# --- Production env shows production key ---

run_build_context \
  "HEROBIDS_ENV=production" \
  "TF_BACKEND_BUCKET=prod-bucket" \
  "TF_BACKEND_REGION=us-east-1"
assert_contains "${RUN_OUTPUT}" "herobids/production/terraform.tfstate" "production env shows production state key"
assert_contains "${RUN_OUTPUT}" "prod-bucket" "shows production bucket"
assert_contains "${RUN_OUTPUT}" "us-east-1" "shows production region"

# --- Shows DynamoDB lock table when set ---

run_build_context \
  "TF_BACKEND_BUCKET=my-bucket" \
  "TF_BACKEND_REGION=eu-central-1" \
  "TF_BACKEND_DYNAMODB_TABLE=tf-locks"
assert_contains "${RUN_OUTPUT}" "tf-locks" "context shows DynamoDB table when set"
assert_contains "${RUN_OUTPUT}" "Lock table" "context has lock table label"

# --- Omits DynamoDB when unset ---

run_build_context \
  "TF_BACKEND_BUCKET=my-bucket" \
  "TF_BACKEND_REGION=eu-central-1"
assert_not_contains "${RUN_OUTPUT}" "Lock table" "no lock table label when TF_BACKEND_DYNAMODB_TABLE is unset"

# --- Shows <not set> placeholders when vars are missing ---

run_build_context \
  "TF_BACKEND_BUCKET=" \
  "TF_BACKEND_REGION="
assert_contains "${RUN_OUTPUT}" "<not set>" "shows <not set> when backend vars are empty"

# --- Shows Terraform directory ---

run_build_context \
  "TF_BACKEND_BUCKET=my-bucket" \
  "TF_BACKEND_REGION=eu-central-1"
assert_contains "${RUN_OUTPUT}" "Dir:" "context has Dir label"

# --- Does not mention local terraform.tfstate ---

run_build_context \
  "TF_BACKEND_BUCKET=my-bucket" \
  "TF_BACKEND_REGION=eu-central-1"
assert_not_contains "${RUN_OUTPUT}" "terraform.tfstate.d" "no reference to local terraform.tfstate.d"
# The key path contains terraform.tfstate but that's the S3 key, not a local file reference.
# We specifically check that it does NOT reference a local state file path pattern.
assert_not_contains "${RUN_OUTPUT}" "Local state" "no reference to local state"

# --- Context includes failure metadata ---

run_build_context \
  "TF_BACKEND_BUCKET=my-bucket" \
  "TF_BACKEND_REGION=eu-central-1"
assert_contains "${RUN_OUTPUT}" "test_failure" "context includes the failure type"
assert_contains "${RUN_OUTPUT}" "test reason" "context includes the failure reason"
assert_contains "${RUN_OUTPUT}" "staging" "context includes the environment"
assert_contains "${RUN_OUTPUT}" "Herobids Autoscale Alert" "context has the alert header"

# --- Context includes node count from state file ---

echo "7" > "${TEST_TMPDIR}/node-count"
run_build_context \
  "TF_BACKEND_BUCKET=my-bucket" \
  "TF_BACKEND_REGION=eu-central-1"
assert_contains "${RUN_OUTPUT}" "7" "context includes the node count from state file"

# --- Context includes manual recovery reference ---

run_build_context \
  "TF_BACKEND_BUCKET=my-bucket" \
  "TF_BACKEND_REGION=eu-central-1"
assert_contains "${RUN_OUTPUT}" "Manual recovery" "context includes manual recovery reference"
assert_contains "${RUN_OUTPUT}" "herobids-nomad-autoscaler" "context includes autoscaler attribution"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══ All alert-context test suites complete ═══"
exit "${SUITE_FAILED}"
