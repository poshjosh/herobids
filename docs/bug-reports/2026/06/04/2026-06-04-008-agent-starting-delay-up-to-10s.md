# Bug Report: Agent showed "starting" for up to 10 s after clicking Start

- **Status:** CLOSED
- **Severity:** Low
- **Date:** 2026-06-04
- **Summary:** After clicking "Start" on an AI agent, the UI correctly showed the `starting` status badge, but the agent could stay in `starting` for up to 10 seconds before the worker transitioned it toward `active`. The delay was noticeable and felt like the system was unresponsive.

## Root Cause

`AgentSessionManager` reconciles starting sessions on a fixed polling interval (`healthCheckIntervalMs`, default 10 000 ms). When the API set the agent and session status to `starting`, the worker only discovered the new session on the next reconcile tick — which could be up to 10 s after the API response.

There was no push-based trigger (queue job, pub/sub) from the API to the worker when an agent started, so the worst-case lag was the full polling interval.

Bug 005 improved the UI feedback (polling, error banners) but did not shorten the window between API response and worker pick-up.

## Fix

Reduced `healthCheckIntervalMs` from the default 10 000 ms to 2 000 ms in `apps/worker/src/index.ts`:

```ts
const sessionManager = new AgentSessionManager(
  agentRepo, eventPublisher, agentRuntimeLauncher,
  { healthCheckIntervalMs: 2000 },   // was: undefined (default 10 s)
  agentReconnectHandler, platformAlerts
);
```

The reconcile function performs lightweight DB queries (one JOIN select + one conditional UPDATE), so a 2 s interval is appropriate for small-to-medium deployments. Worst-case start latency is now ~2 s.

## Files Changed

- [apps/worker/src/index.ts](../../apps/worker/src/index.ts)

## Verification

- Ran `pnpm lint`
- Result: `tsc --noEmit` completed successfully with no errors

## Regression Tests

`apps/worker/src/agents/agent-session-manager.test.ts` — **`healthCheckIntervalMs configuration (bug-008 regression)`** describe block with two tests:

- **`default interval is 10 000 ms — production MUST override to a lower value`** — constructs `AgentSessionManager` without any config override and asserts `config.healthCheckIntervalMs === 10_000`. Documents that the default is the problematic slow value and any production deployment MUST explicitly pass `{ healthCheckIntervalMs: 2000 }`.
- **`accepts a custom healthCheckIntervalMs that overrides the default`** — constructs with `{ healthCheckIntervalMs: 2000 }` and asserts the config reflects `2000`. Verifies the fix (passing `2000` from `apps/worker/src/index.ts`) is correctly stored and would be used by the reconcile timer.

The fix was also re-applied in `apps/worker/src/index.ts` (the `healthCheckIntervalMs: 2000` had been inadvertently dropped from the `AgentSessionManager` constructor options during later refactoring). All 15 `agent-session-manager.test.ts` tests pass.
