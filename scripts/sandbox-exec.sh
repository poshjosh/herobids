#!/bin/sh
# sandbox-exec.sh — refuses to run a command unless egress rules are active.
#
# Called by the worker for every execute_shell and execute_code command. It
# does not create a network namespace. The egress rules are installed once per
# container by sandbox-egress.sh, which writes the marker checked below.
#
# Why not a namespace per command (the previous design):
#   `ip netns add` mounts /var/run/netns. That needs SYS_ADMIN and a mount,
#   which Docker's default AppArmor profile denies on Nomad nodes.
#
# Why fail when the marker is missing, instead of running unrestricted:
#   Without the rules, a standard-mode command could reach private networks.
#   A loud failure is safer than a silent one. Exit 97 is matched by
#   NON_RECOVERABLE_SANDBOX_PATTERNS in sandbox-utils.ts, so the agent is told
#   not to retry.
#
# Full mode and execute_code run as root, which these rules do not restrict
# (see sandbox-egress.sh). They still go through this check so every path
# behaves the same at container start.

MARKER=/run/herobids/sandbox-egress-ready

if [ $# -eq 0 ]; then
  echo "Usage: sandbox-exec.sh <command> [args...]" >&2
  exit 1
fi

if [ ! -f "$MARKER" ]; then
  echo "sandbox egress rules not active in this container" >&2
  exit 97
fi

exec "$@"
