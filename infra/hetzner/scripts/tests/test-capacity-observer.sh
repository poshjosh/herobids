#!/usr/bin/env bash
# test-capacity-observer.sh — Watcher observer mode (plan 5.1).
#
# Runs a copy of check-placement-failures.sh against a fake Nomad API on
# 127.0.0.1 with six resource-blocked evaluations (above the threshold of 5).
# scale-out.sh is replaced by a recording stub in the copy, so any trigger is
# visible. The legacy-policy run is a positive control: it must reach the stub,
# otherwise the zero-trigger assertions in demand mode would prove nothing.
#
# Run: bash infra/hetzner/scripts/tests/test-capacity-observer.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
SERVER_PID=""
cleanup() {
  if [[ -n "${SERVER_PID}" ]]; then kill "${SERVER_PID}" 2>/dev/null || true; wait "${SERVER_PID}" 2>/dev/null || true; fi
  rm -rf "${TEST_TMPDIR}"
}
trap cleanup EXIT

SCRIPTS_DIR="$(cd "${TESTS_DIR}/.." && pwd)"
SCRIPTS_COPY="${TEST_TMPDIR}/scripts"
PORT="${TEST_OBSERVER_PORT:-47711}"
REQUEST_LOG="${TEST_TMPDIR}/requests.log"
CALLS_LOG="${TEST_TMPDIR}/scale-out-calls.log"
STATE_FILE="${TEST_TMPDIR}/placement-failure-state"
NOMAD_URL="http://127.0.0.1:${PORT}"

mkdir -p "${SCRIPTS_COPY}"
cp "${SCRIPTS_DIR}"/*.sh "${SCRIPTS_COPY}/"
cat > "${SCRIPTS_COPY}/scale-out.sh" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "${CALLS_LOG}"
exit 0
STUB
chmod +x "${SCRIPTS_COPY}/scale-out.sh" "${SCRIPTS_COPY}/check-placement-failures.sh"

python3 "${TESTS_DIR}/fake-nomad-observer.py" "${PORT}" "${REQUEST_LOG}" 6 >/dev/null 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  if curl -s "${NOMAD_URL}/v1/status/leader" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

# run_watcher DEMAND_FLAG — runs the watcher copy and prints "rc|output".
run_watcher() {
  local demand="$1" out rc
  rm -f "${STATE_FILE}" "${CALLS_LOG}" "${REQUEST_LOG}"
  out="$(env -i PATH="/usr/bin:/bin:/opt/homebrew/bin" HOME="${TEST_TMPDIR}" \
    NOMAD_ADDR="${NOMAD_URL}" \
    NOMAD_AUTOSCALE_LOG_FILE="${TEST_TMPDIR}/watcher.log" \
    NOMAD_AUTOSCALE_DEMAND_ENABLED="${demand}" \
    NOMAD_PLACEMENT_FAILURE_THRESHOLD=5 \
    NOMAD_PLACEMENT_FAILURE_STATE_FILE="${STATE_FILE}" \
    NOMAD_AUTOSCALE_FAILURE_COUNT_FILE="${TEST_TMPDIR}/failure-count" \
    bash "${SCRIPTS_COPY}/check-placement-failures.sh" 2>&1)" && rc=0 || rc=$?
  echo "${rc}|${out}"
}

test_begin "observer: demand mode reports backlog, triggers nothing, writes nothing"
RESULT="$(run_watcher true)"
assert_eq "${RESULT%%|*}" "0" "demand mode exits 0"
assert_contains "${RESULT}" "OBSERVER (demand-aware mode)" "demand mode logs the observer line"
assert_contains "${RESULT}" "Blocked evaluations" "observer still reports the blocked count"
assert_eq "$([[ -e "${CALLS_LOG}" ]] && echo called || echo none)" "none" "demand mode never invokes scale-out.sh"
assert_eq "$([[ -e "${STATE_FILE}" ]] && echo written || echo absent)" "absent" "demand mode writes no safety-net state"
assert_contains "$(cat "${REQUEST_LOG}" 2>/dev/null || true)" "/v1/evaluations?namespace=herobids-agents" \
  "evaluations query is scoped to the agent namespace"
test_end || SUITE_FAILED=1

test_begin "observer: legacy policy still triggers (positive control)"
RESULT="$(run_watcher false)"
assert_eq "${RESULT%%|*}" "0" "legacy mode exits 0 after triggering"
assert_eq "$([[ -s "${CALLS_LOG}" ]] && echo called || echo none)" "called" \
  "legacy mode reaches the scale-out stub, so the demand-mode zero is meaningful"
assert_contains "$(cat "${CALLS_LOG}" 2>/dev/null || true)" "--bypass-cooldown" \
  "legacy safety-net trigger keeps its original arguments"
test_end || SUITE_FAILED=1

exit "${SUITE_FAILED:-0}"
