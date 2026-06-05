# Bug Report: Agent stub launcher never emits heartbeats — agents never reach `active` state

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-04
- **Summary:** Starting an AI agent via `POST /agents/:id/start` caused the agent to enter `starting` state and the session to enter `launching`, but neither ever progressed further. The agent remained stuck indefinitely (or until the 30 s health-check timeout cleaned up the session). No error was surfaced to the user.

## Root Cause

`AgentRuntimeLauncher` is the stub V1 launcher used in development and paper-mode environments. It creates an in-memory session handle and returns a session ID to `AgentSessionManager`, but it never published any messages to the Redis stream `agent:inbound:{tradingInstanceId}`.

`AgentSessionManager` waits for heartbeat messages on that stream (via `AgentStreamConsumer` → `AgentMessageBroker`) to transition a session from `launching` to `running` and ultimately set the agent's status to `active`. Since no heartbeats were ever published, the state machine stalled:

- Agent status: `starting` → stuck
- Session status: `launching` → cleaned up after 30 s timeout

The session manager's health-check loop would eventually detect the stale session and clean it up, but the agent UI showed no meaningful feedback beyond "starting" throughout.

## Fix

`AgentRuntimeLauncher` now accepts an optional `AgentRuntimeLauncherConfig` with a Redis client. When Redis is provided, `launch()` starts a stub heartbeat loop that publishes well-formed `agent.runtime.heartbeat` envelopes to `agent:inbound:{tradingInstanceId}` every `heartbeatIntervalMs` (default 5 000 ms):

```typescript
const envelope = {
  schemaVersion: 'v1',
  messageId: crypto.randomUUID(),
  correlationId: handle.sessionId,
  initiatorType: 'agent',
  initiatorId: handle.agentId,
  tradingInstanceId,
  type: 'agent.runtime.heartbeat',
  createdAt: new Date().toISOString(),
  payload: { sessionId: handle.sessionId, status: 'ready' },
};
await this.redis!.xadd(streamKey, '*', 'envelope', JSON.stringify(envelope));
```

The Redis client is injected in `apps/worker/src/index.ts`:

```typescript
const agentRuntimeLauncher = new AgentRuntimeLauncher({ redis: redisClient });
```

Heartbeat timers are cleared on `stop()`, `kill()`, and `stopAll()` to prevent leaked intervals.

## Long-term Fix

The stub heartbeat is a workaround for the absence of a real agent container process. When a production runtime is integrated, it will publish heartbeats natively and the stub loop will be removed. The launcher interface (`AgentRuntimePort`) remains unchanged.

## Files Changed

- [apps/worker/src/agents/agent-runtime-launcher.ts](../../apps/worker/src/agents/agent-runtime-launcher.ts)
- [apps/worker/src/index.ts](../../apps/worker/src/index.ts)

## Verification

- Agent starts and transitions to `active` within ~5 s.
- Heartbeat messages appear in the Redis stream `agent:inbound:{tradingInstanceId}`.
- `AgentSessionManager` transitions the session to `running` on first heartbeat.
- `pnpm lint` passes.
