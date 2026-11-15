#!/usr/bin/env bash
# test-maintenance-restart-runtime.sh — Runtime detection and agent stop path in
# maintenance-restart.sh.
#
# Runs the real script with --skip-deploy against a temp HEROBIDS_ROOT and stub
# docker / nomad / curl / sleep on PATH. Covers bug report
# docs/bug-reports/2026/11/15/004-maintenance-restart-exits-silently-after-memory-check.md:
# missing .env keys must not abort the script silently, and a Nomad runtime with
# Nomad unreachable must fail before any agent is marked stopped.
#
# Run: bash infra/hetzner/scripts/tests/test-maintenance-restart-runtime.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${TESTS_DIR}/../maintenance-restart.sh"
source "${TESTS_DIR}/test-harness.sh"

SUITE_FAILED=0
AGENT_ID="11111111-2222-3333-4444-555555555555"

if (( BASH_VERSINFO[0] < 4 )); then
  test_begin "maintenance-restart.sh runtime detection"
  echo "  SKIP: maintenance-restart.sh uses mapfile, which needs bash >= 4; bash ${BASH_VERSION} cannot run it"
  test_end
  exit 0
fi

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

ROOT_DIR="${TEST_TMPDIR}/root"
MOCK_BIN="${TEST_TMPDIR}/bin"
CALLS="${TEST_TMPDIR}/calls.log"
mkdir -p "${ROOT_DIR}" "${MOCK_BIN}"

# ─── Stubs ────────────────────────────────────────────────────────────────────
# Every stub appends one line per call to ${CALLS} so tests can assert on what
# the script did (DB writes, docker stop, nomad job stop).

# docker: `exec herobids-postgres-1 psql ... -c <sql>` answers the script's
# queries (SQL is the last argument); `ps` / `stop` emulate one agent container.
cat > "${MOCK_BIN}/docker" << 'STUB'
#!/usr/bin/env bash
case "$1" in
  exec)
    sql="${*: -1}"
    if [[ "${sql}" == *"UPDATE agent_runtime_sessions"* ]]; then
      echo "pg: mark-stopped" >> "${CALLS}"
    elif [[ "${sql}" == *"WITH claimed"* ]]; then
      echo "pg: queue-start" >> "${CALLS}"
      echo " 1"
    elif [[ "${sql}" == *"= 'live'"* ]]; then
      :  # no live agents
    elif [[ "${sql}" == *"SELECT DISTINCT s.agent_id"* ]]; then
      echo " ${STUB_AGENT_ID}"
    fi
    ;;
  ps)
    if [[ "$*" == *"herobids.agentId=${STUB_AGENT_ID}"* ]]; then
      echo "container-1"
    fi
    ;;
  stop)
    echo "docker stop ${*:2}" >> "${CALLS}"
    ;;
esac
exit 0
STUB

# nomad: `status` exits STUB_NOMAD_STATUS_EXIT; `job stop` records its args.
cat > "${MOCK_BIN}/nomad" << 'STUB'
#!/usr/bin/env bash
if [[ "$1" == "status" ]]; then
  [[ "${STUB_NOMAD_STATUS_EXIT:-0}" == "0" ]] && exit 0
  echo "Error querying jobs: Unexpected response code: 403 (ACL token not found)" >&2
  exit 1
fi
echo "nomad $* token=${NOMAD_TOKEN:-} addr=${NOMAD_ADDR:-}" >> "${CALLS}"
exit 0
STUB

printf '#!/usr/bin/env bash\nexit 0\n' > "${MOCK_BIN}/curl"
printf '#!/usr/bin/env bash\nexit 0\n' > "${MOCK_BIN}/sleep"
chmod +x "${MOCK_BIN}"/*

# A PATH without the nomad stub, for the "CLI not installed" case.
NO_NOMAD_BIN="${TEST_TMPDIR}/bin-no-nomad"
mkdir -p "${NO_NOMAD_BIN}"
cp "${MOCK_BIN}/docker" "${MOCK_BIN}/curl" "${MOCK_BIN}/sleep" "${NO_NOMAD_BIN}/"

# ─── Runner ───────────────────────────────────────────────────────────────────

# write_env <lines...> — replace ${ROOT_DIR}/.env with the given lines.
write_env() {
  printf '%s\n' "$@" > "${ROOT_DIR}/.env"
}

# run_restart [VAR=value ...] — run the script with a clean environment (no
# RUNTIME_BACKEND / NOMAD_* leaking in from the caller's shell).
# Sets RUN_EXIT, RUN_OUTPUT and RUN_CALLS.
run_restart() {
  : > "${CALLS}"
  RUN_EXIT=0
  RUN_OUTPUT="$(env -i \
    PATH="${MOCK_BIN}:${PATH}" \
    HOME="${HOME}" \
    HEROBIDS_ROOT="${ROOT_DIR}" \
    HEROBIDS_ENV=staging \
    CALLS="${CALLS}" \
    STUB_AGENT_ID="${AGENT_ID}" \
    "$@" \
    bash "${SCRIPT}" --skip-deploy 2>&1)" || RUN_EXIT=$?
  RUN_CALLS="$(cat "${CALLS}")"
}

# ═════════════════════════════════════════════════════════════════════════════

test_begin "Docker runtime: .env without RUNTIME_BACKEND / NOMAD_* keys"

write_env "FOO=bar"
run_restart
assert_eq "${RUN_EXIT}" "0" "script exits 0 when the runtime keys are missing"
assert_contains "${RUN_OUTPUT}" "Step 1 — Discovering running agents" "script gets past runtime detection (no silent exit)"
assert_contains "${RUN_OUTPUT}" "Maintenance restart complete" "script runs to completion"
assert_contains "${RUN_CALLS}" "docker stop container-1" "agent container is docker-stopped"
assert_not_contains "${RUN_CALLS}" "nomad job stop" "no Nomad job is stopped"
assert_contains "${RUN_CALLS}" "pg: queue-start" "agent is queued to restart"

rm -f "${ROOT_DIR}/.env"
run_restart
assert_eq "${RUN_EXIT}" "0" "script exits 0 when there is no .env file at all"
assert_contains "${RUN_CALLS}" "docker stop container-1" "missing .env falls back to docker stop"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "Nomad runtime, Nomad reachable"

# Mirrors a real staging .env: no NOMAD_NAMESPACE key (the worker has no env
# override for it). The original script exited silently on that read.
write_env "RUNTIME_BACKEND=nomad" "NOMAD_ADDR=http://10.0.0.2:4646" "NOMAD_TOKEN=test-token"
run_restart
assert_eq "${RUN_EXIT}" "0" "script exits 0 with a complete Nomad .env"
assert_contains "${RUN_OUTPUT}" "Maintenance restart complete" "script runs to completion"
assert_contains "${RUN_CALLS}" "nomad job stop -purge -namespace=herobids-agents agent-${AGENT_ID}" \
  "agent job is purged in the default namespace"
assert_contains "${RUN_CALLS}" "token=test-token addr=http://10.0.0.2:4646" \
  "nomad CLI receives NOMAD_TOKEN and NOMAD_ADDR from .env"
assert_not_contains "${RUN_CALLS}" "docker stop" "no container is docker-stopped"

write_env "RUNTIME_BACKEND=nomad" "NOMAD_ADDR=http://10.0.0.2:4646" "NOMAD_TOKEN=t" "NOMAD_NAMESPACE=other"
run_restart
assert_contains "${RUN_CALLS}" "-namespace=herobids-agents" \
  "a NOMAD_NAMESPACE key in .env is ignored (the worker ignores it too)"

run_restart NOMAD_AGENT_NAMESPACE=custom-agents
assert_contains "${RUN_CALLS}" "-namespace=custom-agents" "NOMAD_AGENT_NAMESPACE overrides the namespace"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "Nomad runtime, Nomad unusable: fail before any agent is stopped"

write_env "RUNTIME_BACKEND=nomad" "NOMAD_ADDR=http://10.0.0.2:4646" "NOMAD_TOKEN=bad-token"
run_restart STUB_NOMAD_STATUS_EXIT=1
assert_neq "${RUN_EXIT}" "0" "script fails when nomad status fails"
assert_contains "${RUN_OUTPUT}" "FAIL RUNTIME_BACKEND=nomad but Nomad cannot be used" "failure says why"
assert_contains "${RUN_OUTPUT}" "ACL token not found" "failure includes the nomad error"
assert_not_contains "${RUN_CALLS}" "pg: mark-stopped" "agents are not marked stopped in the DB"
assert_not_contains "${RUN_CALLS}" "docker stop" "no docker stop fallback"

write_env "RUNTIME_BACKEND=nomad" "NOMAD_TOKEN=t"
run_restart
assert_neq "${RUN_EXIT}" "0" "script fails when NOMAD_ADDR is empty"
assert_contains "${RUN_OUTPUT}" "NOMAD_ADDR is empty" "failure names the empty NOMAD_ADDR"
assert_not_contains "${RUN_CALLS}" "pg: mark-stopped" "agents are not marked stopped (empty NOMAD_ADDR)"

if PATH="/usr/bin:/bin" command -v nomad >/dev/null 2>&1; then
  echo "  SKIP: a real nomad CLI is installed in /usr/bin or /bin, so the missing-CLI case cannot be simulated"
  test_end || SUITE_FAILED=1
  echo ""
  echo "═══ All maintenance-restart runtime test suites complete ═══"
  exit "${SUITE_FAILED}"
fi

write_env "RUNTIME_BACKEND=nomad" "NOMAD_ADDR=http://10.0.0.2:4646" "NOMAD_TOKEN=t"
: > "${CALLS}"
RUN_EXIT=0
RUN_OUTPUT="$(env -i PATH="${NO_NOMAD_BIN}:/usr/bin:/bin" HOME="${HOME}" HEROBIDS_ROOT="${ROOT_DIR}" \
  HEROBIDS_ENV=staging CALLS="${CALLS}" STUB_AGENT_ID="${AGENT_ID}" \
  "${BASH}" "${SCRIPT}" --skip-deploy 2>&1)" || RUN_EXIT=$?
RUN_CALLS="$(cat "${CALLS}")"
assert_neq "${RUN_EXIT}" "0" "script fails when the nomad CLI is missing"
assert_contains "${RUN_OUTPUT}" "nomad CLI is not installed" "failure names the missing CLI"
assert_not_contains "${RUN_CALLS}" "pg: mark-stopped" "agents are not marked stopped (no CLI)"

test_end || SUITE_FAILED=1

echo ""
echo "═══ All maintenance-restart runtime test suites complete ═══"
exit "${SUITE_FAILED}"
