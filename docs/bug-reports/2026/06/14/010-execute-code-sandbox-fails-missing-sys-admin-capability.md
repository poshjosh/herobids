# 010 — execute_code Sandbox Fails: Missing CAP_SYS_ADMIN in Agent Container

- **Status:** OPEN
- **Severity:** High
- **Date:** 2026-06-14
- **Summary:** The `execute_code` tool always fails inside Docker-mode agent containers because `sandbox-exec.sh` requires `CAP_SYS_ADMIN` to create a network namespace, but agent containers are only granted `CAP_NET_ADMIN`. After three consecutive failures the tool circuit breaker opens, and the agent reports "code execution unavailable" for the rest of the session — even though the tool is enabled in policy.

## Symptoms

- Agent messages report `execute_code` as "suspended" or "unavailable" even when the capability grant has `enabled: true`.
- Container logs show: `mount --make-shared /var/run/netns failed: Operation not permitted`
- Immediately after, the circuit breaker fires: `"Tool circuit opened"` / `"Tool circuit open — ignoring"`.
- The agent does not receive any explanation that this is an infrastructure misconfiguration — it infers the tool is broken but has no way to distinguish that from a user-code failure.

## Root Cause

`sandbox-exec.sh` creates a Linux network namespace via `ip netns add <name>`. Internally, `ip netns add` calls `mount --make-shared /var/run/netns` to set mount propagation on the netns bind-mount directory. This `mount(2)` syscall requires `CAP_SYS_ADMIN`.

`DockerAgentManager` only adds `CAP_NET_ADMIN` to `CapAdd`:

```typescript
// apps/worker/src/agents/docker-agent-manager.ts
CapAdd: ['NET_ADMIN'],
```

Without `CAP_SYS_ADMIN`, the script hits `set -e` on the first `ip netns add` and exits non-zero. The `execute_code` tool treats this as a code-execution failure (exit code ≠ 0), increments the circuit-breaker failure counter, and after three invocations the circuit opens permanently for the session.

The reference implementation (aitradingbot `docker-manager.ts:367`) documents and applies both capabilities:
```typescript
CapAdd: ['NET_ADMIN', 'SYS_ADMIN'],
// comment in sandbox-exec.sh: "Requires: CAP_NET_ADMIN, CAP_SYS_ADMIN"
```

A secondary issue compounds the user experience: `code.ts` has no non-recoverable error detection. Infrastructure failures (e.g. `Operation not permitted`, `mount --make-shared`) are indistinguishable from user-code errors, so the circuit breaker fires before the agent gets any useful signal.

## Impact

- `execute_code` is fully broken in all Docker-mode deployments.
- Affects every agent session — the circuit breaker opens within the first tick if the agent tries code execution.
- The unsandboxed fallback (used in stub/local-dev mode) is NOT triggered in Docker mode; `hasSandbox` returns `true` because the script file exists, even though it cannot run. This means there is no silent degradation — the tool simply fails.

## Fix

Two changes are required.

### Change 1 — Add `CAP_SYS_ADMIN` to agent container capabilities

**File:** `apps/worker/src/agents/docker-agent-manager.ts`

Locate the `HostConfig` block inside the `start()` method (the `body` object passed to the Docker API). Change:

```typescript
CapAdd: ['NET_ADMIN'],
```

to:

```typescript
CapAdd: ['NET_ADMIN', 'SYS_ADMIN'],
```

`CAP_SYS_ADMIN` is needed solely for `mount --make-shared` during namespace creation. The container remains non-privileged; no host namespaces, host devices, or raw filesystem access are granted by this change. This matches aitradingbot's proven configuration.

### Change 2 — Detect non-recoverable sandbox errors in `execute_code`

**File:** `apps/worker/src/tools/code.ts`

Add a helper that recognises infrastructure-level failures (as opposed to user-code failures):

```typescript
const NON_RECOVERABLE_PATTERNS = [
  'Operation not permitted',
  'Permission denied',
  'mount --make-shared',
];

function isNonRecoverableSandboxError(stderr: string): boolean {
  return NON_RECOVERABLE_PATTERNS.some((p) => stderr.includes(p));
}
```

In the `catch` block of the sandbox execution (after `execErr` is destructured), before returning the generic failure result, add:

```typescript
if (isNonRecoverableSandboxError(stderr)) {
  return {
    success: false,
    data: { stdout, stderr, exitCode, durationMs: Date.now() - codeStartMs },
    error:
      'Sandbox infrastructure error (non-recoverable): the execute_code sandbox ' +
      'is misconfigured in this container. Do NOT retry — record this limitation ' +
      `in memory. Detail: ${stderr.slice(0, 300)}`,
    retryable: false,
  };
}
```

This gives the agent a clear, honest failure message that tells it to stop retrying and note the limitation — rather than burning three circuit-breaker slots on what the agent perceives as flaky code-execution failures.

## Files to Change

- `apps/worker/src/agents/docker-agent-manager.ts`
- `apps/worker/src/tools/code.ts`

## Verification

1. Rebuild the agent image after the `docker-agent-manager.ts` change.
2. Start a new agent session (Docker mode).
3. Ask the agent to run any Python or JavaScript snippet via `execute_code`.
4. Confirm: no `mount --make-shared` errors in container logs; tool returns a successful result.
5. To test Change 2 in isolation (without Docker): temporarily remove `sandbox-exec.sh` from the container PATH and confirm the agent receives the non-recoverable error message rather than triggering the circuit breaker.
6. Run `pnpm lint` — no new errors expected (both changes are additive).
