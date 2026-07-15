# Telegram Reply Threading

## Status

`draft`

## Purpose

When an agent sends a message via Telegram, attach `ForceReply` markup so the user's Telegram client automatically opens in reply mode. When the user sends a reply, the incoming webhook update contains `message.reply_to_message.message_id`. We look that up against `agent_outbound_messages.telegram_message_id` to identify which agent sent the original message and route the user's reply directly to that agent — no syntax required.

## Scope

### In scope

1. Fully implement the Telegram webhook handler (currently a stub that drops all incoming messages).
2. Fix the webhook secret validation (security fix — currently compares against the bot token, which is wrong).
3. Register the webhook with Telegram at worker/API startup via `setWebhook`.
4. Attach `ForceReply` markup to every outbound agent Telegram message.
5. Resolve routing from `reply_to_message.message_id` → `agent_outbound_messages` → `agent_id`.
6. Route the user's reply into the agent's Redis outbound stream (`agent:outbound:{agentId}`).
7. Cold-start: when an agent session starts, send a platform "session started" message (also with `ForceReply`) so the user always has an anchor to reply to.
8. Reply to the user with a delivery confirmation or a clear error (agent not running, agent not found).
9. User verification: confirm the incoming `chat.id` matches `users.telegram_chat_id` before routing.
10. Tests (unit + integration).
11. User-facing documentation at `docs/public/documentation/telegram/reply-threading.md`.

### Out of scope

1. Slash command parsing (covered by `telegram-slash-commands` plan).
2. Telegram inline keyboard buttons (`callback_query`) — we use `ForceReply`, not inline keyboards.
3. Per-agent Telegram bot tokens.
4. Multi-user bot shared with multiple accounts.

## Problem Statement

The Telegram webhook handler at `POST /telegram/webhook` currently acknowledges every incoming update and immediately discards it:

```ts
// Acknowledge immediately — Telegram expects a fast response
// The update body can be processed asynchronously in a real implementation
return reply.status(200).send({ ok: true });
```

This means any message a user sends to the bot — including replies to agent messages — is silently dropped. There is no way for a user to send instructions to a running agent from Telegram today.

Additionally:
- The webhook secret validation incorrectly compares against the bot token rather than a separate webhook secret. The bot token must never travel in HTTP headers.
- `TelegramClient.sendText` does not attach `ForceReply`, so users have to manually use the reply feature in Telegram with no prompt.
- The webhook is never registered with Telegram (`setWebhook` is never called).

## Target End State

1. Every Telegram message sent by an agent arrives with `ForceReply` — the user's client automatically opens in reply mode.
2. When the user replies, the platform looks up the original agent from `telegram_message_id` and pushes the reply into `agent:outbound:{agentId}`.
3. The agent receives and processes the message at its next tick.
4. If the agent is stopped, the user receives a clear "Agent X is stopped" reply.
5. If the `telegram_message_id` is not found (e.g. message too old or DB pruned), the user receives an actionable fallback message.
6. All routing decisions are verified against the user's own `telegram_chat_id` — no cross-user leakage.

## Security Notes

- The current `secretHeader !== botToken` check in `telegramWebhookHandler` must be replaced. A separate `TELEGRAM_WEBHOOK_SECRET` env var (distinct from the bot token) should be generated at deploy time and passed to `setWebhook` as the `secret_token` parameter. This fix is mandatory and must land in the same slice as the webhook implementation.
- The bot token must never appear in request/response headers or logs.

## Data Flow

```
User replies to agent Telegram message
  → Telegram sends POST /telegram/webhook
  → Validate X-Telegram-Bot-Api-Secret-Token against TELEGRAM_WEBHOOK_SECRET
  → Parse update body: message.reply_to_message.message_id, message.chat.id, message.text
  → Verify message.chat.id matches a known users.telegram_chat_id → get userId
  → Query agent_outbound_messages WHERE telegram_message_id = reply_to_message.message_id
      AND agent.user_id = userId   ← ownership check
  → Get agent_id from matching row
  → Check agent status: if stopped/crashed → reply "Agent X is stopped"
  → xadd agent:outbound:{agentId} with user.message envelope
  → Reply "Delivered to <agent name>"
```

## Files Expected To Change

### API

- `apps/api/src/routes/agent-interactivity.ts` — implement `telegramWebhookHandler`, add `setWebhook` call
- `apps/api/src/config.ts` — add `TELEGRAM_WEBHOOK_SECRET` to operator config schema

### Worker / Alerting

- `apps/worker/src/alerting/telegram-client.ts` — add optional `reply_markup` param to `sendText` and a `ForceReply` helper; add `setWebhook` method
- `apps/worker/src/agents/agent-session-manager.ts` (or agent start path) — send "session started" platform message on agent start

### DB

- `packages/db/src/agent-repository.ts` — add `getAgentByTelegramMessageId(telegramMessageId: string, userId: string)` query

### Config

- `config/default.yaml` — document `TELEGRAM_WEBHOOK_SECRET` alongside existing `TELEGRAM_BOT_TOKEN`

### Tests

- `apps/api/src/routes/agent-interactivity.test.ts` — webhook routing, ownership check, not-found/not-running replies, secret validation
- `apps/worker/src/alerting/telegram-client.test.ts` — `ForceReply` markup shape, `setWebhook` call

### Documentation

- `docs/public/documentation/telegram/reply-threading.md`

## Implementation Plan

---

### Slice 1 — Security fix + webhook secret config

#### Goal

Replace the broken secret validation and introduce a proper `TELEGRAM_WEBHOOK_SECRET` config value.

#### Tasks

1. Add `telegramWebhookSecret` to operator config schema (`apps/api/src/config.ts` and `packages/domain/src/config/schema.ts`).
2. Update `telegramWebhookHandler` to compare `X-Telegram-Bot-Api-Secret-Token` against `telegramWebhookSecret` (not the bot token).
3. Document both `botToken` and `webhookSecret` in `config/default.yaml`.

#### Exit criteria

- Handler returns 401 when the header is absent or wrong.
- Handler returns 501 when Telegram is not configured (no bot token).
- Bot token is never read or logged in the request path.

---

### Slice 2 — `ForceReply` on outbound agent messages + `setWebhook` registration

#### Goal

Every agent Telegram message arrives with `ForceReply` markup. The webhook is registered with Telegram at startup.

#### Tasks

1. Add `replyMarkup?: Record<string, unknown>` parameter to `TelegramClient.sendText`.
2. Add a `forceReply()` helper that returns `{ force_reply: true, selective: true }`.
3. Pass `forceReply()` as `replyMarkup` when the broker calls `sendText` in `handleSendMessage`.
4. Add `setWebhook(url: string, secretToken: string)` method to `TelegramClient`.
5. Call `setWebhook` at worker startup (or API startup — wherever Telegram is wired in) with the configured public webhook URL.
6. Add `telegramWebhookUrl` to operator config schema so it is explicit and validated.

#### Exit criteria

- Outbound Telegram messages include `reply_markup: { force_reply: true, selective: true }`.
- `setWebhook` is called once at startup with the correct URL and secret.

#### Dev-time note

`setWebhook` requires a publicly reachable HTTPS URL. In local development this means using a tunnel (e.g. ngrok). `telegramWebhookUrl` should be omitted from `config/default.yaml` so that startup skips `setWebhook` when the value is absent — developers opt in explicitly rather than failing silently with an unreachable localhost URL.

---

### Slice 3 — DB query: resolve agent from Telegram message ID

#### Goal

Given a `telegram_message_id` and a `userId` (derived from `chat_id`), return the owning agent.

#### Tasks

1. Add `getAgentByTelegramMessageId(telegramMessageId: string, userId: string)` to `AgentRepository`. Joins `agent_outbound_messages` → `agents` and filters by `agents.user_id = userId`.
2. Returns `{ agentId: string; agentName: string; status: string } | null`.

#### Exit criteria

- Returns null when `telegram_message_id` is not found.
- Returns null when found but agent belongs to a different user (ownership enforced in the query).

---

### Slice 4 — Webhook handler: parse and route replies

#### Goal

Incoming Telegram updates that are replies to agent messages get routed to the correct agent.

#### Tasks

1. Parse the Telegram `Update` object from the request body (type-safe minimal parsing — no full SDK needed).
2. Resolve `userId` from `message.chat.id` via `users.telegram_chat_id`. If not found, return 200 (not our user) with no action.
3. If `message.reply_to_message` is present:
   a. Look up agent via `getAgentByTelegramMessageId`.
   b. If not found → send "I couldn't find which agent that reply belongs to. The message may be too old." via Telegram.
   c. If agent is stopped/crashed → send "Agent <name> is stopped and cannot receive messages right now."
   d. If agent is running/starting/paused → push to `agent:outbound:{agentId}` stream with `type: 'user.message'` envelope, send "Delivered to <name>." confirmation.
4. If `message.reply_to_message` is absent → no routing (slash commands plan handles this case).
5. Always return 200 to Telegram within the response (fire-and-forget async processing if needed).

#### Exit criteria

- Reply to an agent message routes to the correct agent's stream.
- Reply to a foreign message (not an agent message) sends a user-facing fallback.
- No cross-user routing possible.

---

### Slice 5 — Cold-start: session started message

#### Goal

When an agent session starts, the platform sends a Telegram message with `ForceReply` so the user always has an anchor to reply to, even before the agent sends its first message.

#### Tasks

1. In the agent start path (session manager or agent actor start), after the agent status transitions to `running`, call `TelegramClient.sendText` with a "session started" message and `ForceReply`.
2. Persist to `agent_outbound_messages` with `authoredBy: 'platform'` so the `telegram_message_id` is stored and reply routing works.
3. Message text: `<b><agent name></b> is now running. Reply to this message to send it instructions.`

#### Exit criteria

- When an agent starts, a platform message appears in the user's Telegram chat.
- Replying to that message routes to the agent.

---

### Slice 6 — Tests

#### Tasks

1. Unit test `TelegramClient.sendText` sends `ForceReply` markup when flag is passed.
2. Unit test `getAgentByTelegramMessageId` returns correct agent / null for cross-user case.
3. Unit test webhook handler: reply routing, not-found, not-running, missing `chat_id`, wrong secret.
4. Integration test: full reply flow end-to-end (webhook → DB lookup → Redis stream write).

---

### Slice 7 — Documentation

#### Tasks

1. Create `docs/public/documentation/telegram/reply-threading.md` explaining:
   - How to link your Telegram account (existing flow)
   - That agent messages arrive with reply mode pre-activated
   - What happens when you reply
   - What the "session started" message is
   - Error messages the bot may send and what they mean
