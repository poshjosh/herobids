#!/usr/bin/env bash
# converge-control-plane.sh — Bring an EXISTING control plane in line with the
# committed infra/hetzner/cloud-init.yaml (Nomad advertise + UFW rules).
#
# Runs ON the control plane as root. Idempotent: a re-run on a converged,
# healthy box changes nothing and does not restart Nomad.
#
# Why: hcloud_server.default has `lifecycle { ignore_changes = [user_data] }`,
# so a control plane created from older cloud-init never receives fixes made
# to it later (see docs/bug-reports/2026/10/07/002-* and 003-*).
#
# What it does (in this order, so an early failure leaves nothing half-done):
#   1. Resolves the private IP (first `ip -4 addr show` address in the private
#      subnet's /16, exactly like nomad-private-ip.service). Dies if none.
#   2. Asserts the private-subnet and Docker-bridge UFW allow rules.
#   3. Installs nomad-private-ip.service (same unit as cloud-init.yaml) and a
#      nomad.service drop-in (After=/Requires=) unless the main unit has both.
#   3c. Adds an EnvironmentFile=-/etc/herobids/autoscale.env drop-in to each
#      autoscale unit whose unit file lacks it (daemon-reload only).
#   4. Rewrites `{{ GetPrivateIP }}` / `__PRIVATE_IP__` in nomad.hcl to the IP.
#   5. Checks once (no waiting) whether the live leader and `nomad server
#      members` show the configured advertise IP. Restarts Nomad if nomad.hcl
#      or the nomad.service dependency changed OR the live check failed, then
#      waits (bounded). A content-only update of the oneshot just daemon-reloads.
#   6. Warns (non-fatal) if a Raft peer address differs from the advertise IP.
#   7. Warns (non-fatal) if nomad.hcl does not enable ACLs.
# It NEVER touches /opt/nomad/data (Raft state holds the ACL bootstrap/tokens)
# and never restarts nomad-private-ip.service (Requires= would restart Nomad).
#
# Keep the unit content and UFW rules in sync with infra/hetzner/cloud-init.yaml.
#
# Environment:
#   PRIVATE_SUBNET         (required) Private subnet CIDR, e.g. 10.0.0.0/24.
#   DOCKER_BRIDGE_SUBNET   Docker compose bridge subnet (default 172.18.0.0/16;
#                          pinned in docker-compose.yaml networks.default.ipam).
#   NOMAD_HCL              Path override (default /etc/nomad.d/nomad.hcl).
#   NOMAD_ACL_TOKEN_FILE   Path override (default /etc/nomad.d/acl-token).
#   SYSTEMD_DIR            Path override (default /etc/systemd/system).
#   CONVERGE_TIMEOUT_SECS  Max wait for leader + members after restart (default 60).
#   CONVERGE_POLL_SECS     Poll interval (default 2).

set -euo pipefail

PRIVATE_SUBNET="${PRIVATE_SUBNET:-}"
DOCKER_BRIDGE_SUBNET="${DOCKER_BRIDGE_SUBNET:-172.18.0.0/16}"
NOMAD_HCL="${NOMAD_HCL:-/etc/nomad.d/nomad.hcl}"
NOMAD_ACL_TOKEN_FILE="${NOMAD_ACL_TOKEN_FILE:-/etc/nomad.d/acl-token}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
CONVERGE_TIMEOUT_SECS="${CONVERGE_TIMEOUT_SECS:-60}"
CONVERGE_POLL_SECS="${CONVERGE_POLL_SECS:-2}"
NOMAD_LOCAL_ADDR="http://127.0.0.1:4646"
PRIVATE_IP_UNIT_NAME="nomad-private-ip.service"

LOG_PREFIX="converge-control-plane:"
CIDR_REGEX='^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$'
IPV4_REGEX='^([0-9]{1,3}\.){3}[0-9]{1,3}$'

log() { echo "${LOG_PREFIX} $*"; }
warn() { echo "${LOG_PREFIX} WARNING: $*" >&2; }
die() { echo "${LOG_PREFIX} ERROR: $*" >&2; exit 1; }

# ─── Validate inputs ─────────────────────────────────────────────────────────

[[ -n "${PRIVATE_SUBNET}" ]] || die "PRIVATE_SUBNET is required (e.g. 10.0.0.0/24)."
[[ "${PRIVATE_SUBNET}" =~ ${CIDR_REGEX} ]] || die "PRIVATE_SUBNET '${PRIVATE_SUBNET}' is not an IPv4 CIDR."
[[ "${DOCKER_BRIDGE_SUBNET}" =~ ${CIDR_REGEX} ]] || die "DOCKER_BRIDGE_SUBNET '${DOCKER_BRIDGE_SUBNET}' is not an IPv4 CIDR."

if [[ ! -f "${NOMAD_HCL}" ]]; then
  log "${NOMAD_HCL} not found (enable_nomad off?) — nothing to converge."
  exit 0
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

CHANGES=()
# nomad.service dependency changed (needs a Nomad restart) vs. only the
# oneshot's own content changed (daemon-reload is enough: the running Nomad
# process does not depend on the oneshot's script text).
NOMAD_UNIT_CHANGED=false
PRIVATE_IP_UNIT_CHANGED=false
AUTOSCALE_UNITS_CHANGED=false
HCL_CHANGED=false

# ─── 1. Resolve the private IP before mutating anything ─────────────────────

# Same rule as the unit: first address matching the subnet's first two octets.
# (-E instead of the unit's -P so this also runs where grep lacks PCRE.)
resolve_private_ip() {
  local prefix
  prefix="$(echo "${PRIVATE_SUBNET}" | cut -d. -f1-2)"
  ip -4 addr show | grep -oE "${prefix//./\\.}\.[0-9]+\.[0-9]+" | head -1 || true
}

PRIVATE_IP="$(resolve_private_ip)"
[[ "${PRIVATE_IP}" =~ ${IPV4_REGEX} ]] \
  || die "no ${PRIVATE_SUBNET} address on this host (ip -4 addr show); nothing was changed."
log "private IP ${PRIVATE_IP}."

# ─── 2. UFW rules (ufw skips rules that already exist) ──────────────────────

UFW_ADDED=0
ufw_allow() {
  local source="$1" port="$2" output
  output="$(ufw allow from "${source}" to any port "${port}" proto tcp)"
  if [[ "${output}" != *"Skipping"* ]]; then
    UFW_ADDED=$((UFW_ADDED + 1))
    log "ufw: ${source} -> ${port}/tcp: ${output}"
  fi
}

for port in 4646 4647 4648 5432 6379; do
  ufw_allow "${PRIVATE_SUBNET}" "${port}"
done
for port in 4646 4647 4648; do
  ufw_allow "${DOCKER_BRIDGE_SUBNET}" "${port}"
done
if [[ ${UFW_ADDED} -gt 0 ]]; then
  CHANGES+=("added ${UFW_ADDED} ufw rule(s)")
fi

# write_if_changed <path> <content> — writes content (mode 0644) only if it
# differs from what is on disk. Returns 0 if written, 1 if unchanged.
write_if_changed() {
  local path="$1" content="$2" candidate="${WORK_DIR}/candidate"
  printf '%s\n' "${content}" > "${candidate}"
  if [[ -f "${path}" ]] && cmp -s "${candidate}" "${path}"; then
    return 1
  fi
  mkdir -p "$(dirname "${path}")"
  cp "${candidate}" "${path}"
  chmod 0644 "${path}"
  return 0
}

# ─── 3a. nomad-private-ip.service (mirrors cloud-init.yaml) ──────────────────

PRIVATE_IP_UNIT="${SYSTEMD_DIR}/${PRIVATE_IP_UNIT_NAME}"
# Single-quoted heredoc: $VARS here are for /bin/sh at unit run time, not for us.
PRIVATE_IP_UNIT_CONTENT="$(cat <<'UNIT'
[Unit]
Description=Resolve Hetzner private IP and patch Nomad advertise before start
# Runs on EVERY boot (not just first boot) so a NIC that only comes up
# after a reboot still gets its private IP substituted into nomad.hcl.
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=PRIVATE_SUBNET="@PRIVATE_SUBNET@"
# Fails (and so blocks nomad.service via Requires=) ONLY when nomad.hcl still
# has the placeholder and no private IP is visible. An already-patched
# nomad.hcl always succeeds, so a late NIC never stops Nomad from starting.
ExecStart=/bin/sh -c 'set -eu; \
  SUBNET_PREFIX="$(echo "$PRIVATE_SUBNET" | cut -d. -f1-2)"; \
  PRIVATE_IP="$(ip -4 addr show | grep -oP "$SUBNET_PREFIX\.\d+\.\d+" | head -1 || true)"; \
  if ! grep -q "__PRIVATE_IP__" @NOMAD_HCL@ 2>/dev/null; then \
    echo "nomad.hcl already patched (no __PRIVATE_IP__ placeholder)"; \
  elif [ -z "$PRIVATE_IP" ]; then \
    echo "WARNING: private IP not yet available (subnet $PRIVATE_SUBNET); will retry next boot"; \
    exit 1; \
  else \
    sed -i "s/__PRIVATE_IP__/$PRIVATE_IP/g" @NOMAD_HCL@; \
    echo "Patched nomad.hcl advertise to $PRIVATE_IP"; \
  fi'

[Install]
WantedBy=multi-user.target
UNIT
)"
PRIVATE_IP_UNIT_CONTENT="${PRIVATE_IP_UNIT_CONTENT//@PRIVATE_SUBNET@/${PRIVATE_SUBNET}}"
PRIVATE_IP_UNIT_CONTENT="${PRIVATE_IP_UNIT_CONTENT//@NOMAD_HCL@/${NOMAD_HCL}}"

PRIVATE_IP_UNIT_VERB="installed"
[[ -f "${PRIVATE_IP_UNIT}" ]] && PRIVATE_IP_UNIT_VERB="updated"
if write_if_changed "${PRIVATE_IP_UNIT}" "${PRIVATE_IP_UNIT_CONTENT}"; then
  CHANGES+=("${PRIVATE_IP_UNIT_VERB} ${PRIVATE_IP_UNIT_NAME}")
  PRIVATE_IP_UNIT_CHANGED=true
fi

# ─── 3b. nomad.service ordering/dependency on nomad-private-ip ───────────────

NOMAD_UNIT="${SYSTEMD_DIR}/nomad.service"
DROPIN="${SYSTEMD_DIR}/nomad.service.d/10-private-ip.conf"

main_unit_has_dependency() {
  [[ -f "${NOMAD_UNIT}" ]] \
    && grep -Eq '^After=.*nomad-private-ip\.service' "${NOMAD_UNIT}" \
    && grep -Eq '^Requires=.*nomad-private-ip\.service' "${NOMAD_UNIT}"
}

if ! main_unit_has_dependency; then
  if write_if_changed "${DROPIN}" "$(printf '%s\n' '[Unit]' 'After=nomad-private-ip.service' 'Requires=nomad-private-ip.service')"; then
    CHANGES+=("installed nomad.service drop-in")
    NOMAD_UNIT_CHANGED=true
  fi
fi

# ─── 3c. Autoscale units load /etc/herobids/autoscale.env ───────────────────
# Older control planes have the autoscale units without EnvironmentFile=, so
# they never see the S3 creds or NOMAD_TOKEN (production, 2026-10-08). These
# are timer-driven oneshots: a daemon-reload is enough, no restart needed.

AUTOSCALE_UNITS=(nomad-autoscale nomad-scale-in nomad-placement-failure-watcher)
AUTOSCALE_ENV_DROPIN_NAME="10-autoscale-env.conf"
for unit in "${AUTOSCALE_UNITS[@]}"; do
  unit_file="${SYSTEMD_DIR}/${unit}.service"
  [[ -f "${unit_file}" ]] || continue
  grep -Eq '^EnvironmentFile=-?/etc/herobids/autoscale\.env' "${unit_file}" && continue
  if write_if_changed "${SYSTEMD_DIR}/${unit}.service.d/${AUTOSCALE_ENV_DROPIN_NAME}" \
    "$(printf '%s\n' '[Service]' 'EnvironmentFile=-/etc/herobids/autoscale.env')"; then
    CHANGES+=("installed ${unit}.service autoscale.env drop-in")
    AUTOSCALE_UNITS_CHANGED=true
  fi
done

# ─── 4. Substitute the private IP into nomad.hcl ────────────────────────────

# Generate the full new content first; only then truncate+write the target
# (cat >, not mv) so the file keeps its owner/mode. Brackets match literal
# braces in both GNU and BSD sed.
HCL_NEW="${WORK_DIR}/nomad.hcl.new"
sed -E \
  -e "s/[{][{] *GetPrivateIP *[}][}]/${PRIVATE_IP}/g" \
  -e "s/__PRIVATE_IP__/${PRIVATE_IP}/g" \
  "${NOMAD_HCL}" > "${HCL_NEW}"
if ! cmp -s "${HCL_NEW}" "${NOMAD_HCL}"; then
  cat "${HCL_NEW}" > "${NOMAD_HCL}"
  HCL_CHANGED=true
  CHANGES+=("patched nomad.hcl advertise to ${PRIVATE_IP}")
fi

if [[ "${NOMAD_UNIT_CHANGED}" == "true" || "${PRIVATE_IP_UNIT_CHANGED}" == "true" \
  || "${AUTOSCALE_UNITS_CHANGED}" == "true" ]]; then
  systemctl daemon-reload
fi
systemctl is-enabled --quiet "${PRIVATE_IP_UNIT_NAME}" \
  || systemctl enable --quiet "${PRIVATE_IP_UNIT_NAME}"

# Only `start` (never `restart`): with nomad.service Requires= this unit, a
# restart would propagate to Nomad. nomad.hcl is already patched, so the
# unit's run here is a no-op that just marks it active.
if ! systemctl is-active --quiet "${PRIVATE_IP_UNIT_NAME}"; then
  if ! systemctl start "${PRIVATE_IP_UNIT_NAME}"; then
    journalctl -u "${PRIVATE_IP_UNIT_NAME}" -n 20 --no-pager >&2 || true
    die "${PRIVATE_IP_UNIT_NAME} failed to start."
  fi
fi

# ─── 5. Live check, then restart Nomad only if needed ───────────────────────

advertised_rpc_ip() {
  awk '
    /^[[:space:]]*advertise[[:space:]]*[{]/ { inside = 1; next }
    inside && /^[[:space:]]*[}]/ { inside = 0 }
    inside && /^[[:space:]]*rpc[[:space:]]*=/ {
      if (match($0, /"[^"]+"/)) { print substr($0, RSTART + 1, RLENGTH - 2); exit }
    }
  ' "${NOMAD_HCL}"
}

ADVERTISE_IP="$(advertised_rpc_ip)"
[[ "${ADVERTISE_IP}" =~ ${IPV4_REGEX} ]] \
  || die "could not read advertise.rpc IP from ${NOMAD_HCL} (got '${ADVERTISE_IP}')."
if [[ "${ADVERTISE_IP}" != "${PRIVATE_IP}" ]]; then
  warn "nomad.hcl advertise.rpc is ${ADVERTISE_IP}, but this host's private IP is ${PRIVATE_IP}."
fi

HAS_TOKEN_FILE=false
[[ -r "${NOMAD_ACL_TOKEN_FILE}" ]] && HAS_TOKEN_FILE=true

nomad_cli() {
  local token=""
  [[ "${HAS_TOKEN_FILE}" == "true" ]] && token="$(cat "${NOMAD_ACL_TOKEN_FILE}")"
  NOMAD_ADDR="${NOMAD_LOCAL_ADDR}" NOMAD_TOKEN="${token}" nomad "$@"
}

LAST_LEADER=""
LAST_MEMBERS=""

# nomad_advertises <ip> — one check, no waiting. True when the leader is
# exactly "<ip>:<port>" and (if we hold a token) server members list <ip>.
# Without a token, `server members` may 403 under ACLs, so the leader alone
# decides.
nomad_advertises() {
  local ip="$1"
  LAST_LEADER="$(curl -s --max-time 3 "${NOMAD_LOCAL_ADDR}/v1/status/leader" 2>/dev/null || true)"
  [[ "${LAST_LEADER}" == "\"${ip}:"* ]] || return 1
  [[ "${HAS_TOKEN_FILE}" == "true" ]] || return 0
  LAST_MEMBERS="$(nomad_cli server members 2>/dev/null || true)"
  [[ "${LAST_MEMBERS}" == *" ${ip} "* ]]
}

wait_for_leader_on() {
  local ip="$1" waited=0
  while [[ ${waited} -le ${CONVERGE_TIMEOUT_SECS} ]]; do
    if nomad_advertises "${ip}"; then
      return 0
    fi
    sleep "${CONVERGE_POLL_SECS}"
    waited=$((waited + CONVERGE_POLL_SECS))
  done
  return 1
}

print_last_check() {
  echo "${LOG_PREFIX} last leader response: '${LAST_LEADER}'" >&2
  if [[ "${HAS_TOKEN_FILE}" == "true" ]]; then
    echo "${LOG_PREFIX} last server members:" >&2
    echo "${LAST_MEMBERS}" >&2
  fi
}

LIVE_MISMATCH=false
if ! nomad_advertises "${ADVERTISE_IP}"; then
  LIVE_MISMATCH=true
  log "live Nomad does not advertise ${ADVERTISE_IP} (leader '${LAST_LEADER}')."
fi

if [[ "${HCL_CHANGED}" == "true" || "${NOMAD_UNIT_CHANGED}" == "true" || "${LIVE_MISMATCH}" == "true" ]]; then
  log "restarting nomad (advertise ${ADVERTISE_IP})..."
  systemctl restart nomad
  CHANGES+=("restarted nomad")

  if ! wait_for_leader_on "${ADVERTISE_IP}"; then
    # Raft caution: do NOT attempt peers.json recovery or touch /opt/nomad/data
    # here; an operator must decide. Print the journal and stop.
    print_last_check
    echo "${LOG_PREFIX} journalctl -u nomad -n 80:" >&2
    journalctl -u nomad -n 80 --no-pager >&2 || true
    die "no Nomad leader advertising ${ADVERTISE_IP} within ${CONVERGE_TIMEOUT_SECS}s after restart. Manual Raft review needed; /opt/nomad/data was not touched."
  fi
fi
log "leader ${LAST_LEADER}; advertise ${ADVERTISE_IP} verified."

# ─── 6. Raft peer address check (warning only, never restarts) ──────────────

if RAFT_PEERS="$(nomad_cli operator raft list-peers 2>/dev/null)"; then
  STALE_PEERS="$(echo "${RAFT_PEERS}" \
    | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]+' \
    | grep -v "^${ADVERTISE_IP//./\\.}:" || true)"
  if [[ -n "${STALE_PEERS}" ]]; then
    warn "Raft peer address(es) $(echo "${STALE_PEERS}" | tr '\n' ' ')differ from advertise ${ADVERTISE_IP}. Fixing this needs operator peers.json recovery under /opt/nomad/data (not done here)."
  fi
else
  log "could not list Raft peers; skipped the Raft address check."
fi

# ─── 7. ACL check (warning only) ────────────────────────────────────────────
# cloud-init.yaml ships `acl { enabled = true }`. Not converged automatically:
# enabling ACLs needs a matching bootstrap + token rollout, or every client of
# the API is locked out. See docs/bug-reports/2026/10/08/003-*.md.

acl_enabled_in_hcl() {
  awk '
    /^[[:space:]]*acl[[:space:]]*[{]/ { inside = 1; next }
    inside && /^[[:space:]]*[}]/ { inside = 0 }
    inside && /^[[:space:]]*enabled[[:space:]]*=[[:space:]]*true/ { found = 1 }
    END { exit found ? 0 : 1 }
  ' "${NOMAD_HCL}"
}

if ! acl_enabled_in_hcl; then
  warn "ACLs are NOT enabled in ${NOMAD_HCL} (cloud-init.yaml has acl { enabled = true }); the Nomad API accepts anonymous requests. Enable + bootstrap per docs/bug-reports/2026/10/08/003-*."
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

if [[ ${#CHANGES[@]} -eq 0 ]]; then
  log "already converged."
else
  summary="$(printf '%s; ' "${CHANGES[@]}")"
  log "changed: ${summary%; }."
fi
