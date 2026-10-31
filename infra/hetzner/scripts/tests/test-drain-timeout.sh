#!/usr/bin/env bash
# test-drain-timeout.sh — Unit tests for drain-timeout safety semantics
# in scale-common.sh (wait_for_drain_complete) and the scale-in.sh drain loop.
#
# Validates W1 (drain-timeout safety): a timed-out node is excluded from
# DRAIN_OK, and mixed scenarios only include successfully-drained nodes.
#
# Run: bash infra/hetzner/scripts/tests/test-drain-timeout.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

# ─── Setup / teardown ─────────────────────────────────────────────────────────

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

# Source scale-common.sh with safe temp paths.
source "${TESTS_DIR}/source-helper.sh"

SUITE_FAILED=0

# ═════════════════════════════════════════════════════════════════════════════
# wait_for_drain_complete — timeout behavior
# ═════════════════════════════════════════════════════════════════════════════

test_begin "wait_for_drain_complete — timeout returns non-zero"

# --- Node with running allocs times out ---

# Override node_running_alloc_count to always return > 0
node_running_alloc_count() { echo "3"; }

RUN_EXIT=0
RUN_OUTPUT="$(wait_for_drain_complete "test-node-abc" 2 1 2>&1)" || RUN_EXIT=$?

assert_neq "${RUN_EXIT}" "0" "returns non-zero when node does not drain in time"
assert_contains "${RUN_OUTPUT}" "did not drain within" \
  "logs the timeout warning message"
assert_contains "${RUN_OUTPUT}" "test-node-abc" \
  "timeout message includes the node ID"
assert_contains "${RUN_OUTPUT}" "2s" \
  "timeout message includes the deadline"

# --- Node that drains immediately returns 0 ---

node_running_alloc_count() { echo "0"; }

RUN_EXIT=0
RUN_OUTPUT="$(wait_for_drain_complete "test-node-xyz" 5 1 2>&1)" || RUN_EXIT=$?

assert_eq "${RUN_EXIT}" "0" "returns 0 when node has no running allocs"
assert_contains "${RUN_OUTPUT}" "fully drained" \
  "logs the success message"

# --- Node that drains mid-poll returns 0 ---

# Use a counter file to simulate alloc count decreasing
ALLOC_COUNTER="${TEST_TMPDIR}/alloc-counter"
echo "2" > "${ALLOC_COUNTER}"

node_running_alloc_count() {
  local count
  count="$(cat "${ALLOC_COUNTER}")"
  local new_count=$(( count - 1 ))
  if [[ ${new_count} -lt 0 ]]; then new_count=0; fi
  echo "${new_count}" > "${ALLOC_COUNTER}"
  echo "${count}"
}

RUN_EXIT=0
RUN_OUTPUT="$(wait_for_drain_complete "test-node-mid" 10 1 2>&1)" || RUN_EXIT=$?

assert_eq "${RUN_EXIT}" "0" "returns 0 when node drains during polling"
assert_contains "${RUN_OUTPUT}" "fully drained" \
  "logs success after mid-poll drain"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Scale-in drain loop — DRAIN_OK exclusion logic
# ═════════════════════════════════════════════════════════════════════════════

SCALE_IN="${SCRIPTS_DIR}/scale-in.sh"
source "${SCRIPTS_DIR}/scale-in-guard.sh"

# ═════════════════════════════════════════════════════════════════════════════
# The shipped drain loop, extracted from scale-in.sh and run unchanged. Only the
# Nomad calls are stubbed. CALLS records what the loop asked for, in order.
# ═════════════════════════════════════════════════════════════════════════════

DRAIN_LOOP_SRC="$(awk '/^declare -a DRAIN_OK=\(\)/{on=1} on{print} on && /^done$/{exit}' "${SCALE_IN}")"
# shellcheck disable=SC2034  # read by the eval'd drain loop extracted from scale-in.sh
NOMAD_SCALE_IN_DRAIN_DEADLINE_SECONDS=5
log() { :; }
CALLS=""
node_is_idle() { CALLS+="idle:$1 "; [[ "${IDLE_FAIL:-}" != "$1" ]]; }
node_name() { if [[ "${NAME_MISMATCH:-}" == "$1" ]]; then echo "other-host"; else echo "name-$1"; fi; }
mark_node_ineligible() { CALLS+="inel:$1 "; [[ "${INEL_FAIL:-}" != "$1" ]]; }
drain_node() { CALLS+="drain:$1 "; [[ "${DRAIN_FAIL:-}" != "$1" ]]; }
wait_for_drain_complete() { CALLS+="wait:$1 "; [[ "${WAIT_FAIL:-}" != "$1" ]]; }
scale_in_restore_node() { CALLS+="restore:$1 "; }

# set_candidates ID... sets the selected suffix top-down, as scale-in.sh builds it.
set_candidates() {
  local n=0 id
  CAND_ID=(); CAND_SUFFIX=(); CAND_NAME=()
  for id in "$@"; do
    CAND_ID+=("${id}"); CAND_SUFFIX+=("${n}"); CAND_NAME+=("name-${id}"); n=$(( n + 1 ))
  done
  # shellcheck disable=SC2034  # read by the eval'd drain loop extracted from scale-in.sh
  RUN_LEN=${#CAND_ID[@]}
  CALLS=""; IDLE_FAIL=""; NAME_MISMATCH=""; INEL_FAIL=""; DRAIN_FAIL=""; WAIT_FAIL=""
}

# drained_list prints DRAIN_OK space-separated; the bash 3.2-safe form tolerates an empty array.
drained_list() {
  local out="" x
  for x in ${DRAIN_OK[@]+"${DRAIN_OK[@]}"}; do out+="${out:+ }${x}"; done
  printf '%s' "${out}"
}

test_begin "scale-in drain loop: a node that times out stops the run and is restored, never deleted"

set_candidates a b c
WAIT_FAIL=b
eval "${DRAIN_LOOP_SRC}"
assert_eq "$(drained_list)" "a" "only the node drained before the timeout is kept"
assert_contains "${CALLS}" "restore:b " "the timed-out node is restored to schedulable"
assert_not_contains "${CALLS}" "drain:c" "the node after the timeout is not drained"

test_end || SUITE_FAILED=1

test_begin "scale-in drain loop: every candidate that drains is kept in suffix order"

set_candidates a b c
eval "${DRAIN_LOOP_SRC}"
assert_eq "$(drained_list)" "a b c" "all three drained nodes are kept in order"
assert_not_contains "${CALLS}" "restore:" "a clean run restores nothing"

test_end || SUITE_FAILED=1

test_begin "scale-in drain loop: an idle check that cannot prove idle stops before any drain"

set_candidates a b c
IDLE_FAIL=b
eval "${DRAIN_LOOP_SRC}"
assert_eq "$(drained_list)" "a" "only the node before the unproven one is kept"
assert_not_contains "${CALLS}" "drain:b" "a node that is not proven idle is not drained"
assert_not_contains "${CALLS}" "drain:c" "nothing after it is drained"

test_end || SUITE_FAILED=1

test_begin "scale-in drain loop: a live name that no longer matches the server stops the run"

set_candidates a b
NAME_MISMATCH=b
eval "${DRAIN_LOOP_SRC}"
assert_eq "$(drained_list)" "a" "the mismatched node is not kept"
assert_not_contains "${CALLS}" "inel:b" "the mismatched node is not marked ineligible"
assert_not_contains "${CALLS}" "drain:b" "the mismatched node is not drained"

test_end || SUITE_FAILED=1

test_begin "scale-in drain loop: a node that cannot be marked ineligible is not drained"

set_candidates a b
INEL_FAIL=a
eval "${DRAIN_LOOP_SRC}"
assert_eq "$(drained_list)" "" "no node is kept when the first cannot be marked"
assert_not_contains "${CALLS}" "drain:a" "the unmarked node is not drained"

test_end || SUITE_FAILED=1

test_begin "scale-in drain loop: a failed drain start is restored and stops the run"

set_candidates a b
DRAIN_FAIL=a
eval "${DRAIN_LOOP_SRC}"
assert_eq "$(drained_list)" "" "no node is kept when the drain fails to start"
assert_contains "${CALLS}" "restore:a " "the node whose drain failed to start is restored"
assert_not_contains "${CALLS}" "drain:b" "the run stops, so the next node is not drained"

test_end || SUITE_FAILED=1

test_begin "scale-in: an empty drain set exits before terraform is reached"

EMPTY_BLOCK="$(awk '/^if \[\[ "\$\{#DRAIN_OK\[@\]\}" -eq 0 \]\]; then/{on=1} on{print} on && /^fi$/{exit}' "${SCALE_IN}")"
assert_contains "${EMPTY_BLOCK}" "exit 1" "no drained node exits non-zero"
assert_not_contains "${EMPTY_BLOCK}" "tf_apply" "no drained node skips terraform"

test_end || SUITE_FAILED=1

test_begin "scale-in restore: a failed restore is recorded so the run ends in a visible failure"

# The real helper, extracted from scale-in.sh, with only the Nomad restore stubbed.
RESTORE_SRC="$(awk '/^scale_in_restore_node\(\) \{/{on=1} on{print} on && /^}$/{exit}' "${SCALE_IN}")"
eval "${RESTORE_SRC}"
restore_node_schedulable() { return "${RESTORE_RC:-0}"; }
send_alert() { :; }
alert_failure() { return 0; }

SCALE_IN_RESTORE_FAILED=0
RESTORE_RC=0
scale_in_restore_node "a" >/dev/null 2>&1
assert_eq "${SCALE_IN_RESTORE_FAILED}" "0" "a successful restore records no failure"

RESTORE_RC=1
scale_in_restore_node "a" >/dev/null 2>&1
assert_eq "${SCALE_IN_RESTORE_FAILED}" "1" "a failed restore is recorded, not hidden"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# New count: current minus drained, refused outside [MIN, CURRENT) (no clamp)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "scale-in new count: a target below min is refused, never clamped up to min"

assert_failure "removing 1 of 3 at min 3 is refused, not clamped to 3" scale_in_new_count_ok 3 2 3
assert_success "removing 1 of 5 at min 2 is accepted" scale_in_new_count_ok 5 4 2
assert_success "removing 3 of 8 at min 2 is accepted" scale_in_new_count_ok 8 5 2
assert_failure "removing nothing is refused" scale_in_new_count_ok 3 3 2

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══ All drain-timeout test suites complete ═══"
exit "${SUITE_FAILED}"
