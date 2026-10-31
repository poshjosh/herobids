#!/usr/bin/env bash
# test-capacity-tfvars-node-count.sh — sync_tfvars_node_count keeps the
# agent_node_count line in <env>.tfvars equal to the applied count, so a manual
# Terraform run cannot plan to remove live agent nodes.
#
# Run: bash infra/hetzner/scripts/tests/test-capacity-tfvars-node-count.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

source "${TESTS_DIR}/source-helper.sh"

SUITE_FAILED=0
RUN_OUTPUT=""
RUN_EXIT=0

# Each case gets its own directory so one case cannot leak into another.
new_case_dir() {
  local dir
  dir="$(mktemp -d "${TEST_TMPDIR}/case.XXXXXX")"
  echo "${dir}"
}

# run_sync <terraform-dir> <env> <count> — runs the helper in a subshell.
run_sync() {
  local dir="$1" env="$2" count="$3"
  RUN_EXIT=0
  RUN_OUTPUT="$(
    {
      source "${TESTS_DIR}/source-helper.sh"
      export TERRAFORM_DIR="${dir}"
      export HEROBIDS_ENV="${env}"
      sync_tfvars_node_count "${count}"
    } 2>&1
  )" || RUN_EXIT=$?
}

file_mode() {
  stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"
}

# ═════════════════════════════════════════════════════════════════════════════

test_begin "sync_tfvars_node_count: replaces an existing agent_node_count line"

DIR="$(new_case_dir)"
cat > "${DIR}/staging.tfvars" <<'EOF'
server_name = "herobids"
agent_node_count = 1
agent_node_server_type = "cx23"
EOF
chmod 600 "${DIR}/staging.tfvars"
run_sync "${DIR}" staging 2
assert_eq "${RUN_EXIT}" "0" "exits 0 on a valid count"
assert_eq "$(grep -c '^agent_node_count = 2$' "${DIR}/staging.tfvars")" "1" "line now reads agent_node_count = 2"
assert_eq "$(grep -c 'agent_node_count' "${DIR}/staging.tfvars")" "1" "exactly one agent_node_count line"
assert_contains "$(cat "${DIR}/staging.tfvars")" 'server_name = "herobids"' "other lines are kept"
assert_contains "$(cat "${DIR}/staging.tfvars")" 'agent_node_server_type = "cx23"' "later lines are kept"
assert_eq "$(file_mode "${DIR}/staging.tfvars")" "600" "file mode stays 0600"
assert_eq "$(ls -A "${DIR}" | grep -c 'XXXXXX' || true)" "0" "no temp file left behind"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "sync_tfvars_node_count: handles spacing variants and leaves comments alone"

DIR="$(new_case_dir)"
cat > "${DIR}/staging.tfvars" <<'EOF'
# agent_node_count = 9
   agent_node_count=1
EOF
run_sync "${DIR}" staging 3
assert_eq "${RUN_EXIT}" "0" "exits 0 with a no-spaces assignment"
assert_contains "$(cat "${DIR}/staging.tfvars")" "# agent_node_count = 9" "commented line is untouched"
assert_eq "$(grep -c '^agent_node_count = 3$' "${DIR}/staging.tfvars")" "1" "no-spaces assignment is replaced"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "sync_tfvars_node_count: appends the line when the file has none"

DIR="$(new_case_dir)"
printf 'server_name = "herobids"\n' > "${DIR}/staging.tfvars"
run_sync "${DIR}" staging 2
assert_eq "${RUN_EXIT}" "0" "exits 0 when the line is missing"
assert_eq "$(grep -c '^agent_node_count = 2$' "${DIR}/staging.tfvars")" "1" "line is appended"
assert_contains "$(cat "${DIR}/staging.tfvars")" 'server_name = "herobids"' "existing content is kept"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "sync_tfvars_node_count: refuses bad input without touching the file"

DIR="$(new_case_dir)"
printf 'agent_node_count = 1\n' > "${DIR}/staging.tfvars"
before="$(cat "${DIR}/staging.tfvars")"

run_sync "${DIR}" staging "two"
assert_neq "${RUN_EXIT}" "0" "refuses a non-numeric count"
run_sync "${DIR}" staging ""
assert_neq "${RUN_EXIT}" "0" "refuses an empty count"
run_sync "${DIR}" staging "-1"
assert_neq "${RUN_EXIT}" "0" "refuses a negative count"
assert_eq "$(cat "${DIR}/staging.tfvars")" "${before}" "file is unchanged after refused input"

EMPTY_DIR="$(new_case_dir)"
run_sync "${EMPTY_DIR}" staging 2
assert_neq "${RUN_EXIT}" "0" "refuses when the tfvars file is missing"
assert_contains "${RUN_OUTPUT}" "not found" "missing file is reported"
assert_eq "$(ls -A "${EMPTY_DIR}" | wc -l | tr -d ' ')" "0" "no file is created when the tfvars is missing"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "sync_tfvars_node_count: every apply path records the count after a successful apply"

SCALE_OUT="${TESTS_DIR}/../scale-out.sh"
SCALE_IN="${TESTS_DIR}/../scale-in.sh"

# first_line <file> <fixed-string> — line number of the first match, or 0.
first_line() {
  local n
  n="$(grep -n -F -- "$2" "$1" | head -1 | cut -d: -f1)" || true
  echo "${n:-0}"
}

DEMAND_APPLY="$(first_line "${SCALE_OUT}" 'terraform apply -input=false "${plan_file}"')"
DEMAND_SYNC="$(first_line "${SCALE_OUT}" 'sync_tfvars_node_count "${target}"')"
LEGACY_APPLY="$(first_line "${SCALE_OUT}" 'if tf_apply_var "agent_node_count=${NEW_COUNT}"')"
LEGACY_SYNC="$(first_line "${SCALE_OUT}" 'sync_tfvars_node_count "${NEW_COUNT}"')"
LEGACY_CACHE="$(first_line "${SCALE_OUT}" 'write_node_count "${NEW_COUNT}"')"
IN_STATE="$(first_line "${SCALE_IN}" 'if ! scale_in_sync_state "${NEW_COUNT}"')"
IN_SYNC="$(first_line "${SCALE_IN}" 'sync_tfvars_node_count "${NEW_COUNT}"')"
IN_CACHE="$(first_line "${SCALE_IN}" 'write_node_count "${NEW_COUNT}"')"

assert_neq "${DEMAND_SYNC}" "0" "demand path calls sync_tfvars_node_count"
assert_neq "${DEMAND_APPLY}" "0" "demand path apply line is found"
assert_eq "$([[ ${DEMAND_SYNC} -gt ${DEMAND_APPLY} ]] && echo yes || echo no)" "yes" "demand sync comes after the saved-plan apply"
assert_neq "${LEGACY_SYNC}" "0" "legacy path calls sync_tfvars_node_count"
assert_eq "$([[ ${LEGACY_SYNC} -gt ${LEGACY_APPLY} ]] && echo yes || echo no)" "yes" "legacy sync comes after tf_apply_var"
assert_eq "$([[ ${LEGACY_SYNC} -lt ${LEGACY_CACHE} ]] && echo yes || echo no)" "yes" "legacy sync comes before the cache write"
assert_neq "${IN_SYNC}" "0" "scale-in calls sync_tfvars_node_count"
assert_eq "$([[ ${IN_SYNC} -gt ${IN_STATE} ]] && echo yes || echo no)" "yes" "scale-in sync comes after scale_in_sync_state"
assert_eq "$([[ ${IN_SYNC} -lt ${IN_CACHE} ]] && echo yes || echo no)" "yes" "scale-in sync comes before the cache write"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══ All test suites complete ═══"
exit "${SUITE_FAILED}"
