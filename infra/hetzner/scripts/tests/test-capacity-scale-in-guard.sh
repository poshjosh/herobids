#!/usr/bin/env bash
# shellcheck disable=SC2034  # config variables are read by the sourced scale-in helpers
# test-capacity-scale-in-guard.sh — the drained-suffix guard for scale-in (plan §8).
# A saved scale-in plan must delete exactly the drained, contiguous, highest-index
# suffix. The validator is exercised on fixture plan JSON; scale-in.sh ordering
# (lock before Terraform, validator before apply, drain-timeout and grace rules)
# is checked statically, because the script's main flow needs live cloud and Nomad.
#
# Nothing is networked and no Terraform backend is touched.
#
# Run: bash infra/hetzner/scripts/tests/test-capacity-scale-in-guard.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

source "${TESTS_DIR}/source-helper.sh"
source "${SCRIPTS_DIR}/scale-in-guard.sh"

SCALE_IN="${SCRIPTS_DIR}/scale-in.sh"

ACT_DEL='["delete"]'
ACT_KEEP='["no-op"]'
ACT_UPD='["update"]'
ACT_REPLACE='["delete","create"]'

# Plan fixture builders. Each prints one terraform show -json resource_changes entry.
# A server's name is herobids-agent-(index+1), as main.tf names it.
srv() { printf '{"address":"hcloud_server.agent[%s]","mode":"managed","type":"hcloud_server","name":"agent","index":%s,"change":{"actions":%s,"before":{"name":"herobids-agent-%s"}}}' "$1" "$1" "$2" "$(( $1 + 1 ))"; }
net() { printf '{"address":"hcloud_server_network.agent[%s]","mode":"managed","type":"hcloud_server_network","name":"agent","index":%s,"change":{"actions":%s}}' "$1" "$1" "$2"; }
# plan_of NEW RESOURCE_CHANGES_BODY
plan_of() { printf '{"variables":{"agent_node_count":{"value":%s}},"resource_changes":[%s]}' "$1" "$2"; }

# default_bindings DRAINED_CSV — the binding each drained index should carry.
default_bindings() {
  local out="" i
  local IFS=','
  for i in $1; do out+="${out:+,}${i}=herobids-agent-$(( i + 1 ))"; done
  printf '%s' "${out}"
}

# run_validate CUR NEW DRAINED JSON [BINDINGS] — sets V_RC and V_ERR. Without an
# explicit BINDINGS argument the correct default bindings are passed.
run_validate() {
  local rc=0 err bindings
  if [[ $# -ge 5 ]]; then bindings="$5"; else bindings="$(default_bindings "$3")"; fi
  err="$(printf '%s' "$4" | scale_in_plan_validate "$1" "$2" "$3" "${bindings}" 2>&1 >/dev/null)" || rc=$?
  V_RC="${rc}"
  V_ERR="${err}"
}

# Count 3 -> 1, drained suffix indices 1,2 (TF) = suffix nodes 2,3.
GOOD_C3_N1="$(plan_of 1 "$(srv 0 "${ACT_KEEP}"),$(srv 1 "${ACT_DEL}"),$(srv 2 "${ACT_DEL}"),$(net 0 "${ACT_KEEP}"),$(net 1 "${ACT_DEL}"),$(net 2 "${ACT_DEL}")")"

# ═════════════════════════════════════════════════════════════════════════════
# Drained-suffix validator: accepted and refused plans
# ═════════════════════════════════════════════════════════════════════════════

test_begin "scale-in guard: a valid drained suffix is accepted"

run_validate 3 1 "1,2" "${GOOD_C3_N1}"
assert_eq "${V_RC}" "0" "3 -> 1 deleting exactly indices 1,2 passes"
assert_eq "${V_ERR}" "" "an accepted plan prints no violations"

GOOD_C3_N2="$(plan_of 2 "$(srv 0 "${ACT_KEEP}"),$(srv 1 "${ACT_KEEP}"),$(srv 2 "${ACT_DEL}"),$(net 2 "${ACT_DEL}")")"
run_validate 3 2 "2" "${GOOD_C3_N2}"
assert_eq "${V_RC}" "0" "a single-node suffix 3 -> 2 deleting only index 2 passes"

test_end || SUITE_FAILED=1

test_begin "scale-in guard: a lower-index delete is refused"

LOWER_INDEX="$(plan_of 1 "$(srv 0 "${ACT_DEL}"),$(srv 1 "${ACT_KEEP}"),$(srv 2 "${ACT_DEL}")")"
run_validate 3 1 "1,2" "${LOWER_INDEX}"
assert_eq "${V_RC}" "1" "a plan that deletes index 0 instead of index 1 is refused"
assert_contains "${V_ERR}" "server delete indices" "the refusal names the mismatched delete set"

test_end || SUITE_FAILED=1

test_begin "scale-in guard: a non-contiguous drained set is refused"

NONCONTIG="$(plan_of 2 "$(srv 0 "${ACT_KEEP}"),$(srv 1 "${ACT_DEL}"),$(srv 2 "${ACT_KEEP}"),$(srv 3 "${ACT_DEL}")")"
run_validate 4 2 "1,3" "${NONCONTIG}"
assert_eq "${V_RC}" "1" "drained indices 1,3 with 4 -> 2 are refused"
assert_contains "${V_ERR}" "not the contiguous suffix" "the refusal states the suffix is not contiguous"

test_end || SUITE_FAILED=1

test_begin "scale-in guard: an active or undrained server in the suffix is refused"

# Index 1 is active (not drained) but the plan still deletes it.
ACTIVE_IN_SUFFIX="$(plan_of 2 "$(srv 0 "${ACT_KEEP}"),$(srv 1 "${ACT_DEL}"),$(srv 2 "${ACT_DEL}")")"
run_validate 3 2 "2" "${ACTIVE_IN_SUFFIX}"
assert_eq "${V_RC}" "1" "a plan deleting an undrained index 1 beyond the drained set is refused"
assert_contains "${V_ERR}" "server delete indices" "the refusal reports the extra delete"

# The undrained server is updated in place rather than deleted.
UPDATED_IN_SUFFIX="$(plan_of 2 "$(srv 0 "${ACT_KEEP}"),$(srv 1 "${ACT_UPD}"),$(srv 2 "${ACT_DEL}")")"
run_validate 3 2 "2" "${UPDATED_IN_SUFFIX}"
assert_eq "${V_RC}" "1" "an undrained server with an in-place update is refused"
assert_contains "${V_ERR}" "non-delete change" "the refusal names the non-delete action"

# A replacement (delete then create) of a drained server is not a plain delete.
REPLACED="$(plan_of 1 "$(srv 0 "${ACT_KEEP}"),$(srv 1 "${ACT_REPLACE}"),$(srv 2 "${ACT_DEL}")")"
run_validate 3 1 "1,2" "${REPLACED}"
assert_eq "${V_RC}" "1" "a replace action on an agent server is refused"

test_end || SUITE_FAILED=1

test_begin "scale-in guard: a count that disagrees with the suffix length is refused"

# Plan says 1 node remains, but the arguments claim 2 remain for two drained nodes.
run_validate 3 2 "1,2" "${GOOD_C3_N1}"
assert_eq "${V_RC}" "1" "bash count 2 against a two-node suffix and a plan of 1 is refused"
assert_contains "${V_ERR}" "planned agent_node_count is not 2" "the refusal reports the planned count mismatch"

# Plan variable says 1 but the validator is asked about 3 -> 1 with only one drained index.
run_validate 3 1 "2" "${GOOD_C3_N1}"
assert_eq "${V_RC}" "1" "a drained set of one index against a plan that deletes two is refused"

test_end || SUITE_FAILED=1

test_begin "scale-in guard: other resources and malformed plans are refused"

WITH_NETWORK_UPDATE="$(plan_of 1 "$(srv 0 "${ACT_KEEP}"),$(srv 1 "${ACT_DEL}"),$(srv 2 "${ACT_DEL}"),{\"address\":\"hcloud_network.main\",\"mode\":\"managed\",\"type\":\"hcloud_network\",\"name\":\"main\",\"change\":{\"actions\":[\"update\"]}}")"
run_validate 3 1 "1,2" "${WITH_NETWORK_UPDATE}"
assert_eq "${V_RC}" "1" "an unrelated in-place change to another resource is refused"
assert_contains "${V_ERR}" "unexpected change" "the refusal names the unrelated change"

run_validate 3 2 "1,,2" "${GOOD_C3_N1}"
assert_eq "${V_RC}" "1" "a malformed drained index list is refused"

run_validate 3 3 "2" "${GOOD_C3_N2}"
assert_eq "${V_RC}" "1" "a new count that is not below the current count is refused"

run_validate 3 1 "1,2" '{"variables":{}}'
assert_eq "${V_RC}" "1" "a plan with no resource_changes array is refused"

run_validate 3 1 "1,2" '{not json'
assert_eq "${V_RC}" "1" "malformed plan JSON is refused"

run_validate 3 1 "1,2" ""
assert_eq "${V_RC}" "1" "an empty plan is refused (empty output must not pass)"
assert_contains "${V_ERR}" "saved plan JSON is empty" "the refusal states the plan was empty"

test_end || SUITE_FAILED=1

test_begin "scale-in guard (H1): the plan must bind each deleted server to the drained Nomad node"

# A correct suffix delete whose server is named for a different node than the one bound.
run_validate 3 1 "1,2" "${GOOD_C3_N1}" "1=herobids-agent-2,2=herobids-agent-3"
assert_eq "${V_RC}" "0" "the correct binding of index 1 to herobids-agent-2 passes"

run_validate 3 1 "1,2" "${GOOD_C3_N1}" "1=herobids-agent-9,2=herobids-agent-3"
assert_eq "${V_RC}" "1" "a binding to a node name that does not match the deleted server is refused"
assert_contains "${V_ERR}" "bound to herobids-agent-9" "the refusal names the mismatched binding"

# Empty binding list: the server-to-node link cannot be proven, so refuse.
run_validate 3 1 "1,2" "${GOOD_C3_N1}" ""
assert_eq "${V_RC}" "1" "an empty binding list is refused"
assert_contains "${V_ERR}" "bindings are missing or malformed" "the refusal states the binding is missing"

# A binding for a suffix index that is not drained, or a drained index without a binding.
run_validate 3 1 "1,2" "${GOOD_C3_N1}" "0=herobids-agent-1,1=herobids-agent-2,2=herobids-agent-3"
assert_eq "${V_RC}" "1" "an extra binding for an index outside the drained set is refused"
assert_contains "${V_ERR}" "are not the drained set" "the refusal reports the binding set mismatch"

run_validate 3 1 "1,2" "${GOOD_C3_N1}" "1=herobids-agent-2"
assert_eq "${V_RC}" "1" "a drained index with no binding is refused"

# Malformed binding syntax (space in name, missing index) is refused before jq runs.
run_validate 3 1 "1,2" "${GOOD_C3_N1}" "1=herobids agent-2,2=herobids-agent-3"
assert_eq "${V_RC}" "1" "a binding with an invalid server name is refused"

# A delete whose before.name is absent cannot be bound to any node.
UNNAMED_DELETE="$(plan_of 1 "$(srv 0 "${ACT_KEEP}"),{\"address\":\"hcloud_server.agent[1]\",\"mode\":\"managed\",\"type\":\"hcloud_server\",\"name\":\"agent\",\"index\":1,\"change\":{\"actions\":[\"delete\"],\"before\":{}}},$(srv 2 "${ACT_DEL}")")"
run_validate 3 1 "1,2" "${UNNAMED_DELETE}"
assert_eq "${V_RC}" "1" "a deleted server with no recorded name is refused"
assert_contains "${V_ERR}" "named unnamed" "the refusal states the server has no name"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Top-down selection: the leading run of drainable nodes
# ═════════════════════════════════════════════════════════════════════════════

test_begin "scale-in guard: the leading run stops at the first non-drainable node"

leading() { printf '%s' "$1" | scale_in_leading_run; }

assert_eq "$(leading $'3 1\n2 1\n1 1')" "3" "three consecutive drainable suffixes give a run of three"
assert_eq "$(leading $'3 1\n2 1\n0 1')" "2" "a gap in suffixes ends the run"
assert_eq "$(leading $'3 1\n2 0\n1 1')" "1" "an undrainable node stops the run even if lower nodes are idle"
assert_eq "$(leading $'3 0\n2 1')" "0" "an undrainable top node gives an empty run"
assert_eq "$(leading '')" "0" "no candidates give an empty run"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Fail-closed node reads (C1): an unreadable node is never idle
# ═════════════════════════════════════════════════════════════════════════════

# Stub curl so the real nomad_api runs. CURL_MODE selects the simulated response:
#   fail    curl exits non-zero (connection error)
#   ok      body "[]" with HTTP 200 (no allocations)
#   running one running allocation with HTTP 200
#   object  a non-array JSON body with HTTP 200
#   empty   an empty body with HTTP 200
#   badelem an array whose element is not an object
#   http500 an error body with HTTP 500
NOMAD_ADDR="http://127.0.0.1:4646"
CURL_MODE=""
curl() {
  case "${CURL_MODE}" in
    fail) echo "curl: (7) connection refused"; return 7 ;;
    ok) printf '[]\n200' ;;
    running) printf '[{"ClientStatus":"running"}]\n200' ;;
    object) printf '{"error":"nope"}\n200' ;;
    empty) printf '\n200' ;;
    badelem) printf '[1]\n200' ;;
    http500) printf 'boom\n500' ;;
    node_old) printf '{"StatusUpdatedAt":1992800}\n200' ;;
    node_edge) printf '{"StatusUpdatedAt":1999400}\n200' ;;
    node_recent) printf '{"StatusUpdatedAt":1999940}\n200' ;;
    node_unknown) printf '{"ID":"node-x"}\n200' ;;
    node_zero) printf '{"StatusUpdatedAt":0}\n200' ;;
    node_badjson) printf 'not json\n200' ;;
  esac
}

test_begin "scale-in guard: an unreadable allocation list is never idle"

for mode in fail http500 object empty badelem; do
  CURL_MODE="${mode}"
  rc=0; node_is_idle "node-x" || rc=$?
  assert_eq "${rc}" "1" "mode ${mode}: node_is_idle returns 1 (not idle)"
  rc=0; out="$(node_running_alloc_count "node-x")" || rc=$?
  assert_eq "${rc}" "1" "mode ${mode}: node_running_alloc_count returns 1"
  assert_eq "${out}" "" "mode ${mode}: node_running_alloc_count prints no default count"
done

test_end || SUITE_FAILED=1

test_begin "scale-in guard: a readable empty or busy node is classified correctly"

CURL_MODE="ok"
assert_success "an empty allocation array (HTTP 200) is idle" node_is_idle "node-x"
assert_eq "$(node_running_alloc_count "node-x")" "0" "an empty allocation array counts zero"

CURL_MODE="running"
assert_failure "a node with a running allocation is not idle" node_is_idle "node-x"
assert_eq "$(node_running_alloc_count "node-x")" "1" "a running allocation is counted"

test_end || SUITE_FAILED=1

test_begin "scale-in guard: a drain wait never reports drained on a read failure"

# Every read fails: the wait must time out (1), not report the node drained (0).
node_running_alloc_count() { return 1; }
rc=0; wait_for_drain_complete "node-x" 2 1 >/dev/null 2>&1 || rc=$?
assert_eq "${rc}" "1" "unreadable allocations time out instead of reporting drained"

# The first read fails, the second succeeds with zero: drained only once a read proves it.
READ_LOG="${TEST_TMPDIR}/alloc-reads"
: > "${READ_LOG}"
node_running_alloc_count() {
  echo "x" >> "${READ_LOG}"
  if [[ "$(wc -l < "${READ_LOG}" | tr -d ' ')" -eq 1 ]]; then return 1; fi
  echo "0"
}
rc=0; wait_for_drain_complete "node-x" 5 1 >/dev/null 2>&1 || rc=$?
assert_eq "${rc}" "0" "a later proven-empty read completes the drain"
assert_eq "$(wc -l < "${READ_LOG}" | tr -d ' ')" "2" "the failed read is retried, not counted as drained"

# Restore the real implementation for the remaining sections.
source "${SCRIPTS_DIR}/scale-common.sh"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# scale-in.sh ordering and wiring (static)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "scale-in guard: the autoscale lock is taken before any Terraform preparation"

ACQUIRE_LINE="$(grep -n 'acquire_lock "${NOMAD_AUTOSCALE_LOCKFILE}"' "${SCALE_IN}" | head -1 | cut -d: -f1 || true)"
FIRST_TF_LINE="$(grep -nE 'tf_ensure_env$|tf_ensure_ready$|terraform (plan|show|apply) |tf_apply_var' "${SCALE_IN}" | head -1 | cut -d: -f1 || true)"
PLAN_LINE="$(grep -n 'terraform plan "' "${SCALE_IN}" | head -1 | cut -d: -f1 || true)"
assert_eq "$(( ${ACQUIRE_LINE:-0} > 0 && ${ACQUIRE_LINE} < ${FIRST_TF_LINE:-0} ))" "1" \
  "acquire_lock precedes the first Terraform call (init, ready, plan, show, apply)"
assert_eq "$(( ${FIRST_TF_LINE:-0} > 0 && ${PLAN_LINE:-0} > ${ACQUIRE_LINE:-0} ))" "1" \
  "the saved plan is generated only after the lock"

test_end || SUITE_FAILED=1

test_begin "scale-in guard: the validator runs before the saved plan is applied"

VALIDATE_LINE="$(grep -n 'scale_in_plan_validate "' "${SCALE_IN}" | head -1 | cut -d: -f1 || true)"
APPLY_LINE="$(grep -n 'tf_apply_plan "${plan_file}"' "${SCALE_IN}" | head -1 | cut -d: -f1 || true)"
assert_eq "$(( ${VALIDATE_LINE:-0} > 0 && ${VALIDATE_LINE} < ${APPLY_LINE:-0} ))" "1" \
  "scale_in_plan_validate precedes tf_apply_plan of the saved plan"
assert_contains "$(cat "${SCALE_IN}")" 'terraform plan "${plan_args[@]}"' "scale-in writes a saved plan with -out"
assert_not_contains "$(cat "${SCALE_IN}")" "apply -auto-approve" "scale-in never applies a non-saved plan"
assert_not_contains "$(cat "${SCALE_IN}")" "terraform apply -input=false" "scale-in applies only through tf_apply_plan"
assert_not_contains "$(cat "${SCALE_IN}")" "tf_apply_var" "scale-in does not use the unvalidated apply helper"
assert_contains "$(cat "${SCALE_IN}")" 'source "${SCRIPT_DIR}/scale-in-guard.sh"' "the guard is sourced by scale-in.sh"

test_end || SUITE_FAILED=1

test_begin "scale-in guard: a timed-out drain is never destroyed"

TIMEOUT_BLOCK="$(awk '/if ! wait_for_drain_complete/{on=1} on{print} on && /^  fi$/{exit}' "${SCALE_IN}")"
assert_contains "${TIMEOUT_BLOCK}" "Node will NOT be destroyed" "the timeout branch states the node is kept"
assert_contains "${TIMEOUT_BLOCK}" "break" "the timeout branch stops the drain loop"
assert_not_contains "${TIMEOUT_BLOCK}" "DRAIN_OK" "the timeout branch never records the node as drained"

DRAIN_LOOP="$(awk '/for \(\(i=0; i<RUN_LEN/{on=1} on{print} on && /^done$/{exit}' "${SCALE_IN}")"
assert_not_contains "${DRAIN_LOOP}" "continue" "the drain loop never skips a failure and moves on"

test_end || SUITE_FAILED=1

test_begin "scale-in guard: a scale-out still inside its readiness window ends scale-in without action"

GATE_IN_FLIGHT_BLOCK="$(awk '/^  2\)/{on=1} on{print} /;;/{if(on){exit}}' "${SCALE_IN}")"
assert_contains "${GATE_IN_FLIGHT_BLOCK}" "exit 0" "a scale-out inside its readiness window ends scale-in without action"
assert_not_contains "${GATE_IN_FLIGHT_BLOCK}" "drain" "the in-flight branch does not drain"
assert_not_contains "${GATE_IN_FLIGHT_BLOCK}" "terraform" "the in-flight branch does not touch terraform"

test_end || SUITE_FAILED=1

test_begin "scale-in guard: an unreadable or inconsistent capacity snapshot refuses before node selection"

UNREADABLE_BLOCK="$(awk '/^  \*\)/{on=1} on{print} /;;/{if(on){exit}}' "${SCALE_IN}")"
assert_contains "${UNREADABLE_BLOCK}" "exit 1" "an unreadable capacity guard refuses scale-in"
assert_not_contains "${UNREADABLE_BLOCK}" "drain" "an unreadable guard drains nothing"

CONSISTENT_LINE="$(grep -n "'.status' <<<" "${SCALE_IN}" | head -1 | cut -d: -f1 || true)"
SELECT_LINE="$(grep -n 'Select the drained suffix' "${SCALE_IN}" | head -1 | cut -d: -f1 || true)"
assert_eq "$(( ${CONSISTENT_LINE:-0} > 0 && ${CONSISTENT_LINE} < ${SELECT_LINE:-0} ))" "1" \
  "the snapshot consistency check precedes any node selection"
assert_contains "$(grep -A2 "'.status' <<<" "${SCALE_IN}" | head -3)" "exit 1" \
  "an inconsistent snapshot exits 1 without draining"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Count guard (M2) and unique node names (M3)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "scale-in guard: a target count outside [MIN, CURRENT) is refused, never clamped"

assert_success "a target between MIN and CURRENT is accepted" scale_in_new_count_ok 3 2 1
assert_success "a target equal to MIN is accepted" scale_in_new_count_ok 3 1 1
assert_failure "a target below MIN is refused rather than clamped up" scale_in_new_count_ok 3 0 1
assert_failure "a target equal to CURRENT removes nothing and is refused" scale_in_new_count_ok 3 3 1
assert_failure "a target above CURRENT is refused" scale_in_new_count_ok 3 4 1
assert_failure "a non-numeric target is refused" scale_in_new_count_ok 3 x 1

test_end || SUITE_FAILED=1

names_unique() { printf '%b' "$1" | scale_in_names_unique; }

test_begin "scale-in guard: duplicate or blank node names are refused"

assert_success "distinct names are accepted" names_unique 'a\nb\n'
assert_success "an empty name list is accepted" names_unique ''
assert_success "a name that is a prefix of another is not a duplicate" names_unique 'a\nab\n'
assert_success "regex metacharacters in names are compared literally" names_unique 'a.b\naxb\n'
assert_failure "an exact duplicate name is refused" names_unique 'a\na\n'
assert_failure "a duplicate separated by other names is refused" names_unique 'a\nb\na\n'
assert_failure "a blank name is refused" names_unique 'a\n\nb\n'

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Registration grace (H5): unknown registration time defers
# ═════════════════════════════════════════════════════════════════════════════

NOMAD_SCALE_IN_NODE_GRACE_SECONDS=600
GRACE_NOW=2000000

test_begin "scale-in guard: a node is eligible for removal only past its grace window"

CURL_MODE="node_old"
assert_success "a node registered 7200s ago is past the window" node_ready_for_grace "node-x" "${GRACE_NOW}"
CURL_MODE="node_edge"
assert_success "a node registered exactly the window ago is eligible" node_ready_for_grace "node-x" "${GRACE_NOW}"
CURL_MODE="node_recent"
assert_failure "a node registered 60s ago is inside the window and defers" node_ready_for_grace "node-x" "${GRACE_NOW}"

test_end || SUITE_FAILED=1

test_begin "scale-in guard: an unknown or unreadable registration time defers"

CURL_MODE="node_unknown"
assert_failure "a node with no registration time defers" node_ready_for_grace "node-x" "${GRACE_NOW}"
CURL_MODE="node_zero"
assert_failure "a zero registration time defers" node_ready_for_grace "node-x" "${GRACE_NOW}"
CURL_MODE="node_badjson"
assert_failure "a non-JSON node response defers" node_ready_for_grace "node-x" "${GRACE_NOW}"
CURL_MODE="fail"
assert_failure "an unreachable Nomad API defers" node_ready_for_grace "node-x" "${GRACE_NOW}"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Terraform apply failure seam (H2)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "scale-in guard: a forced terraform apply failure goes through the tf_apply_plan seam"

# The hook runs in a subshell so its set -euo pipefail and overrides stay contained.
HOOK_RC=0
HOOK_OUT="$( (
  export HEROBIDS_ENV=staging INJECT_TF_APPLY_FAILURE=true
  source "${SCRIPTS_DIR}/tests/staging-hooks.sh" >/dev/null 2>&1
  tf_apply_plan "${TEST_TMPDIR}/no-such.tfplan"
) 2>&1 )" || HOOK_RC=$?
assert_eq "${HOOK_RC}" "1" "the injected plan apply returns 1, so scale-in takes its failure branch"
assert_contains "${HOOK_OUT}" "[STAGING-HOOK]" "the injected failure is announced"

NO_HOOK_FN="$( (
  export HEROBIDS_ENV=staging
  unset INJECT_TF_APPLY_FAILURE
  source "${SCRIPTS_DIR}/tests/staging-hooks.sh" >/dev/null 2>&1
  declare -f tf_apply_plan
) 2>&1 )"
assert_not_contains "${NO_HOOK_FN}" "STAGING-HOOK" "without the injection flag tf_apply_plan is not overridden"

APPLY_BLOCK="$(awk '/^if tf_apply_plan/{on=1} on{print} on && /^fi$/{exit}' "${SCALE_IN}")"
assert_contains "${APPLY_BLOCK}" "scale_in_restore_drained" "a failed plan apply restores the drained nodes"
assert_contains "${APPLY_BLOCK}" "exit 1" "a failed plan apply exits non-zero"
assert_contains "${APPLY_BLOCK}" "scale_in_clear_deferrals" "a successful plan apply clears the deferral streak"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Demand mode refusal (H4), run as a subprocess; nothing reaches Terraform or Nomad
# ═════════════════════════════════════════════════════════════════════════════

test_begin "scale-in guard: demand mode exits 0 before any drain or terraform call"

H4_RC=0
H4_OUT="$(ENABLE_SCALE_IN=true NOMAD_AUTOSCALE_DEMAND_ENABLED=true \
  NOMAD_AUTOSCALE_STATE_DIR="${TEST_TMPDIR}/h4-state" \
  NOMAD_AUTOSCALE_LOG_FILE="${TEST_TMPDIR}/h4.log" \
  NOMAD_AUTOSCALE_LOCKFILE="${TEST_TMPDIR}/h4.lock" \
  "${BASH}" "${SCALE_IN}" 2>&1)" || H4_RC=$?
assert_eq "${H4_RC}" "0" "demand mode exits 0 so the nightly timer stays green"
assert_contains "${H4_OUT}" "demand mode is on" "the refusal is logged"
assert_not_contains "${H4_OUT}" "drain" "demand mode never drains a node"
assert_not_contains "${H4_OUT}" "terraform" "demand mode never reaches Terraform"

H4_RC=0
H4_OUT="$(ENABLE_SCALE_IN=true NOMAD_AUTOSCALE_DEMAND_ENABLED=maybe \
  NOMAD_AUTOSCALE_STATE_DIR="${TEST_TMPDIR}/h4-state" \
  NOMAD_AUTOSCALE_LOG_FILE="${TEST_TMPDIR}/h4.log" \
  NOMAD_AUTOSCALE_LOCKFILE="${TEST_TMPDIR}/h4.lock" \
  "${BASH}" "${SCALE_IN}" 2>&1)" || H4_RC=$?
assert_eq "${H4_RC}" "2" "an invalid demand flag fails closed (exit 2), it does not scale in"
assert_not_contains "${H4_OUT}" "drain" "an invalid demand flag never drains a node"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Deferral streak (M1): counted, alerted at N, cleared on success or recovery
# ═════════════════════════════════════════════════════════════════════════════

# Extract the real helpers from scale-in.sh so the test exercises the shipped code.
eval "$(awk '/^scale_in_note_deferral\(\) \{/{on=1} on{print} on && /^}$/{exit}' "${SCALE_IN}")"
eval "$(awk '/^scale_in_clear_deferrals\(\) \{/{on=1} on{print} on && /^}$/{exit}' "${SCALE_IN}")"

M1_STATE="${TEST_TMPDIR}/m1-state"
M1_ALERTS="${TEST_TMPDIR}/m1-alerts"
NOMAD_AUTOSCALE_STATE_DIR="${M1_STATE}"
NOMAD_AUTOSCALE_NODE_POOL="agent"
NOMAD_SCALE_IN_DEFERRAL_ALERT_AFTER=3
DEFERRAL_FILE="${M1_STATE}/scale-in-deferrals"
DRY_RUN=false
send_alert() { echo "$1" >> "${M1_ALERTS}"; return 0; }

test_begin "scale-in guard: consecutive top-node deferrals alert at the threshold and the helper clears the streak"

: > "${M1_ALERTS}"
rm -rf "${M1_STATE}"
scale_in_note_deferral >/dev/null 2>&1
scale_in_note_deferral >/dev/null 2>&1
assert_eq "$(cat "${DEFERRAL_FILE}")" "2" "two deferrals are counted"
assert_eq "$(wc -l < "${M1_ALERTS}" | tr -d ' ')" "0" "no alert before the threshold"

scale_in_note_deferral >/dev/null 2>&1
assert_eq "$(cat "${DEFERRAL_FILE}")" "3" "the third deferral is counted"
assert_eq "$(cat "${M1_ALERTS}")" "scale_in_top_node_unjoined" "the threshold sends the top-node alert"

scale_in_clear_deferrals >/dev/null 2>&1
assert_failure "scale_in_clear_deferrals removes the streak file" test -e "${DEFERRAL_FILE}"

test_end || SUITE_FAILED=1

test_begin "scale-in guard: a corrupt streak file restarts the count and dry-run writes nothing"

printf 'garbage\n' > "${DEFERRAL_FILE}"
scale_in_note_deferral >/dev/null 2>&1
assert_eq "$(cat "${DEFERRAL_FILE}")" "1" "an unparseable streak restarts at 1, not a crash"

DRY_RUN=true
scale_in_clear_deferrals >/dev/null 2>&1
rm -f "${DEFERRAL_FILE}"
scale_in_note_deferral >/dev/null 2>&1
assert_failure "a dry run writes no deferral file" test -e "${DEFERRAL_FILE}"
DRY_RUN=false

test_end || SUITE_FAILED=1

echo ""
echo "═══ Capacity scale-in guard suite complete ═══"
exit "${SUITE_FAILED:-0}"
