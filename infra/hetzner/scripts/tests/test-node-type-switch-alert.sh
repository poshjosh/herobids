#!/usr/bin/env bash
# test-node-type-switch-alert.sh — decision + rate-limit tests for check-node-type-switch.sh.
# Stubs curl (the transport nomad_api uses) to return canned node/jobs counts. No network.
#
# Run: bash infra/hetzner/scripts/tests/test-node-type-switch-alert.sh

set -uo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(dirname "${TESTS_DIR}")"
source "${TESTS_DIR}/test-harness.sh"
CHECK="${SCRIPTS_DIR}/check-node-type-switch.sh"
TMP="$(create_test_tmpdir)"
trap 'rm -rf "${TMP}"' EXIT
SUITE_FAILED=0

MOCK_BIN="${TMP}/bin"
mkdir -p "${MOCK_BIN}"

# curl stub: returns N ready agent nodes for /v1/nodes and M running agent jobs for /v1/jobs.
# N and M come from env NODES / AGENTS. nomad_api appends an HTTP-code trailer convention? No —
# scale-common nomad_api parses the body then a separate http_code via -w; emulate both by
# honouring -w "%{http_code}" (print body then 200) the way the real curl would with -s -w.
# Quoted heredoc: the stub reads NODES/AGENTS from its OWN environment at exec time (passed
# through by run_check), not baked in at write time.
cat > "${MOCK_BIN}/curl" <<'STUB'
#!/usr/bin/env bash
url=""
for a in "$@"; do url="$a"; done
if [[ "$url" == *"/v1/nodes"* ]]; then
  arr="["; for i in $(seq 1 "${NODES:-0}"); do [[ $i -gt 1 ]] && arr+=","; arr+='{"NodeClass":"agent","Status":"ready"}'; done; arr+="]"
  printf '%s\n200' "$arr"
elif [[ "$url" == *"/v1/jobs"* ]]; then
  arr="["; for i in $(seq 1 "${AGENTS:-0}"); do [[ $i -gt 1 ]] && arr+=","; arr+='{"ID":"agent-x'"$i"'","Status":"running"}'; done; arr+="]"
  printf '%s\n200' "$arr"
else
  printf '%s\n200' "[]"
fi
exit 0
STUB
chmod +x "${MOCK_BIN}/curl"

VAR_FILE="${TMP}/staging.tfvars"
echo 'agent_node_server_type = "cx23"' > "${VAR_FILE}"

run_check() { # reads NODES / AGENTS / *_THRESHOLD from the environment -> sets OUT
  OUT="$(env PATH="${MOCK_BIN}:${PATH}" \
    HEROBIDS_ENV=staging TERRAFORM_DIR="${TMP}" NOMAD_ADDR="http://127.0.0.1:4646" \
    NOMAD_AUTOSCALE_LOG_FILE="${TMP}/log" \
    NODE_SWITCH_ALERT_FILE="${TMP}/switch-stamp" \
    NODE_SWITCH_THRESHOLD="${NODE_SWITCH_THRESHOLD:-60}" \
    AGENT_SWITCH_THRESHOLD="${AGENT_SWITCH_THRESHOLD:-750}" \
    NODES="${NODES:-0}" AGENTS="${AGENTS:-0}" \
    bash "${CHECK}" --dry-run 2>&1)" || true
}

test_begin "node-type switch alert: trigger decision"

NODES=10 AGENTS=50 run_check
assert_contains "${OUT}" "Below the switch threshold" "well under thresholds: no alert"

NODES=60 AGENTS=50 run_check
assert_contains "${OUT}" "Would send" "60 nodes reaches the node threshold -> would alert"
assert_contains "${OUT}" "nodes (60 >= 60)" "the node trigger is named"

NODES=5 AGENTS=800 run_check
assert_contains "${OUT}" "Would send" "800 agents reaches the agent threshold -> would alert"
assert_contains "${OUT}" "agents (800 >= 750)" "the agent trigger is named"

test_end || SUITE_FAILED=1

test_begin "node-type switch alert: only while on the small type"

echo 'agent_node_server_type = "cx53"' > "${VAR_FILE}"
NODES=90 AGENTS=5000 run_check
assert_contains "${OUT}" "not applicable" "once on cx53 the reminder is silent even above thresholds"
echo 'agent_node_server_type = "cx23"' > "${VAR_FILE}"

test_end || SUITE_FAILED=1

test_begin "node-type switch alert: rate-limit stamp suppresses repeats"

# Real (non-dry-run) send writes the stamp via the logger fallback (no SMTP configured).
env PATH="${MOCK_BIN}:${PATH}" HEROBIDS_ENV=staging TERRAFORM_DIR="${TMP}" \
  NOMAD_ADDR="http://127.0.0.1:4646" NOMAD_AUTOSCALE_LOG_FILE="${TMP}/log" \
  NODE_SWITCH_ALERT_FILE="${TMP}/switch-stamp" NODES=70 AGENTS=50 \
  bash "${CHECK}" >/dev/null 2>&1 || true
assert_eq "$([[ -f "${TMP}/switch-stamp" ]] && echo yes || echo no)" "yes" "a real send writes the rate-limit stamp"

# Immediately re-run: should be suppressed by the stamp.
NODES=70 AGENTS=50 run_check
assert_contains "${OUT}" "already sent" "a second run within the window is suppressed"

test_end || SUITE_FAILED=1

exit "${SUITE_FAILED}"
