#!/bin/sh
# sandbox-egress.sh — UID-based egress rules for sandboxed agent commands.
#
# Run once by agent-entrypoint.sh, as root, when the container has NET_ADMIN.
# Replaces the per-command network namespace in the previous sandbox-exec.sh.
#
# Why rules keyed to a user, not a namespace:
#   - Only NET_ADMIN is needed. No mount, so no SYS_ADMIN and no AppArmor change.
#     Docker's default AppArmor profile denies `mount` on Nomad nodes.
#   - The rules apply to the container's network namespace. The agent runtime
#     (root) is not matched, so it keeps reaching Redis, Postgres and the API.
#     Only processes running as the agent user are restricted.
#
# Known limitations (accepted for simplicity; see the feature plan):
#   - Standard-mode commands run as the agent user, which has passwordless sudo
#     (docker/Dockerfile.agent). A command can run `sudo iptables -F`. These
#     rules guard against accidental private-network access. They are not a
#     security boundary.
#   - Full mode runs as root, and root is not matched by these rules. This is
#     intended: full mode means full control of the container.
#   - execute_code runs as root in every mode, so these rules do not restrict it.
#   - Loopback (127.0.0.0/8) is not blocked. Docker's embedded DNS resolver is on
#     loopback, and blocking it would break name resolution. Nothing else is
#     known to listen there in the agent container; check before relying on it.
#
# Fail closed: `set -e` stops at the first failed rule. The marker is written
# last, so sandbox-exec.sh refuses to run commands on a partial rule set.

set -eu

AGENT_USER=${SANDBOX_AGENT_USER:-agent}
MARKER_DIR=/run/herobids
MARKER="$MARKER_DIR/sandbox-egress-ready"
CHAIN=HEROBIDS_SANDBOX_EGRESS

mkdir -p "$MARKER_DIR"
rm -f "$MARKER"

AGENT_UID=$(id -u "$AGENT_USER")

# Keep only addresses of the requested family: 4 (no colon) or 6 (colon).
filter_family() {
  if [ "$1" = 6 ]; then
    grep ':' || true
  else
    grep -v ':' || true
  fi
}

# Nameservers from resolv.conf. Accepted first, so a private resolver still works.
resolver_addresses() {
  awk '/^nameserver/ {print $2}' /etc/resolv.conf 2>/dev/null | filter_family "$1"
}

# SANDBOX_ALLOWED_HOSTS is a comma-separated list of IPs or CIDRs, for example
# the browser pool on the Docker network. Entries with other characters are
# dropped, as the previous script did, so nothing unexpected reaches iptables.
allowed_addresses() {
  [ -n "${SANDBOX_ALLOWED_HOSTS:-}" ] || return 0
  printf '%s\n' "$SANDBOX_ALLOWED_HOSTS" | tr ',' '\n' | tr -d ' ' \
    | grep -E '^[0-9a-zA-Z.:/-]+$' | filter_family "$1" || true
}

# Private and link-local ranges. 172.16.0.0/12 includes the Docker bridge, which
# is why the browser pool needs an allowlist entry on a bridge network.
blocked_networks() {
  if [ "$1" = 6 ]; then
    printf '%s\n' fc00::/7 fe80::/10
  else
    printf '%s\n' 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16
  fi
}

add_rules() {
  ipt=$1
  family=$2

  # Rebuild the chain each time, so re-running the script is safe.
  $ipt -N "$CHAIN" 2>/dev/null || $ipt -F "$CHAIN"
  $ipt -C OUTPUT -m owner --uid-owner "$AGENT_UID" -j "$CHAIN" 2>/dev/null \
    || $ipt -I OUTPUT 1 -m owner --uid-owner "$AGENT_UID" -j "$CHAIN"

  # Replies to connections the agent user did not start (for example, a service
  # answering a sudo child) must not be cut off.
  $ipt -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

  for address in $(resolver_addresses "$family"); do
    $ipt -A "$CHAIN" -d "$address" -j ACCEPT
  done
  for address in $(allowed_addresses "$family"); do
    $ipt -A "$CHAIN" -d "$address" -j ACCEPT
  done
  for network in $(blocked_networks "$family"); do
    $ipt -A "$CHAIN" -d "$network" -j REJECT
  done
}

add_rules iptables 4
add_rules ip6tables 6

echo ok > "$MARKER"
echo "sandbox-egress: rules installed for user $AGENT_USER (uid $AGENT_UID)" >&2
