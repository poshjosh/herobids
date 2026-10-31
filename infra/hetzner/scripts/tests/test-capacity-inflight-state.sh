#!/usr/bin/env bash
# test-capacity-inflight-state.sh — Durable in-flight provisioning state for
# capacity-inventory.sh: atomic no-clobber begin, concurrent-begin safety,
# clear only when ready or expired, argument validation, fail-closed reads,
# reboot survival, and no blind replay of a missing record.
#
# Run: bash infra/hetzner/scripts/tests/test-capacity-inflight-state.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

source "${TESTS_DIR}/source-helper.sh"
source "${SCRIPTS_DIR}/capacity-inventory.sh"

FX="${TESTS_DIR}/fixtures/capacity"
STATE_FILE="${NOMAD_AUTOSCALE_STATE_DIR}/inflight.json"

# A fresh bash process, as after a reboot. The library has no dependencies, so
# it can be sourced on its own. Arguments are passed positionally, never spliced.
fresh() {
  bash -c 'source "$1"; shift; "$@"' _ "${SCRIPTS_DIR}/capacity-inventory.sh" "$@"
}

# ═════════════════════════════════════════════════════════════════════════════
# Begin, read and clear
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity in-flight state: begin, read, clear"

# begin FILE ENV POOL TARGET BASELINE NOW TIMEOUT
assert_success "begin creates the record" \
  capacity_inflight_begin "${STATE_FILE}" synthetic synth 3 1 1000 600
assert_eq "$(jq -r '.deadline_epoch' "${STATE_FILE}")" "1600" "deadline is requested time plus timeout"
assert_eq "$(jq -r '.requested_epoch' "${STATE_FILE}")" "1000" "record keeps the requested time"
assert_eq "$(jq -r '.target_count' "${STATE_FILE}")" "3" "record keeps the target count"
assert_eq "$(jq -r '.baseline_count' "${STATE_FILE}")" "1" "record keeps the baseline count"
assert_eq "$(jq -c '.server_ids' "${STATE_FILE}")" "[]" "new record starts with no observed server IDs"
assert_eq "$(jq -r '.schema_version' "${STATE_FILE}")" "1" "record carries schema_version 1"

LEFTOVER="$(find "$(dirname "${STATE_FILE}")" -maxdepth 1 -name '.inflight.*' | wc -l | tr -d ' ')"
assert_eq "${LEFTOVER}" "0" "begin leaves no temporary file behind"

BEFORE="$(cat "${STATE_FILE}")"
assert_failure "begin refuses to overwrite an existing record" \
  capacity_inflight_begin "${STATE_FILE}" synthetic synth 5 2 2000 600
assert_eq "$(cat "${STATE_FILE}")" "${BEFORE}" "refused begin leaves the original record unchanged"

assert_eq "$(capacity_inflight_read "${TEST_TMPDIR}/absent.json" synthetic synth)" "" \
  "reading an absent record prints nothing"
assert_success "reading an absent record succeeds" \
  capacity_inflight_read "${TEST_TMPDIR}/absent.json" synthetic synth

assert_contains "$(capacity_inflight_read "${STATE_FILE}" synthetic synth)" '"deadline_epoch":1600' \
  "reading an existing record prints it"

assert_failure "corrupt record is refused on read" \
  capacity_inflight_read "${FX}/inflight-corrupt.json" synthetic synth
assert_failure "unsupported schema is refused on read" \
  capacity_inflight_read "${FX}/inflight-unsupported.json" synthetic synth
assert_failure "record for another environment is refused on read" \
  capacity_inflight_read "${FX}/inflight-other-env.json" synthetic synth

# Only a ready or expired record may be cleared (M2).
assert_failure "clear refuses a pending record" capacity_inflight_clear "${STATE_FILE}" pending
assert_success "pending record is kept after a refused clear" test -e "${STATE_FILE}"
assert_failure "clear refuses an unknown state" capacity_inflight_clear "${STATE_FILE}" ""
assert_success "record is kept after an unknown-state clear" test -e "${STATE_FILE}"

assert_success "clear removes a ready record" capacity_inflight_clear "${STATE_FILE}" ready
assert_failure "record is gone after clearing a ready state" test -e "${STATE_FILE}"

assert_success "begin succeeds after clear" \
  capacity_inflight_begin "${STATE_FILE}" synthetic synth 4 2 2000 600
assert_eq "$(jq -r '.deadline_epoch' "${STATE_FILE}")" "2600" "new request after clear gets a new deadline"

assert_success "clear removes an expired record" capacity_inflight_clear "${STATE_FILE}" expired
assert_success "clearing an absent record is harmless" capacity_inflight_clear "${STATE_FILE}" expired

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Concurrent begin: no-clobber (M1)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity in-flight state: concurrent begin is no-clobber"

RACE_FILE="${TEST_TMPDIR}/race/inflight.json"
RACE_WINS_BAD=0
for trial in 1 2 3 4 5 6 7 8 9 10; do
  rm -rf "${TEST_TMPDIR}/race"
  fresh capacity_inflight_begin "${RACE_FILE}" synthetic synth 3 1 "$(( 1000 + trial ))" 600 \
    > "${TEST_TMPDIR}/race-a.rc" 2>/dev/null &
  PID_A=$!
  fresh capacity_inflight_begin "${RACE_FILE}" synthetic synth 3 1 "$(( 2000 + trial ))" 600 \
    > "${TEST_TMPDIR}/race-b.rc" 2>/dev/null &
  PID_B=$!
  RC_A=0; RC_B=0
  wait "${PID_A}" || RC_A=$?
  wait "${PID_B}" || RC_B=$?
  WINS=0
  [[ "${RC_A}" -eq 0 ]] && WINS=$(( WINS + 1 ))
  [[ "${RC_B}" -eq 0 ]] && WINS=$(( WINS + 1 ))
  if [[ "${WINS}" -ne 1 ]]; then
    RACE_WINS_BAD=$(( RACE_WINS_BAD + 1 ))
  fi
  # The surviving record must be exactly one of the two requests, intact.
  assert_success "trial ${trial}: surviving record is valid JSON" jq -e . "${RACE_FILE}"
done
assert_eq "${RACE_WINS_BAD}" "0" "exactly one of two concurrent begins succeeds in every trial"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Invalid arguments create nothing (L5)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity in-flight state: invalid arguments"

BAD_FILE="${TEST_TMPDIR}/bad/inflight.json"
assert_failure "invalid environment name is rejected" \
  capacity_inflight_begin "${BAD_FILE}" "Bad Env" synth 3 1 1000 600
assert_failure "invalid pool name is rejected" \
  capacity_inflight_begin "${BAD_FILE}" synthetic "Bad Pool" 3 1 1000 600
assert_failure "negative target is rejected" \
  capacity_inflight_begin "${BAD_FILE}" synthetic synth -1 0 1000 600
assert_failure "zero target is rejected" \
  capacity_inflight_begin "${BAD_FILE}" synthetic synth 0 0 1000 600
assert_failure "target equal to the baseline is rejected" \
  capacity_inflight_begin "${BAD_FILE}" synthetic synth 3 3 1000 600
assert_failure "target below the baseline is rejected" \
  capacity_inflight_begin "${BAD_FILE}" synthetic synth 2 3 1000 600
assert_failure "non-numeric timeout is rejected" \
  capacity_inflight_begin "${BAD_FILE}" synthetic synth 3 1 1000 long
assert_failure "non-numeric time is rejected" \
  capacity_inflight_begin "${BAD_FILE}" synthetic synth 3 1 soon 600
assert_eq "$(test -e "${BAD_FILE}" && echo yes || echo no)" "no" \
  "rejected begin creates no record"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Fail closed on unreadable state (L4)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity in-flight state: unreadable state fails closed"

echo "not a directory" > "${TEST_TMPDIR}/plainfile"
assert_failure "a stat error other than a missing file fails the read" \
  capacity_inflight_read "${TEST_TMPDIR}/plainfile/inflight.json" synthetic synth
assert_eq "$(capacity_inflight_read "${TEST_TMPDIR}/plainfile/inflight.json" synthetic synth 2>/dev/null || true)" "" \
  "a failed read prints no record, so it cannot be mistaken for an absent one"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Reboot: a fresh process reads the same deadline and never restarts it
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity in-flight state: survives reboot"

capacity_inflight_begin "${STATE_FILE}" synthetic synth 3 1 1000 600

REBOOTED="$(fresh capacity_inflight_read "${STATE_FILE}" synthetic synth)"
assert_eq "$(jq -r '.deadline_epoch' <<< "${REBOOTED}")" "1600" \
  "fresh process reads the original deadline"

assert_failure "fresh process cannot reset a deadline still in flight" \
  fresh capacity_inflight_begin "${STATE_FILE}" synthetic synth 3 1 1500 600
assert_eq "$(jq -r '.deadline_epoch' "${STATE_FILE}")" "1600" \
  "deadline is unchanged after a refused restart"

RC=0
OUT="$(fresh capacity_reconcile "$(cat "${FX}/cloud-healthy.json")" \
  "$(cat "${FX}/nomad-healthy.json")" 3 synthetic synth 1500 "${REBOOTED}")" || RC=$?
assert_eq "$(jq -r '.in_flight.state' <<< "${OUT}")" "pending" \
  "fresh process reports the request as pending before the deadline"
assert_eq "${RC}" "0" "pending request after reboot is not a blocker"

RC=0
OUT="$(fresh capacity_reconcile "$(cat "${FX}/cloud-healthy.json")" \
  "$(cat "${FX}/nomad-healthy.json")" 3 synthetic synth 1700 "${REBOOTED}")" || RC=$?
assert_eq "$(jq -r '.in_flight.state' <<< "${OUT}")" "expired" \
  "fresh process reports the request as expired after the deadline"
assert_contains "$(jq -r '.blockers | join(",")' <<< "${OUT}")" "readiness_deadline_exceeded" \
  "expired request after reboot raises readiness_deadline_exceeded"
assert_eq "${RC}" "2" "expired request after reboot is blocked"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# No blind replay: a missing record with an unjoined node is refused (L7)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity in-flight state: missing record is never replayed"

rm -f "${STATE_FILE}"
RC=0
OUT="$(fresh capacity_reconcile "$(cat "${FX}/cloud-healthy.json")" \
  "$(cat "${FX}/nomad-empty.json")" 2 synthetic synth 1000 "")" || RC=$?
assert_eq "${RC}" "2" "unjoined servers with no record are blocked"
assert_contains "$(jq -r '.blockers | join(",")' <<< "${OUT}")" "unjoined_without_record" \
  "unjoined servers with no record raise unjoined_without_record"
assert_failure "reconciling never writes a replacement record" test -e "${STATE_FILE}"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══ Capacity in-flight state suite complete ═══"
exit "${SUITE_FAILED:-0}"
