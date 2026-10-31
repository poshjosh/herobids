#!/usr/bin/env bash
# test-capacity-scale-out-demand.sh — Demand-mode scale-out guards (plan 5.1, 5.7).
#
# Runs the real scale-out.sh with recording stubs first on PATH for terraform,
# flock, curl, sendmail and mail. Nothing reaches a network or a backend.
#   - --bypass-cooldown and --safety-net must fail before any side effect.
#   - Dry-run with no initialised backend must exit non-zero and write nothing.
#   - A held autoscale lock must stop the run before Terraform or any HTTP call.
#   - In a live run the lock is taken before backend preparation (ordering).
#
# Run: bash infra/hetzner/scripts/tests/test-capacity-scale-out-demand.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
FAKE_PID=""
trap 'if [[ -n "${FAKE_PID}" ]]; then kill "${FAKE_PID}" 2>/dev/null || true; fi; rm -rf "${TEST_TMPDIR}"' EXIT

SCRIPTS_DIR="$(cd "${TESTS_DIR}/.." && pwd)"
MOCK_BIN="${TEST_TMPDIR}/bin"
CALLS_LOG="${TEST_TMPDIR}/calls.log"
TF_DIR="${TEST_TMPDIR}/terraform"
STATE_DIR="${TEST_TMPDIR}/state"
OUT="${TEST_TMPDIR}/out.log"

mkdir -p "${MOCK_BIN}" "${TF_DIR}"

# Recording stubs. Every call is appended to CALLS_LOG in order, so ordering
# assertions can compare the lock with backend preparation.
make_stub() {
  local name="$1" body="$2" dir="${3:-${MOCK_BIN}}"
  printf '#!/usr/bin/env bash\necho "%s $*" >> "%s"\n%s\n' "${name}" "${CALLS_LOG}" "${body}" > "${dir}/${name}"
  chmod +x "${dir}/${name}"
}
make_stub terraform 'exit 0'
make_stub flock 'exit "${FLOCK_RC:-0}"'
make_stub curl 'exit 7'
make_stub sendmail 'exit 0'
make_stub mail 'exit 0'

# run_scale_out FLOCK_RC ARGS... — runs scale-out.sh under demand mode; prints "rc|output".
run_scale_out() {
  local flock_rc="$1"; shift
  local rc
  rm -f "${CALLS_LOG}"
  env -i PATH="${MOCK_BIN}:/usr/bin:/bin:/opt/homebrew/bin" HOME="${TEST_TMPDIR}" \
    FLOCK_RC="${flock_rc}" \
    HEROBIDS_ENV=staging \
    TERRAFORM_DIR="${TF_DIR}" \
    NOMAD_AUTOSCALE_DEMAND_ENABLED=true \
    NOMAD_NODE_TEMPLATE_MEMORY_MB=4096 \
    NOMAD_NODE_TEMPLATE_CPU_MHZ=4000 \
    NOMAD_AUTOSCALE_STATE_DIR="${STATE_DIR}" \
    NOMAD_AUTOSCALE_LOCKFILE="${TEST_TMPDIR}/autoscale.lock" \
    NOMAD_AUTOSCALE_LOG_FILE="${TEST_TMPDIR}/autoscale.log" \
    NOMAD_AUTOSCALE_FAILURE_COUNT_FILE="${TEST_TMPDIR}/failure-count" \
    TF_VAR_max_agent_nodes=3 TF_VAR_min_agent_nodes=0 \
    "${BASH}" "${SCRIPTS_DIR}/scale-out.sh" "$@" > "${OUT}" 2>&1 && rc=0 || rc=$?
  echo "${rc}"
}

calls_count() { if [[ -s "${CALLS_LOG}" ]]; then grep -c "^$1 " "${CALLS_LOG}" || true; else echo 0; fi; }
calls_matching() { if [[ -s "${CALLS_LOG}" ]]; then grep -c -E "$1" "${CALLS_LOG}" || true; else echo 0; fi; }

test_begin "demand guards: bypass and safety-net fail explicitly before any side effect"
RC="$(run_scale_out 0 --bypass-cooldown)"
assert_eq "${RC}" "1" "--bypass-cooldown exits 1 in demand mode"
assert_contains "$(cat "${OUT}")" "not supported when NOMAD_AUTOSCALE_DEMAND_ENABLED=true" \
  "--bypass-cooldown names the demand policy"
assert_eq "$(calls_count terraform)" "0" "--bypass-cooldown calls no terraform"
assert_eq "$(calls_count curl)" "0" "--bypass-cooldown makes no HTTP call"
RC="$(run_scale_out 0 --safety-net)"
assert_eq "${RC}" "1" "--safety-net exits 1 in demand mode"
assert_eq "$(calls_count terraform)" "0" "--safety-net calls no terraform"
test_end || SUITE_FAILED=1

test_begin "dry-run: uninitialised backend exits non-zero and writes nothing"
RC="$(run_scale_out 0 --dry-run)"
assert_eq "${RC}" "1" "dry-run without an initialised backend exits 1"
assert_contains "$(cat "${OUT}")" "not initialised" "dry-run names the missing backend"
assert_eq "$(calls_count terraform)" "0" "dry-run calls no terraform (no init, select or plan)"
assert_eq "$(calls_count curl)" "0" "dry-run makes no HTTP call before the state check"
assert_eq "$([[ -e "${TF_DIR}/.terraform-envs" ]] && echo created || echo absent)" "absent" \
  "dry-run does not create a terraform data dir"
assert_eq "$(find "${STATE_DIR}" -type f 2>/dev/null | wc -l | tr -d ' ')" "0" \
  "dry-run writes no controller state, cooldown or count files"
test_end || SUITE_FAILED=1

test_begin "live run: a held lock stops before terraform or HTTP"
if (( BASH_VERSINFO[0] < 4 )); then
  echo "  SKIP: live lock path needs bash >= 4.1 (acquire_lock uses exec {fd}); bash ${BASH_VERSION} cannot run it"
else
  RC="$(run_scale_out 1)"
  assert_eq "${RC}" "4" "held lock exits 4"
  assert_contains "$(cat "${OUT}")" "skipping" "held lock reports the skip"
  assert_eq "$(calls_count terraform)" "0" "held lock calls no terraform"
  assert_eq "$(calls_count curl)" "0" "held lock makes no HTTP call"
fi
test_end || SUITE_FAILED=1

test_begin "live run: lock is taken before backend preparation (ordering)"
if (( BASH_VERSINFO[0] < 4 )); then
  echo "  SKIP: live lock path needs bash >= 4.1 (acquire_lock uses exec {fd}); bash ${BASH_VERSION} cannot run it"
else
  RC="$(run_scale_out 0)"
  LOCK_LINE="$(grep -n 'Lock acquired' "${OUT}" | head -1 | cut -d: -f1 || true)"
  BACKEND_LINE="$(grep -n 'Missing backend environment' "${OUT}" | head -1 | cut -d: -f1 || true)"
  assert_eq "$([[ -n "${LOCK_LINE}" && -n "${BACKEND_LINE}" && "${LOCK_LINE}" -lt "${BACKEND_LINE}" ]] && echo ordered || echo unordered)" \
    "ordered" "lock is acquired before backend environment is checked"
  assert_eq "$(grep -m1 '^flock ' "${CALLS_LOG}" | cut -d' ' -f2)" "-n" \
    "first flock call is the non-blocking acquire (-n), before any release"
  assert_eq "$(calls_count terraform)" "0" "missing backend stops before any terraform call"
  assert_eq "${RC}" "1" "missing backend exits 1 after the lock"
fi
test_end || SUITE_FAILED=1

# --force end-to-end: real curl against a 127.0.0.1 fake Hetzner/Nomad API, stubbed
# check-nomad-capacity and a stubbed terraform on PATH. Synthetic fixtures only.
test_begin "--force: obeys the cap and the lock; saved plan applied without auto-approve"
if (( BASH_VERSINFO[0] < 4 )); then
  echo "  SKIP: live gate needs the bash >= 4.1 lock path; bash ${BASH_VERSION} cannot run it"
else
  FORCE_PORT="${TEST_FORCE_PORT:-47712}"
  FORCE_URL="http://127.0.0.1:${FORCE_PORT}"
  API_LOG="${TEST_TMPDIR}/api-requests.log"
  SCRIPTS_COPY="${TEST_TMPDIR}/scripts"
  LIVE_BIN="${TEST_TMPDIR}/livebin"
  PLAN_FIXTURE="${TESTS_DIR}/fixtures/capacity/plan-create-agent.json"
  mkdir -p "${LIVE_BIN}" "${SCRIPTS_COPY}"
  cp "${SCRIPTS_DIR}"/*.sh "${SCRIPTS_COPY}/"
  # Synthetic tfvars supply environment, server_name and agent_node_server_type; the
  # location is supplied as TF_VAR_location below (matches the fixture plan's nbg1).
  cp "${TESTS_DIR}/fixtures/capacity/synthetic-staging-tfvars.txt" "${TF_DIR}/staging.tfvars"
  # The real check-nomad-capacity.sh needs Nomad allocation endpoints the fake does not serve.
  printf '%s\n' '#!/usr/bin/env bash' "printf '%s\\n' '{\"ready_nodes\":2,\"free_slots\":0,\"bins\":[{\"id\":\"n1\",\"kind\":\"actual\",\"free_memory_mb\":0,\"free_cpu_mhz\":0},{\"id\":\"n2\",\"kind\":\"actual\",\"free_memory_mb\":0,\"free_cpu_mhz\":0}]}'" \
    > "${SCRIPTS_COPY}/check-nomad-capacity.sh"
  chmod +x "${SCRIPTS_COPY}/check-nomad-capacity.sh"
  make_stub terraform 'case "$1" in show) cat "${TF_PLAN_FIXTURE}" ;; esac; exit 0' "${LIVE_BIN}"
  make_stub flock 'exit "${FLOCK_RC:-0}"' "${LIVE_BIN}"

  python3 "${TESTS_DIR}/fake-capacity-api.py" "${FORCE_PORT}" "${TESTS_DIR}/fixtures/capacity" "${API_LOG}" staging \
    >/dev/null 2>&1 &
  FAKE_PID=$!
  for _ in $(seq 1 50); do
    if curl -s "${FORCE_URL}/v1/nodes" >/dev/null 2>&1; then break; fi
    sleep 0.1
  done

  # run_force CAP FLOCK_RC ARGS... — live scale-out against the fake API; prints "rc".
  run_force() {
    local cap="$1" flock_rc="$2"; shift 2
    local rc
    rm -f "${CALLS_LOG}"
    env -i PATH="${LIVE_BIN}:/usr/bin:/bin:/opt/homebrew/bin" HOME="${TEST_TMPDIR}" \
      FLOCK_RC="${flock_rc}" TF_PLAN_FIXTURE="${PLAN_FIXTURE}" \
      HEROBIDS_ENV=staging \
      TERRAFORM_DIR="${TF_DIR}" \
      NOMAD_AUTOSCALE_DEMAND_ENABLED=true \
      NOMAD_NODE_TEMPLATE_MEMORY_MB=4096 \
      NOMAD_NODE_TEMPLATE_CPU_MHZ=4000 \
      NOMAD_AUTOSCALE_NODE_POOL=synth \
      NOMAD_AUTOSCALE_STATE_DIR="${STATE_DIR}" \
      NOMAD_AUTOSCALE_LOCKFILE="${TEST_TMPDIR}/autoscale.lock" \
      NOMAD_AUTOSCALE_LOG_FILE="${TEST_TMPDIR}/autoscale.log" \
      NOMAD_AUTOSCALE_FAILURE_COUNT_FILE="${TEST_TMPDIR}/failure-count" \
      NOMAD_AUTOSCALE_NODE_COUNT_FILE="${TEST_TMPDIR}/node-count" \
      NOMAD_AUTOSCALE_COOLDOWN_FILE="${TEST_TMPDIR}/last-scale-out" \
      TF_VAR_max_agent_nodes="${cap}" TF_VAR_min_agent_nodes=0 TF_VAR_location=nbg1 \
      HCLOUD_API_URL="${FORCE_URL}/v1" HCLOUD_TOKEN="synthetic-token" \
      NOMAD_ADDR="${FORCE_URL}" \
      TF_BACKEND_BUCKET=synthetic-bucket TF_BACKEND_REGION=eu-central-1 \
      AWS_ACCESS_KEY_ID=synthetic AWS_SECRET_ACCESS_KEY=synthetic \
      "${BASH}" "${SCRIPTS_COPY}/scale-out.sh" "$@" > "${OUT}" 2>&1 && rc=0 || rc=$?
    echo "${rc}"
  }

  # Cap equals the two managed servers: --force must not add past the cap.
  RC="$(run_force 2 0 --force)"
  assert_eq "${RC}" "0" "--force at cap exits 0 as a reasoned no-op"
  assert_contains "$(cat "${OUT}")" "remaining_headroom=0" "--force at cap reports zero headroom"
  assert_eq "$(calls_matching '^terraform (plan|apply) ')" "0" "--force at cap plans and applies nothing"

  # Held lock: --force must not bypass the lock.
  RC="$(run_force 3 1 --force)"
  assert_eq "${RC}" "4" "--force with a held lock exits 4"
  assert_eq "$(calls_matching '^terraform (plan|apply) ')" "0" "--force with a held lock plans nothing"

  # Headroom of one: --force requests exactly one node, planned and applied from the saved plan.
  RC="$(run_force 3 0 --force)"
  [[ "${RC}" == "0" ]] || { echo "--- scale-out output for the failed --force run ---" >&2; cat "${OUT}" >&2; }
  assert_eq "${RC}" "0" "--force below cap exits 0"
  assert_contains "$(cat "${OUT}")" "Decision: add=1 target=3" "--force adds exactly one node"
  assert_eq "$(calls_matching '^terraform plan .*agent_node_count=3')" "1" \
    "--force plans agent_node_count=3 (never above the cap)"
  assert_eq "$(calls_matching '^terraform apply -input=false ')" "1" \
    "--force applies the saved plan file"
  assert_eq "$(calls_matching 'auto-approve')" "0" "apply never uses -auto-approve"
  assert_not_contains "$(cat "${OUT}")" "hcloud_server" "plan JSON is never logged"
  assert_eq "$([[ "$(grep -c '/v1/servers' "${API_LOG}" 2>/dev/null || true)" -ge 1 ]] && echo yes || echo no)" "yes" \
    "cloud inventory was read through the fake API"

  # The apply above recorded the success cooldown. A second --force inside it must not add.
  assert_eq "$([[ -s "${TEST_TMPDIR}/last-scale-out" ]] && echo yes || echo no)" "yes" \
    "successful apply recorded the cooldown timestamp"
  RC="$(run_force 3 0 --force)"
  assert_eq "${RC}" "0" "--force inside cooldown exits 0 as a reasoned no-op"
  assert_contains "$(cat "${OUT}")" "--force does not bypass cooldown" "--force inside cooldown names cooldown as the reason"
  assert_eq "$(calls_matching '^terraform (plan|apply) ')" "0" "--force inside cooldown plans and applies nothing"
fi
test_end || SUITE_FAILED=1


test_begin "M2: a node-count write failure after a successful apply still records the cooldown"

M2_DIR="${TEST_TMPDIR}/m2"
mkdir -p "${M2_DIR}"
# Real scale-common.sh, with the node-count write forced to fail. record_scale_success must
# still have recorded the cooldown, because the apply has already changed infrastructure.
M2_RC="$(
  export NOMAD_AUTOSCALE_COOLDOWN_FILE="${M2_DIR}/cooldown" \
    NOMAD_AUTOSCALE_NODE_COUNT_FILE="${M2_DIR}/node-count" \
    NOMAD_AUTOSCALE_LOG_FILE="${M2_DIR}/log"
  source "${SCRIPTS_DIR}/scale-common.sh" >/dev/null 2>&1
  write_node_count() { return 1; }
  record_scale_success 2 >/dev/null 2>&1 && echo 0 || echo $?
)"
assert_neq "${M2_RC}" "0" "the failed node-count write is still reported as a failure"
assert_eq "$([[ -s "${M2_DIR}/cooldown" ]] && echo present || echo absent)" "present" \
  "the cooldown file exists after the count-write failure"
assert_eq "$(grep -cE '^[0-9]+$' "${M2_DIR}/cooldown" || true)" "1" \
  "the cooldown file holds an epoch timestamp"
assert_eq "$([[ -e "${M2_DIR}/node-count" ]] && echo present || echo absent)" "absent" \
  "no node count is written when the write fails (the failure is real, not masked)"

# Call-site guard: the demand path must use the ordered helper, not the count write alone.
assert_eq "$(grep -c 'record_scale_success "${target}"' "${SCRIPTS_DIR}/scale-out.sh" || true)" "1" \
  "scale-out.sh records the success through record_scale_success (cooldown first)"
assert_eq "$(grep -c 'write_node_count "${target}"' "${SCRIPTS_DIR}/scale-out.sh" || true)" "0" \
  "scale-out.sh no longer calls write_node_count before the cooldown"

test_end || SUITE_FAILED=1


exit "${SUITE_FAILED:-0}"

