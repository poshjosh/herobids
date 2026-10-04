# Implementation Plan

**Status:** draft
**Created:** 2026-10-04
**Parent:** [000-README.md](./000-README.md)

Phased so that each phase is independently shippable and verifiable, and so the
abstraction lands **before** any second provider. Every phase ends with
`pnpm lint` + targeted tests green (AGENTS.md). No phase regresses Telegram.

## Phase 0 — Capability-doc amendment (no code)

Align the registry with this feature before touching code.
- Amend [009 manifest](../000-capability-foundations/009-initial-capability-registry-and-tool-ownership-manifest.md):
  add `messaging / chat / sms` with transport mode **`brokered`** (decided, 020);
  note WhatsApp will flip `planned → available`.
- Consistency check against source ADRs: the amendment must stay within
  [ADR 07/002](../../../tech/architecture/adrs/2026/07/002-capability-model-and-registry.md)
  (taxonomy + Telegram/Gmail asymmetry) and
  [ADR 08/008](../../../tech/architecture/adrs/2026/08/008-native-capabilities-and-external-backends.md)
  (messaging native; owner kinds). SMS is **brokered** like Telegram/WhatsApp, so
  no user-owned chat `connection` is introduced and no ADR change is required. A
  future per-user-number (connection-backed) model would be an ADR-level change
  (ADR 07/002 Follow-Up Rule 5), not a registry edit — and is out of scope.
- **Gate**: manifest tests still pass (key-set equality, planned-provider
  non-actionability). No new capability IDs or tools.

## Phase 1 — Introduce the port, re-wire Telegram behind it (no new provider)

The pure refactor. Behaviour-identical to today; this is where the risk is.
- Define `ChatProvider`, `ChatAddress`, `ChatOutboundBody`, `InboundChatMessage`,
  `ChatChannel`, `ChatInboundAdapter`, `ChatChannelRegistry` (010). Branded
  types; `Result`-returning (AGENTS.md).
- Implement `telegram-channel.ts` as a `ChatChannel` + `ChatInboundAdapter`
  wrapping the existing `TelegramClient` logic and the existing webhook
  parse/verify. No wire changes.
- Introduce `ChatDelivery` (worker) and migrate the three outbound senders
  (`agent-message-broker`, `platform-alert-service`, `agent-decision-handler`)
  off the concrete `TelegramClient` onto `ChatDelivery.send(...)`.
- Lift the inbound routing precedence out of `agent-interactivity.ts` into a
  provider-neutral `ChatInboundRouter`; keep `POST /telegram/webhook` working by
  delegating to the Telegram adapter + router.
- **Gate**: all existing Telegram tests pass unchanged (slash-commands, parser,
  handlers, broker, platform-alert, webhook integration). No schema change yet.

## Phase 2 — Channel-neutral data model (expand + backfill + dual-read)

- Expand migration: `chat_addresses` table; `delivery_provider` /
  `delivery_address` / `provider_message_id` on `agent_outbound_messages`; widen
  `agent_documents.source`; neutral approval-source values (040).
- Backfill existing `telegram_chat_id` / outbound rows into the neutral shape.
- `getEffectiveChatAddress(agentId, provider)` and
  `resolveAgentForChatReply(provider, address, providerMessageId?)` with
  dual-read fallback to legacy columns.
- **Gate**: reply routing + effective-address resolution tests pass against both
  legacy-column and `chat_addresses` data. Backfill verified in a migration
  test. No column drops.

## Phase 3 — Provider-neutral inbound ingress + config block

- Add `POST /messaging/chat/:provider/webhook` (+ GET verify variant) delegating
  to the adapter registry; keep `/telegram/webhook` as a working alias.
- Introduce `messaging.chat.*` operator config (060) with `alerts.telegram.*`
  dual-read alias; add `.env.example` twins.
- **Gate**: Telegram works through *both* the new neutral route and the legacy
  route; config loads from both old and new keys.

## Phase 4 — WhatsApp adapter (first new provider)

Depends on Phases 1–3. Operational prerequisites (030) run in parallel.
- `whatsapp-channel.ts`: Cloud API send (in-window free-form only — no
  templates), GET verify handshake + `X-Hub-Signature-256` verification, inbound
  parse incl. `context` quoting (050 strategy 2), per-recipient 24h window state
  with email fallback when closed.
- Auto-capture onboarding + consent recording (060); i18n keys.
- Flip registry `whatsapp` → `available` when readiness check exists.
- **Gate**: send+receive round-trip test (mock Cloud API); window-closed path
  falls back to email; webhook signature rejection test; opt-in recorded.
- **Confirm before launch**: Meta in-window pricing; direct-vs-BSP (030).

## Phase 5 — SMS adapter (second new provider)

Depends on Phases 1–3; independent of Phase 4.
- `sms-channel.ts`: provider send (e.g. Twilio), `X-Twilio-Signature`
  verification, Unicode-aware segment-counting renderer (strip markup,
  handle/transliterate emoji, segment-aware truncation), inbound parse.
- **STOP/START/HELP interception** ahead of routing, updating
  `chat_addresses.status` (050, 030) — compliance-critical.
- Add `messaging / chat / sms` config + `.example` (one shared `SMS_FROM_NUMBER`,
  brokered); registry row `available`, transport mode `brokered`.
- **Gate**: send+receive round-trip test (mock provider); STOP sets `revoked`
  and blocks subsequent delivery; segment counting correct for GSM-7 vs UCS-2;
  webhook signature rejection test; inbound to the shared number routes to the
  correct agent via strategy 1 / `/to` (050).
- **Confirm before launch**: A2P 10DLC brand+campaign registered for the single
  shared number (conversational use case). Transport mode is already fixed —
  **brokered** (020) — so no number-model decision remains.

## Phase 6 — Contract migration (cleanup, separate PR)

Only after dual-read has been live and verified across environments.
- Remove dual-read; drop `users.telegram_chat_id`, `agents.telegram_chat_id`,
  `agent_outbound_messages.telegram_message_id` / `telegram_chat_id`; remove the
  `alerts.telegram.*` config alias and the `/telegram/webhook` alias (or keep
  the route alias indefinitely if external webhooks are already registered to it
  — Telegram's `setWebhook` points at a fixed URL, so **prefer keeping the route
  alias**, drop only the config/columns).
- **Gate**: full suite green with no legacy columns; no provider regressions.

## Deferred / out of scope (tracked, not built here)

- Agent-*initiated* messaging after a closed window (WhatsApp templates, SMS
  campaigns) — email covers it (README non-goal 2).
- Operator alert channels (`alert-dispatcher.ts`) migration to multi-provider —
  platform→operator, not reply-only; can follow in a separate slice.
- Per-user / per-agent dedicated numbers (connection-backed SMS). Ruled out by
  the all-brokered decision (020); would require a new ADR for a user-owned chat
  connection model.
- Rich provider features (buttons, reactions, voice).

## Risk notes

1. **Phase 1 is the risky one** — it's a wide refactor across worker + API with
   no behaviour change. Keep it strictly behaviour-preserving; add no features.
2. **i18n blast radius** (060) — Telegram strings exist in every locale; the
   per-provider generalisation is real translation work, not just backend.
3. **Window-state (WhatsApp) and STOP-handling (SMS)** are the two genuinely
   new stateful concerns; both have durable homes in `chat_addresses` and
   per-recipient state, and both fail safe (fall back to email / block send).
4. **External prerequisites gate launch, not code**: A2P registration and Meta
   verification are long-lead items — start them when Phase 4/5 begins, not when
   it ends.
