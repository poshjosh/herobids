# Bug Report 001 — User messages are woken but never read by the agent runtime (silent stall)

- **Status:** OPEN (root cause unconfirmed; investigation deferred)
- **Severity:** High (user messages to a running agent are silently dropped; the platform reports delivery as successful)
- **Date:** 2026-11-01
- **Environment:** staging (`herobids-staging`, `138.199.172.202`), `RUNTIME_BACKEND=nomad`
- **Agent:** `pa`, id `30fd88fb-97ce-4ac9-b664-9ed3bfcfbcbb`, owner `8dfb28e2-25f7-47e1-aa3e-a32919a09ed9`
- **Related:** bug report 001 (2026-10-28, web chat attachments not materialized on Nomad); `docs/bug-reports/2026/09/26/001-worker-cannot-reach-nomad-ufw-docker-bridge.md`

## Summary

The user's web-chat messages to agent `pa` are stored and published to `agent:outbound:30fd88fb-…`. The wake consumer receives them and wakes the runtime, but the runtime's own consumer group (`agent-runtime`) has not delivered any entry since **2026-11-01 14:30:43 UTC**. As a result the LLM never sees the user's text. The agent replies that it was "woken by a message" but the text "didn't come through". The platform records the user's messages as `sent`, so nothing in the UI or the logs shows the failure.

The runtime process is alive and ticking. No error is logged. The failure is silent.

## Observed Evidence

### User messages (Postgres, `conversation_messages`, read-only)

| created_at (UTC) | sender | channel | delivery_status |
|---|---|---|---|
| 2026-11-01 17:43:18.403 | user `8dfb28e2…` | web | sent |
| 2026-11-01 18:04:08.028 | user `8dfb28e2…` | web | sent |

Agent replies (`sender_type = agent`, channel telegram, all `delivery_status = sent`) at 17:28:04 (tg 187), 17:43:26 (tg 188), 18:04:12 (tg 189). The Telegram send succeeded, so the outbound path is not the failure.

### Wake path works

- Runtime alloc logs (`nomad alloc logs -namespace=herobids-agents -task agent 6a661704`): `Received user message between ticks` at 17:43:18.410 and 18:04:08.043 (UTC), each followed by `Scheduling early tick due to wake request`.
- The wake consumer group `agent-market-wake` on the same stream has lag 0. It sees every entry.

### Runtime consumer group is stalled

`XINFO GROUPS agent:outbound:30fd88fb-…` (checked about 18:17 UTC):

| group | last-delivered-id | lag | pending | entries-read |
|---|---|---|---|---|
| `agent-market-wake` | 1793556807669-0 (18:13:27) | 0 | 0 | 6741 |
| `agent-runtime` | **1793543443273-0 (14:30:43)** | **235** | 0 | 6506 |

`XINFO CONSUMERS agent-runtime`: one consumer, `agent-30fd88fb-…-1`, `idle` and `inactive` about 743 s (last successful read about 18:04).

The stream has `XLEN` 1000. Entries after the stall point: 2 `user.message`, 2 `agent.wake`, 995 `market.discovery.detected`, 1 `instance.status`. The first unread entries are normal ~680-byte system events. Nothing is oversized.

### Runtime process is alive

- Job: `agent-30fd88fb-…`, namespace `herobids-agents`, submitted **2026-11-01 17:27:35 UTC**, one allocation `6a661704` on node `9fed1a12` (`herobids-staging-agent-2`), status running.
- Heartbeats (`agent.runtime.heartbeat` on `agent:inbound:30fd…`) every 5 s, `status: "ready"`, `cpuPct: 0`, about 61 MB. Latest at 18:17:13 UTC.
- Alloc log: `Agent runtime starting`, `Redis connected`, `Wake-signal Redis connected`, `Agent tick starting` at tickCount 1–4. Ticks 2–4 were all wake-driven.
- Tick 4 (18:04:08.049): `Agent tick starting` → `Processing market wake signal` at 18:04:08.245 (about 200 ms later) → `Prepared tick context payload` with `mode: "diff"`, `estimatedTokens: 139`. The user's text is absent from the context.
- Alloc logs contain **no** `Failed to read outbound messages`, `onPausedReadError`, or any warn/error entry. `handleRuntimeFailure` logs `Agent runtime failure classified` at error level, and that line never appears.

### Timing

- The `agent-runtime` group stopped advancing at 14:30:43 UTC. That is before the staging disk cleanup (15:38 UTC), before the worker restart (17:12 UTC), and before the job resubmission (17:27:35 UTC). None of those events explains the stall.
- The job resubmission at 17:27:35 did not clear the stall. The new allocation has the same consumer name pattern and the same stalled group.

## Code Path (as read, not executed)

- `apps/worker/src/agent.ts` `readOutboundMessages()` (~1581): calls `readAgentOutboundMessages` with `consumerGroup: 'agent-runtime'` and `maxDrain: 200`.
- Tick read (~2661): `Promise.race([readOutboundMessages(), setTimeout(() => resolve([]), OUTBOUND_READ_TIMEOUT_MS)])`. `OUTBOUND_READ_TIMEOUT_MS` is 2000 ms. A timeout resolves to `[]` with no log.
- `apps/worker/src/agents/outbound-message-reader.ts`: `XGROUP CREATE … 0 MKSTREAM` (BUSYGROUP ignored), then `XREADGROUP GROUP agent-runtime <consumer> COUNT 200 BLOCK 1500 STREAMS <stream> >`. For each entry it parses the envelope and then `XACK`s it before returning. An empty result returns `[]` with no log.
- Two consumer groups read the same stream. The wake group (`agent.ts` ~1641–1711) sets `pendingUserMessage` and requests a tick. The content is consumed only by the `agent-runtime` group, inside the tick.
- The comments at `agent.ts` ~1574–1578 and ~1622 state that Redis "delivers each message to only ONE consumer group". This is incorrect. Each consumer group receives every entry. The design depends on this premise.

## Why It Is Not Yet Explained

The data shows that the `agent-runtime` group does not deliver entries, but not why. Candidate causes, none confirmed:

1. `XREADGROUP` on the runtime's Redis connection returns `null` or an error that is swallowed. The read path has no logging for empty results and no logging for timeouts.
2. The 2 s race times out on each tick. The inner read may still be pending, so its result (and acks) are discarded or never applied. This would not explain a stalled `last-delivered-id`, because a completed read would advance it.
3. A blocking read on a shared connection is stuck, and every later read on that connection queues behind it. A fresh process would clear this, but the stall persisted after the 17:27 resubmission, so this needs a check of whether the new allocation uses a different connection.
4. The runtime reads from a Redis instance or stream key other than the one inspected. Not supported by the evidence: the runtime's Redis client appears in `CLIENT LIST` on `herobids-redis-1`, and the wake consumer reads the same key.

Logs at info level on the runtime do not distinguish these cases.

## Architecture Concerns (independent of the root cause)

1. **Silent empty reads.** Timeouts and empty reads are indistinguishable from "no new messages". Nothing is logged.
2. **Ack before apply.** The reader `XACK`s each entry before the tick applies it. A crash between read and apply loses the message. A timed-out read also acks entries whose results are then discarded.
3. **Split consumers.** The wake group can succeed while the content group fails. The wake signal hides the failure.
4. **Misleading delivery state.** `conversation_messages.delivery_status = sent` means the message was published to Redis, not that the agent read it. No read receipt exists.
5. **No self-healing or alerting.** Nothing compares a consumer group's `last-delivered-id` with the stream tail, and nothing flags a user message unread for more than a few minutes.
6. **Wrong premise in comments.** The "one consumer group" claim (see Code Path) should be corrected or removed.

## Expected

- A user message to a running agent is read by the runtime and reaches the LLM prompt within one tick.
- If it is not read within about 60 s, the platform alerts and recovers without operator action.
- An empty or failed read is logged at warn or error with count and elapsed time.
- The UI shows a read receipt, not only a publish state.

## Files

- `apps/worker/src/agent.ts` — `readOutboundMessages`, tick read race, wake-group loop, misleading comments
- `apps/worker/src/agents/outbound-message-reader.ts` — read, ack-before-apply, silent empty result
- `apps/api/src/routes/agent-interactivity.ts` — publishes user messages to `agent:outbound`, marks `sent` on publish
- `apps/api/src/routes/chat-inbound-router.ts` — same publish pattern for Telegram-originated messages
- `apps/worker/src/agents/agent-runtime-launcher.ts` — Nomad job lifecycle (`Runtime reconcile complete via port`, logs no per-agent state)

## Investigation Plan (for later)

1. Add an info-level log per `readOutboundMessages` call: stream, group, entry count, elapsed ms, and whether the race timed out. Redeploy the `pa` runtime and observe.
2. Capture `CLIENT LIST` for the runtime's connection on `herobids-redis-1` during a stall, to see whether a blocking `XREADGROUP` is stuck.
3. Check the runtime's Redis host and key configuration against the worker's (`AGENT_RUNTIME_MODE=docker`, `RUNTIME_BACKEND=nomad`, `SHARED_REDIS_HOST`).
4. Check whether other agents show the same stall. Staging has about 8 other `herobids-agents` allocations. Compare `agent-runtime` `last-delivered-id` for each agent's outbound stream.
5. Reproduce on a fresh agent: send a web message and check whether the runtime reads it.

## Verification After Fix

- Staging: send a web message to a running agent; the agent's next reply quotes the message text. `XINFO GROUPS` shows `agent-runtime` lag 0 afterwards.
- Staging: force an empty or timed-out read (for example, pause Redis briefly); an error is logged and an alert fires.
- Unit: the reader acks only after the caller applies messages; a timed-out read does not drop entries.

## Unrelated Issues Seen During Investigation (not part of this bug)

- `herobids-skills-api-1`: 85 `Validation FAILED - not saving data` entries since 2026-10-28, e.g. `Skill count dropped by 71.1% (34311 → 9911)`. Separate data-integrity issue.
- `herobids-worker-1`: `evaluateAgentWatches: no ownerId — skipping` (WARN) about every 5 s for agent `bc033fb5-478f-4fa7-ae10-94b2f6023a8a`. Separate issue.
