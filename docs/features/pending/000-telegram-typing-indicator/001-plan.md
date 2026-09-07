# Plan: Telegram "typing…" indicator while an agent processes a user message

Status: pending
Owner: (unassigned)
Related discussion: perceived-latency reduction for Telegram agent replies

## Problem

When a user messages an agent via Telegram, the platform acknowledges quickly
("Delivered to <agent-name>."), but the agent's real reply arrives seconds to
tens of seconds later (early tick + blocking stream read + a full LLM
round-trip, up to `llm.timeoutMs` ≈ 60s). During that gap the user has no signal
that the agent is working.

Note (verified): a user message already triggers an *early tick* via
`requestWakeDrivenTick` (`apps/worker/src/agent.ts:~1507`) and bypasses the
context-hash gate via `pendingUserMessage`. So the delay is real thinking time,
not idle waiting. This feature masks that thinking time; it does not change tick
scheduling.

## Goal

Show Telegram's native "typing…" chat action in the user's chat while the agent
is producing a reply to their message, refreshing it periodically (Telegram's
typing action auto-expires after ~5s), and letting it stop naturally once the
reply is sent.

Non-goals:
- No streaming of partial content.
- No rephrasing of the existing "Delivered to…" acknowledgement (Option B was
  explicitly descoped).
- No config toggle for *which* message types trigger typing. Typing is tied to
  the reply path by code placement, not a feature flag.
- No new tick-lifecycle signalling contract between the agent container and the
  worker (rejected in favour of a bounded fixed-window refresh — see Decisions).

## Key facts established during investigation

1. `TelegramClient` (`apps/worker/src/alerting/telegram-client.ts`) has no
   `sendChatAction` method today. It only calls `/sendMessage`, `/setWebhook`,
   `/setMyCommands`.
2. The agent runtime process (`apps/worker/src/agent.ts`) is isolated: it holds
   **no** `TelegramClient` and no chat ID. It communicates only via Redis
   streams. It cannot send the typing action itself.
3. The agent's reply is sent out-of-(agent)-process by
   `AgentMessageBroker.handleSendMessage`
   (`apps/worker/src/agents/agent-message-broker.ts:~537`) via
   `this.telegram.sendText(chatId, text, forceReply())`. The broker already
   resolves the chat ID via `agentRepo.getEffectiveTelegramChatId(agentId)` and
   holds a `TelegramClient` (`workerTelegram`, injected in
   `apps/worker/src/index.ts:~1586`).
4. The **inbound** user message is enqueued by the **API** process
   (`apps/api/src/routes/agent-interactivity.ts` → `deliverTelegramMessage` →
   `xadd agent:outbound:<agentId>`), not by the worker. The worker has no direct
   "user message just arrived" event.
5. Sending any message to a chat implicitly clears the typing indicator on the
   Telegram client. Explicit cancellation of the refresh timer is still required
   so a stray refresh does not re-assert typing *after* the reply.
6. Operator config for Telegram lives in the `alerts.telegram` block:
   Zod schema at `packages/domain/src/config/schema.ts` (`TelegramChannelConfigSchema`
   and the surrounding `alerts.telegram` object), defaults in
   `config/default.yaml`.

## Design decision: where the timer lives

The user-message-arrived event (API) and the reply-sent event (worker broker)
are in **different processes**. Two viable placements:

- **Option 1 — Worker-only, keyed off the reply path (RECOMMENDED).**
  The worker cannot see the inbound arrival, but it does not need to. When a
  tick that was triggered by a user message begins producing output, the worker
  is the process that ultimately calls `sendText`. However, the worker only
  learns about the reply *at* `handleSendMessage` — which is the *end* of
  thinking, too late to show typing during it.

  Therefore the practical trigger is the **inbound side**. See Option 2.

- **Option 2 — Start on inbound (API), stop on reply (implicit).** The typing
  refresh is started where the inbound user message is handled
  (`apps/api/src/routes/agent-interactivity.ts`, right after
  `deliverTelegramMessage`). The API already has the `botToken` (via
  `alertsConfig.telegram`) and the `chatId` (it is handling the webhook). The
  refresh runs for a bounded window (config `maxWindowMs`) on a config interval
  (`refreshIntervalMs`). It stops when the window elapses. The eventual reply
  (sent by the worker) clears the on-screen indicator natively; the API-side
  refresh timer simply expires.

  This keeps the trigger at the only point that knows a user message just
  arrived, needs no cross-process signalling, and fails safe: worst case the
  indicator stops ~a few seconds before a slow reply (window shorter than think
  time), or the last refresh lands slightly before the reply (harmless).

**Chosen: Option 2 (start on inbound in the API, bounded fixed window).**
Rationale: it is the only placement where the "a user message just arrived"
event is observable; it respects process isolation; and the fixed window matches
the imprecise, self-expiring nature of the typing action (KISS — no new
messaging contract, no per-agent tick-lifecycle correlation state).

Trade-off accepted: if think time exceeds `maxWindowMs`, typing stops before the
reply. Mitigation: default `maxWindowMs` sized to comfortably cover the normal
case against `llm.timeoutMs` (~60s).

## Configurable values (per user requirement)

Both live under `alerts.telegram` (operator config layer — no hard-coded
magic numbers, per AGENTS.md):

- `typingRefreshIntervalMs` — how often to re-send the typing action.
  Default: `4000` (Telegram's typing status lasts ~5s).
- `typingMaxWindowMs` — upper bound on how long to keep refreshing after an
  inbound user message. Default: sized against `llm.timeoutMs` (e.g. `60000`).

Validation: startup Zod validation (fail fast), consistent with the rest of the
`alerts.telegram` block. Both are positive integers with defaults.

## Files to change

1. `apps/worker/src/alerting/telegram-client.ts`
   - Add `sendChatAction(chatId: string, action?: string): Promise<Result<...>>`
     hitting the `/sendChatAction` endpoint with `{ chat_id, action }`
     (default `action = 'typing'`), mirroring the existing `sendText`
     Result/error pattern. Reused by both processes (API and worker construct
     `TelegramClient` from the same class).

2. `apps/api/src/routes/agent-interactivity.ts`
   - After a user message is delivered to a target agent
     (`deliverTelegramMessage(...)`), start a bounded typing-refresh loop for
     that `chatId`: send `sendChatAction(chatId, 'typing')` immediately, then on
     `typingRefreshIntervalMs` up to `typingMaxWindowMs`, then stop.
   - Track active refreshers keyed by `chatId` so a fresh inbound message resets
     the window rather than stacking timers. Clear on process teardown.
   - Source the two intervals from the injected config (`alertsConfig.telegram`).
   - Uses the existing Telegram send helper / bot token already present in this
     module (the file already does `fetch(.../sendMessage)` — the
     `sendChatAction` call can reuse the same `botToken` + `fetch` pattern, or a
     shared `TelegramClient` instance; prefer reusing `TelegramClient` to avoid a
     second ad-hoc `fetch`).

3. `packages/domain/src/config/schema.ts`
   - Add `typingRefreshIntervalMs` and `typingMaxWindowMs` (positive int, with
     defaults) to the `alerts.telegram` object schema.

4. `config/default.yaml`
   - Add the two keys under `alerts.telegram` with documented defaults.

## Tests

- `apps/worker/src/alerting/telegram-client.test.ts` (or extend the existing
  `alert-dispatcher.test.ts` which already exercises `TelegramClient`): assert
  `sendChatAction` POSTs to `/sendChatAction` with `{ chat_id, action: 'typing' }`
  and maps success/error to `Result`.
- API-side: a focused test that starting the refresher issues an immediate
  typing action and reschedules on the configured interval, and that it stops at
  `typingMaxWindowMs`. Use fake timers.
- Config: schema test asserting defaults and rejection of non-positive values
  (follow existing `alerts.telegram` schema test patterns).

## Open items to confirm at implementation time

- Confirm the exact call site(s) in `agent-interactivity.ts` where
  `deliverTelegramMessage` is invoked (reply path, `/to` path, single-agent
  path, document path) and decide which should start typing. Likely all
  text-delivery paths; document delivery is optional.
- Decide whether the API already constructs a shared `TelegramClient` or only
  uses ad-hoc `fetch`; if the latter, construct one from `alertsConfig.telegram.botToken`
  to reuse the new `sendChatAction` rather than duplicating the fetch.
- Confirm default `typingMaxWindowMs` against the effective `llm.timeoutMs`.

## Risks

- If `agent-interactivity.ts` uses a plain `fetch` helper rather than
  `TelegramClient`, file #2 may either add a `TelegramClient` instance or add a
  local `sendChatAction` fetch. Prefer the shared client to keep one code path.
- Multiple rapid user messages to the same chat must reset (not stack) the
  refresh window; the `chatId`-keyed tracker handles this.
- Refresh timers must be cleared on shutdown to avoid dangling intervals.
