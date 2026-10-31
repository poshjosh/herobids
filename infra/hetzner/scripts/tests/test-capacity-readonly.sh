#!/usr/bin/env bash
# test-capacity-readonly.sh — Dry-run must cause no mutation.
#
# Runs the real scale-out.sh and scale-in.sh as subprocesses with recording
# mocks for terraform, hcloud, curl, sendmail and mail on PATH. The mocks
# never reach a network or a real backend. check-nomad-capacity.sh is replaced
# by a stub in a copy of the scripts directory, so the test controls whether a
# scale-out is needed. A live run is included as a positive control: if the
# recorders could not see a mutation, the zero-mutation assertions would
# prove nothing.
#
# Run: bash infra/hetzner/scripts/tests/test-capacity-readonly.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

SCRIPTS_DIR="$(cd "${TESTS_DIR}/.." && pwd)"
FX="${TESTS_DIR}/fixtures/capacity"
MOCK_BIN="${TEST_TMPDIR}/bin"
SCRIPTS_COPY="${TEST_TMPDIR}/scripts"
RUN=""
OUT=""
STUB_MODE="scale"

# ─── Recording mocks ──────────────────────────────────────────────────────────

mkdir -p "${MOCK_BIN}" "${SCRIPTS_COPY}"
cp "${SCRIPTS_DIR}"/*.sh "${SCRIPTS_COPY}/"

# The Hetzner API returns {servers, meta}. The synthetic inventory is re-labelled
# to the run's environment and to the pool the scripts derive from
# TF_VAR_server_name, so the live gate sees a healthy staging pool.
MOCK_CLOUD_FIXTURE="${TEST_TMPDIR}/cloud-api-staging.json"
jq '{servers: [.[] | .labels.environment = "staging" | .labels.node_pool = "synth"],
     meta: {pagination: {next_page: null}}}' "${FX}/cloud-healthy.json" > "${MOCK_CLOUD_FIXTURE}"

# Every mutating binary records its call and does nothing else.
for tool in terraform hcloud sendmail mail; do
  cat > "${MOCK_BIN}/${tool}" <<'EOF'
#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "${MOCK_LOG_DIR}/mutation-calls"
exit 0
EOF
  chmod +x "${MOCK_BIN}/${tool}"
done

# util-linux flock is absent on macOS and the scripts run on Linux hosts. The
# control is single-process, so a lock that always succeeds is faithful here.
cat > "${MOCK_BIN}/flock" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "${MOCK_BIN}/flock"

# curl records every call with its method. It serves Nomad and Hetzner GETs from
# the synthetic fixtures. Any non-GET request, or any SMTP URL, is also recorded
# as a mutation.
cat > "${MOCK_BIN}/curl" <<'EOF'
#!/usr/bin/env bash
method="GET"
url=""
prev=""
for arg in "$@"; do
  case "${prev}" in -X) method="${arg}" ;; esac
  case "${arg}" in http://*|https://*|smtp://*|smtps://*) url="${arg}" ;; esac
  prev="${arg}"
done
echo "${method} ${url}" >> "${MOCK_LOG_DIR}/http-calls"
if [[ "${method}" != "GET" || "${url}" == smtp* ]]; then
  echo "curl ${method} ${url}" >> "${MOCK_LOG_DIR}/mutation-calls"
fi
# The Hetzner config arrives on stdin (-K -); drain it as curl would.
case " $* " in *" -K - "*) cat >/dev/null ;; esac
case "${url}" in
  */v1/nodes) cat "${MOCK_NODES_FIXTURE}" ;;
  */v1/servers*) cat "${MOCK_CLOUD_FIXTURE}" ;;
  *) echo "[]" ;;
esac
# nomad_api asks curl to append the HTTP status code after the body.
case "${*}" in *'%{http_code}'*) printf '\n200\n' ;; esac
exit 0
EOF
chmod +x "${MOCK_BIN}/curl"

# Stub for the capacity check. Its key=value output is the contract scale-out.sh
# parses; the mode selects a scale-out-needed result or the no-ready exit 2.
# Each invocation is recorded so a test can prove whether it was consulted.
cat > "${SCRIPTS_COPY}/check-nomad-capacity.sh" <<'EOF'
#!/usr/bin/env bash
echo "check-nomad-capacity $*" >> "${MOCK_LOG_DIR}/capacity-calls"
case "${CAPACITY_STUB_MODE:-scale}" in
  scale)    printf 'free_memory_mb=50\nfree_memory_pct=5\nfree_slots=0\nready_nodes=2\n' ;;
  no-ready) exit 2 ;;
  *)        exit 1 ;;
esac
EOF
chmod +x "${SCRIPTS_COPY}/check-nomad-capacity.sh"

# ─── Helpers ──────────────────────────────────────────────────────────────────

# reset_run <name> — a fresh, seeded run directory. Every path the scripts can
# touch lives under it. The cached count (0) deliberately differs from the
# synthetic inventory (2 managed servers), so any decision read from the cache
# would be visible in the Terraform argument. The failure count of 1 is visible
# to any write that ignored dry-run.
reset_run() {
  RUN="${TEST_TMPDIR}/run-$1"
  OUT="${TEST_TMPDIR}/out-$1.txt"
  rm -rf "${RUN}"
  mkdir -p "${RUN}/terraform"
  echo "0" > "${RUN}/node-count"
  echo "1" > "${RUN}/failure-count"
  touch "${RUN}/http-calls" "${RUN}/mutation-calls" "${RUN}/capacity-calls"
  STUB_MODE="scale"
}

# run_script <script> [args...] — runs one autoscale script with a controlled
# environment (env -i), so no operator setting leaks in. The backend variables
# are synthetic placeholders, present so a live run can reach terraform init.
run_script() {
  env -i \
    PATH="${MOCK_BIN}:${PATH}" \
    HOME="${RUN}" \
    HEROBIDS_ENV=staging \
    NOMAD_ADDR="http://nomad.synthetic.invalid:4646" \
    TERRAFORM_DIR="${RUN}/terraform" \
    NOMAD_AUTOSCALE_LOG_FILE="${RUN}/autoscale.log" \
    NOMAD_AUTOSCALE_LOCKFILE="${RUN}/autoscale.lock" \
    NOMAD_AUTOSCALE_COOLDOWN_FILE="${RUN}/cooldown" \
    NOMAD_AUTOSCALE_NODE_COUNT_FILE="${RUN}/node-count" \
    NOMAD_AUTOSCALE_FAILURE_COUNT_FILE="${RUN}/failure-count" \
    NOMAD_AUTOSCALE_LAST_ALERT_FILE="${RUN}/last-alert" \
    NOMAD_AUTOSCALE_STATE_DIR="${RUN}/state" \
    TF_VAR_server_name=synth \
    TF_VAR_max_agent_nodes=5 \
    TF_VAR_min_agent_nodes=1 \
    HCLOUD_TOKEN=synthetic-token-not-real \
    MOCK_CLOUD_FIXTURE="${MOCK_CLOUD_FIXTURE}" \
    ENABLE_SCALE_IN=true \
    TF_BACKEND_BUCKET=synthetic-state-bucket \
    TF_BACKEND_REGION=synthetic-region \
    AWS_ACCESS_KEY_ID=synthetic-key-id \
    AWS_SECRET_ACCESS_KEY=synthetic-secret \
    CAPACITY_STUB_MODE="${STUB_MODE}" \
    MOCK_LOG_DIR="${RUN}" \
    MOCK_NODES_FIXTURE="${FX}/nomad-healthy.json" \
    "$@"
}

# snapshot — checksums of every file under the run directory. Logs and mock call
# records are excluded: they are evidence of behaviour, not state.
snapshot() {
  (cd "${RUN}" && find . -type f \
    ! -name 'autoscale.log' ! -name 'mutation-calls' ! -name 'http-calls' \
    ! -name 'capacity-calls' \
    -exec cksum {} \; | sort)
}

# ═════════════════════════════════════════════════════════════════════════════
# Scale-out dry-run
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity read-only: scale-out dry-run changes nothing"

reset_run scaleout-dry
BEFORE="$(snapshot)"
RC=0
run_script bash "${SCRIPTS_COPY}/scale-out.sh" --dry-run > "${OUT}" 2>&1 || RC=$?

assert_eq "${RC}" "0" "dry-run scale-out exits 0"
assert_contains "$(cat "${OUT}")" "Managed agent_node_count: 2" "dry-run reads the managed count from the reconciled inventory"
assert_contains "$(cat "${OUT}")" "Candidate new count:" "dry-run reaches the candidate decision"
assert_contains "$(cat "${OUT}")" "[DRY-RUN] No changes made." "dry-run reports that nothing changed"
assert_eq "$(snapshot)" "${BEFORE}" "dry-run leaves every state file unchanged"
assert_failure "dry-run writes no cooldown file" test -e "${RUN}/cooldown"
assert_failure "dry-run creates no state directory" test -e "${RUN}/state"
assert_eq "$(cat "${RUN}/mutation-calls")" "" "dry-run calls no terraform, hcloud or mail binary"
assert_eq "$(grep -cv '^GET ' "${RUN}/http-calls" || true)" "0" "dry-run makes no non-GET HTTP request"
assert_eq "$(cat "${RUN}/capacity-calls")" "" "dry-run does not consult the live capacity check"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Scale-out dry-run when the live capacity check would report no ready nodes
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity read-only: dry-run never reaches the live capacity check"

reset_run scaleout-noready
STUB_MODE="no-ready"
BEFORE="$(snapshot)"
RC=0
run_script bash "${SCRIPTS_COPY}/scale-out.sh" --dry-run > "${OUT}" 2>&1 || RC=$?

assert_eq "${RC}" "0" "dry-run exits 0 without consulting the capacity check"
assert_eq "$(cat "${RUN}/failure-count")" "1" "failure counter is not incremented in dry-run"
assert_eq "$(snapshot)" "${BEFORE}" "dry-run leaves every state file unchanged"
assert_eq "$(cat "${RUN}/mutation-calls")" "" "dry-run sends no alert"
assert_eq "$(cat "${RUN}/capacity-calls")" "" "the no-ready stub is never invoked in dry-run"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# alert_failure guard: dry-run neither records nor signals
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity read-only: alert_failure records nothing in dry-run"

reset_run alert-guard
RC=0
run_script bash -c 'source "$1/scale-common.sh"; source "$1/alert-common.sh"; DRY_RUN=true; if alert_failure; then echo ALERT; else echo NO_ALERT; fi' \
  _ "${SCRIPTS_COPY}" > "${OUT}" 2>&1 || RC=$?

assert_eq "${RC}" "0" "alert_failure runs to completion in dry-run"
assert_eq "$(tail -n 1 "${OUT}")" "NO_ALERT" "alert_failure in dry-run does not signal an alert"
assert_eq "$(cat "${RUN}/failure-count")" "1" "alert_failure in dry-run does not increment the counter"

RC=0
run_script bash -c 'source "$1/scale-common.sh"; source "$1/alert-common.sh"; DRY_RUN=false; alert_failure || true' \
  _ "${SCRIPTS_COPY}" > "${OUT}" 2>&1 || RC=$?
assert_eq "$(cat "${RUN}/failure-count")" "2" "control: alert_failure outside dry-run increments the counter"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Scale-in dry-run
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity read-only: scale-in dry-run changes nothing"

reset_run scalein-dry
BEFORE="$(snapshot)"
RC=0
run_script bash "${SCRIPTS_COPY}/scale-in.sh" --dry-run > "${OUT}" 2>&1 || RC=$?

assert_eq "${RC}" "0" "dry-run scale-in exits 0"
assert_contains "$(cat "${OUT}")" "Nodes to drain this run: 1" "dry-run reached the drain decision"
assert_contains "$(cat "${OUT}")" "[DRY-RUN] No changes made." "dry-run reports that nothing changed"
assert_eq "$(snapshot)" "${BEFORE}" "dry-run leaves every state file unchanged"
assert_eq "$(cat "${RUN}/mutation-calls")" "" "dry-run calls no terraform, hcloud or mail binary"
assert_eq "$(grep -cv '^GET ' "${RUN}/http-calls" || true)" "0" "dry-run makes no non-GET HTTP request"
assert_contains "$(cat "${RUN}/http-calls")" "GET http://nomad.synthetic.invalid:4646/v1/nodes" \
  "dry-run reads the node list (read-only)"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Positive control: a live run must be visible to the recorders
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity read-only: a live run is recorded and sized from the reconciled inventory (control)"

reset_run control-live
BEFORE="$(snapshot)"
RC=0
run_script bash "${SCRIPTS_COPY}/scale-out.sh" > "${OUT}" 2>&1 || RC=$?

# The expected count is derived from the synthetic inventory, not from the
# seeded cache (0). The recorders must see whatever the live run really does,
# so this control does not hard-code an apply claim.
EXPECTED_MANAGED="$(jq '[.[] | select(.labels.role == "agent")] | length' "${FX}/cloud-healthy.json")"
EXPECTED_NEW=$(( EXPECTED_MANAGED + 1 ))

assert_eq "${RC}" "0" "live scale-out with capacity needed exits 0"
assert_contains "$(cat "${RUN}/mutation-calls")" "terraform apply -auto-approve" \
  "live run reaches terraform apply, and the recorder sees it"
assert_contains "$(cat "${RUN}/mutation-calls")" "agent_node_count=${EXPECTED_NEW}" \
  "live run applies the count reconciled from cloud and Nomad"
assert_not_contains "$(cat "${RUN}/mutation-calls")" "agent_node_count=1" \
  "live run does not derive the count from the cached node-count file"
assert_neq "$(snapshot)" "${BEFORE}" "live run changes state, so the dry-run assertions are meaningful"
assert_eq "$(jq -r '.target_count' "${RUN}/state/inflight.json")" "${EXPECTED_NEW}" \
  "live run records the target before apply"
assert_eq "$(jq -r '.baseline_count' "${RUN}/state/inflight.json")" "${EXPECTED_MANAGED}" \
  "live run records the reconciled baseline"
assert_eq "$(cat "${RUN}/node-count")" "${EXPECTED_NEW}" "live run writes the diagnostic count"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══ Capacity read-only suite complete ═══"
exit "${SUITE_FAILED:-0}"
