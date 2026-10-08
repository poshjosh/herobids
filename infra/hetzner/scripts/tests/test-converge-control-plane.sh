#!/usr/bin/env bash
# test-converge-control-plane.sh — Unit tests for converge-control-plane.sh and
# setup-control-plane.sh (bug reports 2026/10/07 002 + 003).
#
# Runs converge-control-plane.sh against a temp root with
# ip/systemctl/ufw/nomad/curl/journalctl stubbed on PATH, and checks it stays in
# sync with cloud-init.yaml and docker-compose.yaml.
#
# Run: bash infra/hetzner/scripts/tests/test-converge-control-plane.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(dirname "${TESTS_DIR}")"
HETZNER_DIR="$(dirname "${SCRIPTS_DIR}")"
REPO_ROOT="$(cd "${HETZNER_DIR}/../.." && pwd)"
CONVERGE="${SCRIPTS_DIR}/converge-control-plane.sh"
SETUP="${SCRIPTS_DIR}/setup-control-plane.sh"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

SUITE_FAILED=0
STUB_PRIVATE_IP="10.0.0.2"
DOCKER0_IP="172.17.0.1"

# ─── Stubs ────────────────────────────────────────────────────────────────────
# Shared state lives in $STUB_STATE (exported per run):
#   calls.log      every stubbed command
#   ufw-rules      existing ufw rules
#   <unit>.active / <unit>.enabled   unit state
#   nomad-live-ip  advertise IP the RUNNING Nomad uses (set by `restart nomad`
#                  from nomad.hcl), independent of what is on disk.

MOCK_BIN="${TEST_TMPDIR}/bin"
mkdir -p "${MOCK_BIN}"

cat > "${MOCK_BIN}/ip" <<'STUB'
#!/usr/bin/env bash
echo "ip $*" >> "${STUB_STATE}/calls.log"
echo "1: lo: <LOOPBACK,UP>"
echo "    inet 127.0.0.1/8 scope host lo"
echo "2: docker0: <BROADCAST,UP>"
echo "    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0"
if [[ "${STUB_NO_PRIVATE_IP:-false}" != "true" ]]; then
  echo "3: enp7s0: <BROADCAST,UP>"
  echo "    inet ${STUB_PRIVATE_IP}/32 brd ${STUB_PRIVATE_IP} scope global dynamic enp7s0"
fi
STUB

cat > "${MOCK_BIN}/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "systemctl $*" >> "${STUB_STATE}/calls.log"
args=()
for a in "$@"; do [[ "${a}" == --* ]] || args+=("${a}"); done
cmd="${args[0]:-}"; unit="${args[1]:-}"
case "${cmd}" in
  is-active) [[ -f "${STUB_STATE}/${unit}.active" ]]; exit $? ;;
  is-enabled) [[ -f "${STUB_STATE}/${unit}.enabled" ]]; exit $? ;;
  enable) touch "${STUB_STATE}/${unit}.enabled" ;;
  start|restart)
    if [[ "${unit}" == "nomad" ]]; then
      # NOOP: restart "succeeds" but the running Nomad keeps its old config.
      [[ "${STUB_NOMAD_RESTART_NOOP:-false}" == "true" ]] && exit 0
      sed -nE 's/^[[:space:]]*rpc[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "${NOMAD_HCL}" | head -1 \
        > "${STUB_STATE}/nomad-live-ip"
    fi
    [[ "${unit}" == "nomad-private-ip.service" && "${STUB_UNIT_START_FAILS:-false}" == "true" ]] && exit 1
    touch "${STUB_STATE}/${unit}.active"
    ;;
esac
exit 0
STUB

cat > "${MOCK_BIN}/ufw" <<'STUB'
#!/usr/bin/env bash
echo "ufw $*" >> "${STUB_STATE}/calls.log"
if [[ "${STUB_UFW_FAILS:-false}" == "true" ]]; then
  echo "ERROR: problem running iptables" >&2
  exit 1
fi
rule="$*"
touch "${STUB_STATE}/ufw-rules"
if grep -qxF "${rule}" "${STUB_STATE}/ufw-rules"; then
  echo "Skipping adding existing rule"
else
  echo "${rule}" >> "${STUB_STATE}/ufw-rules"
  echo "Rule added"
fi
STUB

cat > "${MOCK_BIN}/nomad" <<'STUB'
#!/usr/bin/env bash
echo "nomad $* (token=${NOMAD_TOKEN:+set})" >> "${STUB_STATE}/calls.log"
live="$(cat "${STUB_STATE}/nomad-live-ip" 2>/dev/null || true)"
case "$1 $2" in
  "server members")
    [[ -n "${NOMAD_TOKEN:-}" ]] || { echo "Error: 403 (Permission denied)" >&2; exit 1; }
    echo "Name       Address  Port  Status  Leader"
    echo "cp.global  ${STUB_MEMBER_IP:-${live}}  4648  alive   true"
    ;;
  "operator raft")
    [[ "${STUB_RAFT_FAILS:-false}" == "true" ]] && { echo "Error: 403" >&2; exit 1; }
    echo "Node       ID        Address                                 State   Voter  RaftProtocol"
    echo "cp.global  4730df44  ${STUB_RAFT_PEER_IP:-${live}}:4647  leader  true   3"
    ;;
esac
STUB

cat > "${MOCK_BIN}/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >> "${STUB_STATE}/calls.log"
if [[ -n "${STUB_LEADER+x}" ]]; then printf '%s' "${STUB_LEADER}"; exit 0; fi
live="$(cat "${STUB_STATE}/nomad-live-ip" 2>/dev/null || true)"
if [[ -n "${live}" ]]; then printf '"%s:4647"' "${live}"; else printf '""'; fi
STUB

cat > "${MOCK_BIN}/journalctl" <<'STUB'
#!/usr/bin/env bash
echo "journalctl $*" >> "${STUB_STATE}/calls.log"
echo "stub journal output"
STUB

cat > "${MOCK_BIN}/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

chmod +x "${MOCK_BIN}"/*

# ─── Fixture helpers ──────────────────────────────────────────────────────────

# new_root <name> [live-ip] — fresh fake filesystem; sets ROOT. The running
# Nomad advertises live-ip (default docker0, as on stale production).
new_root() {
  ROOT="${TEST_TMPDIR}/$1"
  mkdir -p "${ROOT}/etc/nomad.d" "${ROOT}/etc/systemd/system" "${ROOT}/state"
  printf 'secret-token\n' > "${ROOT}/etc/nomad.d/acl-token"
  printf '%s\n' "${2:-${DOCKER0_IP}}" > "${ROOT}/state/nomad-live-ip"
  # Stale main unit, as on the live control planes (no private-ip dependency).
  printf '%s\n' '[Unit]' 'Description=Nomad' 'After=network-online.target' '' \
    '[Service]' 'ExecStart=/usr/bin/nomad agent -config=/etc/nomad.d/nomad.hcl' \
    > "${ROOT}/etc/systemd/system/nomad.service"
}

# write_hcl <advertise value> [acl-enabled: true|false] — nomad.hcl with the
# given advertise value; includes cloud-init's acl block unless told not to.
write_hcl() {
  cat > "${ROOT}/etc/nomad.d/nomad.hcl" <<HCL
data_dir = "/opt/nomad/data"

advertise {
  http = "$1"
  rpc  = "$1"
  serf = "$1"
}
HCL
  if [[ "${2:-true}" == "true" ]]; then
    printf '\nacl {\n  enabled = true\n}\n' >> "${ROOT}/etc/nomad.d/nomad.hcl"
  fi
}

write_stale_hcl() { write_hcl "{{ GetPrivateIP }}"; }

# run_converge [VAR=value ...] — runs the script in ROOT; sets RUN_OUTPUT/RUN_EXIT.
run_converge() {
  : > "${ROOT}/state/calls.log"
  RUN_EXIT=0
  RUN_OUTPUT="$(
    env PATH="${MOCK_BIN}:${PATH}" \
      STUB_STATE="${ROOT}/state" STUB_PRIVATE_IP="${STUB_PRIVATE_IP}" \
      PRIVATE_SUBNET="10.0.0.0/24" \
      NOMAD_HCL="${ROOT}/etc/nomad.d/nomad.hcl" \
      NOMAD_ACL_TOKEN_FILE="${ROOT}/etc/nomad.d/acl-token" \
      SYSTEMD_DIR="${ROOT}/etc/systemd/system" \
      CONVERGE_TIMEOUT_SECS=2 CONVERGE_POLL_SECS=1 \
      "$@" bash "${CONVERGE}" 2>&1
  )" || RUN_EXIT=$?
  CALLS="$(cat "${ROOT}/state/calls.log")"
  NOMAD_RESTARTS="$(grep -cx 'systemctl restart nomad' "${ROOT}/state/calls.log" || true)"
}

# assert_not_falsely_converged <label> — a re-run must restart Nomad or fail.
assert_not_falsely_converged() {
  assert_not_contains "${RUN_OUTPUT}" "already converged" "$1: does not report already converged"
  if [[ "${RUN_EXIT}" -eq 0 ]]; then
    assert_eq "${NOMAD_RESTARTS}" "1" "$1: restarts nomad"
  else
    assert_neq "${RUN_EXIT}" "0" "$1: fails"
  fi
}

# ═════════════════════════════════════════════════════════════════════════════

test_begin "converge-control-plane — input validation and skip"

new_root "validation"
write_stale_hcl
run_converge PRIVATE_SUBNET=
assert_neq "${RUN_EXIT}" "0" "exits non-zero when PRIVATE_SUBNET is missing"
assert_contains "${RUN_OUTPUT}" "PRIVATE_SUBNET is required" "explains PRIVATE_SUBNET is required"
assert_eq "${CALLS}" "" "makes no system calls when PRIVATE_SUBNET is missing"

run_converge "PRIVATE_SUBNET=10.0.0.0/24; rm -rf /"
assert_neq "${RUN_EXIT}" "0" "rejects a PRIVATE_SUBNET that is not a CIDR"

new_root "no-nomad"
run_converge
assert_eq "${RUN_EXIT}" "0" "exits 0 when nomad.hcl is absent (enable_nomad off)"
assert_contains "${RUN_OUTPUT}" "nothing to converge" "says it skipped"
assert_eq "${CALLS}" "" "makes no system calls when nomad.hcl is absent"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "converge-control-plane — stale control plane (production case)"

new_root "stale"
write_stale_hcl
run_converge
HCL="$(cat "${ROOT}/etc/nomad.d/nomad.hcl")"
UNIT_FILE="${ROOT}/etc/systemd/system/nomad-private-ip.service"
DROPIN_FILE="${ROOT}/etc/systemd/system/nomad.service.d/10-private-ip.conf"

assert_eq "${RUN_EXIT}" "0" "first run succeeds"
assert_not_contains "${HCL}" "GetPrivateIP" "removes {{ GetPrivateIP }} from nomad.hcl"
assert_not_contains "${HCL}" "__PRIVATE_IP__" "substitutes the IP directly (no placeholder left)"
assert_contains "${HCL}" "rpc  = \"${STUB_PRIVATE_IP}\"" "nomad.hcl advertises the private IP, not docker0"
assert_contains "${HCL}" 'data_dir = "/opt/nomad/data"' "leaves the rest of nomad.hcl intact"
assert_success "installs nomad-private-ip.service" test -f "${UNIT_FILE}"
assert_contains "$(cat "${UNIT_FILE}")" 'Environment=PRIVATE_SUBNET="10.0.0.0/24"' "unit carries the private subnet"
assert_contains "$(cat "${DROPIN_FILE}")" "After=nomad-private-ip.service" "drop-in orders nomad after the unit"
assert_contains "$(cat "${DROPIN_FILE}")" "Requires=nomad-private-ip.service" "drop-in makes nomad require the unit"
assert_contains "${CALLS}" "systemctl daemon-reload" "reloads systemd"
assert_contains "${CALLS}" "systemctl enable --quiet nomad-private-ip.service" "enables the unit"
assert_contains "${CALLS}" "systemctl start nomad-private-ip.service" "starts the inactive unit"
assert_not_contains "${CALLS}" "systemctl restart nomad-private-ip.service" "never restarts the oneshot"
assert_eq "${NOMAD_RESTARTS}" "1" "restarts nomad exactly once"
assert_eq "$(cat "${ROOT}/state/nomad-live-ip")" "${STUB_PRIVATE_IP}" "running nomad now advertises the private IP"
assert_contains "${CALLS}" "ufw allow from 10.0.0.0/24 to any port 5432 proto tcp" "asserts private-subnet Postgres rule"
assert_contains "${CALLS}" "ufw allow from 172.18.0.0/16 to any port 4648 proto tcp" "asserts bridge Serf rule"
assert_eq "$(wc -l < "${ROOT}/state/ufw-rules" | tr -d ' ')" "8" "asserts exactly 8 ufw rules"
assert_contains "${CALLS}" "nomad server members" "verifies server members"
assert_not_contains "${RUN_OUTPUT}" "secret-token" "never prints the ACL token"
assert_not_contains "${RUN_OUTPUT}" "WARNING: Raft" "no Raft warning when the peer matches"
assert_contains "${RUN_OUTPUT}" "changed:" "summary lists changes"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "converge-control-plane — second run is a no-op"

run_converge
assert_eq "${RUN_EXIT}" "0" "second run succeeds"
assert_contains "${RUN_OUTPUT}" "already converged" "reports already converged"
assert_not_contains "${CALLS}" "systemctl restart" "does not restart anything"
assert_not_contains "${CALLS}" "daemon-reload" "does not reload systemd"
assert_not_contains "${CALLS}" "systemctl start" "does not re-run the active unit"
assert_not_contains "${CALLS}" "systemctl enable" "does not re-enable an enabled unit"
assert_contains "${CALLS}" "curl -s --max-time 3 http://127.0.0.1:4646/v1/status/leader" "does one live leader check"
assert_eq "$(grep -c '^curl' "${ROOT}/state/calls.log")" "1" "the live check does not poll"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "converge-control-plane — re-run after a mid-way failure"

# First run fails in ufw: nothing may be mutated, so the second run converges.
new_root "ufw-fails"
write_stale_hcl
HCL_BEFORE_RUN="$(cat "${ROOT}/etc/nomad.d/nomad.hcl")"
run_converge STUB_UFW_FAILS=true
assert_neq "${RUN_EXIT}" "0" "ufw failure: first run fails"
assert_eq "$(cat "${ROOT}/etc/nomad.d/nomad.hcl")" "${HCL_BEFORE_RUN}" "ufw failure: nomad.hcl untouched"
assert_failure "ufw failure: no unit installed" test -e "${ROOT}/etc/systemd/system/nomad-private-ip.service"
assert_not_contains "${CALLS}" "systemctl" "ufw failure: no systemctl calls"
run_converge
assert_eq "${RUN_EXIT}" "0" "ufw failure: second run succeeds"
assert_not_falsely_converged "ufw failure"
assert_eq "$(cat "${ROOT}/state/nomad-live-ip")" "${STUB_PRIVATE_IP}" "ufw failure: nomad ends on the private IP"

# First run patches + restarts, but the restart never takes effect (leader
# wait times out with Nomad still on docker0). Files are now converged.
new_root "restart-fails"
write_stale_hcl
run_converge STUB_NOMAD_RESTART_NOOP=true
assert_neq "${RUN_EXIT}" "0" "leader-wait failure: first run fails"
assert_contains "$(cat "${ROOT}/etc/nomad.d/nomad.hcl")" "rpc  = \"${STUB_PRIVATE_IP}\"" "leader-wait failure: nomad.hcl was patched"
run_converge
assert_eq "${RUN_EXIT}" "0" "leader-wait failure: second run succeeds"
assert_not_falsely_converged "leader-wait failure"
assert_contains "${RUN_OUTPUT}" "live Nomad does not advertise ${STUB_PRIVATE_IP}" "leader-wait failure: explains the live mismatch"
assert_eq "$(cat "${ROOT}/state/nomad-live-ip")" "${STUB_PRIVATE_IP}" "leader-wait failure: nomad ends on the private IP"

# Leader never comes back: every re-run restarts once and fails again.
new_root "no-leader-persistent"
write_stale_hcl
run_converge STUB_LEADER='""'
assert_neq "${RUN_EXIT}" "0" "persistent no-leader: first run fails"
run_converge STUB_LEADER='""'
assert_not_falsely_converged "persistent no-leader"
assert_neq "${RUN_EXIT}" "0" "persistent no-leader: second run fails too"
assert_eq "${NOMAD_RESTARTS}" "1" "persistent no-leader: second run restarts once before failing"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "converge-control-plane — hand-patched control plane (staging case)"

new_root "hand-patched" "${STUB_PRIVATE_IP}"
write_hcl "${STUB_PRIVATE_IP}"
run_converge
assert_eq "${RUN_EXIT}" "0" "succeeds"
assert_contains "${RUN_OUTPUT}" "installed nomad-private-ip.service" "adds the missing unit"
assert_not_contains "${RUN_OUTPUT}" "patched nomad.hcl" "leaves nomad.hcl unchanged"

# Removed ufw rule comes back, without a Nomad restart.
grep -vF "from 172.18.0.0/16 to any port 4648" "${ROOT}/state/ufw-rules" > "${ROOT}/state/ufw.tmp"
mv "${ROOT}/state/ufw.tmp" "${ROOT}/state/ufw-rules"
run_converge
assert_contains "$(cat "${ROOT}/state/ufw-rules")" "allow from 172.18.0.0/16 to any port 4648 proto tcp" "restores a deleted bridge rule"
assert_contains "${RUN_OUTPUT}" "added 1 ufw rule(s)" "reports the restored rule"
assert_eq "${NOMAD_RESTARTS}" "0" "does not restart nomad for a ufw-only change"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "converge-control-plane — placeholder, unit and dependency variants"

# Fresh cloud-init box where the unit never ran: placeholder rewritten directly.
new_root "placeholder"
write_hcl "__PRIVATE_IP__"
run_converge
assert_eq "${RUN_EXIT}" "0" "placeholder: succeeds"
assert_contains "$(cat "${ROOT}/etc/nomad.d/nomad.hcl")" "rpc  = \"${STUB_PRIVATE_IP}\"" "placeholder: rewritten to the private IP"

new_root "fresh-unit"
write_stale_hcl
printf '%s\n' '[Unit]' 'After=network-online.target nomad-private-ip.service' 'Requires=nomad-private-ip.service' \
  > "${ROOT}/etc/systemd/system/nomad.service"
run_converge
assert_eq "${RUN_EXIT}" "0" "main unit has dependency: succeeds"
assert_failure "main unit has dependency: no drop-in" test -e "${ROOT}/etc/systemd/system/nomad.service.d/10-private-ip.conf"

# Converged box with an older nomad-private-ip.service text (live boxes after
# the late-NIC fix): rewrite + daemon-reload, but no Nomad restart.
new_root "old-unit-text" "${STUB_PRIVATE_IP}"
write_hcl "${STUB_PRIVATE_IP}"
run_converge
printf '%s\n' '[Unit]' 'Description=older nomad-private-ip' > "${ROOT}/etc/systemd/system/nomad-private-ip.service"
run_converge
assert_eq "${RUN_EXIT}" "0" "old unit text: succeeds"
assert_contains "${RUN_OUTPUT}" "updated nomad-private-ip.service" "old unit text: reports the update"
assert_contains "${CALLS}" "systemctl daemon-reload" "old unit text: reloads systemd"
assert_eq "${NOMAD_RESTARTS}" "0" "old unit text: does not restart nomad"
assert_not_contains "${CALLS}" "start nomad-private-ip.service" "old unit text: leaves the active oneshot alone"
run_converge
assert_contains "${RUN_OUTPUT}" "already converged" "old unit text: next run is already converged"

# Converged files, unit installed+enabled but inactive: start, never restart.
new_root "inactive-unit" "${STUB_PRIVATE_IP}"
write_hcl "${STUB_PRIVATE_IP}"
run_converge
rm -f "${ROOT}/state/nomad-private-ip.service.active"
run_converge
assert_eq "${RUN_EXIT}" "0" "inactive unit: succeeds"
assert_contains "${CALLS}" "systemctl start nomad-private-ip.service" "inactive unit: started"
assert_not_contains "${CALLS}" "systemctl restart" "inactive unit: nothing restarted"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "converge-control-plane — live checks, token and Raft peers"

# Leader must match "<ip>: exactly, not as a substring (10.0.0.20 != 10.0.0.2).
new_root "leader-prefix" "${STUB_PRIVATE_IP}"
write_hcl "${STUB_PRIVATE_IP}"
run_converge
run_converge STUB_LEADER='"10.0.0.20:4647"'
assert_eq "${NOMAD_RESTARTS}" "1" "leader 10.0.0.20 is a mismatch for 10.0.0.2 (restarts)"
assert_neq "${RUN_EXIT}" "0" "fails when the leader stays on another IP"

new_root "wrong-member"
write_stale_hcl
run_converge STUB_MEMBER_IP="${DOCKER0_IP}"
assert_neq "${RUN_EXIT}" "0" "fails when server members still show the docker bridge IP"

# No ACL token file: leader check only, no 403 from server members.
new_root "no-token" "${STUB_PRIVATE_IP}"
write_hcl "${STUB_PRIVATE_IP}"
rm -f "${ROOT}/etc/nomad.d/acl-token"
run_converge
run_converge
assert_eq "${RUN_EXIT}" "0" "no token: succeeds"
assert_contains "${RUN_OUTPUT}" "already converged" "no token: converged box stays converged"
assert_not_contains "${CALLS}" "nomad server members" "no token: skips server members"

# Stale Raft peer (production): warn, exit 0, never restart.
new_root "raft-stale" "${STUB_PRIVATE_IP}"
write_hcl "${STUB_PRIVATE_IP}"
run_converge
run_converge STUB_RAFT_PEER_IP="${DOCKER0_IP}"
assert_eq "${RUN_EXIT}" "0" "stale Raft peer: succeeds"
assert_contains "${RUN_OUTPUT}" "WARNING: Raft peer address(es) ${DOCKER0_IP}:4647" "stale Raft peer: warns with the address"
assert_contains "${RUN_OUTPUT}" "already converged" "stale Raft peer: still already converged"
assert_eq "${NOMAD_RESTARTS}" "0" "stale Raft peer: no restart"

run_converge STUB_RAFT_FAILS=true
assert_eq "${RUN_EXIT}" "0" "raft list-peers failure is non-fatal"
assert_contains "${RUN_OUTPUT}" "skipped the Raft address check" "raft list-peers failure is reported"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "converge-control-plane — autoscale units load autoscale.env"

new_root "autoscale-env" "${STUB_PRIVATE_IP}"
write_hcl "${STUB_PRIVATE_IP}"
run_converge
# Production case: units exist but lack EnvironmentFile=.
printf '%s\n' '[Service]' 'Type=oneshot' 'ExecStart=/opt/herobids/infra/hetzner/scripts/scale-out.sh' \
  > "${ROOT}/etc/systemd/system/nomad-autoscale.service"
printf '%s\n' '[Service]' 'Type=oneshot' 'EnvironmentFile=-/etc/herobids/autoscale.env' \
  > "${ROOT}/etc/systemd/system/nomad-scale-in.service"
run_converge
DROPIN_DIR="${ROOT}/etc/systemd/system/nomad-autoscale.service.d"
assert_eq "${RUN_EXIT}" "0" "missing EnvironmentFile: succeeds"
assert_eq "$(cat "${DROPIN_DIR}/10-autoscale-env.conf" 2>/dev/null)" \
  "$(printf '%s\n' '[Service]' 'EnvironmentFile=-/etc/herobids/autoscale.env')" "missing EnvironmentFile: installs the drop-in"
assert_contains "${CALLS}" "systemctl daemon-reload" "missing EnvironmentFile: daemon-reloads"
assert_eq "${NOMAD_RESTARTS}" "0" "missing EnvironmentFile: does not restart nomad"
assert_eq "$([[ -d "${ROOT}/etc/systemd/system/nomad-scale-in.service.d" ]] && echo yes || echo no)" "no" \
  "unit that already has EnvironmentFile: no drop-in"
assert_eq "$([[ -d "${ROOT}/etc/systemd/system/nomad-placement-failure-watcher.service.d" ]] && echo yes || echo no)" "no" \
  "absent unit: no drop-in"
run_converge
assert_contains "${RUN_OUTPUT}" "already converged" "drop-in: second run is a no-op"
assert_not_contains "${CALLS}" "systemctl daemon-reload" "drop-in: second run does not daemon-reload"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "converge-control-plane — ACL check (bug 2026-10-08/003)"

new_root "acl-on" "${STUB_PRIVATE_IP}"
write_hcl "${STUB_PRIVATE_IP}"
run_converge
assert_eq "${RUN_EXIT}" "0" "acl enabled: succeeds"
assert_not_contains "${RUN_OUTPUT}" "ACLs are NOT enabled" "acl enabled: no ACL warning"

new_root "acl-off" "${STUB_PRIVATE_IP}"
write_hcl "${STUB_PRIVATE_IP}" false
run_converge
HCL_BEFORE_SECOND_RUN="$(cat "${ROOT}/etc/nomad.d/nomad.hcl")"
run_converge
assert_eq "${RUN_EXIT}" "0" "acl missing: still succeeds (warning only)"
assert_contains "${RUN_OUTPUT}" "WARNING: ACLs are NOT enabled" "acl missing: warns"
assert_eq "$(cat "${ROOT}/etc/nomad.d/nomad.hcl")" "${HCL_BEFORE_SECOND_RUN}" "acl missing: does not edit nomad.hcl"
assert_eq "${NOMAD_RESTARTS}" "0" "acl missing: does not restart nomad"

new_root "acl-disabled" "${STUB_PRIVATE_IP}"
write_hcl "${STUB_PRIVATE_IP}" false
printf '\nacl {\n  enabled = false\n}\n' >> "${ROOT}/etc/nomad.d/nomad.hcl"
run_converge
assert_contains "${RUN_OUTPUT}" "WARNING: ACLs are NOT enabled" "acl enabled = false: warns"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "converge-control-plane — failures before mutation"

new_root "no-private-ip"
write_stale_hcl
HCL_BEFORE_RUN="$(cat "${ROOT}/etc/nomad.d/nomad.hcl")"
run_converge STUB_NO_PRIVATE_IP=true
assert_neq "${RUN_EXIT}" "0" "fails when no private IP is visible"
assert_contains "${RUN_OUTPUT}" "no 10.0.0.0/24 address" "explains the missing private IP"
assert_eq "$(cat "${ROOT}/etc/nomad.d/nomad.hcl")" "${HCL_BEFORE_RUN}" "nomad.hcl untouched"
assert_not_contains "${CALLS}" "ufw" "no ufw calls"
assert_not_contains "${CALLS}" "systemctl" "no systemctl calls"
assert_failure "no unit installed" test -e "${ROOT}/etc/systemd/system/nomad-private-ip.service"

new_root "no-leader"
write_stale_hcl
run_converge STUB_LEADER='""'
assert_neq "${RUN_EXIT}" "0" "fails when no leader is elected after restart"
assert_contains "${RUN_OUTPUT}" "no Nomad leader" "explains the missing leader"
assert_contains "${CALLS}" "journalctl -u nomad -n 80" "prints the nomad journal"

new_root "unit-start-fails"
write_stale_hcl
run_converge STUB_UNIT_START_FAILS=true
assert_neq "${RUN_EXIT}" "0" "fails when nomad-private-ip.service fails to start"
assert_eq "${NOMAD_RESTARTS}" "0" "does not restart nomad when the unit failed"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "converge-control-plane — in sync with cloud-init.yaml and docker-compose.yaml"

# Extract the nomad-private-ip unit from cloud-init.yaml (6-space YAML indent).
CLOUD_INIT_UNIT="$(awk '
  /- path: \/etc\/systemd\/system\/nomad-private-ip.service/ { found = 1; next }
  found && /content: \|/ { body = 1; next }
  body && /^  - path:/ { exit }
  body { sub(/^      /, ""); print }
' "${HETZNER_DIR}/cloud-init.yaml" | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')"
CLOUD_INIT_UNIT="${CLOUD_INIT_UNIT//\$\{private_subnet\}/10.0.0.0/24}"

new_root "sync"
write_stale_hcl
run_converge
INSTALLED_UNIT="$(cat "${ROOT}/etc/systemd/system/nomad-private-ip.service")"
INSTALLED_UNIT="${INSTALLED_UNIT//${ROOT}\/etc\/nomad.d\/nomad.hcl//etc/nomad.d/nomad.hcl}"
assert_eq "${INSTALLED_UNIT}" "${CLOUD_INIT_UNIT}" "installed unit matches cloud-init.yaml"

COMPOSE_SUBNET="$(sed -nE 's/^[[:space:]]*- subnet:[[:space:]]*([0-9./]+).*/\1/p' "${REPO_ROOT}/docker-compose.yaml" | head -1)"
SETUP_SUBNET="$(sed -nE 's/^DOCKER_BRIDGE_SUBNET="([^"]+)"$/\1/p' "${SETUP}")"
CONVERGE_DEFAULT="$(sed -nE 's/^DOCKER_BRIDGE_SUBNET="\$\{DOCKER_BRIDGE_SUBNET:-([^}]+)\}"$/\1/p' "${CONVERGE}")"
assert_eq "${COMPOSE_SUBNET}" "172.18.0.0/16" "docker-compose.yaml pins the bridge subnet"
assert_eq "${SETUP_SUBNET}" "${COMPOSE_SUBNET}" "setup-control-plane.sh bridge subnet matches docker-compose.yaml"
assert_eq "${CONVERGE_DEFAULT}" "${COMPOSE_SUBNET}" "converge default bridge subnet matches docker-compose.yaml"
assert_eq "$(grep -c "ufw allow from ${COMPOSE_SUBNET} to any port" "${HETZNER_DIR}/cloud-init.yaml")" "3" \
  "cloud-init.yaml bridge rules use the docker-compose.yaml subnet"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "nomad-private-ip.service ExecStart behaviour"

# Run the unit's actual shell (from the installed copy) against fake hcl files.
UNIT_SH="$(sed -n "/^ExecStart=\/bin\/sh -c '/,/fi'$/p" "${ROOT}/etc/systemd/system/nomad-private-ip.service" \
  | sed -e "s/^ExecStart=\/bin\/sh -c '//" -e "s/'$//" -e 's/\\$//')"
UNIT_HCL="${ROOT}/etc/nomad.d/nomad.hcl"
GREP_P_OK=true
echo "10.0.0.2" | grep -qP '10\.0\.\d+' 2>/dev/null || GREP_P_OK=false

run_unit_sh() {
  UNIT_EXIT=0
  UNIT_OUTPUT="$(env PATH="${MOCK_BIN}:${PATH}" STUB_STATE="${ROOT}/state" STUB_PRIVATE_IP="${STUB_PRIVATE_IP}" \
    PRIVATE_SUBNET="10.0.0.0/24" "$@" sh -c "${UNIT_SH}" 2>&1)" || UNIT_EXIT=$?
}

write_hcl "${STUB_PRIVATE_IP}"
run_unit_sh STUB_NO_PRIVATE_IP=true
assert_eq "${UNIT_EXIT}" "0" "already-patched nomad.hcl + late NIC: exits 0 (Nomad can start)"
assert_contains "${UNIT_OUTPUT}" "already patched" "already-patched nomad.hcl: says so"

write_hcl "__PRIVATE_IP__"
run_unit_sh STUB_NO_PRIVATE_IP=true
assert_neq "${UNIT_EXIT}" "0" "placeholder + no private IP: exits 1"
assert_contains "$(cat "${UNIT_HCL}")" "__PRIVATE_IP__" "placeholder + no private IP: nomad.hcl untouched"

if [[ "${GREP_P_OK}" == "true" ]] && sed --version >/dev/null 2>&1; then
  run_unit_sh
  assert_eq "${UNIT_EXIT}" "0" "placeholder + private IP: exits 0"
  assert_contains "$(cat "${UNIT_HCL}")" "rpc  = \"${STUB_PRIVATE_IP}\"" "placeholder + private IP: patched"
else
  echo "  (skipping placeholder+IP unit case: needs GNU grep -P and sed -i)"
fi

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

test_begin "setup-control-plane — nomad_enabled and subnet resolution"

# Stub terraform/ssh/scp for setup-control-plane.sh. terraform output values
# come from STUB_TF_<name>; STUB_TF_FAIL makes every terraform call fail.
SETUP_BIN="${TEST_TMPDIR}/setup-bin"
SETUP_LOG="${TEST_TMPDIR}/setup-calls.log"
mkdir -p "${SETUP_BIN}"
cat > "${SETUP_BIN}/terraform" <<'STUB'
#!/usr/bin/env bash
echo "terraform $*" >> "${SETUP_LOG}"
[[ "${STUB_TF_FAIL:-false}" == "true" ]] && { echo "Error: backend not initialised" >&2; exit 1; }
[[ "$1" == "init" || "$1" == "workspace" ]] && exit 0
name="${!#}"
var="STUB_TF_${name}"
[[ -n "${!var+x}" ]] || { echo "Error: output ${name} not found" >&2; exit 1; }
printf '%s' "${!var}"
STUB
cat > "${SETUP_BIN}/ssh" <<'STUB'
#!/usr/bin/env bash
echo "ssh $*" >> "${SETUP_LOG}"
STUB
cat > "${SETUP_BIN}/scp" <<'STUB'
#!/usr/bin/env bash
echo "scp $*" >> "${SETUP_LOG}"
STUB
chmod +x "${SETUP_BIN}"/*

# TF_DIR points at an empty dir so the real infra/hetzner/.env.backend is never sourced.
SETUP_TF_DIR="${TEST_TMPDIR}/setup-tf-dir"
mkdir -p "${SETUP_TF_DIR}"

run_setup() {
  : > "${SETUP_LOG}"
  SETUP_EXIT=0
  SETUP_OUTPUT="$(env -u PRIVATE_SUBNET -u HEROBIDS_PRIVATE_SUBNET -u HEROBIDS_NOMAD_ENABLED \
    -u TF_BACKEND_DYNAMODB_TABLE \
    PATH="${SETUP_BIN}:${PATH}" SETUP_LOG="${SETUP_LOG}" HEROBIDS_SSH_KEY="/dev/null" \
    TF_DIR="${SETUP_TF_DIR}" TF_BACKEND_BUCKET=test-bucket TF_BACKEND_REGION=eu-central-1 \
    "$@" bash "${SETUP}" --env staging 203.0.113.10 2>&1)" || SETUP_EXIT=$?
  SETUP_CALLS="$(cat "${SETUP_LOG}")"
}

run_setup STUB_TF_FAIL=true
assert_neq "${SETUP_EXIT}" "0" "terraform error: exits non-zero (no silent skip)"
assert_contains "${SETUP_OUTPUT}" "workspace 'staging'" "terraform error: names the workspace"
assert_not_contains "${SETUP_OUTPUT}" "skipping" "terraform error: does not skip"
assert_not_contains "${SETUP_CALLS}" "ssh" "terraform error: does not touch the server"

run_setup STUB_TF_nomad_enabled=false
assert_eq "${SETUP_EXIT}" "0" "nomad_enabled=false: exits 0"
assert_contains "${SETUP_OUTPUT}" "skipping control-plane convergence" "nomad_enabled=false: skips"

run_setup STUB_TF_nomad_enabled=maybe
assert_neq "${SETUP_EXIT}" "0" "nomad_enabled not true/false: exits non-zero"

run_setup STUB_TF_nomad_enabled=true STUB_TF_private_subnet_ip_range=10.0.0.0/24 PRIVATE_SUBNET=192.168.0.0/24
assert_eq "${SETUP_EXIT}" "0" "terraform path: succeeds"
assert_contains "${SETUP_OUTPUT}" "from terraform output private_subnet_ip_range" "terraform path: prints the subnet source"
assert_contains "${SETUP_CALLS}" "PRIVATE_SUBNET=10.0.0.0/24 " "terraform path: a stray PRIVATE_SUBNET does not override terraform"
# Regression (bug 2026-10-08/001): outputs must come from the env's own state key,
# not whichever backend key was last init'ed locally.
assert_contains "${SETUP_CALLS}" "-backend-config=key=herobids/staging/terraform.tfstate" "terraform path: inits the staging state key"
FIRST_TF_CALL="$(grep -m1 '^terraform ' "${SETUP_LOG}")"
assert_contains "${FIRST_TF_CALL}" "terraform init " "terraform path: inits the backend before reading outputs"

run_setup TF_BACKEND_BUCKET= STUB_TF_nomad_enabled=true STUB_TF_private_subnet_ip_range=10.0.0.0/24
assert_neq "${SETUP_EXIT}" "0" "no backend creds: exits non-zero"
assert_contains "${SETUP_OUTPUT}" "TF_BACKEND_BUCKET" "no backend creds: names the missing variable"
assert_not_contains "${SETUP_CALLS}" "terraform" "no backend creds: never runs terraform against a stale backend"
assert_not_contains "${SETUP_CALLS}" "ssh" "no backend creds: does not touch the server"

run_setup STUB_TF_FAIL=true HEROBIDS_NOMAD_ENABLED=true HEROBIDS_PRIVATE_SUBNET=10.0.0.0/24
assert_eq "${SETUP_EXIT}" "0" "overrides: runs without terraform state"
assert_contains "${SETUP_OUTPUT}" "from HEROBIDS_PRIVATE_SUBNET" "overrides: prints the subnet source"
assert_contains "${SETUP_CALLS}" "PRIVATE_SUBNET=10.0.0.0/24 DOCKER_BRIDGE_SUBNET=172.18.0.0/16" "overrides: remote gets PRIVATE_SUBNET"

run_setup STUB_TF_FAIL=true HEROBIDS_NOMAD_ENABLED=true
assert_neq "${SETUP_EXIT}" "0" "override without subnet and no terraform: exits non-zero"

test_end || SUITE_FAILED=1

echo ""
echo "═══ All converge-control-plane test suites complete ═══"
exit "${SUITE_FAILED}"
