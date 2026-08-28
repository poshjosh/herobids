#!/usr/bin/env bash
# source-helper.sh — Source scale-common.sh (and optionally alert-common.sh)
# with safe defaults so the test does not touch system paths or require
# external services.
#
# Usage:
#   TEST_TMPDIR="$(create_test_tmpdir)"
#   source "$(dirname "${BASH_SOURCE[0]}")/source-helper.sh"
#
# Requires TEST_TMPDIR to be set before sourcing.

set -euo pipefail

if [[ -z "${TEST_TMPDIR:-}" ]]; then
  echo "ERROR: TEST_TMPDIR must be set before sourcing source-helper.sh" >&2
  exit 1
fi

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "${TESTS_DIR}/.." && pwd)"

# ─── Override system paths with temp paths ────────────────────────────────────

export NOMAD_AUTOSCALE_LOG_FILE="${TEST_TMPDIR}/autoscale.log"
export NOMAD_AUTOSCALE_LOCKFILE="${TEST_TMPDIR}/autoscale.lock"
export NOMAD_AUTOSCALE_COOLDOWN_FILE="${TEST_TMPDIR}/cooldown"
export NOMAD_AUTOSCALE_NODE_COUNT_FILE="${TEST_TMPDIR}/node-count"
export NOMAD_AUTOSCALE_FAILURE_COUNT_FILE="${TEST_TMPDIR}/failure-count"
export NOMAD_AUTOSCALE_LAST_ALERT_FILE="${TEST_TMPDIR}/last-alert"
export TERRAFORM_DIR="${TEST_TMPDIR}/terraform"
mkdir -p "${TERRAFORM_DIR}"

# Create the log file so tee -a doesn't fail
touch "${NOMAD_AUTOSCALE_LOG_FILE}"

# ─── Source scale-common.sh ───────────────────────────────────────────────────

source "${SCRIPTS_DIR}/scale-common.sh"
