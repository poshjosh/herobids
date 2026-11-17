# Bug Report: A slow Telegram call stalls the single inbound stream consumer, so heartbeats are not processed and a healthy agent is marked unhealthy

- **Status:** OPEN (diagnosed, fix not implemented)
- **Severity:** High
- **Date:** 2026-11-17
- **Discovered By:** Manual report. The agent detail page (`/agents/42008a23-16a7-4f4f-ae78-021d6faaa2c0`) showed "AI agent runtime is unhealthy. Heartbeats are missing and the worker is recovering." for an agent that was running normally.
- **Summary:** The worker reads every agent's inbound Redis stream in one serial loop and awaits each message's handler before reading the next. A `tick_skipped` message with reason `billing.soft_limit_reached` awaited a Telegram `sendMessage` call. That call has no timeout and took about 2 minutes to return `HTTP 504`. No other inbound message was processed during that time, including the agent's heartbeats. The health monitor then marked the session `unhealthy` after 30 s, and the broker rejected some of the agent's messages as stale. The agent itself never stopped.

## Symptom

- The agent detail page shows the yellow/red "runtime is unhealthy" banner shortly after an agent starts.
- The banner clears by itself about 2 minutes later.
- The agent container is up and logging normally throughout. No crash, no restart.

## Investigation (local docker stack, read-only)

Agent `42008a23-16a7-4f4f-ae78-021d6faaa2c0`, session `f1c9b264-f48a-4dca-b2ee-a6884da3827c`.

Timeline (UTC, 2026-11-17):

| Time | Event | Source |
|---|---|---|
| 17:40:01 | Container started, worker subscribed to the inbound stream | worker log |
| 17:40:06.19 | Heartbeat `ready` stored (last one stored for 2 minutes) | `agent_messages` |
| 17:40:06.22 | Heartbeat `busy` stored (tick start) | `agent_messages` |
| 17:40:06.236 | `agent.tick.started` stored | `agent_messages` |
| 17:40:06.338 | `agent.tick.skipped` (`billing.soft_limit_reached`) stored. Its handler starts the billing notification | `agent_messages` |
| 17:40:11 onward | Agent keeps publishing a heartbeat every 5 s (still seen in Redis at 17:42:21). None are stored | Redis `XREVRANGE` |
| 17:40:37 | Health monitor: "Stale agent session detected" (`lastHeartbeat` 17:40:06.225). Session set to `unhealthy` | worker log |
| 17:42:02 | "Failed to send the session-started message to Telegram" | worker log |
| 17:42:09 | "Billing notification chat delivery failed", `telegram.http_error`, `HTTP 504 Gateway Timeout` | worker log |
| 17:42:09.9 | The backlog is processed. 12 "Stale session message rejected at broker boundary" warnings are logged | worker log |
| 17:42:09 | "Handling agent reconnect" and "Reconnect recovery complete" (the unhealthy recovery path) | worker log |
| 17:42:46 | Session `running`, `last_heartbeat_at` current, heartbeats stored every 5 s again | DB |

Other facts:

- The Redis consumer group `agent-broker` on the agent's inbound stream shows `pending: 0`, `lag: 0`. The messages were not lost. They were delivered to the worker and sat unprocessed until the blocked handler returned.
- The agent container log shows no heartbeat errors (`Failed to send heartbeat` never appears). The agent side is healthy.
- `agent_messages` has no row between 17:40:06.338 and 17:42:09.919 for this agent, and the next rows are the agent's tool calls from the queued backlog.
- The agent's tool calls were not blocked by anything on the agent side. `add_skills` took about 15 s per call, which is a separate, unrelated slowness (see Not the cause).

## Root Cause

Three defects combine. Any one of them alone would have kept the blast radius small.

1. **One serial consumer for all agents.** `AgentStreamConsumer` (`apps/worker/src/agents/agent-stream-consumer.ts`) calls `XREADGROUP` over all subscribed agent streams, then runs:

   ```ts
   for (const [_streamKey, messages] of results) {
     for (const [messageStreamId, fields] of messages) {
       await this.processMessage(messageStreamId, fields, _streamKey);
     }
   }
   ```

   `processMessage` awaits `broker.processInbound`, which awaits the full handler. Heartbeats go through the same path as everything else, so one slow handler delays every message behind it, for this agent and for every other agent on the same worker.

2. **A slow side effect awaited inline in the handler.** `AgentMessageBroker.processInbound` handles `TICK_SKIPPED` with `await this.handleBillingNotification(...)` (`agent-message-broker.ts` around line 386). That method awaits `chatDelivery.send` (Telegram), then the email send. The notification is best-effort, but the inbound path waits for it.

3. **No timeout on the Telegram HTTP call.** `TelegramClient.sendText` (`apps/worker/src/alerting/telegram-client.ts`, line 39) calls `fetch(...)` with no `AbortSignal`. A slow or hanging Telegram gateway holds the call for as long as the network stack allows. Here it was about 2 minutes, ending in a 504. `setWebhook` and `setMyCommands` have the same shape.

The health monitor then did what it was designed to do. `heartbeatTimeoutMs` is 30 s (`agent-health-monitor.ts`, `agent-session-manager.ts`). It reads `last_heartbeat_at` from the DB, which is only updated by `handleHeartbeat`. A heartbeat that is published but not processed is indistinguishable from a missing one.

## Why the broker rejected agent messages (impact beyond the banner)

`processInbound` step 4 requires `isActiveSession` for every agent-originated message except heartbeat and session_ended. `isActiveSession` only accepts sessions in `running` status. While the session was `unhealthy`, non-heartbeat messages in the backlog failed this check:

```
WARN (agent-message-broker): Stale session message rejected at broker boundary   (x12 at 17:42:09)
```

The backlog was processed in order, and the heartbeat that restores `running` sat behind some of those messages. The 12 rejected messages are therefore dropped, not retried (`processMessage` always ACKs). I did not identify which message types were among the 12, so I cannot say whether any carried a decision. This needs checking before the fix is verified.

## Why it showed up now

- The agent was started at 17:40 on a local stack whose account was already `soft_limited`, so the very first tick emitted `billing.soft_limit_reached` and triggered a Telegram send.
- Telegram was returning 504s at the time (also seen on the session-started message at 17:42:02).
- Any worker with a billing notification, alert, or other awaited network call in a handler path is exposed in the same way. A Telegram outage or slow response makes every agent on that worker look unhealthy.

## Not the cause (ruled out)

- **Agent runtime heartbeats.** The runtime publishes every 5 s from a `setInterval` (`apps/worker/src/agent.ts`, `HEARTBEAT_INTERVAL_MS` 5000). Redis shows them arriving continuously.
- **Redis or consumer group.** `pending: 0`, `lag: 0`, one consumer, no NOGROUP or read-loop errors in the log.
- **Container health.** Container up, no exit events other than a "stale container exit — different session" info line at 17:38:43, which belongs to an earlier container.
- **Bug 2026/06/09/005** (stopped agent shows the unhealthy banner). That was a UI condition on `agent.status`. Here the session really was `unhealthy` in the DB.
- **Bug 2026/06/14/008** (survived containers marked stale after a worker restart). The worker had restarted at about 17:39:43, but the agent container was started fresh at 17:40:01 and heartbeats were flowing from the first second.
- **`add_skills` taking about 15 s per call.** The agent log shows two `add_skills` calls for `system/long-running-task` at 17:40:24 and 17:40:43, each followed by a 15 s gap. The agent says they timed out. This is slow, but the heartbeat timer is not blocked by it (heartbeats continued). It is a separate issue and is not investigated here.

## Reproduction Steps

1. Run the local stack with an account whose billing status is `soft_limited` (or force any `agent.tick.skipped` with a `billing.*` reason).
2. Make `api.telegram.org` slow or return 504 (for example by blocking it at the proxy, or by pointing the bot base URL at a server that delays its response by 2 minutes).
3. Start an agent.
4. Within 30 s of the first tick, the worker logs "Stale agent session detected" and the session becomes `unhealthy`, while the agent container keeps logging and heartbeats keep arriving in `agent:inbound:<agentId>`.
5. When the Telegram call returns, the backlog is processed, "Stale session message rejected" warnings appear, and the session returns to `running`.

**Expected:** a slow notification never delays heartbeats or other agents' messages. The session stays `running`.
**Actual:** all inbound processing for the worker pauses for the length of the notification call.

## Recommended Fix (not implemented)

The root cause is structural (1) and the trigger is local (2 and 3). Fix all three, in this order of value:

1. **Take heartbeats off the serial path.** Handle `agent.runtime.heartbeat` ahead of the queue (or on a separate consumer) so liveness is recorded independently of slow handlers. This also protects other agents on the same worker. A stricter alternative is per-agent concurrency, so one agent's slow handler cannot hold another's messages.
2. **Do not await best-effort notifications in the inbound path.** Fire `handleBillingNotification` without awaiting it and log failures, the way `onSessionStarted` is already invoked (`Promise.resolve(...).catch(...)` in `AgentSessionManager`). Keep the Redis dedup write so retries do not spam.
3. **Add a timeout to every Telegram HTTP call** (`AbortSignal.timeout(...)`). The value belongs in operator config, not a literal, per `docs/best-practices/configuration.md`.

Optional hardening:

- Log the duration of each `processMessage` and warn above a threshold, so a slow handler is visible before the health monitor fires.
- Consider whether messages rejected as `stale_session` while a session is `unhealthy` should be dropped or deferred. Today they are ACKed and lost.

## Tests the fix should add

- A heartbeat is processed while an earlier message's handler is still pending.
- A hung `chatDelivery.send` does not delay a following message from the same or a different agent.
- `TelegramClient.sendText` returns an error result (`telegram.timeout` or similar) when the server does not respond within the configured limit.

## Files Involved

- `apps/worker/src/agents/agent-stream-consumer.ts` (serial loop, `processMessage`)
- `apps/worker/src/agents/agent-message-broker.ts` (`processInbound`, `TICK_SKIPPED` case, `handleBillingNotification`)
- `apps/worker/src/alerting/telegram-client.ts` (`sendText`, no timeout)
- `apps/worker/src/agents/agent-health-monitor.ts`, `agent-session-manager.ts` (30 s heartbeat timeout; recovery in `handleHeartbeat`)
- `packages/db/src/agent-repository.ts` (`isActiveSession` accepts only `running`)

## Verification Notes

- Everything above comes from the local docker stack (worker, agent, Postgres, Redis logs and rows) and from reading the code. I did not reproduce the stall on demand.
- The 2-minute Telegram duration is inferred from timestamps (`tick.skipped` stored at 17:40:06.338, billing failure logged at 17:42:09). The Telegram client has no timeout, so the real duration is whatever the network returned. No timeout setting was found on the client or `fetch`.
- It is not yet known which message types were rejected as stale, or whether any carried agent decisions.
