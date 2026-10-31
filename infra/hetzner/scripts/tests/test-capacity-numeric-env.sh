#!/usr/bin/env bash
# test-capacity-numeric-env.sh — operator-set numeric knobs must be validated before
# any arithmetic. Bash evaluates array subscripts inside arithmetic, so a value such
# as a[$(cmd)] would run cmd if it reached (( )) or [[ -lt ]]. Each attack writes a
# marker file if executed; the marker must never appear.
#
# Run: bash infra/hetzner/scripts/tests/test-capacity-numeric-env.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

source "${TESTS_DIR}/source-helper.sh"

SCRIPTS_DIR="$(cd "${TESTS_DIR}/.." && pwd)"
MARKER="${TEST_TMPDIR}/executed"

# uint_status VALUE MIN MAX — prints 0 when require_uint accepts VALUE, else the exit status.
uint_status() {
  ( require_uint TEST_KNOB "$1" "$2" "$3" ) >/dev/null 2>&1 && echo 0 || echo $?
}

test_begin "numeric env: plain integers inside the range are accepted"

assert_eq "$(uint_status 0 0 100)" "0" "0 is accepted at the lower bound"
assert_eq "$(uint_status 100 0 100)" "0" "100 is accepted at the upper bound"
assert_eq "$(uint_status 1 1 100)" "0" "1 is accepted at a minimum of 1"
assert_eq "$(uint_status 999999999 0 999999999)" "0" "nine digits are accepted when within the maximum"
assert_eq "$(validate_scale_numeric_env >/dev/null 2>&1 && echo 0 || echo $?)" "0" \
  "the shipped defaults pass validate_scale_numeric_env"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "numeric env: the demand batch cap is 2; the legacy increment keeps its HEAD bound"

# Demand mode is refused below bash 4.1 (covered by the startup-guard test below), so the
# demand-accepted range checks run only where demand mode can start.
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 1) )); then
  assert_eq "$(NOMAD_AUTOSCALE_DEMAND_ENABLED=true NOMAD_SCALE_OUT_INCREMENT_MAX=2 validate_scale_numeric_env >/dev/null 2>&1 && echo 0 || echo $?)" "0" \
    "demand increment max 2 is accepted"
  assert_eq "$(NOMAD_AUTOSCALE_DEMAND_ENABLED=true NOMAD_SCALE_OUT_INCREMENT_MAX=1 validate_scale_numeric_env >/dev/null 2>&1 && echo 0 || echo $?)" "0" \
    "demand increment max 1 is accepted"
fi
assert_neq "$(NOMAD_AUTOSCALE_DEMAND_ENABLED=true NOMAD_SCALE_OUT_INCREMENT_MAX=3 validate_scale_numeric_env >/dev/null 2>&1 && echo 0 || echo $?)" "0" \
  "demand increment max 3 is refused in demand mode"
assert_eq "$(NOMAD_AUTOSCALE_DEMAND_ENABLED=false NOMAD_SCALE_OUT_INCREMENT_MAX=5 validate_scale_numeric_env >/dev/null 2>&1 && echo 0 || echo $?)" "0" \
  "an unused demand max of 5 does not abort a legacy-mode run"
assert_eq "$(NOMAD_SCALE_OUT_INCREMENT=3 validate_scale_numeric_env >/dev/null 2>&1 && echo 0 || echo $?)" "0" \
  "legacy increment 3 is still accepted (the gate-disabled path is unchanged)"
assert_eq "$(NOMAD_SCALE_OUT_INCREMENT=100 validate_scale_numeric_env >/dev/null 2>&1 && echo 0 || echo $?)" "0" \
  "legacy increment 100 is still accepted (HEAD upper bound)"
assert_neq "$(NOMAD_SCALE_OUT_INCREMENT=101 validate_scale_numeric_env >/dev/null 2>&1 && echo 0 || echo $?)" "0" \
  "legacy increment 101 is refused"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "numeric env: non-integers, out-of-range values and leading zeros are refused"

for value in "" "abc" "-1" "1.5" "08" " 5" "0x10" "1e3" "+5" "101" "1000000000"; do
  assert_neq "$(uint_status "${value}" 0 100)" "0" "refused: '${value}'"
done
assert_neq "$(uint_status 0 1 100)" "0" "refused: 0 below a minimum of 1"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "numeric env: command-substitution values never execute"

for value in "a[\$(touch ${MARKER})]" "\$(touch ${MARKER})" "1;touch ${MARKER}" "1 && touch ${MARKER}"; do
  uint_status "${value}" 0 100 >/dev/null
done
assert_eq "$([[ -e "${MARKER}" ]] && echo present || echo absent)" "absent" \
  "no injected value reached arithmetic"
assert_eq "$(uint_status "a[\$(touch ${MARKER})]" 0 100)" "2" \
  "the subscript attack is refused with exit 2"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

# run_entry NAME VALUE SCRIPT — runs an entry script with one bad knob and prints "rc|output".
# Validation runs before any lock, network, or Terraform call, so no side effects occur.
run_entry() {
  local name="$1" value="$2" script="$3" out rc
  out="$(env -i PATH="/usr/bin:/bin" HOME="${TEST_TMPDIR}" \
    NOMAD_AUTOSCALE_LOG_FILE="${TEST_TMPDIR}/entry.log" \
    "${name}=${value}" bash "${SCRIPTS_DIR}/${script}" 2>&1)" && rc=0 || rc=$?
  echo "${rc}|${out}"
}

test_begin "numeric env: entry scripts refuse a bad knob at load time, before any side effect"

RESULT="$(run_entry NOMAD_AGENT_MEMORY_RESERVATION_MB "a[\$(touch ${MARKER})]" check-nomad-capacity.sh)"
assert_eq "${RESULT%%|*}" "1" "check-nomad-capacity.sh: refuses the subscript attack with exit 1"
assert_contains "${RESULT}" "NOMAD_AGENT_MEMORY_RESERVATION_MB=" "check-nomad-capacity.sh: names the variable"
assert_eq "$([[ -e "${MARKER}" ]] && echo present || echo absent)" "absent" \
  "check-nomad-capacity.sh: the injected value never executes"

RESULT="$(run_entry NOMAD_SCALE_OUT_COOLDOWN_SECONDS "soon" scale-out.sh)"
assert_eq "${RESULT%%|*}" "2" "scale-out.sh: refuses a non-integer cooldown with exit 2"
assert_contains "${RESULT}" "NOMAD_SCALE_OUT_COOLDOWN_SECONDS='soon'" "scale-out.sh: names the bad value"

RESULT="$(run_entry NOMAD_SCALE_IN_MAX_NODES_PER_RUN "11" scale-in.sh)"
assert_eq "${RESULT%%|*}" "2" "scale-in.sh: refuses 11 nodes per run with exit 2"

test_end || SUITE_FAILED=1

# demand_startup_status — prints 0 when startup validation accepts demand mode, else the exit status.
demand_startup_status() {
  ( NOMAD_AUTOSCALE_DEMAND_ENABLED=true validate_scale_numeric_env ) >/dev/null 2>&1 && echo 0 || echo $?
}

test_begin "numeric env: demand mode is refused at startup on bash < 4.1 (exec-fd lock)"

if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 1) )); then
  assert_eq "$(demand_startup_status)" "2" "bash ${BASH_VERSION}: demand mode exits 2 before any side effect"
  assert_contains "$( (NOMAD_AUTOSCALE_DEMAND_ENABLED=true validate_scale_numeric_env) 2>&1 || true)" \
    "needs bash >= 4.1" "bash ${BASH_VERSION}: the refusal names the requirement"
else
  assert_eq "$(demand_startup_status)" "0" "bash ${BASH_VERSION}: the guard does not refuse demand mode"
fi
assert_eq "$( (validate_scale_numeric_env) >/dev/null 2>&1 && echo 0 || echo $?)" "0" \
  "legacy mode (demand off) is accepted on every bash version"

test_end || SUITE_FAILED=1

exit "${SUITE_FAILED:-0}"