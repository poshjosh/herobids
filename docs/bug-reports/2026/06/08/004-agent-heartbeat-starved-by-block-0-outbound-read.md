# Bug: Agent Heartbeats Starved by BLOCK 0 on Shared Redis Connection

**Date:** 2026-06-08
**Severity:** High — causes recurring session-unhealthy/reconnect cycles every ~60 s for every running agent
**Status:** Closed

## Symptom

Recurring stale-heartbeat reconnects at a regular cadence (observed: every ~2 min across 4 cycles).
On each cycle:

1. Health monitor marks session `unhealthy`, emits `instance.guardrail.triggered` with `code: 'heartbeat.timeout'`.
2. Worker fires reconnect recovery, which replays `instance.guardrail.triggered` (and other high-value events) back into `agent:outbound:{agentId}`.
3. Session transitions back to `running`.
4. The cycle repeats at the next tick.

## Root Cause

`readOutboundMessages()` in `apps/worker/src/agent.ts` issues:

```typescript
const result = await redis.xreadgroup(
  'GROUP', CONSUMER_GROUP, CONSUMER_NAME,
  'COUNT', '10',
  'BLOCK', '0',          // ← infinite block on the shared connection
  'STREAMS', OUTBOUND_STREAM, '>',
);
```

The function is wrapped in a `Promise.race` with a 2 s timeout:

```typescript
const incomingMessages = await Promise.race([
  readOutboundMessages(),
  new Promise<...>((resolve) => setTimeout(() => resolve([]), 2000)),
]);
```

When the 2 s JS timeout fires and `Promise.race` resolves to an empty array, JS continues to the LLM call. **However, the ioredis TCP connection is still committed to the `XREADGROUP BLOCK 0` command.** ioredis queues any new commands — including `xadd` calls from the heartbeat `setInterval` — behind the in-flight blocking read.

The LLM call can take 30–60 s (`llm.timeoutMs: 60000`). During that window:

- Heartbeats fire every 5 s but are queued and never delivered to Redis.
- After 30 s the health monitor finds `lastHeartbeatAt` stale and calls `markUnhealthy`.
- `emitGuardrailTriggered` writes to the outbound stream.
- **This delivers a message to the stream, unblocking the `XREADGROUP BLOCK 0` command.**
- The queued `xadd` heartbeats flush all at once.
- `handleHeartbeat` promotes the session back to `running` and fires `handleReconnect`.

The reconnect then replays `instance.guardrail.triggered` (it is in `REPLAY_TYPES`), accumulating heartbeat-timeout guardrail copies in the stream with each cycle. The `is_replay` field correctly prevents exponential growth, but each new cycle still appends fresh originals.

### Relevant timing from operator config

```
llm.tickIntervalMs:       60000   # 1-minute reasoning loop
llm.heartbeatIntervalMs:  5000    # heartbeats every 5 s (forwarded as HEARTBEAT_INTERVAL_MS)
llm.timeoutMs:            60000   # LLM call may take up to 60 s
heartbeatTimeoutMs:       30000   # session marked unhealthy after 30 s without a heartbeat
healthCheckIntervalMs:    10000   # health monitor runs every 10 s
```

With a 60 s LLM timeout, the session consistently exceeds the 30 s heartbeat threshold during the LLM call phase of every tick where the outbound stream is idle.

### Why the outbound stream is idle

Between ticks, no platform messages arrive for most agents (no live decisions, no reconciliation notices). The BLOCK 0 command therefore holds the connection for the entire tick duration rather than returning quickly when messages arrive.

## Affected files

- `apps/worker/src/agent.ts` — `readOutboundMessages()` — **fixed here**

## Fix

Change `BLOCK '0'` to `BLOCK 1500` so the `XREADGROUP` command completes on its own within 1.5 s maximum — comfortably inside the existing 2 s `Promise.race` timeout — and releases the connection promptly.

```diff
- 'BLOCK', '0',
+ 'BLOCK', 1500,
```

This guarantees the connection is free within ≤1.5 s, so heartbeat `xadd` calls execute promptly rather than queuing behind an indefinitely blocked connection.

## What this does NOT change

- Replay behaviour for `instance.guardrail.triggered` is **not changed**. Guardrail events continue to be replayed on reconnect per the recovery spec.
- The `Promise.race` guard stays in place as a secondary safety net.
- No session-state, health-monitor, or reconnect logic is changed.

## Verification

After the fix, the `agent-health-monitor` log line `'Stale agent session detected'` should stop appearing at the regular per-tick cadence for idle agents. Platform alert `RUNTIME_UNHEALTHY` should no longer fire repeatedly for healthy, continuously-heartbeating containers.
