# Bug Report: sandbox-exec.sh leaks veth pairs and namespaces — breaks sandbox networking after a few invocations

- **Status:** FIXED
- **Severity:** Critical
- **Date:** 2026-08-31
- **Summary:** The sandbox script uses `exec` to run the child command inside the network namespace, which replaces the shell process and prevents the cleanup trap from firing. Each invocation leaks a veth pair and network namespace, all sharing the same `10.200.0.0/30` subnet. The kernel routes return traffic to the first (stale) veth, causing a packet black hole. After a handful of sandbox invocations, all outbound networking from inside the sandbox fails — CDP connections time out, DNS queries fail, and HTTP requests hang.

## Symptoms

Agent `839c4438-3361-4067-b4fd-f5c9c62f2b72` had:
- `agent-browser` CDP connection failures: `Failed to connect via CDP to ws://172.18.0.2:3000`
- DNS failures from `execute_code`: `Error: <urlopen error [Errno -3] Try again>`
- 10 stale network namespaces (`sandbox-90` through `sandbox-329`)
- 10 stale veth pairs (`veth-h-90` through `veth-h-329`) all with `10.200.0.1/30`
- 10 competing kernel routes for `10.200.0.0/30` — first match is a stale veth

Despite correct iptables ACCEPT rules for `172.18.0.2` and correct `SANDBOX_ALLOWED_HOSTS` configuration, packets were routed to a stale veth whose peer namespace was no longer active.

## Root Cause

`scripts/sandbox-exec.sh` ends with:

```sh
exec ip netns exec "$NS" "$@"
```

`exec` replaces the current shell with `ip netns exec`, so the `trap cleanup EXIT` handler never fires. Every sandbox invocation leaves behind:
1. A network namespace (`sandbox-$$`)
2. A host-side veth interface (`veth-h-$$`) configured with `10.200.0.1/30`

Since all veths share the same `/30` subnet, the kernel routing table accumulates duplicate routes. The first (oldest, stale) route wins, and return traffic gets sent to a dead veth.

## Impact

- Any agent container that executes more than a few `execute_shell` or `execute_code` commands loses sandbox networking entirely.
- CDP connections to the browser pool time out (agent-browser fails).
- DNS queries to `8.8.8.8` fail (Python/wget network operations fail).
- The container must be restarted to recover — stale veths and namespaces persist for the container's lifetime.

## Files Involved

- `scripts/sandbox-exec.sh` — the `exec` at the end prevents cleanup

## Fix

Replace `exec ip netns exec "$NS" "$@"` with a foreground invocation that preserves the exit code:

```sh
ip netns exec "$NS" "$@"
_exit_code=$?
exit "$_exit_code"
```

The shell process stays alive, the EXIT trap fires on `exit`, and the cleanup function removes the namespace and veth pair. The child's exit code is preserved and propagated correctly.

## Files Changed

- `scripts/sandbox-exec.sh` — replaced `exec` with foreground run + explicit exit

## Verification

- `pnpm lint` passes.
