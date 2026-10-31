#!/usr/bin/env bash
# test-capacity-controller.sh — the demand-aware controller library (capacity-controller.sh):
# decision matrix (plan 5.6), the ready==0 cross-check (7a), the saved-plan allowlist (5.7),
# failure backoff and the consecutive-observation streak. Every plan JSON is SYNTHETIC and
# UNVERIFIED against the real `terraform show -json` shape; see fixtures/capacity/README.md.
#
# Run: bash infra/hetzner/scripts/tests/test-capacity-controller.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

source "${TESTS_DIR}/source-helper.sh"
source "${SCRIPTS_DIR}/capacity-demand.sh"
source "${SCRIPTS_DIR}/capacity-controller.sh"

FIX="${TESTS_DIR}/fixtures/capacity"
PLAN="${FIX}/plan-create-agent.json"

CONTROLLER_FAILURE_FILE="${TEST_TMPDIR}/state/last-failure"
CONTROLLER_STREAK_FILE="${TEST_TMPDIR}/state/streak"

# Base controller input: an empty, healthy pool with a 4096 MB / 2000 MHz template.
BASE_INPUT='{"floor":0,"cap":5,"increment_max":2,"pool_count":0,"live_managed":0,"active":0,
  "viable_inflight":0,"unavailable":0,"template":{"memory_mb":4096,"cpu_mhz":2000},
  "cooldown_active":false,"failure_backoff_active":false,"headroom_pressure":false,
  "classification_usable":true,"bins":[],"items":[]}'

# decide OVERRIDES_JSON — merges overrides into the base input and prints the decision.
decide() {
  jq -c --argjson o "$1" '. + $o' <<< "${BASE_INPUT}" | controller_decide
}

# rc_of COMMAND... — exit status without aborting the suite.
rc_of() {
  ( "$@" ) >/dev/null 2>&1 && echo 0 || echo $?
}

# ─── Decision matrix (5.6) ────────────────────────────────────────────────────

D="$(decide '{"floor":2}')"
assert_eq "$(jq -r '.nodes_to_add' <<< "${D}")" "2" "floor deficit only: adds the floor deficit"
assert_contains "$(jq -r '.reasons | join(",")' <<< "${D}")" "floor_deficit" "floor deficit only: reason recorded"

D="$(decide '{"active":1,"pool_count":1,"live_managed":1,"bins":[{"id":"a","kind":"actual","free_memory_mb":0,"free_cpu_mhz":0}],"items":[{"key":"j1","class":"backlog","mature":true,"memory_mb":1024,"cpu_mhz":500,"count":3}]}')"
assert_eq "$(jq -r '.nodes_to_add' <<< "${D}")" "1" "backlog only: 3 slots of 1024 MB need one new node"
assert_contains "$(jq -r '.reasons | join(",")' <<< "${D}")" "backlog" "backlog only: reason recorded"

D="$(decide '{"active":1,"pool_count":1,"live_managed":1,"headroom_pressure":true,"bins":[{"id":"a","kind":"actual","free_memory_mb":0,"free_cpu_mhz":0}],"items":[{"key":"h1","class":"headroom","mature":true,"memory_mb":512,"cpu_mhz":100,"count":1}]}')"
assert_eq "$(jq -r '.nodes_to_add' <<< "${D}")" "1" "headroom only: slot-sized headroom adds one node"
assert_contains "$(jq -r '.reasons | join(",")' <<< "${D}")" "headroom" "headroom only: reason recorded"

# Combined: the two floor bins absorb the backlog, so the adds are not counted twice (7c).
D="$(decide '{"floor":2,"items":[{"key":"j1","class":"backlog","mature":true,"memory_mb":1024,"cpu_mhz":500,"count":4}]}')"
assert_eq "$(jq -r '.nodes_to_add' <<< "${D}")" "2" "combined: floor bins simulated, backlog adds nothing extra"
assert_eq "$(jq -r '.fit.new_nodes_needed' <<< "${D}")" "0" "combined: backlog fits the simulated floor bins"

# Recovery: floor 1, the only managed node is unavailable, nothing viable in flight.
D="$(decide '{"floor":1,"pool_count":1,"live_managed":1,"unavailable":1}')"
assert_eq "$(jq -r '.nodes_to_add' <<< "${D}")" "1" "recovery: one unavailable node and floor 1 requests one node"
assert_contains "$(jq -r '.reasons | join(",")' <<< "${D}")" "recovery" "recovery: reason recorded"

# Floor 0 with zero free percentage and no demand creates nothing (slot pressure only).
D="$(decide '{"active":2,"pool_count":2,"live_managed":2,"bins":[{"id":"a","kind":"actual","free_memory_mb":0,"free_cpu_mhz":0}]}')"
assert_eq "$(jq -r '.action' <<< "${D}")" "noop" "floor 0 with no demand: no-op"
assert_eq "$(jq -r '.nodes_to_add' <<< "${D}")" "0" "floor 0 with no demand: zero additions"

# Cap clamp: one slot of cap headroom remains, so the floor deficit is clamped to 1.
D="$(decide '{"floor":3,"cap":2,"active":1,"pool_count":1,"live_managed":1,"bins":[{"id":"a","kind":"actual","free_memory_mb":0,"free_cpu_mhz":0}]}')"
assert_eq "$(jq -r '.nodes_to_add' <<< "${D}")" "1" "cap clamp: adds only the remaining headroom"
assert_eq "$(jq -r '.target_count' <<< "${D}")" "2" "cap clamp: target is pool count plus additions"
assert_contains "$(jq -r '.reasons | join(",")' <<< "${D}")" "cap_clamped" "cap clamp: reason recorded"

# Batch clamp: the increment never exceeds the batch limit of 2.
D="$(decide '{"floor":5}')"
assert_eq "$(jq -r '.nodes_to_add' <<< "${D}")" "2" "batch clamp: additions never exceed increment_max"
assert_contains "$(jq -r '.reasons | join(",")' <<< "${D}")" "batch_clamped" "batch clamp: reason recorded"

D="$(decide '{"floor":2,"cooldown_active":true}')"
assert_eq "$(jq -r '.nodes_to_add' <<< "${D}")" "0" "cooldown active: no addition"
assert_contains "$(jq -r '.reasons | join(",")' <<< "${D}")" "cooldown_active" "cooldown active: reason recorded"

D="$(decide '{"floor":2,"failure_backoff_active":true}')"
assert_eq "$(jq -r '.nodes_to_add' <<< "${D}")" "0" "failure backoff: no addition"
assert_contains "$(jq -r '.reasons | join(",")' <<< "${D}")" "failure_backoff_active" "failure backoff: reason recorded"

# In-flight subtraction: a viable pending node already covers the floor.
D="$(decide '{"floor":2,"active":1,"viable_inflight":1,"pool_count":2,"live_managed":2}')"
assert_eq "$(jq -r '.floor_deficit' <<< "${D}")" "0" "in-flight: viable pending node reduces floor deficit"
assert_eq "$(jq -r '.nodes_to_add' <<< "${D}")" "0" "in-flight: no second node for the same floor slot"

# Unusable classification drops backlog but keeps the floor.
D="$(decide '{"classification_usable":false,"items":[{"key":"j1","class":"backlog","mature":true,"memory_mb":1024,"cpu_mhz":500,"count":3}]}')"
assert_eq "$(jq -r '.nodes_to_add' <<< "${D}")" "0" "classification unusable: backlog ignored"
assert_contains "$(jq -r '.reasons | join(",")' <<< "${D}")" "classification_unusable" "classification unusable: reason recorded"

# ─── Zero-ready cross-check (7a) ──────────────────────────────────────────────

assert_eq "$(controller_ready_crosscheck 2 2 2)" "ready" "cross-check: ready nodes agree"
assert_eq "$(controller_ready_crosscheck 0 0 0)" "capacity_blocked" "cross-check: no ready and no managed is capacity_blocked"
assert_eq "$(controller_ready_crosscheck 0 0 3)" "dead_pool" "cross-check: no ready but managed servers is dead_pool"
assert_eq "$(rc_of controller_ready_crosscheck 0 1 2)" "1" "cross-check: check says zero ready but inventory says ready fails closed"
assert_eq "$(rc_of controller_ready_crosscheck 3 0 0)" "1" "cross-check: check says ready but inventory says zero fails closed"

# ─── Saved-plan allowlist (5.7) ───────────────────────────────────────────────

# plan_rc JQ_MUTATION CURRENT EXPECTED CAP [SERVER_NAME SERVER_TYPE LOCATION ENVIRONMENT] — applies a
# jq mutation to the fixture plan and runs the allowlist on it. Prints the exit status (0 = allowlist_ok,
# otherwise non-zero). The expected inputs default to the fixture values; an explicit empty string is
# passed through (\${5-...}, not \${5:-...}) so the fail-closed empty case can be tested.
plan_rc() {
  local sn="${5-herobids}" st="${6-cpx21}" loc="${7-nbg1}" env="${8-staging}"
  ( jq "$1" "${PLAN}" | controller_plan_allowlist "$2" "$3" "$4" "${sn}" "${st}" "${loc}" "${env}" ) >/dev/null 2>&1 && echo 0 || echo $?
}

assert_eq "$(plan_rc '.' 2 1 5)" "0" "allowlist: accepts create-only agent[2] server and network"

assert_eq "$(plan_rc '.resource_changes[0].change.actions = ["delete"]' 2 1 5)" "1" "allowlist: rejects a server delete"
assert_eq "$(plan_rc '.resource_changes[0].change.actions = ["delete","create"]' 2 1 5)" "1" "allowlist: rejects a server replace"
assert_eq "$(plan_rc '.resource_changes[0].change.actions = ["update"]' 2 1 5)" "1" "allowlist: rejects an in-place update"

assert_eq "$(plan_rc '.resource_changes += [{"address":"hcloud_firewall.web","mode":"managed","type":"hcloud_firewall","name":"web","index":null,"change":{"actions":["create"]}}]' 2 1 5)" "1" "allowlist: rejects an unrelated create"
assert_eq "$(plan_rc '.resource_changes += [{"address":"hcloud_server.control","mode":"managed","type":"hcloud_server","name":"control","index":null,"change":{"actions":["create"]}}]' 2 1 5)" "1" "allowlist: rejects a control plane create"
assert_eq "$(plan_rc '.resource_changes += [{"address":"hcloud_ssh_key.ops","mode":"managed","type":"hcloud_ssh_key","name":"ops","index":null,"change":{"actions":["create"]}}]' 2 1 5)" "1" "allowlist: rejects an SSH key create"
assert_eq "$(plan_rc '.resource_changes += [{"address":"cloudflare_record.agent","mode":"managed","type":"cloudflare_record","name":"agent","index":null,"change":{"actions":["create"]}}]' 2 1 5)" "1" "allowlist: rejects a DNS create"
assert_eq "$(plan_rc '.resource_changes += [{"address":"hcloud_network.main","mode":"managed","type":"hcloud_network","name":"main","index":null,"change":{"actions":["update"]}}]' 2 1 5)" "1" "allowlist: rejects a network update"
assert_eq "$(plan_rc '.resource_changes += [{"address":"hcloud_firewall.web","mode":"managed","type":"hcloud_firewall","name":"web","index":null,"change":{"actions":["delete"]}}]' 2 1 5)" "1" "allowlist: rejects a firewall delete"

assert_eq "$(plan_rc '.resource_drift = [{"address":"hcloud_server.agent[0]"}]' 2 1 5)" "1" "allowlist: rejects a plan with drift"
assert_eq "$(plan_rc '.resource_changes = [.resource_changes[2]]' 2 1 5)" "1" "allowlist: rejects a plan with no changes"
assert_eq "$(plan_rc '.' 2 1 2)" "1" "allowlist: rejects a prospective count above the cap"
assert_eq "$(plan_rc '.' 2 0 5)" "1" "allowlist: rejects a zero expected addition"
assert_eq "$(plan_rc '.resource_changes[1].index = 3 | .resource_changes[1].address = "hcloud_server_network.agent[3]"' 2 1 5)" "1" "allowlist: rejects a network create on the wrong index"

# H1: the change.after shape, the expected Terraform inputs, and the environment network (plan 5.7).
# Each case must be rejected: non-zero status, and controller_plan_allowlist never returns allowlist_ok.
assert_eq "$(plan_rc '.' 2 1 5)" "0" "allowlist H1: accepts the create with the expected shape (documented server_id exception included)"
assert_eq "$(plan_rc '.resource_changes[1].change.after_unknown.server_id = true | .resource_changes[1].change.after.server_id = null' 2 1 5)" "0" "allowlist H1: accepts an unknown server_id on a network attachment whose server is created in this plan"
assert_eq "$(plan_rc '.resource_changes[0].change.after.server_type = "cx23"' 2 1 5)" "1" "allowlist H1: rejects a server of the wrong type"
assert_eq "$(plan_rc '.resource_changes[0].change.after.labels.environment = "production"' 2 1 5)" "1" "allowlist H1: rejects a server with the wrong environment label"
assert_eq "$(plan_rc '.resource_changes[0].change.after.location = "fsn1"' 2 1 5)" "1" "allowlist H1: rejects a server in the wrong location"
assert_eq "$(plan_rc '.resource_changes[0].change.after.name = "herobids-agent-2"' 2 1 5)" "1" "allowlist H1: rejects a server with the wrong name for its index"
assert_eq "$(plan_rc '.resource_changes[1].change.after.network_id = "9999"' 2 1 5)" "1" "allowlist H1: rejects a network attachment to the wrong network"
assert_eq "$(plan_rc '.resource_changes[0].change.after = null' 2 1 5)" "1" "allowlist H1: rejects a server create with a null after"
assert_eq "$(plan_rc '.resource_changes[1].change.after = null' 2 1 5)" "1" "allowlist H1: rejects a network attachment create with a null after"
assert_eq "$(plan_rc '.resource_changes[0].change.after_unknown = true' 2 1 5)" "1" "allowlist H1: rejects a server create whose whole after is unknown"
assert_eq "$(plan_rc '.resource_changes[0].change.after_unknown.server_type = true' 2 1 5)" "1" "allowlist H1: rejects an unknown server_type on a checked field"
assert_eq "$(plan_rc '.resource_changes[0].change.after_unknown.labels = true' 2 1 5)" "1" "allowlist H1: rejects an unknown labels map (a parent of the checked environment label)"
assert_eq "$(plan_rc '.resource_changes[1].change.after_unknown.network_id = true' 2 1 5)" "1" "allowlist H1: rejects an unknown network_id"
assert_eq "$(plan_rc '.resource_changes[1].change.after_unknown.server_id = false | .resource_changes[1].change.after.server_id = 12345' 2 1 5)" "1" "allowlist H1: rejects a known server_id on a create (only unknown is the documented exception)"
assert_eq "$(plan_rc 'del(.prior_state)' 2 1 5)" "1" "allowlist H1: rejects a plan without prior state (the network cannot be verified)"
assert_eq "$(plan_rc 'del(.prior_state.values.root_module.resources[0])' 2 1 5)" "1" "allowlist H1: rejects a prior state without hcloud_network.private[0]"
assert_eq "$(plan_rc '.prior_state.values.root_module.resources[0].values.labels.environment = "production"' 2 1 5)" "1" "allowlist H1: rejects a prior network from another environment"
assert_eq "$(plan_rc '.' 2 1 5 herobids cx23 nbg1 staging)" "1" "allowlist H1: rejects a server type that differs from the expected Terraform input"
assert_eq "$(plan_rc '.' 2 1 5 herobids cpx21 fsn1 staging)" "1" "allowlist H1: rejects a location that differs from the expected Terraform input"
assert_eq "$(plan_rc '.' 2 1 5 herobids cpx21 nbg1 production)" "1" "allowlist H1: rejects an environment that differs from the expected Terraform input"
assert_eq "$(plan_rc '.' 2 1 5 herobids-staging cpx21 nbg1 staging)" "1" "allowlist H1: rejects a server name that differs from the expected Terraform input"
assert_eq "$(plan_rc '.' 2 1 5 herobids "" nbg1 staging)" "1" "allowlist H1: fails closed on an empty expected server type"
assert_eq "$(plan_rc '.' 2 1 5 "" cpx21 nbg1 staging)" "1" "allowlist H1: fails closed on an empty expected server name"
assert_eq "$(plan_rc '.' 2 1 5 herobids cpx21 "" staging)" "1" "allowlist H1: fails closed on an empty expected location"
assert_eq "$(plan_rc '.' 2 1 5 herobids cpx21 nbg1 "")" "1" "allowlist H1: fails closed on an empty expected environment"

# controller_tf_input: the value Terraform will use (tfvars literal first, then TF_VAR_<name>; fail closed).
TFV_FILE="${TEST_TMPDIR}/env.tfvars"
printf 'environment = "staging"\nserver_name = "herobids-staging"\n' > "${TFV_FILE}"
assert_eq "$(controller_tf_input server_name "${TFV_FILE}")" "herobids-staging" "tf input: reads a quoted literal from the env tfvars"
assert_eq "$(controller_tf_input environment "${TFV_FILE}")" "staging" "tf input: reads the environment literal from the env tfvars"
unset TF_VAR_location
assert_eq "$(rc_of controller_tf_input location "${TFV_FILE}")" "1" "tf input: a key set nowhere fails closed (no Terraform default is guessed)"
assert_eq "$(TF_VAR_location=nbg1 controller_tf_input location "${TFV_FILE}")" "nbg1" "tf input: falls back to TF_VAR_<name> when the tfvars file does not set the key"
assert_eq "$(TF_VAR_server_name=other controller_tf_input server_name "${TFV_FILE}")" "herobids-staging" "tf input: the tfvars literal wins over TF_VAR_<name> (as -var-file does)"
printf 'server_name = "a"\nserver_name = "b"\n' > "${TEST_TMPDIR}/dup.tfvars"
assert_eq "$(rc_of controller_tf_input server_name "${TEST_TMPDIR}/dup.tfvars")" "1" "tf input: a duplicated key fails closed"
printf 'server_name = some_expression\n' > "${TEST_TMPDIR}/expr.tfvars"
assert_eq "$(rc_of controller_tf_input server_name "${TEST_TMPDIR}/expr.tfvars")" "1" "tf input: an unquoted (non-literal) value fails closed"

# ─── Failure backoff and the observation streak ───────────────────────────────

mkdir -p "${TEST_TMPDIR}/state"

# LOW-7: the epoch helper uses the same grammar as require_uint (no leading zeros), with a 10-digit bound.
assert_eq "$(rc_of _controller_require_epoch 1700000000)" "0" "epoch: a current 10-digit epoch is accepted"
assert_eq "$(rc_of _controller_require_epoch 9999999999)" "0" "epoch: the 10-digit upper bound is accepted"
assert_eq "$(rc_of _controller_require_epoch 10000000000)" "2" "epoch: an 11-digit value is rejected"
assert_eq "$(rc_of _controller_require_epoch 0123)" "2" "epoch: a leading zero is rejected (same grammar as require_uint)"

assert_eq "$(rc_of controller_failure_backoff_active 1000)" "1" "backoff: no failure record does not back off"
controller_record_failure 1000
assert_eq "$(rc_of controller_failure_backoff_active 1100)" "0" "backoff: active inside the failure window"
assert_eq "$(rc_of controller_failure_backoff_active 1000000)" "1" "backoff: lapses after the failure window"

printf 'garbage\n' > "${CONTROLLER_FAILURE_FILE}"
assert_eq "$(rc_of controller_failure_backoff_active 1000000)" "0" "backoff: corrupt failure record fails closed"

rm -f "${CONTROLLER_STREAK_FILE}"
assert_eq "$(controller_streak_read)" "0" "streak: absent file reads as zero"
controller_streak_observe capacity_blocked
controller_streak_observe capacity_blocked
assert_eq "$(controller_streak_read)" "2" "streak: consecutive capacity_blocked ticks accumulate"
assert_eq "$(rc_of controller_streak_mature)" "0" "streak: mature at the consecutive-observation threshold"
controller_streak_observe ready
assert_eq "$(controller_streak_read)" "0" "streak: a non-blocked tick resets the streak"
assert_eq "$(rc_of controller_streak_mature)" "1" "streak: reset streak is not mature"

printf 'abc\n' > "${CONTROLLER_STREAK_FILE}"
assert_eq "$(rc_of controller_streak_read)" "1" "streak: corrupt streak file fails closed"

test_end
