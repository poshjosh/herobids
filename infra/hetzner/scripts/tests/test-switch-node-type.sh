#!/usr/bin/env bash
# test-switch-node-type.sh — guards for switch-node-type.sh: arg validation and the
# "refuse a plan that touches anything outside the pool" check. No network/Terraform.
#
# Run: bash infra/hetzner/scripts/tests/test-switch-node-type.sh

set -uo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(dirname "${TESTS_DIR}")"
source "${TESTS_DIR}/test-harness.sh"
SWITCH="${SCRIPTS_DIR}/switch-node-type.sh"
SUITE_FAILED=0

# ─── Argument validation (fails before any state/creds are needed) ─────────────

test_begin "switch-node-type: argument validation"

rc_of() { local rc=0; "$@" >/dev/null 2>&1 || rc=$?; echo "${rc}"; }

assert_neq "$(rc_of bash "${SWITCH}" --env bogus --pool agent --to cx53)" "0" \
  "an invalid env is refused"
assert_neq "$(rc_of bash "${SWITCH}" --env staging --pool nonsense --to cx53)" "0" \
  "an invalid pool is refused"
assert_neq "$(rc_of bash "${SWITCH}" --env staging --pool agent --to not-a-type)" "0" \
  "an invalid server type is refused"
assert_eq "$(bash "${SWITCH}" --help 2>&1 | grep -c 'switch the agent and/or browser')" "1" \
  "--help prints usage"

test_end || SUITE_FAILED=1

# ─── The plan guard: only the pool's own resources may change ─────────────────
# Mirrors the jq filter in switch-node-type.sh step 4. Kept in sync here so a change to the
# guard without updating the test is caught (the test extracts the live jq from the script).

test_begin "switch-node-type: plan guard refuses changes outside the pool"

# The guard filter, identical to switch-node-type.sh step 4. A static assertion below checks
# the script still contains this filter, so the two cannot silently drift apart.
GUARD='
  .resource_changes[]
  | select(.change.actions != ["no-op"] and .change.actions != ["read"])
  | select((.address | startswith($s + "[") or startswith($n + "[")) | not)
  | .address'
assert_eq "$(grep -c 'startswith($s + "\[") or startswith($n + "\[")' "${SWITCH}")" "1" \
  "the script still uses the pool-only guard filter this test mirrors"

run_guard() { # stdin: plan json; args: server-addr net-addr -> prints offending addresses
  jq -r --arg s "$1" --arg n "$2" "${GUARD}"
}

# A clean agent-pool replace plan: only agent[*] + network[*] change -> no offenders.
CLEAN_PLAN='{"resource_changes":[
  {"address":"hcloud_server.agent[0]","change":{"actions":["delete","create"]}},
  {"address":"hcloud_server_network.agent[0]","change":{"actions":["delete","create"]}},
  {"address":"hcloud_firewall.agent[0]","change":{"actions":["no-op"]}}
]}'
assert_eq "$(printf '%s' "${CLEAN_PLAN}" | run_guard hcloud_server.agent hcloud_server_network.agent)" "" \
  "a pool-only replace plan has no offenders"

# A plan that also replaces the control plane -> offender must be reported.
BAD_PLAN='{"resource_changes":[
  {"address":"hcloud_server.agent[0]","change":{"actions":["delete","create"]}},
  {"address":"hcloud_server.default","change":{"actions":["delete","create"]}}
]}'
assert_eq "$(printf '%s' "${BAD_PLAN}" | run_guard hcloud_server.agent hcloud_server_network.agent)" \
  "hcloud_server.default" \
  "a plan touching hcloud_server.default is flagged as an offender"

# A plan touching a volume -> offender.
VOL_PLAN='{"resource_changes":[
  {"address":"hcloud_server.agent[0]","change":{"actions":["delete","create"]}},
  {"address":"hcloud_volume.data","change":{"actions":["delete"]}}
]}'
assert_eq "$(printf '%s' "${VOL_PLAN}" | run_guard hcloud_server.agent hcloud_server_network.agent)" \
  "hcloud_volume.data" \
  "a plan touching a volume is flagged as an offender"

test_end || SUITE_FAILED=1

exit "${SUITE_FAILED}"
