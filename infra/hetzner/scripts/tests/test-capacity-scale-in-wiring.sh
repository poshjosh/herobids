#!/usr/bin/env bash
# test-capacity-scale-in-wiring.sh — scale-in takes its count only from the
# capacity gate, refuses when the gate blocks, and computes the new count as
# current minus the drained nodes. The reboot case reads the in-flight record
# from disk in a fresh process, not from an argument.
#
# Cloud and Nomad are replaced by the healthy fixtures; nothing is networked.
#
# Run: bash infra/hetzner/scripts/tests/test-capacity-scale-in-wiring.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

source "${TESTS_DIR}/source-helper.sh"
source "${SCRIPTS_DIR}/capacity-inventory.sh"

FX="${TESTS_DIR}/fixtures/capacity"
SCALE_IN="${SCRIPTS_DIR}/scale-in.sh"
GATE_FILE="${TEST_TMPDIR}/inflight.json"
# Cloud has three managed servers; Nomad joins two, so one is unjoined.
PENDING_T3_AT_1500='{"schema_version":1,"environment":"synthetic","pool":"synth","target_count":3,"baseline_count":2,"requested_epoch":1000,"deadline_epoch":1600,"server_ids":[]}'
EXPIRED_T3='{"schema_version":1,"environment":"synthetic","pool":"synth","target_count":3,"baseline_count":2,"requested_epoch":1000,"deadline_epoch":1600,"server_ids":[]}'
# Three managed cloud servers; the shared healthy Nomad fixture joins only two.
CLOUD_THREE="${TEST_TMPDIR}/cloud-three.json"
jq '. + [(.[0] | .id = 90000003 | .name = "synth-agent-3" | .address = "192.0.2.13")]' \
  "${FX}/cloud-healthy.json" > "${CLOUD_THREE}"

# fresh_gate FILE NOW MUTATE — a new bash process that sources the gate, reads
# the in-flight record from FILE via the environment, and prints the gate's
# stdout and exit code. Nothing from the parent shell is passed in.
fresh_gate() {
  local file="$1" now="$2" mutate="$3" rc=0 out
  out="$(NOMAD_AUTOSCALE_INFLIGHT_FILE="${file}" bash -c '
    source "$1"
    CLOUD_FILE="$4"
    NOMAD_FILE="$5"
    capacity_fetch_cloud_servers() { cat "${CLOUD_FILE}"; }
    capacity_fetch_nomad_nodes() { cat "${NOMAD_FILE}"; }
    capacity_scale_gate synthetic synth "$2" "$3"
  ' _ "${SCRIPTS_DIR}/capacity-inventory.sh" "${now}" "${mutate}" "${CLOUD_THREE}" "${FX}/nomad-healthy.json" 2>/dev/null)" || rc=$?
  GATE_RC="${rc}"
  GATE_OUT="${out}"
}

# ═════════════════════════════════════════════════════════════════════════════
# Count source: scale-in reads the count from the gate and nowhere else
# ═════════════════════════════════════════════════════════════════════════════

test_begin "scale-in wiring: the current count comes only from the capacity gate"

CURRENT_ASSIGNMENTS="$(grep -c '^CURRENT_COUNT=' "${SCALE_IN}" || true)"
assert_eq "${CURRENT_ASSIGNMENTS}" "1" "CURRENT_COUNT is assigned exactly once in scale-in.sh"
assert_contains "$(grep '^CURRENT_COUNT=' "${SCALE_IN}")" "jq -r '.managed_count' <<< \"\${GATE_OUT}\"" \
  "CURRENT_COUNT is read from the gate snapshot's managed_count"
assert_eq "$(grep -cE 'cat .*(tfstate|node_count|\.count)' "${SCALE_IN}" || true)" "0" \
  "scale-in reads no count from a file or tfstate"

test_end || SUITE_FAILED=1

test_begin "scale-in wiring: the gate reads the managed count from cloud and refuses an unjoined pool"

rm -f "${GATE_FILE}"
fresh_gate "${GATE_FILE}" 2000 false
assert_eq "${GATE_RC}" "3" "healthy pool with one unjoined server and no record is refused"
assert_eq "$(jq -r '.managed_count' <<< "${GATE_OUT}")" "3" "the snapshot's managed_count is the cloud count of three"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Blocker refusal: a blocked gate stops scale-in before any drain or Terraform
# ═════════════════════════════════════════════════════════════════════════════

test_begin "scale-in wiring: a blocked gate refuses before drain or terraform"

BLOCKED_BRANCH="$(awk '/^  3\)/{on=1} on{print} /;;/{if(on){exit}}' "${SCALE_IN}")"
assert_contains "${BLOCKED_BRANCH}" "exit 1" "the blocked branch exits 1"
assert_not_contains "${BLOCKED_BRANCH}" "tf_apply" "the blocked branch does not run terraform"
assert_not_contains "${BLOCKED_BRANCH}" "drain" "the blocked branch does not drain nodes"

GATE_LINE="$(grep -n 'capacity_scale_gate "' "${SCALE_IN}" | head -1 | cut -d: -f1 || true)"
DRAIN_LINE="$(grep -n 'drain_node "' "${SCALE_IN}" | head -1 | cut -d: -f1 || true)"
TF_LINE="$(grep -n 'tf_apply_plan "' "${SCALE_IN}" | head -1 | cut -d: -f1 || true)"
assert_eq "$(( ${GATE_LINE:-0} > 0 && GATE_LINE < ${DRAIN_LINE:-0} && GATE_LINE < ${TF_LINE:-0} ))" "1" \
  "the gate call precedes every drain and terraform apply"

test_end || SUITE_FAILED=1

test_begin "scale-in wiring: an expired record with an unjoined server refuses (gate exit 3)"

printf '%s\n' "${EXPIRED_T3}" > "${GATE_FILE}"
fresh_gate "${GATE_FILE}" 2000 false
assert_eq "${GATE_RC}" "3" "the gate refuses so scale-in exits before draining"
assert_contains "$(jq -r '.blockers | join(",")' <<< "${GATE_OUT}")" "readiness_deadline_exceeded" \
  "the refusal carries the reason code"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# New count: current minus the drained nodes, refused outside [MIN, CURRENT)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "scale-in wiring: the new count is current minus drained and goes through scale_in_new_count_ok"

assert_contains "$(grep '^NEW_COUNT=' "${SCALE_IN}")" 'NEW_COUNT=$(( CURRENT_COUNT - ${#DRAIN_OK[@]} ))' \
  "NEW_COUNT is CURRENT_COUNT minus the drained node count"
assert_eq "$(grep -c 'NEW_COUNT=${MIN_COUNT}' "${SCALE_IN}" || true)" "0" \
  "NEW_COUNT is never overwritten with MIN_COUNT"
assert_contains "$(cat "${SCALE_IN}")" 'scale_in_new_count_ok "${CURRENT_COUNT}" "${NEW_COUNT}" "${MIN_COUNT}"' \
  "the planned count is checked by scale_in_new_count_ok before the plan is saved"
assert_eq "$(grep -c 'would go below min_agent_nodes' "${SCALE_IN}" || true)" "0" \
  "the old inline clamp message is gone"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Reboot reconstruction: the record is read from disk by a fresh process
# ═════════════════════════════════════════════════════════════════════════════

test_begin "scale-in wiring: a reboot reads the in-flight record from disk"

printf '%s\n' "${PENDING_T3_AT_1500}" > "${GATE_FILE}"
fresh_gate "${GATE_FILE}" 1500 false
assert_eq "${GATE_RC}" "2" "a pending record read from disk keeps scale-in waiting (exit 2)"
assert_eq "$(jq -r '.in_flight.target_count' <<< "${GATE_OUT}")" "3" \
  "the target count is rebuilt from the on-disk record"
assert_eq "$(jq -r '.managed_count' <<< "${GATE_OUT}")" "3" \
  "the managed count still comes from cloud, not the record"

printf '%s\n' "${EXPIRED_T3}" > "${GATE_FILE}"
fresh_gate "${GATE_FILE}" 2000 false
assert_eq "${GATE_RC}" "3" "after the deadline, a fresh process reads the expired record and refuses"

printf '%s\n' '{not json' > "${GATE_FILE}"
fresh_gate "${GATE_FILE}" 2000 false
assert_eq "${GATE_RC}" "1" "a corrupt record on disk is refused, not guessed at (exit 1)"
assert_eq "${GATE_OUT}" "" "a corrupt record produces no snapshot"

test_end || SUITE_FAILED=1

echo ""
echo "═══ Capacity scale-in wiring suite complete ═══"
exit "${SUITE_FAILED:-0}"
