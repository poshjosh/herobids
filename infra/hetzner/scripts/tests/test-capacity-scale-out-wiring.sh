#!/usr/bin/env bash
# test-capacity-scale-out-wiring.sh — scale-out.sh sizes from the reconciled
# capacity state and refuses on any blocker.
#
# Runs the real scale-out.sh as a subprocess with recording mocks for terraform,
# hcloud, curl, sendmail, mail and flock on PATH. Hetzner and Nomad answers come
# from synthetic fixtures, re-shaped into temp files. check-nomad-capacity.sh is
# a stub, so each test chooses the live capacity result. Nothing reaches a
# network or a real Terraform backend.
#
# Run: bash infra/hetzner/scripts/tests/test-capacity-scale-out-wiring.sh

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
ALERT_THRESHOLD=1
CLOUD_FIXTURE=""
NODES_FIXTURE=""

mkdir -p "${MOCK_BIN}" "${SCRIPTS_COPY}"
cp "${SCRIPTS_DIR}"/*.sh "${SCRIPTS_COPY}/"

# ─── Synthetic inputs ─────────────────────────────────────────────────────────

# The Hetzner API returns {servers, meta}. Each synthetic inventory is re-labelled
# to the run's environment and to the pool the scripts derive from
# TF_VAR_server_name (synth).
hetzner_body() {
  jq -c '{servers: [.[] | .labels.environment = "staging" | .labels.node_pool = "synth"],
          meta: {pagination: {next_page: null}}}' "$1"
}

CLOUD_TWO="${TEST_TMPDIR}/cloud-two.json"
hetzner_body "${FX}/cloud-healthy.json" > "${CLOUD_TWO}"

CLOUD_THREE="${TEST_TMPDIR}/cloud-three.json"
jq -s -c '{servers: [.[].servers[] | .labels.environment = "staging" | .labels.node_pool = "synth"],
           meta: {pagination: {next_page: null}}}' \
  "${FX}/cloud-page-1.json" "${FX}/cloud-page-2.json" > "${CLOUD_THREE}"

CLOUD_EMPTY="${TEST_TMPDIR}/cloud-empty.json"
echo '{"servers": [], "meta": {"pagination": {"next_page": null}}}' > "${CLOUD_EMPTY}"

# A third agent that joins Nomad ready, and a variant where it is down.
NOMAD_THREE="${TEST_TMPDIR}/nomad-three-ready.json"
jq -c '. + [.[0] | .ID = "00000000-0000-4000-8000-000000000003" | .Name = "synth-agent-3"]' \
  "${FX}/nomad-healthy.json" > "${NOMAD_THREE}"

NOMAD_THREE_DOWN="${TEST_TMPDIR}/nomad-three-down.json"
jq -c 'map(if .Name == "synth-agent-3" then .Status = "down" else . end)' \
  "${NOMAD_THREE}" > "${NOMAD_THREE_DOWN}"

NOMAD_TWO="${FX}/nomad-healthy.json"
NOMAD_EMPTY="${FX}/nomad-empty.json"
NOMAD_NO_BODY="${TEST_TMPDIR}/nomad-no-body"
: > "${NOMAD_NO_BODY}"

# ─── Recording mocks ──────────────────────────────────────────────────────────

for tool in terraform hcloud mail; do
  cat > "${MOCK_BIN}/${tool}" <<'EOF'
#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "${MOCK_LOG_DIR}/mutation-calls"
exit 0
EOF
  chmod +x "${MOCK_BIN}/${tool}"
done

# sendmail records the message body, so a test can assert which event fired.
cat > "${MOCK_BIN}/sendmail" <<'EOF'
#!/usr/bin/env bash
echo "sendmail $*" >> "${MOCK_LOG_DIR}/mutation-calls"
cat >> "${MOCK_LOG_DIR}/alerts"
exit 0
EOF
chmod +x "${MOCK_BIN}/sendmail"

# util-linux flock is absent on macOS. These tests run a single process, so a
# lock that always succeeds is faithful here.
cat > "${MOCK_BIN}/flock" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "${MOCK_BIN}/flock"

# curl serves Hetzner servers and Nomad nodes from the fixture paths in the
# environment. Any non-GET request or SMTP URL is recorded as a mutation.
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
case "${*}" in *'%{http_code}'*) printf '\n200\n' ;; esac
exit 0
EOF
chmod +x "${MOCK_BIN}/curl"

# Stub for the live capacity check. The mode selects the result scale-out.sh
# parses; each invocation is recorded.
cat > "${SCRIPTS_COPY}/check-nomad-capacity.sh" <<'EOF'
#!/usr/bin/env bash
echo "check-nomad-capacity $*" >> "${MOCK_LOG_DIR}/capacity-calls"
case "${CAPACITY_STUB_MODE:-scale}" in
  scale)    printf 'free_memory_mb=50\nfree_memory_pct=5\nfree_slots=0\nready_nodes=2\n' ;;
  no-ready) exit 2 ;;
  malformed) printf 'free_memory_mb=50\nfree_memory_pct=5\nfree_slots=abc\nready_nodes=2\n' ;;
  *)        echo "synthetic capacity failure" >&2; exit 1 ;;
esac
EOF
chmod +x "${SCRIPTS_COPY}/check-nomad-capacity.sh"

# ─── Helpers ──────────────────────────────────────────────────────────────────

# reset_run <name> — a fresh run directory with the default inputs: two healthy
# managed servers, a cached count of 0 (deliberately different from the real
# count, so a cache-derived decision would be visible), one prior failure, and
# an alert threshold of 1 so every failure alerts.
reset_run() {
  RUN="${TEST_TMPDIR}/run-$1"
  OUT="${TEST_TMPDIR}/out-$1.txt"
  rm -rf "${RUN}"
  mkdir -p "${RUN}/terraform"
  echo "0" > "${RUN}/node-count"
  echo "1" > "${RUN}/failure-count"
  touch "${RUN}/http-calls" "${RUN}/mutation-calls" "${RUN}/capacity-calls" "${RUN}/alerts"
  STUB_MODE="scale"
  ALERT_THRESHOLD=1
  CLOUD_FIXTURE="${CLOUD_TWO}"
  NODES_FIXTURE="${NOMAD_TWO}"
}

# run_script <script> [args...] — a controlled environment (env -i) so no
# operator setting leaks in. Backend variables are synthetic placeholders.
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
    ALERT_FAILURE_THRESHOLD="${ALERT_THRESHOLD}" \
    ALERT_TO=ops@synthetic.invalid \
    ALERT_FROM=autoscale@synthetic.invalid \
    TF_VAR_server_name=synth \
    TF_VAR_max_agent_nodes=5 \
    TF_VAR_min_agent_nodes=1 \
    HCLOUD_TOKEN=synthetic-token-not-real \
    TF_BACKEND_BUCKET=synthetic-state-bucket \
    TF_BACKEND_REGION=synthetic-region \
    AWS_ACCESS_KEY_ID=synthetic-key-id \
    AWS_SECRET_ACCESS_KEY=synthetic-secret \
    CAPACITY_STUB_MODE="${STUB_MODE}" \
    MOCK_LOG_DIR="${RUN}" \
    MOCK_CLOUD_FIXTURE="${CLOUD_FIXTURE}" \
    MOCK_NODES_FIXTURE="${NODES_FIXTURE}" \
    "$@"
}

# scale_out <args...> — runs scale-out.sh and sets RC and OUT for the caller.
scale_out() {
  RC=0
  run_script bash "${SCRIPTS_COPY}/scale-out.sh" "$@" > "${OUT}" 2>&1 || RC=$?
}

MUTATIONS() { cat "${RUN}/mutation-calls"; }
ALERTS() { cat "${RUN}/alerts"; }

# ═════════════════════════════════════════════════════════════════════════════
# Count source (C1, H3)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity wiring: the applied count comes from the reconciled inventory, not the cache (H3)"

reset_run three-ready
CLOUD_FIXTURE="${CLOUD_THREE}"
NODES_FIXTURE="${NOMAD_THREE}"
scale_out

assert_eq "${RC}" "0" "scale-out with three reconciled servers exits 0"
assert_contains "$(MUTATIONS)" "terraform apply" "live run reaches terraform apply"
assert_contains "$(MUTATIONS)" "agent_node_count=4" "applies three reconciled servers plus one"
assert_not_contains "$(MUTATIONS)" "agent_node_count=1" "does not derive the count from the cached 0"

test_end || SUITE_FAILED=1

test_begin "capacity wiring: a server that is down in Nomad still counts toward the managed count (H3)"

reset_run three-down
CLOUD_FIXTURE="${CLOUD_THREE}"
NODES_FIXTURE="${NOMAD_THREE_DOWN}"
scale_out

assert_eq "${RC}" "0" "scale-out with one down node exits 0"
assert_contains "$(MUTATIONS)" "agent_node_count=4" \
  "the down server stays in the managed count, so the target is still three plus one"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Refusals (C1, M8)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity wiring: an empty Nomad answer refuses scale-out end to end (M8)"

reset_run empty-nomad-body
NODES_FIXTURE="${NOMAD_NO_BODY}"
scale_out

assert_eq "${RC}" "1" "an empty Nomad answer exits 1"
assert_not_contains "$(MUTATIONS)" "terraform apply" "an empty Nomad answer never reaches apply"
assert_contains "$(ALERTS)" "scale_out_capacity_guard_failed" \
  "the refusal is reported as a guard failure"

test_end || SUITE_FAILED=1

test_begin "capacity wiring: an empty Hetzner answer refuses scale-out end to end (M8)"

reset_run empty-cloud-body
CLOUD_FIXTURE="${NOMAD_NO_BODY}"
scale_out

assert_eq "${RC}" "1" "an empty Hetzner answer exits 1"
assert_not_contains "$(MUTATIONS)" "terraform apply" "an empty Hetzner answer never reaches apply"
assert_contains "$(ALERTS)" "scale_out_capacity_guard_failed" \
  "the refusal is reported as a guard failure"

test_end || SUITE_FAILED=1

test_begin "capacity wiring: an empty inventory at declared 0 refuses scale-out"

reset_run empty-inventory
CLOUD_FIXTURE="${CLOUD_EMPTY}"
NODES_FIXTURE="${NOMAD_EMPTY}"
scale_out

assert_eq "${RC}" "1" "empty cloud and Nomad inventories exit 1"
assert_contains "$(cat "${OUT}")" "empty_inventory" "the blocker is named in the log"
assert_not_contains "$(MUTATIONS)" "terraform apply" "an empty inventory never reaches apply"
assert_contains "$(ALERTS)" "scale_out_capacity_blocked" "the blocked refusal alerts"

test_end || SUITE_FAILED=1

test_begin "capacity wiring: joined-less servers with no in-flight record refuse scale-out"

reset_run unjoined
NODES_FIXTURE="${NOMAD_EMPTY}"
scale_out

assert_eq "${RC}" "1" "servers not in Nomad exit 1 when no record explains them"
assert_contains "$(cat "${OUT}")" "unjoined_without_record" "the blocker is named in the log"
assert_not_contains "$(MUTATIONS)" "terraform apply" "an unexplained inventory never reaches apply"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Capacity-check exit codes reach their alerts (H2)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity wiring: a failing capacity check reaches the exit-N alert path (H2)"

reset_run check-fails
STUB_MODE="fail"
scale_out

assert_eq "${RC}" "1" "a failing capacity check exits 1"
assert_contains "$(cat "${OUT}")" "Capacity check failed with exit code 1" \
  "the captured exit code is reported"
assert_eq "$(cat "${RUN}/failure-count")" "2" "the failure streak is incremented"
assert_contains "$(ALERTS)" "scale_out_capacity_check_failed" "the alert is sent"
assert_not_contains "$(MUTATIONS)" "terraform apply" "a failed capacity check never reaches apply"

test_end || SUITE_FAILED=1

test_begin "capacity wiring: no ready Nomad nodes reaches the exit-2 alert path (H2)"

reset_run no-ready
STUB_MODE="no-ready"
scale_out

assert_eq "${RC}" "2" "no ready nodes exits 2"
assert_eq "$(cat "${RUN}/failure-count")" "2" "the failure streak is incremented"
assert_contains "$(ALERTS)" "scale_out_no_ready_nodes" "the alert is sent"
assert_not_contains "$(MUTATIONS)" "terraform apply" "no ready nodes never reaches apply"

test_end || SUITE_FAILED=1

test_begin "capacity wiring: malformed capacity output refuses scale-out and alerts (item 6)"

reset_run malformed-output
STUB_MODE="malformed"
scale_out

assert_eq "${RC}" "1" "malformed capacity output exits 1"
assert_contains "$(cat "${OUT}")" "Capacity output was malformed" "the refusal is logged"
assert_eq "$(cat "${RUN}/failure-count")" "2" "the failure streak is incremented"
assert_contains "$(ALERTS)" "scale_out_capacity_output_malformed" "the malformed-output alert is sent"
assert_not_contains "$(MUTATIONS)" "terraform apply" "malformed capacity output never reaches apply"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Lock ordering (M7)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity wiring: dry-run creates no lockfile (M7)"

reset_run dry-lock
scale_out --dry-run

assert_eq "${RC}" "0" "dry-run exits 0"
assert_failure "dry-run creates no lockfile" test -e "${RUN}/autoscale.lock"
assert_eq "$(MUTATIONS)" "" "dry-run calls no mutating binary"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# In-flight record gating (H5, M2)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity wiring: a pending in-flight record blocks a second apply"

reset_run pending
mkdir -p "${RUN}/state"
NOW="$(date +%s)"
jq -n --argjson now "${NOW}" \
  '{schema_version: 1, environment: "staging", pool: "synth", target_count: 3, baseline_count: 2,
    requested_epoch: $now, deadline_epoch: ($now + 600), server_ids: []}' \
  > "${RUN}/state/inflight.json"
scale_out

assert_eq "${RC}" "0" "a pending scale-out exits 0"
assert_contains "$(cat "${OUT}")" "still in flight" "the run skips because readiness is pending"
assert_not_contains "$(MUTATIONS)" "terraform apply" "a pending scale-out never reaches apply"
assert_contains "$(cat "${RUN}/state/inflight.json")" '"target_count": 3' \
  "the pending record is left in place"

test_end || SUITE_FAILED=1

test_begin "capacity wiring: an expired in-flight record is cleared and the run refused (M2)"

reset_run expired
mkdir -p "${RUN}/state"
NOW="$(date +%s)"
jq -n --argjson now "${NOW}" \
  '{schema_version: 1, environment: "staging", pool: "synth", target_count: 3, baseline_count: 2,
    requested_epoch: ($now - 700), deadline_epoch: ($now - 100), server_ids: []}' \
  > "${RUN}/state/inflight.json"
scale_out

assert_eq "${RC}" "1" "an expired scale-out is refused"
assert_failure "the expired record is cleared" test -e "${RUN}/state/inflight.json"
assert_contains "$(cat "${OUT}")" "readiness_deadline_exceeded" "the expiry is named in the log"
assert_not_contains "$(MUTATIONS)" "terraform apply" "an expired scale-out never reaches apply"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══ Capacity scale-out wiring suite complete ═══"
exit "${SUITE_FAILED:-0}"
