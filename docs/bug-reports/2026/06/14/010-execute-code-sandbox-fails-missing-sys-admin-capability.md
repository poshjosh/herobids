# 010 — execute_code Sandbox Fails: Missing CAP_SYS_ADMIN in Agent Container

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-14
- **Summary:** The `execute_code` tool always fails inside Docker-mode agent containers because `sandbox-exec.sh` requires `CAP_SYS_ADMIN` to create a network namespace, but agent containers are only granted `CAP_NET_ADMIN`. After three consecutive failures the tool circuit breaker opens, and the agent reports "code execution unavailable" for the rest of the session — even though the tool is enabled in policy.

## Symptoms

- Agent messages report `execute_code` as "suspended" or "unavailable" even when the capability grant has `enabled: true`.
- Container logs show: `mount --make-shared /var/run/netns failed: Operation not permitted`
- Immediately after, the circuit breaker fires: `"Tool circuit opened"` / `"Tool circuit open — ignoring"`.
- The agent does not receive any explanation that this is an infrastructure misconfiguration — it infers the tool is broken but has no way to distinguish that from a user-code failure.

## Root Cause

This issue had two coupled causes:

1. `sandbox-exec.sh` creates a Linux network namespace via `ip netns add <name>`. Internally, `ip netns add` calls `mount --make-shared /var/run/netns`, which requires `CAP_SYS_ADMIN`.
2. `execute_code` treated sandbox bootstrap failures like ordinary tool faults, so repeated infrastructure errors were counted by the tool circuit breaker.

`DockerAgentManager` was only adding `CAP_NET_ADMIN` to `CapAdd`, which meant Docker-mode agents could see sandbox setup fail immediately with `mount --make-shared /var/run/netns failed: Operation not permitted`.

## Impact

- `execute_code` is fully broken in all Docker-mode deployments.
- Affects every agent session — the circuit breaker opens within the first tick if the agent tries code execution.
- The unsandboxed fallback (used in stub/local-dev mode) is NOT triggered in Docker mode; `hasSandbox` returns `true` because the script file exists, even though it cannot run. This means there is no silent degradation — the tool simply fails.

## Resolution

Two code changes shipped.

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

`CAP_SYS_ADMIN` is needed for `mount --make-shared` during namespace creation. The container remains non-privileged; this change only adds the capability required for the existing sandbox implementation.

### Change 2 — Detect non-recoverable sandbox errors in `execute_code`

**File:** `apps/worker/src/tools/code.ts`

The tool now recognises infrastructure-level sandbox failures when the sandbox script is in use and the stderr matches known namespace/bootstrap permission errors.

```typescript
const NON_RECOVERABLE_SANDBOX_PATTERNS = [
  'Operation not permitted',
  'Permission denied',
  'mount --make-shared',
];
```

Instead of returning a generic tool failure, `execute_code` now returns a non-retryable, non-fault result for this class of sandbox misconfiguration. Marking it as `fault: false` is important because it prevents the tool circuit breaker from opening on repeated infrastructure misconfiguration.

```typescript
if (usedSandbox && isNonRecoverableSandboxError(stderr)) {
  return {
    success: false,
    data: { stdout, stderr, exitCode, durationMs: Date.now() - codeStartMs },
    error:
      'Sandbox infrastructure error (non-recoverable): the execute_code sandbox ' +
      'is misconfigured in this container. Do NOT retry — record this limitation ' +
      `in memory. Detail: ${stderr.slice(0, 300)}`,
    retryable: false,
    fault: false,
  };
}
```

This gives the agent a clear, honest failure message that tells it to stop retrying and note the limitation — rather than burning three circuit-breaker slots on what the agent perceives as flaky code-execution failures.

## Files Changed

- `apps/worker/src/agents/docker-agent-manager.ts`
- `apps/worker/src/tools/code.ts`
- `apps/worker/src/agents/docker-agent-manager.test.ts`
- `apps/worker/src/tools/code.test.ts`
- `scripts/sandbox-exec.sh`

## Verification

1. Unit test: `execute_code` now returns a non-retryable, non-fault infrastructure error when sandbox bootstrap fails with the known permission signatures.
2. Unit test: `DockerAgentManager` now includes both `NET_ADMIN` and `SYS_ADMIN` in the container create request.
3. Runtime expectation: after rebuilding the agent image and starting a new Docker-mode agent session, `execute_code` should no longer fail at `mount --make-shared` during namespace creation.
4. Run `pnpm lint` — no new errors expected.
