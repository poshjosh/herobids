# Inbound Routing

**Status:** draft
**Created:** 2026-10-04
**Parent:** [000-README.md](./000-README.md)
**Source ADRs:**
[ADR 06/002 Redis Streams Agent Transport](../../../tech/architecture/adrs/2026/06/002-redis-streams-agent-transport.md) (the `agent:outbound:{agentId}` stream the router delivers onto; at-least-once + dedup-by-`messageId` + transport-neutral envelope),
[ADR 06/001 Actor-Neutral Agent Protocol](../../../tech/architecture/adrs/2026/06/001-actor-neutral-agent-protocol.md) (the `user.message` envelope is actor-neutral — a chat inbound is just another actor source)

Inbound is the heart of the reply-only requirement: a user message must reach
the right agent. The existing Telegram webhook already does this well; the work
is to make the ingress and the reply→agent correlation **provider-neutral**,
and to solve correlation for providers that lack Telegram's `force_reply`.

## Current inbound flow (verified, Telegram-only)

`POST /telegram/webhook` (`agent-interactivity.ts`):
1. validate `x-telegram-bot-api-secret-token` against `webhookSecret`;
2. Zod-parse the Telegram update; ACK `200 {ok:true}` immediately;
3. process async — routing precedence:
   - **slash command** (`parseSlashCommand`) → `handle*` handler (needs user
     binding);
   - **reply-to-message** → `resolveAgentForTelegramReply(messageId, chatId)`;
   - **`/to <agent>` command** → `parseTelegramCommand` (supports `*`/`all`);
   - **plain text + exactly one running agent** → that agent;
4. deliver to the agent by `XADD agent:outbound:{agentId}` (a `user.message`
   envelope), same channel as `POST /agents/:id/message`.

The parsers, handlers, and Redis delivery are already provider-neutral (they
operate on strings and ids). Only steps 1–2 and the reply resolution are
Telegram-shaped.

## Target: one neutral ingress, per-provider adapters

```
POST /messaging/chat/:provider/webhook
   │
   ├─ GET  variant (WhatsApp verify handshake) → adapter.verifyChallenge()
   │
   ├─ adapter = ChatInboundAdapterRegistry.get(:provider)
   ├─ adapter.verify(req)        -- provider signature/secret (see below)
   ├─ ACK 200 immediately        -- all providers want a fast 200
   ├─ messages = adapter.parse(req)  -- → InboundChatMessage[]
   └─ for each message:
         ChatInboundRouter.route(message)   -- PROVIDER-NEUTRAL, reused logic
```

`ChatInboundRouter` is the current routing precedence lifted out of the Telegram
handler and generalised to operate on `InboundChatMessage`:

- slash command → existing `handle*` handlers (unchanged);
- reply → `resolveAgentForChatReply(provider, from.address, inReplyTo...)`
  (see correlation below);
- `/to <agent>` → existing `parseTelegramCommand` (rename to
  `parseChatTargetCommand`, behaviour unchanged);
- single running agent → that agent;
- then `XADD agent:outbound:{agentId}` exactly as today.

### Per-provider `verify`

| Provider | Verification |
| --- | --- |
| Telegram | `x-telegram-bot-api-secret-token` header == configured secret (today) |
| WhatsApp | GET verify-token handshake on subscribe; `X-Hub-Signature-256` HMAC over the body on events |
| SMS (Twilio) | `X-Twilio-Signature` HMAC validation against the request URL + params |

Each adapter owns its scheme; the router never sees provider headers.

## The hard part: reply→agent correlation without `force_reply`

Telegram threads replies natively: an outbound send uses `force_reply()`, so the
user's reply carries `reply_to_message.message_id`, which maps back to the agent
via the stored `provider_message_id` (040). **WhatsApp and SMS have no reliable
equivalent** — an inbound message is just "from this address to our
number/bot". Correlation strategies, in order of preference:

1. **Address-scoped single active binding (works for all three).** If an
   `(agent, provider)` binding is 1:1 with a user address — i.e. this phone
   number / wa_id belongs to exactly one user, and that user has exactly one
   running agent — route by address alone. This already matches the existing
   "plain text + single running agent" rule and covers the common case.
2. **WhatsApp context quoting.** WhatsApp inbound payloads include a `context`
   object when the user *quotes* a previous message; its `id` is the business's
   `provider_message_id`. Use it like Telegram's `reply_to_message` when present.
   Not guaranteed (users often don't quote), so it augments strategy 1/3.
3. **`/to <agent>` command for multi-agent disambiguation.** When a user has
   multiple running agents reachable on one brokered number, disambiguate via the
   existing `/to <agent>` command.

> **Brokered decision (020) narrows this.** Because all chat providers use a
> single shared platform number/bot, a per-agent dedicated inbound number is
> **not** available as a disambiguation lever — every user reaches every one of
> their agents through the same shared endpoint. Correlation therefore rests on
> strategy 1 (address + single running agent), strategy 2 (WhatsApp quoting /
> stored `provider_message_id`), and strategy 3 (`/to`). A per-user/per-agent
> number model is explicitly out of scope and would be a separate ADR (020).

**Recommendation**: implement strategy 1 as the baseline (reuses existing
single-agent logic and the new `chat_addresses` uniqueness), add strategy 2 for
WhatsApp opportunistically, and expose `/to` as the explicit disambiguator for
the multi-running-agent case on a shared number.

`resolveAgentForChatReply(provider, address, providerMessageId?)`:
- if `providerMessageId` present → look up `agent_outbound_messages` by
  `(delivery_provider, provider_message_id)` → owning agent (generalises
  today's Telegram join);
- else → resolve by `chat_addresses` + single-running-agent rule;
- else → `/to` or ambiguous → prompt the user (existing behaviour).

## SMS specifics

- Inbound STOP / START / HELP keywords must be intercepted **before** routing to
  an agent and must update `chat_addresses.status` (opt-out → `revoked`). This is
  a compliance requirement (030), not an agent concern.
- Multi-segment inbound messages are reassembled by the provider; the adapter
  receives the full text.

## Invariants

1. The router is provider-agnostic: it receives `InboundChatMessage` and never
   branches on provider for business logic.
2. Every provider ACKs fast (200) and processes async, matching the current
   Telegram anti-retry behaviour. The downstream `agent:outbound:{agentId}`
   envelope keeps a stable `messageId` so the agent runtime's dedup contract
   (ADR 06/002) holds regardless of provider retries.
3. Reply correlation degrades gracefully: `provider_message_id` → address+single
   agent → `/to` → ask. No provider is required to support native threading.
4. Opt-out keywords are honoured ahead of any agent delivery.
