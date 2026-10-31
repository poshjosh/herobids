#!/usr/bin/env bash
# test-capacity-demand.sh — demand classification, deduplication and per-node fit
# (capacity-demand.sh). Every fixture is SYNTHETIC and UNVERIFIED against live Nomad
# 1.9.7; see fixtures/capacity/README.md. Injection cases prove that values reaching jq
# as data are never executed by the shell.
#
# Run: bash infra/hetzner/scripts/tests/test-capacity-demand.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

source "${TESTS_DIR}/source-helper.sh"
source "${SCRIPTS_DIR}/capacity-demand.sh"

FIX="${TESTS_DIR}/fixtures/capacity"
MARKER="${TEST_TMPDIR}/executed"

# rc_of COMMAND... — prints the exit status of the command, without aborting the suite.
rc_of() {
  ( "$@" ) >/dev/null 2>&1 && echo 0 || echo $?
}

# class_of JSON JOB_ID / reason_of JSON JOB_ID — read one row from a demand_classify result.
class_of() { jq -r --arg j "$2" '.rows[] | select(.jobId == $j) | .class' <<<"$1"; }
reason_of() { jq -r --arg j "$2" '.rows[] | select(.jobId == $j) | .reason' <<<"$1"; }

# fit_rc JQ_FILTER FIXTURE — applies a jq edit to a node fixture and prints the
# exit status of capacity_node_fit on the edited node.
fit_rc() {
  local tmp="${TEST_TMPDIR}/mutated-node.json"
  jq "$1" "$2" > "${tmp}"
  ( capacity_node_fit < "${tmp}" ) >/dev/null 2>&1 && echo 0 || echo $?
}

test_begin "demand: only the requested namespace is selected"

OUT="$(demand_classify herobids-agents 1 4096 4000 < "${FIX}/demand-namespace-evaluations.json")"
assert_eq "$(jq -r '[.rows[].jobId] | join(",")' <<<"${OUT}")" "agent-job-a" \
  "herobids-agents selects only its own job"

OUT="$(demand_classify default 1 4096 4000 < "${FIX}/demand-namespace-evaluations.json")"
assert_eq "$(jq -r '[.rows[].jobId] | join(",")' <<<"${OUT}")" "default-job" \
  "the default namespace is selected only when asked for, not by the herobids-agents run"
assert_eq "$(jq -r '.rows[0].queued' <<<"${OUT}")" "9" \
  "default-namespace demand is read separately and is not mixed in"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "demand: repeated evaluations for one task group do not multiply demand"

OUT="$(demand_classify herobids-agents 1 4096 4000 < "${FIX}/demand-namespace-evaluations.json")"
assert_eq "$(jq -r '.rows | length' <<<"${OUT}")" "1" "three evaluations for one task group give one row"
assert_eq "$(jq -r '.rows[0].queued' <<<"${OUT}")" "2" \
  "queued is taken from the newest evaluation, not summed (2 + 2 + 5 would be 9)"
assert_eq "$(jq -r '.rows[0].evaluation_ids | length' <<<"${OUT}")" "3" \
  "all three evaluation IDs are kept for audit"
assert_eq "$(jq -r '.queued_allocs_by_class.capacity_blocked' <<<"${OUT}")" "2" \
  "the class total counts the deduplicated queue once"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "demand: FailedTGAllocs dimension exhaustion classifies by reason"

OUT="$(demand_classify herobids-agents 1 4096 4000 < "${FIX}/demand-classes.json")"
assert_eq "$(class_of "${OUT}" job-memory)" "capacity_blocked" "memory exhaustion on evaluated nodes is capacity_blocked"
assert_eq "$(class_of "${OUT}" job-cpu)" "capacity_blocked" "CPU exhaustion on evaluated nodes is capacity_blocked"
assert_eq "$(class_of "${OUT}" job-mismatch)" "not_capacity_remediable" \
  "a placement that does not match the template is not_capacity_remediable"
assert_contains "$(reason_of "${OUT}" job-mismatch)" "template" "the mismatch reason names the template"
assert_eq "$(class_of "${OUT}" job-too-large)" "not_capacity_remediable" "a request above the template is not_capacity_remediable"
assert_contains "$(reason_of "${OUT}" job-too-large)" "larger" "the larger-than-template reason is given"
assert_eq "$(class_of "${OUT}" job-quota)" "not_capacity_remediable" "an exhausted namespace quota is not_capacity_remediable"
assert_eq "$(class_of "${OUT}" job-filtered)" "not_capacity_remediable" \
  "every evaluated node filtered by constraints is not_capacity_remediable"
assert_eq "$(class_of "${OUT}" job-disk)" "unclassified" "an unrecognised exhausted dimension is unclassified, not capacity"
assert_contains "$(reason_of "${OUT}" job-disk)" "unrecognised" "the unrecognised-dimension reason is given"
assert_eq "$(class_of "${OUT}" job-assigned)" "already_assigned" "nothing queued is already_assigned"
assert_eq "$(jq -r '.queued_allocs_by_class.capacity_blocked' <<<"${OUT}")" "2" "capacity_blocked totals the two capacity jobs"
assert_eq "$(jq -r '.queued_allocs_by_class.not_capacity_remediable' <<<"${OUT}")" "4" "not_capacity_remediable totals four"
assert_eq "$(jq -r '.queued_allocs_by_class.unclassified' <<<"${OUT}")" "1" "unclassified totals one"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "demand: nil diagnostics and BlockedEval-only are never treated as exhaustion"

OUT="$(demand_classify herobids-agents 1 4096 4000 < "${FIX}/demand-diagnostics-missing.json")"
assert_eq "$(class_of "${OUT}" job-nil)" "unclassified" "null FailedTGAllocs is not proof of exhaustion"
assert_eq "$(class_of "${OUT}" job-empty)" "unclassified" "an empty metric object is not proof of exhaustion"
assert_eq "$(class_of "${OUT}" job-null-tg)" "unclassified" "a null metric for the task group is not proof of exhaustion"
assert_eq "$(class_of "${OUT}" job-blocked-only)" "unclassified" "a BlockedEval ID alone is not a reason"
assert_contains "$(reason_of "${OUT}" job-blocked-only)" "no placement diagnostics" \
  "the BlockedEval-only reason is reported as missing diagnostics"
assert_eq "$(jq -r '.queued_allocs_by_class.capacity_blocked' <<<"${OUT}")" "0" \
  "none of the diagnostics-free jobs is counted as capacity_blocked"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "demand: the template is explicit input, so a zero-node cluster is classified from it"

OUT="$(demand_classify herobids-agents 0 4096 4000 < "${FIX}/demand-classes.json")"
assert_eq "$(class_of "${OUT}" job-too-large)" "not_capacity_remediable" \
  "with a 4096 MB template, an 8192 MB request is not remediable"

OUT="$(demand_classify herobids-agents 0 8192 4000 < "${FIX}/demand-classes.json")"
assert_eq "$(class_of "${OUT}" job-too-large)" "capacity_blocked" \
  "with a calibrated 8192 MB template and zero ready nodes, the same request is capacity_blocked"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "fit: fragmented free memory yields no fictitious slots"

FRAG="${FIX}/node-fragmentation.json"
TOTAL=0
for i in 0 1; do
  FIT="$(jq -c ".nodes[${i}]" "${FRAG}" | capacity_node_fit)"
  assert_eq "$(jq -r '.free_memory_mb' <<<"${FIT}")" "400" "node $((i + 1)) reports 400 MB free"
  SLOTS="$(capacity_node_slots "$(jq -r '.free_memory_mb' <<<"${FIT}")" "$(jq -r '.free_cpu_mhz' <<<"${FIT}")" 512 256)"
  TOTAL=$(( TOTAL + SLOTS ))
done
assert_eq "${TOTAL}" "0" "two nodes with 400 MB free each give zero 512 MB slots (not 800 / 512 = 1)"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "fit: CPU shortage with spare RAM gives zero slots"

FIT="$(capacity_node_fit < "${FIX}/node-cpu-shortage.json")"
assert_eq "$(jq -r '.free_memory_mb' <<<"${FIT}")" "3712" "memory is reported as free"
assert_eq "$(jq -r '.free_cpu_mhz' <<<"${FIT}")" "400" "CPU is reported as scarce"
assert_eq "$(capacity_node_slots 3712 400 512 512)" "0" "a 512 MHz slot does not fit into 400 MHz, despite memory for seven"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "fit: pending, non-agent and legacy allocations count; terminal allocations do not"

FIT="$(capacity_node_fit < "${FIX}/node-assigned-pending.json")"
assert_eq "$(jq -r '.allocated_memory_mb' <<<"${FIT}")" "2304" \
  "running 512 + assigned-pending 512 + Browserless 1024 + legacy 256 MB"
assert_eq "$(jq -r '.allocated_cpu_mhz' <<<"${FIT}")" "1280" \
  "running 256 + pending 256 + Browserless 512 + legacy 256 MHz"
assert_eq "$(jq -r '.free_memory_mb' <<<"${FIT}")" "1536" "free memory is total minus reserved minus allocated"
assert_eq "$(jq -r '.free_cpu_mhz' <<<"${FIT}")" "2720" "free CPU is total minus allocated"
assert_eq "$(capacity_node_slots 1536 2720 512 256)" "3" "the per-node slot count is 3 (memory-bound)"

FIT="$(capacity_node_fit < "${FIX}/node-terminal.json")"
assert_eq "$(jq -r '.allocated_memory_mb' <<<"${FIT}")" "512" \
  "complete, failed and lost allocations hold no memory"
assert_eq "$(jq -r '.allocated_cpu_mhz' <<<"${FIT}")" "256" "complete, failed and lost allocations hold no CPU"
assert_eq "$(jq -r '.free_memory_mb' <<<"${FIT}")" "3584" "terminal allocations are released to the node"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "fit: a missing or malformed figure fails the snapshot and is never treated as zero"

PEND="${FIX}/node-assigned-pending.json"
assert_neq "$(fit_rc 'del(.allocations[0].AllocatedResources.Tasks.agent.Memory)' "${PEND}")" "0" \
  "a current-shape allocation without memory fails"
assert_neq "$(fit_rc 'del(.allocations[0].AllocatedResources.Tasks.agent.Cpu)' "${PEND}")" "0" \
  "a current-shape allocation without CPU fails"
assert_neq "$(fit_rc 'del(.allocations[3].Resources.Memory)' "${PEND}")" "0" \
  "a legacy allocation without memory fails"
assert_neq "$(fit_rc 'del(.node.NodeResources.Cpu)' "${PEND}")" "0" "a node without a CPU figure fails"
assert_neq "$(fit_rc 'del(.node.NodeResources.Memory)' "${PEND}")" "0" "a node without a memory figure fails"
assert_neq "$(fit_rc '.node.NodeResources.Memory.MemoryMB = 0' "${PEND}")" "0" "a node with zero memory fails"
assert_neq "$(fit_rc '.allocations[0].ClientStatus = "mystery"' "${PEND}")" "0" \
  "an unrecognised allocation status fails"
assert_eq "$(fit_rc '.' "${PEND}")" "0" "the unedited fixture passes"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "fit: a node without reserved figures reserves nothing"

FIT="$(fit_rc 'del(.node.ReservedResources)' "${FIX}/node-assigned-pending.json")"
assert_eq "${FIT}" "0" "the edited node still fits"
RESERVED_FREE="$(jq -c 'del(.node.ReservedResources)' "${FIX}/node-assigned-pending.json" | capacity_node_fit | jq -r '.free_memory_mb')"
assert_eq "${RESERVED_FREE}" "1792" "with no reservation, free memory is 4096 - 2304 = 1792"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "fit: a non-integer or negative figure fails the snapshot and prints nothing"

# fit_out JQ_FILTER — stdout of capacity_node_fit on an edited fixture (empty on failure).
fit_out() {
  local tmp="${TEST_TMPDIR}/mutated-node.json"
  jq "$1" "${FIX}/node-assigned-pending.json" > "${tmp}"
  capacity_node_fit < "${tmp}" 2>/dev/null || true
}

assert_neq "$(fit_rc '.node.NodeResources.Memory.MemoryMB = 3819.5' "${FIX}/node-assigned-pending.json")" "0" \
  "a fractional node memory figure fails (exit 1 at the caller, never require_uint's 2)"
assert_eq "$(fit_out '.node.NodeResources.Memory.MemoryMB = 3819.5')" "" "a fractional node memory figure prints nothing"
assert_neq "$(fit_rc '.allocations[0].AllocatedResources.Tasks.agent.Memory.MemoryMB = 256.5' "${FIX}/node-assigned-pending.json")" "0" \
  "a fractional allocation memory figure fails"
assert_eq "$(fit_rc '.node.ReservedResources.Memory.MemoryMB = -5000' "${FIX}/node-assigned-pending.json")" "5" \
  "a negative reserved memory fails with jq error status 5 (the -5000 probe gave total 4096, free 9096 before)"
assert_eq "$(fit_out '.node.ReservedResources.Memory.MemoryMB = -5000')" "" "a negative reserved memory prints nothing"
assert_neq "$(fit_rc '.node.ReservedResources.Cpu.CpuShares = -1' "${FIX}/node-assigned-pending.json")" "0" \
  "a negative reserved CPU fails"
assert_eq "$(fit_rc '.node.ReservedResources.Memory.MemoryMB = "512"' "${FIX}/node-assigned-pending.json")" "5" \
  "a string reserved memory fails with jq error status 5"
assert_eq "$(fit_out '.node.ReservedResources.Memory.MemoryMB = "512"')" "" "a string reserved memory prints nothing"
assert_eq "$(fit_rc '.node.ReservedResources.Memory.MemoryMB = 512' "${FIX}/node-assigned-pending.json")" "0" \
  "a valid non-negative reservation still fits"
RESERVED_OK="$(jq -c '.node.ReservedResources.Memory.MemoryMB = 512' "${FIX}/node-assigned-pending.json" | capacity_node_fit | jq -r '.free_memory_mb')"
assert_eq "${RESERVED_OK}" "1280" "a 512 MB reservation leaves 4096 - 512 - 2304 = 1280 MB free"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "slots: invalid arguments are refused"

assert_eq "$(rc_of capacity_node_slots 1e3 400 512 256)" "2" "a non-integer free memory is refused"
assert_eq "$(rc_of capacity_node_slots 1536 2720 0 256)" "2" "a zero slot size is refused"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "plan fit: fragmentation does not place a slot into split free memory"

FRAG_BINS='{"bins":[{"id":"n1","kind":"actual","free_memory_mb":400,"free_cpu_mhz":3744},{"id":"n2","kind":"actual","free_memory_mb":400,"free_cpu_mhz":3744}],"items":[{"key":"agent","memory_mb":512,"cpu_mhz":256,"count":1}]}'
OUT="$(capacity_plan_fit 4096 4000 <<<"${FRAG_BINS}")"
assert_eq "$(jq -r '.placed_existing' <<<"${OUT}")" "0" "neither 400 MB bin takes a 512 MB slot"
assert_eq "$(jq -r '.new_nodes_needed' <<<"${OUT}")" "1" "one calibrated new node is needed"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "plan fit: zero-node path uses the explicit template"

ZERO='{"bins":[],"items":[{"key":"agent","memory_mb":512,"cpu_mhz":256,"count":10}]}'
OUT="$(capacity_plan_fit 4096 4000 <<<"${ZERO}")"
assert_eq "$(jq -r '.new_nodes_needed' <<<"${OUT}")" "2" "a 4096 MB template holds 8 slots, so 10 need 2 nodes"
assert_eq "$(jq -r '.placed_on_new_nodes' <<<"${OUT}")" "10" "all ten are placed on new nodes"
OUT="$(capacity_plan_fit 2048 4000 <<<"${ZERO}")"
assert_eq "$(jq -r '.new_nodes_needed' <<<"${OUT}")" "3" "a 2048 MB template holds 4 slots, so 10 need 3 nodes"
assert_eq "$(rc_of capacity_plan_fit 0 4000)" "2" "a zero template is refused"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "plan fit: existing free bins are filled before any new node is added"

EXIST='{"bins":[{"id":"n1","kind":"actual","free_memory_mb":1024,"free_cpu_mhz":4000}],"items":[{"key":"agent","memory_mb":512,"cpu_mhz":256,"count":3}]}'
OUT="$(capacity_plan_fit 4096 4000 <<<"${EXIST}")"
assert_eq "$(jq -r '.placed_existing' <<<"${OUT}")" "2" "the existing bin takes two slots"
assert_eq "$(jq -r '.placed_on_new_nodes' <<<"${OUT}")" "1" "only the overflow goes to a new node"
assert_eq "$(jq -r '.new_nodes_needed' <<<"${OUT}")" "1" "one new node is needed"

CPU_SHORT='{"bins":[{"id":"n1","kind":"actual","free_memory_mb":3712,"free_cpu_mhz":400}],"items":[{"key":"a","memory_mb":512,"cpu_mhz":512,"count":1}]}'
OUT="$(capacity_plan_fit 4096 4000 <<<"${CPU_SHORT}")"
assert_eq "$(jq -r '.placed_existing' <<<"${OUT}")" "0" "a bin with 400 MHz free does not take a 512 MHz item"
assert_eq "$(jq -r '.new_nodes_needed' <<<"${OUT}")" "1" "CPU shortage with spare RAM needs a new node"

BIG='{"bins":[],"items":[{"key":"big","memory_mb":8192,"cpu_mhz":256,"count":1}]}'
OUT="$(capacity_plan_fit 4096 4000 <<<"${BIG}")"
assert_eq "$(jq -c '.unplaceable' <<<"${OUT}")" '["big#0"]' "a request above the template is unplaceable, not a new node"
assert_eq "$(jq -r '.new_nodes_needed' <<<"${OUT}")" "0" "an unplaceable item adds no node"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "plan fit: first-fit-decreasing is deterministic regardless of input order"

IN_A='{"bins":[{"id":"n2","kind":"actual","free_memory_mb":900,"free_cpu_mhz":1000},{"id":"n1","kind":"actual","free_memory_mb":2000,"free_cpu_mhz":3000}],"items":[{"key":"A","memory_mb":1024,"cpu_mhz":256,"count":2},{"key":"B","memory_mb":512,"cpu_mhz":512,"count":3},{"key":"C","memory_mb":2048,"cpu_mhz":128,"count":1}]}'
IN_B='{"bins":[{"id":"n1","kind":"actual","free_memory_mb":2000,"free_cpu_mhz":3000},{"id":"n2","kind":"actual","free_memory_mb":900,"free_cpu_mhz":1000}],"items":[{"key":"C","memory_mb":2048,"cpu_mhz":128,"count":1},{"key":"B","memory_mb":512,"cpu_mhz":512,"count":3},{"key":"A","memory_mb":1024,"cpu_mhz":256,"count":2}]}'
OUT_A="$(capacity_plan_fit 4096 4000 <<<"${IN_A}")"
OUT_B="$(capacity_plan_fit 4096 4000 <<<"${IN_B}")"
assert_eq "${OUT_A}" "${OUT_B}" "reordered bins and items give identical output"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "injection: attacker-shaped values are never executed"

ATTACK="\$(touch ${MARKER})"

assert_eq "$(rc_of demand_classify "a${ATTACK}" 1 4096 4000 </dev/null)" "2" \
  "a namespace carrying a command substitution is refused with exit 2"
assert_eq "$(rc_of demand_classify herobids-agents "1;touch ${MARKER}" 4096 4000 </dev/null)" "2" \
  "a READY_NODES carrying a command separator is refused with exit 2"
assert_eq "$(rc_of capacity_node_slots "${ATTACK}" 400 512 256)" "2" \
  "a slot argument carrying a command substitution is refused with exit 2"
assert_eq "$(rc_of capacity_plan_fit "a[${ATTACK}]" 4000)" "2" \
  "a template argument carrying a subscript attack is refused with exit 2"

jq -n --arg j "${ATTACK}" \
  '{evaluations: [{ID: "e1", Namespace: "herobids-agents", JobID: $j, Status: "blocked",
    QueuedAllocations: {agent: 1},
    FailedTGAllocs: {agent: {NodesEvaluated: 3, NodesFiltered: 0, NodesExhausted: 3, DimensionExhausted: {memory: 3}}},
    ModifyIndex: 1}],
   asks: [{namespace: "herobids-agents", jobId: $j, taskGroup: "agent", memory_mb: 512, cpu_mhz: 256, placement_matches_template: true}]}' \
  > "${TEST_TMPDIR}/injected-job.json"
OUT="$(demand_classify herobids-agents 1 4096 4000 < "${TEST_TMPDIR}/injected-job.json")"
assert_contains "${OUT}" "touch" "a hostile JobID is carried through as literal data"
assert_eq "$(class_of "${OUT}" "${ATTACK}")" "capacity_blocked" "the hostile JobID is classified as plain data"

jq -n --arg k "${ATTACK}" '{bins: [], items: [{key: $k, memory_mb: 8192, cpu_mhz: 256, count: 1}]}' \
  > "${TEST_TMPDIR}/injected-item.json"
OUT="$(capacity_plan_fit 4096 4000 < "${TEST_TMPDIR}/injected-item.json")"
assert_contains "${OUT}" "touch" "a hostile item key is carried through as literal data"

assert_eq "$([[ -e "${MARKER}" ]] && echo present || echo absent)" "absent" \
  "no injected value reached the shell"

test_end || SUITE_FAILED=1

test_begin "demand: a canceled evaluation with the highest ModifyIndex does not hide live blocked demand"

OUT="$(demand_classify herobids-agents 1 4096 4000 < "${FIX}/demand-canceled-newest.json")"
assert_eq "$(jq -r '[.rows[].jobId] | join(",")' <<<"${OUT}")" "live-job" \
  "only the job with a live evaluation gets a row; the canceled-only job gets none"
assert_eq "$(class_of "${OUT}" live-job)" "capacity_blocked" \
  "the live blocked evaluation (ModifyIndex 100) is classified despite the newer canceled one (300)"
assert_eq "$(jq -r '.rows[] | select(.jobId == "live-job") | .queued' <<<"${OUT}")" "2" \
  "queued comes from the live evaluation, not the canceled one (7)"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "demand: an evaluation without a string Namespace is refused, not skipped"

NS_MISSING="${TEST_TMPDIR}/ns-missing.json"
jq -n '{evaluations: [
    {ID: "e-ok", Namespace: "herobids-agents", JobID: "ok-job", Status: "blocked",
     QueuedAllocations: {agent: 1}, FailedTGAllocs: null, ModifyIndex: 1},
    {ID: "e-no-ns", JobID: "hidden-job", Status: "blocked",
     QueuedAllocations: {agent: 1}, FailedTGAllocs: null, ModifyIndex: 2}],
  asks: []}' > "${NS_MISSING}"
assert_eq "$(rc_of demand_classify herobids-agents 1 4096 4000 < "${NS_MISSING}")" "5" \
  "an evaluation with no Namespace is an error, not silently dropped"

NS_NUMERIC="${TEST_TMPDIR}/ns-numeric.json"
jq -n '{evaluations: [{ID: "e-num", Namespace: 7, JobID: "j", Status: "blocked",
  QueuedAllocations: {agent: 1}, FailedTGAllocs: null, ModifyIndex: 1}], asks: []}' > "${NS_NUMERIC}"
assert_eq "$(rc_of demand_classify herobids-agents 1 4096 4000 < "${NS_NUMERIC}")" "5" \
  "a non-string Namespace is an error"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "plan fit: bins are tried actual first, then viable, then new"

# Bin z is actual (1000 MB) and bin a is viable (1500 MB). By id alone, a would be tried
# first and the 900 MB item would leave the 600 MB item with no room; by kind, z goes first.
KIND_ORDER='{"bins":[{"id":"a","kind":"viable","free_memory_mb":1500,"free_cpu_mhz":4000},{"id":"z","kind":"actual","free_memory_mb":1000,"free_cpu_mhz":4000}],"items":[{"key":"X","memory_mb":1000,"cpu_mhz":100,"count":1},{"key":"Y","memory_mb":900,"cpu_mhz":100,"count":1},{"key":"Z","memory_mb":600,"cpu_mhz":100,"count":1}]}'
OUT="$(capacity_plan_fit 4096 4000 <<<"${KIND_ORDER}")"
assert_eq "$(jq -r '.placed_existing' <<<"${OUT}")" "3" "all three items fit the existing bins when actual is tried first"
assert_eq "$(jq -r '.new_nodes_needed' <<<"${OUT}")" "0" "no new node is needed"

BAD_KIND='{"bins":[{"id":"n1","kind":"bogus","free_memory_mb":4000,"free_cpu_mhz":4000}],"items":[]}'
assert_eq "$(rc_of capacity_plan_fit 4096 4000 <<<"${BAD_KIND}")" "5" "a bin with an unknown kind is refused"

# "new" is never an input kind: new nodes come only from the template count.
NEW_KIND='{"bins":[{"id":"n1","kind":"new","free_memory_mb":4000,"free_cpu_mhz":4000}],"items":[]}'
assert_eq "$(rc_of capacity_plan_fit 4096 4000 <<<"${NEW_KIND}")" "5" "an input bin of kind new is refused"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "plan fit: item sizes and counts outside their ranges are refused"

neg_mem='{"bins":[{"id":"n1","kind":"actual","free_memory_mb":100,"free_cpu_mhz":4000}],"items":[{"key":"a","memory_mb":-4096,"cpu_mhz":256,"count":1}]}'
assert_eq "$(rc_of capacity_plan_fit 4096 4000 <<<"${neg_mem}")" "5" \
  "a negative item memory is refused, so a 100 MB bin cannot take a -4096 MB item"

neg_cpu='{"bins":[],"items":[{"key":"a","memory_mb":512,"cpu_mhz":-1,"count":1}]}'
assert_eq "$(rc_of capacity_plan_fit 4096 4000 <<<"${neg_cpu}")" "5" "a negative item CPU is refused"

zero_mem='{"bins":[],"items":[{"key":"a","memory_mb":0,"cpu_mhz":256,"count":1}]}'
assert_eq "$(rc_of capacity_plan_fit 4096 4000 <<<"${zero_mem}")" "5" "a zero item memory is refused"

frac_mem='{"bins":[],"items":[{"key":"a","memory_mb":512.5,"cpu_mhz":256,"count":1}]}'
assert_eq "$(rc_of capacity_plan_fit 4096 4000 <<<"${frac_mem}")" "5" "a fractional item memory is refused"

neg_count='{"bins":[],"items":[{"key":"a","memory_mb":512,"cpu_mhz":256,"count":-3}]}'
assert_eq "$(rc_of capacity_plan_fit 4096 4000 <<<"${neg_count}")" "5" "a negative count is refused, not silently dropped"

frac_count='{"bins":[],"items":[{"key":"a","memory_mb":512,"cpu_mhz":256,"count":2.5}]}'
assert_eq "$(rc_of capacity_plan_fit 4096 4000 <<<"${frac_count}")" "5" "a fractional count is refused, not rounded into three items"

big_count='{"bins":[],"items":[{"key":"a","memory_mb":512,"cpu_mhz":256,"count":100001}]}'
assert_eq "$(rc_of capacity_plan_fit 4096 4000 <<<"${big_count}")" "5" "a count above the upper bound is refused"

zero_count='{"bins":[],"items":[{"key":"a","memory_mb":512,"cpu_mhz":256,"count":0}]}'
OUT="$(capacity_plan_fit 4096 4000 <<<"${zero_count}")"
assert_eq "$(jq -r '.new_nodes_needed' <<<"${OUT}")" "0" "a count of zero is valid and needs no node"

test_end || SUITE_FAILED=1

exit "${SUITE_FAILED:-0}"
