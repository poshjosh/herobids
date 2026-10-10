# Data Model & Migration

**Status:** draft
**Created:** 2026-10-04
**Parent:** [000-README.md](./000-README.md)

The current schema hardcodes Telegram. To support multiple chat providers we
make identity, addresses, and outbound-message correlation **channel-neutral**,
while preserving all existing Telegram data and behaviour through a backfill.

## What is Telegram-specific today (verified)

- `users.telegram_chat_id` (text, nullable)
- `agents.telegram_chat_id` (text, nullable)
- `agent_outbound_messages.telegram_message_id`, `.telegram_chat_id`,
  `.delivery_status`, `.delivery_error`
- `agent_documents.source` includes the literal `'telegram'`
- approval resolution source enum includes `telegram_yes` / `telegram_no`
- reply→agent routing uses `resolveAgentForTelegramReply(telegramMessageId,
  chatId)` keyed on Telegram's per-chat `message_id`

## Target: channel-neutral identity + addresses

### 1. Chat addresses (replaces single `telegram_chat_id` columns)

A user (and optionally an agent override) can have an address per provider.
Introduce a table rather than widening columns, so adding providers never
touches the schema again.

All three chat providers are **brokered** (020): `chat_addresses` stores the
*user's* address (their phone / chat id / wa_id). The *platform's* shared
endpoint (bot token / WhatsApp number / shared A2P SMS number) lives in operator
config (060), **not** in this table and **not** in a user-owned `connection`
row. So there is no per-provider credential connection to model here.

```text
chat_addresses
  id              UUID pk
  user_id         UUID fk users (not null)
  agent_id        UUID fk agents (nullable — null = user-level default)
  provider        text  not null   -- 'telegram' | 'whatsapp' | 'sms'
  address         text  not null   -- telegram chat id | E.164 phone | ...
  status          text  not null   -- 'active' | 'revoked' | 'pending_optin'
  verified_at     timestamptz nullable
  consent_source  text  nullable   -- how opt-in was captured (060)
  created_at      timestamptz not null
  updated_at      timestamptz not null
  unique (user_id, agent_id, provider)   -- one address per scope per provider
```

Effective-address resolution generalises the existing
`getEffectiveTelegramChatId` precedence (agent-level override > user-level
default) into `getEffectiveChatAddress(agentId, provider)` → `ChatAddress | null`,
treating empty/whitespace as unset exactly as today.

> Alternative considered: keep `telegram_chat_id` and add
> `whatsapp_number` / `sms_number` columns. Rejected — it reintroduces the
> per-provider hardcoding this feature exists to remove and fails the "add a
> provider without a migration" goal.

### 2. Outbound message correlation (generalise `telegram_*` columns)

`agent_outbound_messages` keeps its audit/body columns and gains channel-neutral
delivery columns, deprecating the Telegram-named ones:

```text
agent_outbound_messages  (added / changed)
  delivery_provider        text nullable   -- 'telegram' | 'whatsapp' | 'sms' | 'email'
  delivery_address         text nullable   -- the ChatAddress.address used
  provider_message_id      text nullable   -- replaces telegram_message_id
  -- delivery_status, delivery_error: keep (already neutral)
  -- telegram_message_id, telegram_chat_id: retain during migration, then drop
```

`provider_message_id` + `delivery_provider` + `delivery_address` is the tuple
inbound reply correlation uses (see 050). This replaces the Telegram-only
`(telegramMessageId, telegramChatId)` join in `resolveAgentForTelegramReply`
with a provider-parameterised `resolveAgentForChatReply(provider, address,
providerMessageId)`.

### 3. Documents & approvals (small, additive)

- `agent_documents.source`: allow `'whatsapp'`, `'sms'` alongside `'telegram'`
  (and keep `'control_plane'`). The ingest path itself is unchanged.
- approval resolution source enum: the `telegram_yes` / `telegram_no` values are
  provider-specific labels. Either (a) generalise to `chat_yes` / `chat_no` with
  a provider field, or (b) leave as-is and add equivalents per provider.
  Recommendation: **(a)** to avoid enum sprawl; low-risk string migration.

## Migration plan (expand → backfill → contract)

Follow the project's "`.example` twin + atomic migration" conventions
(AGENTS.md). No behaviour change until adapters ship.

1. **Expand** (one migration): create `chat_addresses`; add
   `delivery_provider` / `delivery_address` / `provider_message_id` to
   `agent_outbound_messages`; widen `agent_documents.source` check; add neutral
   approval-source values. Nullable/additive only — no drops.
2. **Backfill** (data migration): for every non-null `users.telegram_chat_id`
   and `agents.telegram_chat_id`, insert a `chat_addresses` row with
   `provider='telegram'`, `status='active'`, `verified_at=now()` (these were
   already working addresses). Copy `telegram_message_id` → `provider_message_id`
   and `telegram_chat_id` → `delivery_address`, `delivery_provider='telegram'`
   for existing outbound rows. This mirrors 010's rule that a one-time backfill
   for provider-backed messaging is allowed only from an explicit existing
   configuration — a bound Telegram chat id *is* that explicit opt-in.
3. **Dual-read/dual-write** (code): resolver reads `chat_addresses` first,
   falls back to the legacy column until backfill is verified in all envs;
   writes go to both. Keep for one release.
4. **Contract** (later migration, separate PR): drop
   `users.telegram_chat_id`, `agents.telegram_chat_id`,
   `agent_outbound_messages.telegram_message_id` / `telegram_chat_id` once
   dual-read is removed. Explicitly deferred — not in the first shipping PR.

## Invariants

1. No existing Telegram delivery or reply-routing behaviour regresses at any
   migration step (dual-read guarantees this).
2. Reply correlation never depends on a provider-specific primitive at the
   schema level — only on `(provider, address, provider_message_id)`.
3. A new provider adds **rows**, never columns.
4. Addresses carry consent/verification state so 060's opt-in rules and SMS STOP
   handling have a durable home (`status`, `consent_source`, `verified_at`).
