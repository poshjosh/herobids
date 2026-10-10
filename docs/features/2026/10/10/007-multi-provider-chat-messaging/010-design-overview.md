# Design Overview — The Chat Channel Abstraction

**Status:** draft
**Created:** 2026-10-04
**Parent:** [000-README.md](./000-README.md)
**Normative inputs — feature docs:**
[009 registry manifest](../../../../pending/000-capability-foundations/009-initial-capability-registry-and-tool-ownership-manifest.md),
[010 activation model](../../../../pending/000-capability-foundations/010-capability-activation-model.md),
[013 native vs external](../../../../pending/000-capability-foundations/013-native-capabilities-and-external-backends.md)
**Source ADRs:**
[ADR 07/002 Capability Model & Registry](../../../tech/architecture/adrs/2026/07/002-capability-model-and-registry.md) (superseded for taxonomy but still the origin of the `messaging → chat` tree and the Telegram/Gmail asymmetry rule),
[ADR 08/008 Native Capabilities & External Backends](../../../tech/architecture/adrs/2026/08/008-native-capabilities-and-external-backends.md) (owner kinds `core`/`general`/`native:*`/`external:*`; messaging stays native),
[ADR 06/002 Redis Streams Agent Transport](../../../tech/architecture/adrs/2026/06/002-redis-streams-agent-transport.md) (the inbound delivery path reused by the router)

## Goal

One port, many providers. The platform core and the agent broker should speak a
provider-neutral chat vocabulary; Telegram, WhatsApp, and SMS become
interchangeable adapters behind it. "Configured like trading / email" means a
chat provider is reached through the same **connection → agent grant →
capability activation → readiness** path the platform already uses, not a bespoke
`alerts.telegram.*` side channel.

## What exists today (the starting point)

Verified in `herobids` (see `000-README.md` for the full map). The chat path is
Telegram-specific at every layer:

- **Outbound client**: `apps/worker/src/alerting/telegram-client.ts` — concrete
  `TelegramClient` over `https://api.telegram.org/bot<token>`; hardcodes
  `parse_mode: 'HTML'` and `force_reply`.
- **Outbound call sites** (all bound to the concrete client or
  `getEffectiveTelegramChatId`): `agent-message-broker.ts`
  (`handleSendMessage`, billing notices), `platform-alert-service.ts`,
  `agent-decision-handler.ts`, `alert-dispatcher.ts`.
- **Inbound**: single Fastify route `POST /telegram/webhook` in
  `apps/api/src/routes/agent-interactivity.ts`; validates the
  `x-telegram-bot-api-secret-token` header; Zod-parses a Telegram-shaped
  update; ACKs 200; routes slash-command / reply-to / `/to` / single-running-
  agent; delivers to the agent via the Redis stream `agent:outbound:{agentId}`.
- **Identity/persistence**: `users.telegram_chat_id`, `agents.telegram_chat_id`,
  `agent_outbound_messages.telegram_message_id` / `telegram_chat_id`. Reply
  routing depends on Telegram's per-chat `message_id`.
- **Config**: `alerts.telegram.{botToken,webhookSecret,webhookUrl,channels}`
  from `TELEGRAM_*` env vars.

**Already channel-neutral and reusable as-is** (do not rewrite):

- the slash-command parser / `/to` parser / `handle*` command handlers — they
  return plain strings;
- the Redis `agent:outbound:{agentId}` envelope delivery to the agent runtime;
- the `AgentDocumentService` ingestion path (source tag today is `telegram`);
- the outbound-message persistence + delivery-status pattern;
- the alert policy / cooldown / dispatch loop structure.

## Target shape

```
                      ┌──────────────────────────────────────────────┐
   inbound webhooks   │  apps/api                                    │
   (per provider)     │  POST /messaging/chat/:provider/webhook      │
  ───────────────────▶│    → ChatInboundAdapter.parse(req)           │
                      │    → normalized InboundChatMessage            │
                      │    → ChatInboundRouter (provider-neutral)     │
                      │        slash | reply | /to | single-agent     │
                      │    → XADD agent:outbound:{agentId}  (reused)  │
                      └──────────────────────────────────────────────┘

                      ┌──────────────────────────────────────────────┐
   outbound           │  apps/worker                                 │
  (agent/platform) ──▶│  ChatDelivery.send(agentId, msg)             │
                      │    → resolve effective ChatAddress            │
                      │    → ChatChannelRegistry.get(provider)        │
                      │    → ChatChannel.sendText(...) (adapter)      │
                      │    → persist delivery status (channel-neutral)│
                      └──────────────────────────────────────────────┘

   adapters implement ChatChannel + ChatInboundAdapter:
     telegram-channel.ts   whatsapp-channel.ts   sms-channel.ts
```

## Core contracts (illustrative, not final signatures)

These live in a platform-owned messaging module (native capability — **not**
`externals/`). Branded domain types per AGENTS.md conventions.

```ts
// Provider identity — matches the registry provider column (009).
type ChatProvider = 'telegram' | 'whatsapp' | 'sms';

// A delivery destination, provider-neutral. The address *shape* varies by
// provider (chat id vs E.164 phone number) but callers never branch on it.
interface ChatAddress {
  provider: ChatProvider;
  address: string;          // telegram chat id | E.164 phone | ...
}

// Normalized inbound message after an adapter parses a provider webhook.
interface InboundChatMessage {
  provider: ChatProvider;
  from: ChatAddress;
  text?: string;
  caption?: string;
  document?: InboundDocumentRef;      // feeds existing AgentDocumentService
  inReplyToProviderMessageId?: string; // correlation, see 050
  providerMessageId: string;
  receivedAt: Date;
}

interface ChatSendResult { providerMessageId: string; }

// Outbound port. One method set; adapters own the wire format.
interface ChatChannel {
  readonly provider: ChatProvider;
  sendText(to: ChatAddress, body: ChatOutboundBody):
    Promise<Result<ChatSendResult, ChatError>>;
  // capability flags let the delivery layer adapt without branching on provider
  readonly capabilities: {
    richText: boolean;        // telegram=true, sms=false
    maxBodyChars: number;     // telegram ~3800, sms per-segment aware
    nativeReplyThreading: boolean; // telegram=true (force_reply), others=false
  };
}

// Inbound port — one per provider, pure parse + verify. No business logic.
interface ChatInboundAdapter {
  readonly provider: ChatProvider;
  verify(req: WebhookRequest): Result<void, ChatError>; // signature/secret check
  parse(req: WebhookRequest): Result<InboundChatMessage[], ChatError>;
}
```

`ChatOutboundBody` carries the *intent* (subject, body, message class), and each
adapter renders it to its wire format: Telegram → HTML + `force_reply`; SMS →
plaintext, segment-aware truncation; WhatsApp → text within the session window.
This is where `010 §capabilities` is enforced (e.g. SMS strips markup).

## How the existing call sites change

| Call site | Today | After |
| --- | --- | --- |
| `AgentMessageBroker.handleSendMessage` | `this.telegram.sendText(chatId, html, forceReply())` | `this.chatDelivery.send(agentId, body)` — resolver picks the provider + address |
| `PlatformAlertService.fireAlert` | Telegram-with-email-fallback | `chatDelivery.send(...)` with same email fallback; provider-neutral |
| billing / decision notices | direct `TelegramClient` | `chatDelivery.send(...)` |
| `alert-dispatcher.ts` operator channels | `alerts.telegram.channels[]` | operator chat channels keyed by `(provider, address)` (see 060) |
| `POST /telegram/webhook` | one route, Telegram-shaped | `POST /messaging/chat/:provider/webhook` → adapter `verify`/`parse` → shared router |

`ChatDelivery` owns: resolve effective address (040), pick the channel from
`ChatChannelRegistry`, enforce body capabilities, persist delivery status. The
three outbound senders stop knowing anything about Telegram.

## Why this is the smallest correct change

1. **It reuses the native-capability machinery** (009/010) rather than adding a
   parallel one. A chat provider becomes a `messaging / chat / <provider>` row;
   `send_message` keeps its implicit brokered rule; provider actions gate on an
   enabled activation + provider readiness. No new activation concept.
2. **It keeps the reusable neutral pieces untouched** — command parsers,
   handlers, the Redis delivery, document ingest, delivery-status persistence.
3. **It isolates provider-specific knowledge** to adapters, so adding a third
   provider later is one adapter + one registry row + config, not a cross-cutting
   change.
4. **It respects the fixed boundary**: messaging stays native (ADR 08/008 §6);
   the port and adapters live in platform-owned code, never under `externals/`,
   and never use the external-backend invocation contract.

## Open design questions (resolve during implementation, not blocking the shape)

1. Package placement: a new `packages/messaging/` native module vs. keeping the
   port in `apps/worker` with adapters alongside. 006 §Open Latitude permits
   either; prefer a package if the API inbound router also needs the port.
2. Whether operator alert channels (`alert-dispatcher`) migrate in this feature
   or in a follow-up — they are platform→operator, not agent reply-only, so they
   could lag. Flagged in 900.
3. Reply→agent correlation strategy per provider — see 050; this is the one
   genuinely provider-shaped inbound concern.
