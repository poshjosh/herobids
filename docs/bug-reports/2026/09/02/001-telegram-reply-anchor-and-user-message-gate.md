# Bug Report: Non-trading agents get no Telegram reply anchor, and user messages are silently gated out

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-09-02
- **Discovered By:** Manual report — replying to a Telegram notification from agent `nonso-pa-1` returned "I couldn't find which agent that reply belongs to. The message may be too old.", and a `/to nonso-pa-1 <message>` said "Delivered to nonso-pa-1." but the agent never responded.
- **Summary:** Two distinct, compounding defects broke two-way Telegram messaging for a personal-assistant (non-trading) agent:
  - **(A) No reply anchor.** The session-started Telegram anchor (the message users reply to) was never sent for an agent without a trading binding, so reply routing had nothing to resolve against. The same coupling also caused an endless per-heartbeat "reconnect" loop.
  - **(B) User message gated out.** Even once delivered, a user message rarely reached the LLM: it did not reliably bypass the `context_hash` tick gate, and the runtime consumer group could lag so far behind that the message was never read into a tick.

---

## Investigation (live, local docker stack)

Agent `nonso-pa-1` (`59660b0f-…`, owner `a68aa9e6-…`) is a pure personal assistant — **0 `agent_connections`** (no trading binding).

- `agent_outbound_messages` was **empty for all agents** — no reply anchors existed anywhere, so `resolveAgentForTelegramReply(telegram_message_id, chat_id)` always returned null → the "couldn't find which agent" error.
- A genuine cold-start (stop→start via API; fresh session `starting → running`) still wrote **no anchor row**, and worker logs showed "Handling agent reconnect / Reconnect recovery complete" repeating **every ~5s**.
- Redis: `agent:sessions:count = 0`, `SISMEMBER agent:sessions:active = 0` — the session was **never recorded active**.
- Telegram transport itself was healthy (webhook registered, `pending_updates: 0`, no errors), confirming the fault was in application logic, not delivery.

Design intent confirmed in `docs/features/2026/06/15/011-telegram-reply-threading/001-plan.md`: reply anchors are the **session-started** message and agent **`send_message`** outputs. (The billing/soft-cap alert the user originally replied to was never designed to be a reply anchor.)

---

## Root Cause

### (A) Anchor + session-active bookkeeping wrongly coupled to trading-actor activation

In `apps/worker/src/index.ts`, the `onSessionActive` callback resolves a **trading** binding and returns `false` when there is none:

```ts
if (!binding) {
  logger.debug({ agentId }, 'No active binding for agent — grant fallback remains disabled');
  agentState.clearPending(agentId, sessionId);
  return false;   // ← treated as "activation not established"
}
```

In `AgentSessionManager.handleHeartbeat` (`apps/worker/src/agents/agent-session-manager.ts`), a `false` return means `activationEstablished = false`, which:

1. Skips `activatedSessions.add(sessionId)` and the Redis `agent:sessions:*` projection. On the next heartbeat, `shouldBootstrapRecovery` re-enters via `(status === 'running' && !activatedSessions.has(sessionId))`, so every heartbeat re-bootstraps → the endless reconnect loop.
2. Skips the anchor, which is gated `if (isFirstBoot && activationEstablished && this.config.onSessionStarted)`. So `sendSessionStartedTelegramAnchor` never runs → no `agent_outbound_messages` row → reply routing is impossible.

The bug is the overloaded `false`: genuine activation *failures* already **throw** (caught → `handleActivationFailure` → session stopped), and the transient "session superseded" case legitimately returns `false` to retry. But "no trading binding" is neither — the session is **fully activated, it just has no trading actor**. Returning `false` there conflated "no trading actor" with "not activated", excluding every non-trading agent.

### (B) User message never bypasses the context_hash gate / never read

`buildTickGateState` sets `hasWakeSignal` (which bypasses the `context_hash` gate) only from messages present in the current tick's `incomingMessages`. Two things defeated this for user messages:

1. The runtime consumer group read only `COUNT 10` per tick with `'>'` (oldest-first). Market events + status messages accumulate between the infrequent scheduled ticks (30 min on the `standard` cost preset), so the group fell hundreds of entries behind. A newly-arrived `user.message` sat beyond the cursor and was not read for many ticks.
2. The early tick scheduled on a user message therefore ran with the message **absent** from `incomingMessages`, so `hasWakeSignal` was false and the tick was skipped as `context_unchanged` — the LLM never ran.

(Consumer groups are independent, so this is a cursor-lag problem, not cross-group consumption.)

---

## Fix

### (A) `apps/worker/src/index.ts` — `onSessionActive` no-binding branch
Return `true` instead of `false` when there is no trading binding, with a comment explaining that the session is activated without a trading actor. The transient "session superseded" branch still returns `false`. This restores `activatedSessions` bookkeeping (stops the reconnect loop) and lets `onSessionStarted` fire the Telegram anchor for non-trading agents.

### (B1) `apps/worker/src/agents/outbound-message-reader.ts` — drain backlog
Replace the fixed `count: 10` with a `maxDrain` cap (default **200**) applied as the `COUNT` of a single blocking `XREADGROUP` (one round-trip, stays within the tick read-timeout budget). This keeps the runtime group from falling permanently behind so a user message (and current market context) reaches `incomingMessages` promptly. `apps/worker/src/agent.ts` passes `maxDrain: 200`.

### (B2) `apps/worker/src/agent.ts` — pending-user-message flag
Add a module-level `pendingUserMessage` flag. The wake-signal poll loop (`pollWakeSignals`, whose consumer group stays caught up) sets it when it observes a `user.message`/`agent.user.message`, then schedules an early tick. At tick start the flag is drained into `hasBufferedWake` (OR'd) so `buildTickGateState` sets `hasWakeSignal = true` — bypassing the `context_hash` gate **regardless of the runtime group's cursor position**. This mirrors how buffered `agent.wake` signals already solve the same race.

---

## Files Changed

- `apps/worker/src/index.ts` — `onSessionActive` no-binding branch returns `true`.
- `apps/worker/src/agents/outbound-message-reader.ts` — `maxDrain` (default 200) single-read backlog drain.
- `apps/worker/src/agent.ts` — `maxDrain` caller; `pendingUserMessage` flag set in `pollWakeSignals` and drained into the tick gate; user-message early-tick trigger.
- `apps/worker/src/agents/agent-session-manager.test.ts` — regression test: `onSessionActive` returning `true` with no trading actor activates the session and fires `onSessionStarted`, and a second heartbeat does not re-activate.
- `apps/worker/src/agents/outbound-message-reader.test.ts` — updated to the `maxDrain` API; added default-200 single-read and full-backlog-drain-surfacing-a-buried-user.message tests.

(Related prior-session fixes to the same responsiveness area — `tick-gate-state.ts`, `tick-gates`, `tick-thinking`, `tick-message-types` — remain in place.)

---

## Verification

- `pnpm lint` (`tsc --noEmit`): clean.
- Targeted suites (session-manager, outbound-message-reader, tick-gate-state, tick-gates, tick-thinking, tick-message-types): **244 passed**.
- Full `apps/worker` suite: **3411 passed, 21 skipped, 2 failed** — the 2 failures (`tools/code.test.ts`, `tools/shell.test.ts`, "does not misclassify ordinary permission stderr…") are **pre-existing and unrelated** (OS-specific permission-stderr assertions; confirmed by stashing these changes and re-running).
- **Live, after rebuilding the worker AND agent images and cold-starting `nonso-pa-1`:**
  - (A) `redis SISMEMBER agent:sessions:active = 1` immediately; on `starting → running` an anchor row appeared — `authored_by=platform, delivery_status=sent, telegram_message_id=135, telegram_chat_id=8681143261, body "nonso-pa-1 is now running. Reply to this message…"`. Reconnect loop stopped (1 reconnect in 40s vs every-5s before). Reply routing now has a valid anchor.
  - (B) Sent `POST /agents/:id/message`. The wake tick logged "Processing market wake signal" (`hasWakeSignal` true) and "Resolved tick thinking level … reason: user_message", and the LLM dispatched (deep/judge). **No `context_unchanged` skip** after the user message (previously every such tick skipped). Runtime group lag dropped from 300+ to ~20.

---

## Notes / Follow-ups

- **Agent behaviour (not a plumbing bug):** in the live test the judge LLM ran with `toolCalls: 0` and did not call `send_message` to reply. Whether a PA agent replies to a message is prompt/skill behaviour, separate from this infra fix.
- **Deployment note:** these fixes live in the agent runtime and worker. They require **rebuilding both `herobids-worker` and `herobids-agent:latest`** and cold-starting agents to take effect (the worker runs from a built image with no source mount; the reader/tick code runs inside the per-agent container).
- **Ops trap (latent, not fixed here):** the worker's `TELEGRAM_WEBHOOK_URL` is set to `http://localhost:3000/api/telegram/webhook` (localhost, `/api` prefix) while Telegram is registered against the ngrok tunnel at `<host>/telegram/webhook`. On the next worker restart the startup `setWebhook` would overwrite the working registration with an unreachable localhost URL (and the path prefix differs). Recommend unsetting `TELEGRAM_WEBHOOK_URL` locally (so startup skips re-registration and the ngrok registration persists) or setting it to the actual tunnel URL.
- **Cost cadence:** on the `standard` preset (30-min tick interval) a user message relies on the early-tick wake to be timely; the drain + pending-user-message flag ensure it is both processed and gate-bypassed rather than waiting for the next scheduled tick.
