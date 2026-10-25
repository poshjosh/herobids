# Schema note: conversations and peer messaging (MVP)

**Status:** approved 2026-10-25 (DEC-47). Builds on [002 two-way agent chat](./001-plan.md) sections 4.1 and 4.2. Where this note and 002 differ, this note wins for the MVP.
**Used by:** CH2W (the store) and A2A-B (peer messages). Neither may add tables or columns outside this note without a new decision.
**Owner context:** [messaging entrypoint](../../10/007-multi-provider-chat-messaging/ENTRYPOINT.md), decisions DEC-40 to DEC-46 in [DECISIONS](../../10/007-multi-provider-chat-messaging/DECISIONS.md).

## 1. What this note covers

Four points the MVP needs that the 002 plan did not settle:

1. How a peer message names its recipient.
2. How a refused peer send is recorded.
3. The channel value for peer messages.
4. Where the per-user stop switch is stored.

Plus one addition needed for the owner's thread list (section 4).

## 2. Tables

Column types follow the existing schema: `text` IDs, `timestamptz` for times, `text` for enum-like values, and `jsonb` only where the data is already structured.

### 2.1 `conversations` (002 section 4.1, with two additions)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | text | no | Primary key |
| `kind` | text | no | `user_agent` (002) or `agent_agent` (MVP peer) |
| `owner_user_id` | text | no | FK to `users.id`, cascade delete |
| `peer_key` | text | yes | Only for `agent_agent`: the two agent IDs sorted and joined with `:`. Null otherwise. **Addition** |
| `last_message_at` | timestamptz | yes | Set on every new message. Used for the owner's thread list. **Addition** |
| `created_at` | timestamptz | no | |

Keys and indexes:

- Primary key: `id`.
- Unique partial index on `(peer_key)` where `kind = 'agent_agent'`. One thread per agent pair, enforced by the database under concurrent creates.
- Index on `(owner_user_id, last_message_at desc)`. Serves the owner's list of threads in one query.

### 2.2 `conversation_participants` (002 section 4.1, unchanged)

| Column | Type | Null | Notes |
|---|---|---|---|
| `conversation_id` | text | no | FK to `conversations.id`, cascade delete |
| `participant_type` | text | no | `user` or `agent` |
| `participant_id` | text | no | User or agent ID |

Keys and indexes:

- Primary key: `(conversation_id, participant_type, participant_id)`.
- Index on `(participant_type, participant_id)`. Lets the system find conversations for an agent.

An agent-to-agent conversation has two rows with `participant_type = agent`. The recipient of a peer message is the participant that is not the sender. No recipient column is added to messages.

### 2.3 `conversation_messages` (002 section 4.2, with two changes and one proposed column)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | text | no | Primary key. Equals `clientMessageId` or envelope `messageId` (002 D5) |
| `conversation_id` | text | no | FK to `conversations.id`, cascade delete |
| `sender_type` | text | no | `user`, `agent`, or `platform` |
| `sender_id` | text | yes | Null for `platform` |
| `channel` | text | no | `web`, `telegram`, or `internal`. **Change:** `internal` added for peer messages |
| `subject` | text | yes | |
| `body` | text | no | User side capped at 4000 characters (002) |
| `message_class` | text | yes | |
| `delivery_status` | text | no | `queued`, `sent`, `failed`, `not_applicable`, or `refused`. **Change:** `refused` added |
| `delivery_detail` | text | yes | Failure text. For `refused`, a dot-string reason code such as `peer.rate_limited` or `peer.paused` |
| `provider_message_id` | text | yes | Set when a channel returns one |
| `created_at` | timestamptz | no | |
| `queued_at` | timestamptz | no | Default `now()`. **Proposed, pending owner confirmation (DEC-50).** When the row last entered `queued`: equals `created_at` on insert, restamped when a retry claims a `failed` or stale `queued` row. Ages a stuck `queued` row against `messaging.conversations.staleQueuedAfterSeconds`. Added by migration 0085; existing rows get the migration time |

Keys and indexes:

- Primary key: `id`. A repeated write with the same ID returns the existing row (002 D5).
- Index on `(conversation_id, created_at)`. Serves thread reads in one query (002 section 4.2).

Peer messages use `channel = 'internal'`, `delivery_status = 'sent'` once they reach the recipient's queue, and `sender_type = 'agent'`.

### 2.4 `users` (one new column)

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `peer_messaging_paused` | boolean | no | `false` | The owner's stop switch (DEC-43). When true, peer sends are refused and peer wakes do not start |

- No index. It is read by primary key, once per send.
- It is a column, not a key in `notification_preferences`, which is for notification settings only.

### 2.5 No table for the rate limit

The per-user limit (DEC-42) is a Redis counter, keyed by user and minute, with a short expiry. It is not stored in Postgres. This matches the existing 10-per-minute user-message limit in 002 D6.

## 3. Decisions in this note

| ID | Decision | Why |
|---|---|---|
| S-1 | Peer conversations are `agent_agent`, one per agent pair, enforced by `peer_key` | Avoids duplicate threads without a read-then-write race |
| S-2 | The recipient is derived from participants, not stored on the message | One source of truth for who is in a conversation |
| S-3 | `channel = 'internal'` for peer messages | Keeps `telegram` and `web` meaning what they say. Peer messages have no provider |
| S-4 | `refused` is a delivery status, with a reason code in `delivery_detail` | Refusals stay in the same audit trail as other sends. No second table |
| S-5 | The stop switch is one boolean column on `users` | Simplest store. Read by primary key |
| S-6 | The rate limit is a Redis counter, not a table | Cheap to check and no row written for each allowed send |

## 4. Checks against the invariants

**No per-row queries on list paths (I10).**
- Owner's thread list: one query on `conversations` ordered by `last_message_at`, plus one batched query on `conversation_participants` with `conversation_id IN (...)` for the page. Two queries, regardless of page size.
- Thread read: one query on `conversation_messages` by `conversation_id`, using the index.
- Peer send: one read of the sender's `peer_messaging_paused` by key, one Redis increment, one insert, one lookup of the recipient from participants. No loop over messages or agents.

**No provider-specific branches in core logic (I2).**
- `channel` and `delivery_status` are data. Core code stores and reads them without `if channel === 'telegram'` branches.
- Sending through a channel goes through the channel port. `internal` has no provider adapter. Its "send" is the enqueue to the recipient agent.
- Existing `telegram` branches in the delivery path must move behind the port during CH2W. That is a CH2W task, not a schema change.

**Fail closed (I4).**
- If the stop-switch read or the Redis increment fails, the peer send is refused with `delivery_status = refused` and a reason code. It is not allowed through.

**Config, not magic numbers (I7).**
- The rate limit value comes from `agentRuntime.peer.rateLimitPerMinute` (DEC-42).

**Known cost, accepted.**
- A refused send writes one row. A user who keeps sending while over the limit writes one row per attempt. The limit is checked before the insert, and the write is small, but a sustained flood still creates rows. If that becomes a problem, refusals can be aggregated later. This is a known cost of S-4.

## 5. Stop switch write path (DEC-48, approved as delegation)

The owner approved the implementer choosing between (a) a new endpoint and (b) an additive field on `PATCH /auth/me`. The criteria are in DEC-48. The implementer records the choice and the route contract in DEC-49 and PROGRESS.md before building the write path.

## 6. Migration order

1. CH2W creates `conversations`, `conversation_participants`, `conversation_messages`, and the partial index. It adds the `users.peer_messaging_paused` column and the two `channel` and `delivery_status` values.
2. CH2W retires `agent_outbound_messages` after its readers move (002 P0 inventory).
3. A2A-B writes peer rows. It does not change the schema.

## 7. Acceptance for this note

- Every table and column named in CH2W and A2A-B matches this note.
- Any new column or key needs a new decision.
- The open item in section 5 is closed by the owner before the switch's write path is built.
