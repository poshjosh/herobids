#!/bin/sh
# sandbox-exec.sh — network namespace sandbox for agent code execution.
#
# Creates an isolated network namespace that:
#   - Allows public internet egress
#   - Blocks all RFC 1918 ranges (internal networks)
#   - Blocks link-local (169.254.169.254 — cloud metadata endpoints)
#   - Uses public DNS (8.8.8.8, 8.8.4.4) instead of Docker-internal resolver
#
# Requires CAP_NET_ADMIN and CAP_SYS_ADMIN in the container.
#
# Usage: sandbox-exec.sh <command> [args...]
#
# The child command inherits the sandbox network namespace.
# Cleanup is guaranteed on exit.

set -e

if [ $# -eq 0 ]; then
  echo "Usage: sandbox-exec.sh <command> [args...]" >&2
  exit 1
fi

NS="sandbox-$$"
VETH_HOST="veth-h-$$"
VETH_NS="veth-ns-$$"

cleanup() {
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$VETH_HOST" 2>/dev/null || true
}

trap cleanup EXIT

# Create the network namespace
ip netns add "$NS"

# Create veth pair: host side ↔ namespace side
ip link add "$VETH_HOST" type veth peer name "$VETH_NS"
ip link set "$VETH_NS" netns "$NS"

# Configure host side
ip addr add 10.200.0.1/30 dev "$VETH_HOST"
ip link set "$VETH_HOST" up

# Configure namespace side
ip netns exec "$NS" ip addr add 10.200.0.2/30 dev "$VETH_NS"
ip netns exec "$NS" ip link set "$VETH_NS" up
ip netns exec "$NS" ip link set lo up
ip netns exec "$NS" ip route add default via 10.200.0.1

# Configure NAT on host for the namespace traffic
iptables -t nat -A POSTROUTING -s 10.200.0.0/30 -j MASQUERADE 2>/dev/null || true
# Enable IP forwarding for sandbox NAT — best-effort.
# The write is wrapped in a subshell so that when /proc/sys is mounted
# read-only the redirect-open failure lands on the SUBSHELL's stderr (which
# 2>/dev/null suppresses) and surfaces as the subshell's exit status (caught
# by `if !`). A bare `echo 1 > file 2>/dev/null` would still leak a shell-level
# "can't create ...: Read-only file system" message, because the redirect is
# opened before the command's stderr redirection applies. `test -w` is
# insufficient here: it checks permission bits, not the read-only mount.
if ! ( echo 1 > /proc/sys/net/ipv4/ip_forward ) 2>/dev/null; then
  : # /proc/sys is read-only or otherwise unwritable — skip forwarding setup.
fi

# Allow operator-configured hosts (e.g. Browserless pool on Docker network).
# SANDBOX_ALLOWED_HOSTS is a comma-separated list of IPs or CIDRs.
if [ -n "${SANDBOX_ALLOWED_HOSTS:-}" ]; then
  _remaining="$SANDBOX_ALLOWED_HOSTS"
  while [ -n "$_remaining" ]; do
    _host="${_remaining%%,*}"
    if [ "$_host" = "$_remaining" ]; then
      _remaining=""
    else
      _remaining="${_remaining#*,}"
    fi
    if [ -n "$_host" ]; then
      # Validate: must look like an IP, CIDR, or hostname (no shell metacharacters)
      case "$_host" in
        *[!0-9a-zA-Z.:/\-]*) ;; # skip invalid entries
        *) ip netns exec "$NS" iptables -A OUTPUT -d "$_host" -j ACCEPT 2>/dev/null || true ;;
      esac
    fi
  done
fi

# Block RFC 1918 and link-local within the namespace
ip netns exec "$NS" iptables -A OUTPUT -d 10.0.0.0/8 -j REJECT 2>/dev/null || true
ip netns exec "$NS" iptables -A OUTPUT -d 172.16.0.0/12 -j REJECT 2>/dev/null || true
ip netns exec "$NS" iptables -A OUTPUT -d 192.168.0.0/16 -j REJECT 2>/dev/null || true
ip netns exec "$NS" iptables -A OUTPUT -d 169.254.0.0/16 -j REJECT 2>/dev/null || true

# Use public DNS inside the namespace
mkdir -p "/etc/netns/$NS"
echo "nameserver 8.8.8.8" > "/etc/netns/$NS/resolv.conf"
echo "nameserver 8.8.4.4" >> "/etc/netns/$NS/resolv.conf"

# Execute the command inside the sandbox namespace.
# Run in the foreground (not exec) so the EXIT trap fires and cleans up
# the namespace + veth pair. Using exec would replace the shell, preventing
# the trap from running and leaking veth interfaces that share the same
# 10.200.0.0/30 subnet — breaking routing for subsequent sandbox invocations.
ip netns exec "$NS" "$@"
_exit_code=$?
exit "$_exit_code"
