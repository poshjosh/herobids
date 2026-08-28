#!/usr/bin/env bash
# test-nomad-token.sh — Unit tests for Nomad ACL token behavior in
# nomad_api() and related helpers from scale-common.sh.
#
# Validates W4 (Nomad ACL alignment): token is sent when configured,
# omitted when absent, and shell scripts behave gracefully either way.
#
# Run: bash infra/hetzner/scripts/tests/test-nomad-token.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

# ─── Setup / teardown ─────────────────────────────────────────────────────────

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

# Source scale-common.sh with safe temp paths.
source "${TESTS_DIR}/source-helper.sh"

SUITE_FAILED=0

# ─── Mock curl ─────────────────────────────────────────────────────────────────
# Create a fake curl that records all arguments to a file and returns a
# successful HTTP response. This lets us inspect exactly which headers
# nomad_api() passes without making real network calls.

MOCK_BIN_DIR="${TEST_TMPDIR}/mock-bin"
mkdir -p "${MOCK_BIN_DIR}"

create_curl_mock() {
  local http_code="${1:-200}"
  local body="${2:-'{}'}"

  cat > "${MOCK_BIN_DIR}/curl" << CURLMOCK
#!/usr/bin/env bash
# Record all arguments
printf '%s\n' "\$@" > "${TEST_TMPDIR}/curl-args"
# Return body + http code (nomad_api reads last line as status)
echo '${body}'
echo '${http_code}'
CURLMOCK
  chmod +x "${MOCK_BIN_DIR}/curl"
}

# Helper: run nomad_api in a subshell with the mock curl on PATH.
# Sets RUN_OUTPUT and RUN_EXIT, and populates CURL_ARGS with recorded args.
CURL_ARGS=""
run_nomad_api() {
  local extra_env=("$@")

  # Reset recorded args
  : > "${TEST_TMPDIR}/curl-args" 2>/dev/null || true

  RUN_EXIT=0
  RUN_OUTPUT="$(
    {
      export PATH="${MOCK_BIN_DIR}:${PATH}"
      export TEST_TMPDIR="${TEST_TMPDIR}"

      for ev in "${extra_env[@]+"${extra_env[@]}"}"; do
        export "${ev?}"
      done

      source "${TESTS_DIR}/source-helper.sh"

      # Re-apply env overrides after sourcing
      export PATH="${MOCK_BIN_DIR}:${PATH}"
      for ev in "${extra_env[@]+"${extra_env[@]}"}"; do
        export "${ev?}"
      done

      nomad_api GET "/v1/nodes"
    } 2>&1
  )" || RUN_EXIT=$?

  CURL_ARGS="$(cat "${TEST_TMPDIR}/curl-args" 2>/dev/null || echo "")"
}

# ═════════════════════════════════════════════════════════════════════════════
# nomad_api — token header behavior
# ═════════════════════════════════════════════════════════════════════════════

test_begin "nomad_api — X-Nomad-Token header"

create_curl_mock 200 '[]'

# --- Sends X-Nomad-Token when NOMAD_TOKEN is set ---

run_nomad_api "NOMAD_TOKEN=test-secret-token-abc123"
assert_eq "${RUN_EXIT}" "0" "nomad_api succeeds with NOMAD_TOKEN set"
assert_contains "${CURL_ARGS}" "X-Nomad-Token: test-secret-token-abc123" \
  "curl args include X-Nomad-Token header with correct value"
assert_contains "${CURL_ARGS}" "-H" \
  "curl args include -H flag for auth header"

# --- Does NOT send X-Nomad-Token when NOMAD_TOKEN is empty ---

run_nomad_api "NOMAD_TOKEN="
assert_eq "${RUN_EXIT}" "0" "nomad_api succeeds with empty NOMAD_TOKEN"
assert_not_contains "${CURL_ARGS}" "X-Nomad-Token" \
  "curl args do NOT include X-Nomad-Token when NOMAD_TOKEN is empty"

# --- Does NOT send X-Nomad-Token when NOMAD_TOKEN is unset ---

RUN_EXIT=0
: > "${TEST_TMPDIR}/curl-args" 2>/dev/null || true
RUN_OUTPUT="$(
  {
    export PATH="${MOCK_BIN_DIR}:${PATH}"
    export TEST_TMPDIR="${TEST_TMPDIR}"

    unset NOMAD_TOKEN 2>/dev/null || true
    source "${TESTS_DIR}/source-helper.sh"
    export PATH="${MOCK_BIN_DIR}:${PATH}"
    unset NOMAD_TOKEN 2>/dev/null || true

    nomad_api GET "/v1/nodes"
  } 2>&1
)" || RUN_EXIT=$?
CURL_ARGS="$(cat "${TEST_TMPDIR}/curl-args" 2>/dev/null || echo "")"

assert_eq "${RUN_EXIT}" "0" "nomad_api succeeds with unset NOMAD_TOKEN"
assert_not_contains "${CURL_ARGS}" "X-Nomad-Token" \
  "curl args do NOT include X-Nomad-Token when NOMAD_TOKEN is unset"

# --- Always passes the HTTP method ---

run_nomad_api "NOMAD_TOKEN=some-token"
assert_contains "${CURL_ARGS}" "-X" "curl args include -X method flag"
assert_contains "${CURL_ARGS}" "GET" "curl args include GET method"

# --- Always includes the constructed URL ---

run_nomad_api "NOMAD_TOKEN=tk" "NOMAD_ADDR=http://10.0.0.2:4646"
assert_contains "${CURL_ARGS}" "http://10.0.0.2:4646/v1/nodes" \
  "curl args include the full Nomad API URL"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# nomad_api — HTTP error handling
# ═════════════════════════════════════════════════════════════════════════════

test_begin "nomad_api — HTTP status handling"

# --- Returns body on 2xx ---

create_curl_mock 200 '{"nodes": []}'
run_nomad_api "NOMAD_TOKEN=t"
assert_eq "${RUN_EXIT}" "0" "returns 0 on HTTP 200"
assert_contains "${RUN_OUTPUT}" '{"nodes": []}' "output includes response body on success"

# --- Fails on 403 (ACL denied) ---

create_curl_mock 403 '{"error": "Permission denied"}'
run_nomad_api "NOMAD_TOKEN=bad-token"
assert_neq "${RUN_EXIT}" "0" "returns non-zero on HTTP 403"
assert_contains "${RUN_OUTPUT}" "403" "output includes HTTP status code 403"

# --- Fails on 500 (server error) ---

create_curl_mock 500 '{"error": "internal"}'
run_nomad_api "NOMAD_TOKEN=t"
assert_neq "${RUN_EXIT}" "0" "returns non-zero on HTTP 500"
assert_contains "${RUN_OUTPUT}" "500" "output includes HTTP status code 500"

# --- Fails on 401 (unauthenticated) ---

create_curl_mock 401 '{"error": "missing token"}'
run_nomad_api "NOMAD_TOKEN="
assert_neq "${RUN_EXIT}" "0" "returns non-zero on HTTP 401"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# current_agent_node_count — token in fallback path
# ═════════════════════════════════════════════════════════════════════════════

test_begin "current_agent_node_count — Nomad API fallback includes token"

# When the node-count state file is missing, current_agent_node_count falls
# back to the Nomad API. Verify that this fallback path also uses the token.

# Remove the state file so the function hits the curl fallback
rm -f "${NOMAD_AUTOSCALE_NODE_COUNT_FILE}"

# Create a curl mock that returns a valid node list
create_curl_mock 200 '[{"Status":"ready"},{"Status":"ready"}]'

# We need a jq mock too since current_agent_node_count uses jq
MOCK_JQ_DIR="${TEST_TMPDIR}/mock-jq-bin"
mkdir -p "${MOCK_JQ_DIR}"
cat > "${MOCK_JQ_DIR}/jq" << 'JQMOCK'
#!/usr/bin/env bash
echo "2"
JQMOCK
chmod +x "${MOCK_JQ_DIR}/jq"

: > "${TEST_TMPDIR}/curl-args" 2>/dev/null || true
RUN_EXIT=0
RUN_OUTPUT="$(
  {
    export PATH="${MOCK_BIN_DIR}:${MOCK_JQ_DIR}:${PATH}"
    export NOMAD_TOKEN="fallback-test-token"
    export TEST_TMPDIR="${TEST_TMPDIR}"

    source "${TESTS_DIR}/source-helper.sh"

    export PATH="${MOCK_BIN_DIR}:${MOCK_JQ_DIR}:${PATH}"
    export NOMAD_TOKEN="fallback-test-token"
    rm -f "${NOMAD_AUTOSCALE_NODE_COUNT_FILE}"

    current_agent_node_count
  } 2>&1
)" || RUN_EXIT=$?
CURL_ARGS="$(cat "${TEST_TMPDIR}/curl-args" 2>/dev/null || echo "")"

assert_contains "${CURL_ARGS}" "X-Nomad-Token: fallback-test-token" \
  "fallback curl call includes the token header"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# nomad_api — missing token in ACL scenario does not crash the script
# ═════════════════════════════════════════════════════════════════════════════

test_begin "nomad_api — graceful behavior without token"

# The Nomad server returns 403 when ACLs are enabled and no token is sent.
# The script should not crash — it returns a non-zero exit code that callers
# can handle. The important thing is that the function itself is callable
# without NOMAD_TOKEN set.

create_curl_mock 403 '{"error": "Permission denied"}'

RUN_EXIT=0
RUN_OUTPUT="$(
  {
    export PATH="${MOCK_BIN_DIR}:${PATH}"
    export TEST_TMPDIR="${TEST_TMPDIR}"

    unset NOMAD_TOKEN 2>/dev/null || true
    source "${TESTS_DIR}/source-helper.sh"
    export PATH="${MOCK_BIN_DIR}:${PATH}"
    unset NOMAD_TOKEN 2>/dev/null || true

    nomad_api GET "/v1/nodes"
  } 2>&1
)" || RUN_EXIT=$?

assert_neq "${RUN_EXIT}" "0" "returns non-zero when server returns 403"
# The key property: the function completed and returned an error code
# rather than causing a set -e crash before the caller could handle it.
assert_contains "${RUN_OUTPUT}" "403" "error output mentions the 403 status"
assert_contains "${RUN_OUTPUT}" "ERROR" "error output includes ERROR prefix"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══ All nomad-token test suites complete ═══"
exit "${SUITE_FAILED}"
