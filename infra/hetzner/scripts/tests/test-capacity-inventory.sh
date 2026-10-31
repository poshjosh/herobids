#!/usr/bin/env bash
# test-capacity-inventory.sh — Reconciled managed inventory: zero, stale-cache,
# down, unjoined, partial-apply and failed-fetch cases for capacity-inventory.sh.
#
# All inputs are synthetic fixtures under tests/fixtures/capacity/. curl and
# nomad_api are replaced by shell functions, so no network call is made.
#
# Run: bash infra/hetzner/scripts/tests/test-capacity-inventory.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

source "${TESTS_DIR}/source-helper.sh"
source "${SCRIPTS_DIR}/capacity-inventory.sh"

FX="${TESTS_DIR}/fixtures/capacity"
NOW=2000
# In-flight records as begin writes them. Readiness counts only observed IDs
# that are ready in Nomad, so an empty server_ids never becomes ready (H5).
# Server 90000002 is synth-agent-2 in cloud-healthy.json.
INFLIGHT_T3='{"schema_version":1,"environment":"synthetic","pool":"synth","target_count":3,"baseline_count":2,"requested_epoch":1000,"deadline_epoch":1600,"server_ids":[]}'
INFLIGHT_T2_NONE='{"schema_version":1,"environment":"synthetic","pool":"synth","target_count":2,"baseline_count":1,"requested_epoch":1000,"deadline_epoch":1600,"server_ids":[]}'
INFLIGHT_T2_OBSERVED='{"schema_version":1,"environment":"synthetic","pool":"synth","target_count":2,"baseline_count":1,"requested_epoch":1000,"deadline_epoch":1600,"server_ids":[90000002]}'

# reconcile_case CLOUD_FILE NOMAD_FILE DECLARED [INFLIGHT_JSON] [NOW]
# Sets RC and OUT. Files are fixture names relative to FX.
reconcile_case() {
  local cloud="$1" nomad="$2" declared="$3" inflight="${4:-}" now="${5:-${NOW}}"
  RC=0
  OUT="$(capacity_reconcile "$(cat "${FX}/${cloud}")" "$(cat "${FX}/${nomad}")" \
    "${declared}" synthetic synth "${now}" "${inflight}")" || RC=$?
}

field() { jq -r "$1" <<< "${OUT}"; }
blockers() { jq -r '.blockers | join(",")' <<< "${OUT}"; }

# ═════════════════════════════════════════════════════════════════════════════
# Reconcile: zero, healthy and stale-cache inputs
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity inventory: zero and healthy pools"

reconcile_case cloud-empty.json nomad-empty.json 0
assert_eq "${RC}" "2" "zero managed with declared 0 is blocked"
assert_contains "$(blockers)" "empty_inventory" "empty inventory raises empty_inventory even at declared 0"
assert_eq "$(field '.managed_count')" "0" "zero managed reports managed_count 0"

reconcile_case cloud-empty.json nomad-empty.json 2
assert_eq "${RC}" "2" "zero managed with declared 2 is blocked"
assert_contains "$(blockers)" "partial_apply" "zero managed with declared 2 raises partial_apply"

reconcile_case cloud-healthy.json nomad-healthy.json 2
assert_eq "${RC}" "0" "healthy pool with declared count matching is consistent"
assert_eq "$(field '.ready_count')" "2" "healthy pool counts two ready servers"
assert_eq "$(field '.not_ready_count')" "0" "healthy pool has no not-ready servers"
assert_eq "$(blockers)" "" "healthy pool has no blockers"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Reconcile: down, unjoined, joined-not-ready and deleting servers
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity inventory: node states"

reconcile_case cloud-healthy.json nomad-mixed.json 2
assert_eq "$(field '.down_count')" "1" "down Nomad node is counted as down"
assert_eq "$(field '.ready_count')" "1" "down Nomad node is not counted as ready"
assert_eq "${RC}" "0" "down managed server does not block when declared matches managed"
assert_eq "$(blockers)" "" "non-pool Nomad node is ignored (no blockers)"

reconcile_case cloud-healthy.json nomad-empty.json 2
assert_eq "$(field '.unjoined_count')" "2" "servers absent from Nomad are counted as unjoined"
assert_eq "$(field '.ready_count')" "0" "unjoined servers are not ready"
assert_eq "${RC}" "2" "unjoined managed servers with no in-flight record are blocked"
assert_contains "$(blockers)" "unjoined_without_record" "unjoined servers with no record raise unjoined_without_record"

reconcile_case cloud-healthy.json nomad-empty.json 2 "${INFLIGHT_T2_NONE}" 1500
assert_eq "${RC}" "0" "unjoined servers under a pending record for their target are consistent"
assert_eq "$(blockers)" "" "unjoined servers under a pending record raise no blocker"

reconcile_case cloud-healthy.json nomad-joined-not-ready.json 2
assert_eq "$(field '.joined_not_ready_count')" "2" "joined but ineligible or initializing nodes are counted"
assert_eq "$(field '.ready_count')" "0" "joined but not ready nodes are not ready"

reconcile_case cloud-mixed.json nomad-healthy.json 3
assert_eq "$(field '.deleting_count')" "1" "deleting server is counted separately"
assert_eq "$(field '.managed_count')" "3" "deleting server is excluded from managed count"
assert_eq "$(field '.servers | map(.name) | join(",")')" "synth-agent-1,synth-agent-2,synth-agent-3" \
  "deleting server is excluded from the server list"
assert_eq "$(field '.unjoined_count')" "1" "booting server absent from Nomad is unjoined"
assert_eq "${RC}" "2" "booting server with no in-flight record is blocked"
assert_contains "$(blockers)" "unjoined_without_record" "booting server with no record raises unjoined_without_record"

reconcile_case cloud-mixed.json nomad-healthy.json 3 "${INFLIGHT_T3}" 1500
assert_eq "${RC}" "0" "booting and deleting servers under a matching pending record are consistent"
assert_eq "$(blockers)" "" "booting and deleting servers under a matching pending record raise no blocker"


test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Reconcile: ownership, index gaps and orphans
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity inventory: ownership and orphans"

reconcile_case cloud-mixed.json nomad-healthy.json 3
assert_not_contains "$(blockers)" "ownership_mismatch" \
  "server in another environment is ignored, not reported as a mismatch"
assert_eq "$(field '.managed_count')" "3" "foreign environment server is not counted as managed"

reconcile_case cloud-mismatch.json nomad-empty.json 2
assert_eq "${RC}" "2" "agent with the wrong role is blocked"
assert_contains "$(blockers)" "ownership_mismatch" "agent with the wrong role raises ownership_mismatch"

reconcile_case cloud-gap.json nomad-empty.json 2
assert_contains "$(blockers)" "noncontiguous_or_duplicate_indices" \
  "gap in server indices raises noncontiguous_or_duplicate_indices"

reconcile_case cloud-healthy.json nomad-orphan-live.json 2
assert_eq "${RC}" "2" "live Nomad node with no cloud server is blocked"
assert_contains "$(blockers)" "orphan_nomad_node" "live orphan raises orphan_nomad_node"

reconcile_case cloud-healthy.json nomad-orphan-down.json 2
assert_eq "${RC}" "0" "down orphan Nomad node does not block"
assert_eq "$(field '.stale_nomad_down_count')" "1" "down orphan is reported as stale_nomad_down_count"
assert_eq "$(blockers)" "" "down orphan raises no blocker"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Reconcile: partial apply and readiness deadline
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity inventory: partial apply and readiness"

reconcile_case cloud-healthy.json nomad-healthy.json 3
assert_eq "${RC}" "2" "declared above managed with no in-flight record is blocked"
assert_contains "$(blockers)" "partial_apply" "declared above managed raises partial_apply"

reconcile_case cloud-healthy.json nomad-healthy.json 1
assert_contains "$(blockers)" "partial_apply" "declared below managed raises partial_apply"

reconcile_case cloud-healthy.json nomad-healthy.json 3 "${INFLIGHT_T3}" 1500
assert_eq "${RC}" "0" "declared above managed with a pending record for that target is consistent"
assert_eq "$(field '.in_flight.state')" "pending" "in-flight record is pending before its deadline"
assert_eq "$(blockers)" "" "pending in-flight record raises no blocker"

reconcile_case cloud-healthy.json nomad-healthy.json 3 "${INFLIGHT_T3}" 1700
assert_eq "${RC}" "2" "in-flight record past its deadline is blocked"
assert_eq "$(field '.in_flight.state')" "expired" "in-flight record past its deadline is expired"
assert_contains "$(blockers)" "readiness_deadline_exceeded" "expired record raises readiness_deadline_exceeded"

reconcile_case cloud-healthy.json nomad-healthy.json 2 "${INFLIGHT_T2_OBSERVED}" 1700
assert_eq "$(field '.in_flight.state')" "ready" "in-flight record is ready once the observed server is ready"
assert_eq "${RC}" "0" "reached in-flight target is consistent even after its deadline"

# H5: the pool already holds two ready nodes, but none was observed by this
# request. They must not satisfy the target of one new node.
reconcile_case cloud-healthy.json nomad-healthy.json 2 "${INFLIGHT_T2_NONE}" 1500
assert_eq "$(field '.ready_count')" "2" "pool has two pre-existing ready nodes"
assert_eq "$(field '.new_ready_count')" "0" "pre-existing ready nodes are not counted as new"
assert_eq "$(field '.in_flight.state')" "pending" "pre-existing ready nodes do not satisfy the target"
assert_eq "${RC}" "0" "pending request with no observed server is not a blocker before its deadline"

reconcile_case cloud-healthy.json nomad-healthy.json 2 "${INFLIGHT_T2_NONE}" 1700
assert_eq "$(field '.in_flight.state')" "expired" "pre-existing ready nodes do not satisfy the target after the deadline"
assert_contains "$(blockers)" "readiness_deadline_exceeded" "unmet target past its deadline is blocked"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Reconcile: invalid and unusable inputs
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity inventory: invalid inputs fail closed"

assert_failure "invalid environment name is rejected" \
  capacity_reconcile "[]" "[]" 0 "Bad Env" synth "${NOW}"
assert_failure "invalid pool name is rejected" \
  capacity_reconcile "[]" "[]" 0 synthetic "Bad Pool" "${NOW}"
assert_failure "negative declared count is rejected" \
  capacity_reconcile "[]" "[]" -1 synthetic synth "${NOW}"
assert_failure "non-numeric declared count is rejected" \
  capacity_reconcile "[]" "[]" two synthetic synth "${NOW}"
assert_failure "non-numeric time is rejected" \
  capacity_reconcile "[]" "[]" 0 synthetic synth soon

# M8: an empty string from a failed fetch must never read as an empty inventory.
RC=0
OUT="$(capacity_reconcile "" "[]" 0 synthetic synth "${NOW}" 2>/dev/null)" || RC=$?
assert_eq "${RC}" "1" "empty cloud string is refused end to end"
assert_eq "${OUT}" "" "empty cloud string prints no snapshot"
RC=0
OUT="$(capacity_reconcile "[]" "" 0 synthetic synth "${NOW}" 2>/dev/null)" || RC=$?
assert_eq "${RC}" "1" "empty Nomad string is refused end to end"
assert_eq "${OUT}" "" "empty Nomad string prints no snapshot"

reconcile_case nomad-not-array.json nomad-empty.json 0
assert_eq "${RC}" "1" "object as cloud input is rejected"

reconcile_case cloud-empty.json nomad-not-array.json 0
assert_eq "${RC}" "1" "non-array Nomad input is rejected"
assert_eq "${OUT}" "" "rejected Nomad input prints no snapshot"

reconcile_case cloud-empty.json nomad-empty.json 0 "$(cat "${FX}/inflight-corrupt.json")"
assert_eq "${RC}" "1" "corrupt in-flight record is rejected"

reconcile_case cloud-empty.json nomad-empty.json 0 "$(cat "${FX}/inflight-unsupported.json")"
assert_eq "${RC}" "1" "unsupported in-flight schema is rejected"

reconcile_case cloud-empty.json nomad-empty.json 0 "$(cat "${FX}/inflight-other-env.json")"
assert_eq "${RC}" "1" "in-flight record from another environment is rejected"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Fetch: GET-only, paginated, fail-closed
# ═════════════════════════════════════════════════════════════════════════════

MOCK_CURL_LOG="${TEST_TMPDIR}/curl-calls"
MOCK_CURL_CONFIG="${TEST_TMPDIR}/curl-config"
MOCK_NOMAD_LOG="${TEST_TMPDIR}/nomad-calls"
export HCLOUD_TOKEN="synthetic-token-not-real"

# Replaces curl. Serves the synthetic Hetzner pages by the page= parameter.
curl() {
  printf '%s\n' "$*" >> "${MOCK_CURL_LOG}"
  # The token is passed through the curl config on stdin, so record that
  # config separately to prove the token is not in argv.
  if [[ " $* " == *" -K - "* ]]; then
    cat >> "${MOCK_CURL_CONFIG}"
  fi
  if [[ "${MOCK_CURL_FAIL:-}" == "true" ]]; then
    return 22
  fi
  local url="${*: -1}"
  if [[ "${MOCK_CURL_ENDLESS:-}" == "true" ]]; then
    local re='[?&]page=([0-9]+)'
    [[ "${url}" =~ $re ]]
    printf '{"servers":[],"meta":{"pagination":{"next_page":%d}}}\n' "$(( BASH_REMATCH[1] + 1 ))"
    return 0
  fi
  if [[ "${url}" == *"page=2"* ]]; then
    cat "${FX}/cloud-page-2.json"
  else
    cat "${FX}/cloud-page-1.json"
  fi
}

# Replaces nomad_api. Serves the fixture named by MOCK_NOMAD_FILE.
nomad_api() {
  printf '%s\n' "$*" >> "${MOCK_NOMAD_LOG}"
  if [[ "${MOCK_NOMAD_FAIL:-}" == "true" ]]; then
    return 1
  fi
  cat "${FX}/${MOCK_NOMAD_FILE:-nomad-healthy.json}"
}

test_begin "capacity inventory: cloud fetch"

rm -f "${MOCK_CURL_LOG}"
FETCHED="$(capacity_fetch_cloud_servers synthetic)"
assert_eq "$(jq 'length' <<< "${FETCHED}")" "3" "fetch follows pagination and returns all three servers"
assert_eq "$(jq -r '.[].name' <<< "${FETCHED}" | paste -sd, -)" \
  "synth-agent-1,synth-agent-2,synth-agent-3" "fetch returns server names in page order"
assert_eq "$(jq -r '.[2].status' <<< "${FETCHED}")" "running" "fetch keeps the server status from the page"
assert_eq "$(jq -r '.[0].address' <<< "${FETCHED}")" "192.0.2.11" "fetch normalises the public IPv4 address"

CALLS="$(cat "${MOCK_CURL_LOG}")"
assert_contains "${CALLS}" "page=2" "fetch requests the second page named by next_page"
assert_contains "${CALLS}" "label_selector=app=herobids,environment=synthetic" \
  "fetch filters by the herobids app and environment labels"
CONFIG="$(cat "${MOCK_CURL_CONFIG}")"
assert_contains "${CONFIG}" "synthetic-token-not-real" "fetch passes the bearer token through the curl config on stdin"
assert_not_contains "${CALLS}" "synthetic-token-not-real" "fetch keeps the bearer token out of curl argv"
assert_not_contains "${CALLS}" " -X " "fetch does not set an HTTP method"
assert_not_contains "${CALLS}" "--request" "fetch does not use --request"
assert_not_contains "${CALLS}" " -d " "fetch sends no request body"

MOCK_CURL_FAIL=true
assert_failure "fetch returns 1 when the Hetzner request fails" capacity_fetch_cloud_servers synthetic
MOCK_CURL_FAIL=""

rm -f "${MOCK_CURL_LOG}"
assert_failure "fetch returns 1 when HCLOUD_TOKEN is unset" \
  bash -c 'unset HCLOUD_TOKEN; source "$1"; capacity_fetch_cloud_servers synthetic' _ "${SCRIPTS_DIR}/capacity-inventory.sh"
assert_eq "$(cat "${MOCK_CURL_LOG}" 2>/dev/null || true)" "" "fetch makes no request when HCLOUD_TOKEN is unset"

# M3: the environment is validated before any URL is built, so a bad name
# never reaches curl.
rm -f "${MOCK_CURL_LOG}"
assert_failure "fetch rejects an environment with spaces" capacity_fetch_cloud_servers "Bad Env"
assert_failure "fetch rejects an environment with a URL-breaking character" capacity_fetch_cloud_servers "synth&x=1"
assert_eq "$(cat "${MOCK_CURL_LOG}" 2>/dev/null || true)" "" "bad environment makes no curl call"

# L2: an endless next_page chain stops at the page cap and fails closed.
rm -f "${MOCK_CURL_LOG}"
MOCK_CURL_ENDLESS=true
assert_failure "fetch refuses an endless pagination chain" capacity_fetch_cloud_servers synthetic
MOCK_CURL_ENDLESS=""
assert_eq "$(wc -l < "${MOCK_CURL_LOG}" | tr -d ' ')" "100" "pagination stops at the page cap of 100 requests"

test_end || SUITE_FAILED=1

test_begin "capacity inventory: Nomad fetch"

rm -f "${MOCK_NOMAD_LOG}"
MOCK_NOMAD_FILE="nomad-healthy.json"
NODES="$(capacity_fetch_nomad_nodes)"
assert_eq "$(jq 'length' <<< "${NODES}")" "2" "Nomad fetch returns the node array"
assert_eq "$(cat "${MOCK_NOMAD_LOG}")" "GET /v1/nodes" "Nomad fetch is a single GET of /v1/nodes"

MOCK_NOMAD_FILE="nomad-not-array.json"
assert_failure "Nomad fetch rejects a non-array response" capacity_fetch_nomad_nodes

MOCK_NOMAD_FILE="nomad-healthy.json"
MOCK_NOMAD_FAIL=true
assert_failure "Nomad fetch returns 1 when the request fails" capacity_fetch_nomad_nodes
MOCK_NOMAD_FAIL=""

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# End to end: fetched inputs reconcile to the expected verdict
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity inventory: fetched inputs reconcile"

MOCK_NOMAD_FILE="nomad-healthy.json"
CLOUD_JSON="$(capacity_fetch_cloud_servers synthetic)"
NOMAD_JSON="$(capacity_fetch_nomad_nodes)"
RC=0
OUT="$(capacity_reconcile "${CLOUD_JSON}" "${NOMAD_JSON}" 3 synthetic synth "${NOW}")" || RC=$?
assert_eq "$(field '.managed_count')" "3" "fetched pages reconcile to three managed servers"
assert_eq "$(field '.unjoined_count')" "1" "fetched server absent from Nomad is unjoined"
assert_eq "${RC}" "2" "fetched server absent from Nomad with no in-flight record is blocked"
assert_contains "$(blockers)" "unjoined_without_record" "fetched unjoined server raises unjoined_without_record"

RC=0
OUT="$(capacity_reconcile "${CLOUD_JSON}" "${NOMAD_JSON}" 3 synthetic synth 1500 "${INFLIGHT_T3}")" || RC=$?
assert_eq "${RC}" "0" "fetched inventory with declared 3 under a matching pending record is consistent"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Scale gate: an unjoined server refuses and names the clear procedure
# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity inventory: scale gate refuses an unjoined server"

GATE_FILE="${TEST_TMPDIR}/gate-inflight.json"
GATE_ERR="${TEST_TMPDIR}/gate-stderr"
# Three managed cloud servers; the shared healthy Nomad fixture joins only two.
CLOUD_THREE="${TEST_TMPDIR}/cloud-three.json"
jq '. + [(.[0] | .id = 90000003 | .name = "synth-agent-3" | .address = "192.0.2.13")]' \
  "${FX}/cloud-healthy.json" > "${CLOUD_THREE}"

# gate_run MUTATE NOW — runs the gate in a subshell with the fetches replaced by
# the three-server cloud inventory and the two-node Nomad fixture, so one
# server is unjoined.
gate_run() {
  local mutate="$1" now="$2"
  GATE_RC=0
  GATE_OUT="$(
    export NOMAD_AUTOSCALE_INFLIGHT_FILE="${GATE_FILE}"
    capacity_fetch_cloud_servers() { cat "${CLOUD_THREE}"; }
    capacity_fetch_nomad_nodes() { cat "${FX}/nomad-healthy.json"; }
    capacity_scale_gate synthetic synth "${now}" "${mutate}" 2>"${GATE_ERR}"
  )" || GATE_RC=$?
}

printf '%s\n' "${INFLIGHT_T3}" > "${GATE_FILE}"
gate_run false "${NOW}"
assert_eq "${GATE_RC}" "3" "expired record with an unjoined server refuses (exit 3)"
assert_contains "$(jq -r '.blockers | join(",")' <<< "${GATE_OUT}")" "readiness_deadline_exceeded" \
  "expired record raises readiness_deadline_exceeded"
assert_contains "$(cat "${GATE_ERR}")" "Clearing a blocked scale guard" \
  "refusal names the clear procedure"
assert_contains "$(cat "${GATE_ERR}")" "setup-auto-scaling.md" \
  "refusal points to the operator doc"
assert_eq "$(test -e "${GATE_FILE}" && echo present || echo absent)" "present" \
  "a read-only run leaves the expired record in place"

gate_run true "${NOW}"
assert_eq "${GATE_RC}" "3" "MUTATE=true still refuses while the server is unjoined"
assert_eq "$(test -e "${GATE_FILE}" && echo present || echo absent)" "absent" \
  "MUTATE=true clears the expired record"

gate_run true "${NOW}"
assert_eq "${GATE_RC}" "3" "with no record, the unjoined server still refuses (exit 3)"
assert_contains "$(jq -r '.blockers | join(",")' <<< "${GATE_OUT}")" "unjoined_without_record" \
  "no record raises unjoined_without_record"
assert_contains "$(cat "${GATE_ERR}")" "Clearing a blocked scale guard" \
  "the no-record refusal names the clear procedure"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══ Capacity inventory suite complete ═══"
exit "${SUITE_FAILED:-0}"
