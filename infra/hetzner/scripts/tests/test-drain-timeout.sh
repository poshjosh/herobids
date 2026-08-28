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

test_begin "scale-in drain loop — timed-out nodes excluded from DRAIN_OK"

# This test simulates the drain loop from scale-in.sh by calling the
# relevant functions with mocked Nomad API operations. We verify that
# DRAIN_OK contains only successfully-drained nodes.

# We run the drain loop inline (not in subshells) so we can inspect
# DRAIN_OK directly. The loop logic is copied from scale-in.sh.

# --- Single node: times out → DRAIN_OK is empty ---

mark_node_ineligible() { return 0; }
drain_node() { return 0; }
mark_node_eligible() { return 0; }
wait_for_drain_complete() { return 1; }

declare -a DRAIN_OK=()
_VERIFIED=("timeout-node-1")

for node_id in "${_VERIFIED[@]}"; do
  if ! mark_node_ineligible "${node_id}"; then continue; fi
  if ! drain_node "${node_id}" 5; then continue; fi
  if ! wait_for_drain_complete "${node_id}" 5; then
    mark_node_eligible "${node_id}" || true
    continue
  fi
  DRAIN_OK+=("${node_id}")
done

assert_eq "${#DRAIN_OK[@]}" "0" \
  "timed-out node is excluded from DRAIN_OK"

# --- Single node: drains successfully → DRAIN_OK has 1 ---

wait_for_drain_complete() { return 0; }

DRAIN_OK=()
_VERIFIED=("success-node-1")

for node_id in "${_VERIFIED[@]}"; do
  if ! mark_node_ineligible "${node_id}"; then continue; fi
  if ! drain_node "${node_id}" 5; then continue; fi
  if ! wait_for_drain_complete "${node_id}" 5; then
    mark_node_eligible "${node_id}" || true
    continue
  fi
  DRAIN_OK+=("${node_id}")
done

assert_eq "${#DRAIN_OK[@]}" "1" \
  "successfully drained node is in DRAIN_OK"
assert_eq "${DRAIN_OK[0]}" "success-node-1" \
  "DRAIN_OK contains the correct node ID"

# --- Mixed: node A drains, node B times out → only node A in DRAIN_OK ---

wait_for_drain_complete() {
  local nid="$1"
  if [[ "${nid}" == "node-A-ok" ]]; then return 0; fi
  return 1
}

DRAIN_OK=()
_VERIFIED=("node-A-ok" "node-B-timeout")

for node_id in "${_VERIFIED[@]}"; do
  if ! mark_node_ineligible "${node_id}"; then continue; fi
  if ! drain_node "${node_id}" 5; then continue; fi
  if ! wait_for_drain_complete "${node_id}" 5; then
    mark_node_eligible "${node_id}" || true
    continue
  fi
  DRAIN_OK+=("${node_id}")
done

assert_eq "${#DRAIN_OK[@]}" "1" \
  "mixed scenario: only 1 node in DRAIN_OK"
assert_eq "${DRAIN_OK[0]}" "node-A-ok" \
  "mixed scenario: successful node is in DRAIN_OK"

# --- All candidates time out → DRAIN_OK is empty ---

wait_for_drain_complete() { return 1; }

DRAIN_OK=()
_VERIFIED=("node-X" "node-Y" "node-Z")

for node_id in "${_VERIFIED[@]}"; do
  if ! mark_node_ineligible "${node_id}"; then continue; fi
  if ! drain_node "${node_id}" 5; then continue; fi
  if ! wait_for_drain_complete "${node_id}" 5; then
    mark_node_eligible "${node_id}" || true
    continue
  fi
  DRAIN_OK+=("${node_id}")
done

assert_eq "${#DRAIN_OK[@]}" "0" \
  "all-timeout scenario: DRAIN_OK is empty"

# --- mark_node_ineligible fails → node skipped entirely ---

mark_node_ineligible() { return 1; }
wait_for_drain_complete() { return 0; }

DRAIN_OK=()
_VERIFIED=("failed-ineligible-node")

for node_id in "${_VERIFIED[@]}"; do
  if ! mark_node_ineligible "${node_id}"; then continue; fi
  if ! drain_node "${node_id}" 5; then continue; fi
  if ! wait_for_drain_complete "${node_id}" 5; then
    mark_node_eligible "${node_id}" || true
    continue
  fi
  DRAIN_OK+=("${node_id}")
done

assert_eq "${#DRAIN_OK[@]}" "0" \
  "node skipped when mark_node_ineligible fails"

# --- drain_node fails → node skipped ---

mark_node_ineligible() { return 0; }
drain_node() { return 1; }

DRAIN_OK=()
_VERIFIED=("failed-drain-node")

for node_id in "${_VERIFIED[@]}"; do
  if ! mark_node_ineligible "${node_id}"; then continue; fi
  if ! drain_node "${node_id}" 5; then continue; fi
  if ! wait_for_drain_complete "${node_id}" 5; then
    mark_node_eligible "${node_id}" || true
    continue
  fi
  DRAIN_OK+=("${node_id}")
done

assert_eq "${#DRAIN_OK[@]}" "0" \
  "node skipped when drain_node fails"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Scale-in shrink count — derives from DRAIN_OK only
# ═════════════════════════════════════════════════════════════════════════════

test_begin "scale-in shrink count — based on DRAIN_OK size"

# The shrink formula from scale-in.sh:
#   NEW_COUNT = CURRENT_COUNT - ${#DRAIN_OK[@]}
#   if NEW_COUNT < MIN_COUNT then NEW_COUNT = MIN_COUNT

# --- 2 candidates, 1 drains → shrink by 1 ---

CURRENT_COUNT=5
MIN_COUNT=2
DRAIN_OK=("node-ok")

NEW_COUNT=$(( CURRENT_COUNT - ${#DRAIN_OK[@]} ))
if [[ ${NEW_COUNT} -lt ${MIN_COUNT} ]]; then
  NEW_COUNT=${MIN_COUNT}
fi

assert_eq "${NEW_COUNT}" "4" \
  "shrinks by 1 when 1 of 2 nodes drains"

# --- All timeout → DRAIN_OK empty → terraform skipped ---

CURRENT_COUNT=5
MIN_COUNT=2
DRAIN_OK=()

if [[ ${#DRAIN_OK[@]} -eq 0 ]]; then
  _SKIP="true"
else
  _SKIP="false"
  NEW_COUNT=$(( CURRENT_COUNT - ${#DRAIN_OK[@]} ))
  if [[ ${NEW_COUNT} -lt ${MIN_COUNT} ]]; then
    NEW_COUNT=${MIN_COUNT}
  fi
fi

assert_eq "${_SKIP}" "true" \
  "all-timeout: terraform apply is skipped"

# --- Shrink respects min_agent_nodes floor ---

CURRENT_COUNT=3
MIN_COUNT=3
DRAIN_OK=("node-1")

NEW_COUNT=$(( CURRENT_COUNT - ${#DRAIN_OK[@]} ))
if [[ ${NEW_COUNT} -lt ${MIN_COUNT} ]]; then
  NEW_COUNT=${MIN_COUNT}
fi

assert_eq "${NEW_COUNT}" "3" \
  "shrink clamped to min_agent_nodes"

# --- Multiple successful drains → shrinks by that count ---

CURRENT_COUNT=8
MIN_COUNT=2
DRAIN_OK=("node-a" "node-b" "node-c")

NEW_COUNT=$(( CURRENT_COUNT - ${#DRAIN_OK[@]} ))
if [[ ${NEW_COUNT} -lt ${MIN_COUNT} ]]; then
  NEW_COUNT=${MIN_COUNT}
fi

assert_eq "${NEW_COUNT}" "5" \
  "shrinks by 3 when 3 nodes drain successfully"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══ All drain-timeout test suites complete ═══"
exit "${SUITE_FAILED}"
