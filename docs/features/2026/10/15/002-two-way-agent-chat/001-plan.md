# Plan: Two-way agent chat

**Status:** approved 2026-10-25 (DEC-31, DEC-32). P0 and P1 done 2026-10-25 (CH2W slice 1); P2 done in code 2026-10-25 (slice 2; the e2e gate is deferred to the owner); P3 and P4 not started. Runs after the address cutover (C1). The answers to section 9 are in the decision register.
**Owner:** Chinomso Ikwuagwu
**Related:** [agent-onboarding epic IMPLEMENTATION](../../../10/10/002-agent-onboarding-epic/IMPLEMENTATION.md) (§4 D-C3, D-R1; §6 WP-C S2, WP-M Phase 2–3), [PROGRESS](../../../10/10/002-agent-onboarding-epic/PROGRESS.md) (S2 entry), [next plan: agent-to-agent messaging](../../../../pending/000-agent-to-agent-messaging/001-plan.md), superseded: [chat sessions notes](superseded/003-agent-chat-sessions/000-notes.md).

---

## 1. Problem

A user cannot hold a real conversation with an agent in the app. The conversation box on the agent detail page sends messages but never stores them. Verified in code:

- `POST /agents/:id/message` publishes to the Redis stream `agent:outbound:{id}` and writes no database row ([agent-interactivity.ts](../../../../../../apps/api/src/routes/agent-interactivity.ts), around line 372).
- The broker's audit insert (`insertMessage`) runs for agent-originated envelopes on `agent:inbound` ([agent-message-broker.ts](../../../../../../apps/worker/src/agents/agent-message-broker.ts), around line 247). Nothing records the user's side.
- Agent replies are stored in `agent_outbound_messages` with `authored_by` set to `agent` or `platform` ([agent-outbound-messages.ts](../../../../../../packages/db/src/schema/agent-outbound-messages.ts)).
- The page shows two sections over the same endpoint, "Messages to user" (collapsed) and "Talk to your agent". The second labels every non-agent message "From you", so platform alerts appear under the user's name ([AgentConversation.tsx](../../../../../../apps/web/src/features/agents/AgentConversation.tsx)).

Result: the thread shows one side, vanishes on reload, and mislabels platform messages. Telegram is two-way for text, but its messages are not in any thread a user can see in the app.

Root cause: there are three message stores (the Redis stream, `agent_messages` for protocol audit, and `agent_outbound_messages` for agent output) and no single record of a conversation. Patching the UI on top adds a fourth.

## 2. Goal

One conversation store and one write path. Every message between a user and an agent, on any channel, is recorded once, and the user sees both sides in order, before and after reload.

## 3. Non-goals

- **Agent-to-agent messaging.** Next plan: [pending/000-agent-to-agent-messaging](../../../../pending/000-agent-to-agent-messaging/001-plan.md). This plan keeps the data model ready for it (section 4.1).
- **Multiple chat sessions or threads per agent.** Rejected by D-R1 in the epic. The superseded [chat sessions notes](superseded/003-agent-chat-sessions/000-notes.md) are kept only as history.
- **Attachments in either direction.** [pending 003b](../../../../pending/003b-agent-message-document-handling/000-notes.md) and [pending 003c](../../../../pending/003c-agent-outbound-message-attachments/001-plan.md). They attach to message rows later and need no separate store.
- **Email as a conversation channel.** Epic WP-E.
- **Streaming replies, read receipts, markdown, edit and delete.**
- **Backfilling old messages.** The product is pre-launch and environments are rebuilt, so old rows are dropped rather than migrated.
- **Changing the protocol audit log.** `agent_messages` stays as it is (section 4.4).

## 4. Design (proposed; each decision needs owner confirmation)

### 4.1 D1 — Participants, not an owner-agent pair

Add two tables:

- `conversations`: `id`, `kind` (`user_agent` in this plan; `agent_agent` later), `owner_user_id`, `created_at`.
- `conversation_participants`: `conversation_id`, `participant_type` (`user` | `agent`), `participant_id`.

For this plan each agent gets one `user_agent` conversation, with the owner and the agent as participants. Agent-to-agent messaging later adds a conversation with two agent participants. No schema change is needed then.

### 4.2 D2 — One message store: `conversation_messages`

| Column | Notes |
|---|---|
| `id` | Primary key. Equal to the envelope `messageId`, so a retry is detected by the same ID. |
| `conversation_id` | FK to `conversations`, cascade delete. |
| `sender_type` | `user` \| `agent` \| `platform`. |
| `sender_id` | User or agent ID; null for `platform`. |
| `channel` | `web` \| `telegram`. |
| `subject` | Nullable. Used by platform alerts. |
| `body` | Text. The user side is capped at 4000 characters, as today. |
| `message_class` | Nullable: `alert`, `reminder`, and so on, as today. |
| `delivery_status` | `queued` \| `sent` \| `failed` \| `not_applicable`. |
| `delivery_detail` | Nullable failure text. |
| `provider_message_id` | Nullable. Telegram or email message ID, when sent. |
| `created_at` | Timestamp. Index on (`conversation_id`, `created_at`). |

`agent_outbound_messages` is retired. Its delivery fields move onto the message row. This is the largest change; see the inventory step in phase P0 and risk R1.

### 4.3 D3 — One write service

A `ConversationService` is the only code that writes conversation rows:

- `recordUserMessage` (web or Telegram inbound)
- `recordAgentMessage` (the broker's `send_message`)
- `recordPlatformMessage` (platform alerts)
- `markDelivery` (after a channel send succeeds or fails)
- `listThread` (for the web and for Telegram `/log`)

Callers: the web POST route, `ChatInboundRouter` (shared by the Telegram path, see [agent-interactivity.ts](../../../../../../apps/api/src/routes/agent-interactivity.ts) around line 530), the broker, and the platform alert service.

### 4.4 D4 — Protocol audit log stays separate

`agent_messages` records every envelope for replay and security audit. It is a different concern from the conversation and is not changed by this plan. The activity feed continues to merge protocol events from it.

### 4.5 D5 — Retry safety

The web client generates a UUID per message and sends it as `clientMessageId`. The server uses it as the row `id` and envelope `messageId`. A repeated POST with the same ID returns the existing row and does not publish again.

### 4.6 D6 — Delivery flow for a user message

1. Validate the body (length, non-empty) and the existing rate limit (10 per minute per user).
2. Check the agent is running (409 otherwise, as today).
3. Insert the row with `delivery_status = queued`.
4. Publish the envelope to `agent:outbound:{id}`.
5. On publish failure, set `failed` with the error and return 503. The row stays so the user can retry the same ID.
6. Return 202 with the row.

### 4.7 D7 — Read API

- `GET /agents/:id/conversation?limit=50&before=<timestamp>`: returns the user-agent conversation's rows in ascending order, with `sender_type`, `channel`, `body`, `subject`, `message_class`, `delivery_status`, and `created_at`.
- `GET /agents/:id/messages` is removed (pre-launch; the web page and Telegram `/log` move to the new read).

### 4.8 D8 — Web

- One card titled **"Chat with {name}"**.
- User messages on the right, agent messages on the left, platform messages centred with a badge. No message is labelled "From you" unless the user sent it.
- Composer at the bottom. Enter sends; Shift+Enter adds a line. Character counter at 4000.
- Pending and failed states on the user's bubble, with retry on failure.
- Polls every 3 seconds while the agent is running. Stops when the page is hidden or the agent is not running.
- Auto-scroll to the newest message.
- The collapsed "Messages to user" section is removed. The activity feed keeps the history.

### 4.9 D9 — Telegram

- Inbound: `ChatInboundRouter` calls `recordUserMessage` with `channel = telegram`, then publishes as today.
- Outbound: the broker and alert service call `recordAgentMessage` or `recordPlatformMessage`, send through Telegram, then call `markDelivery`.
- `/log` reads `listThread`, so Telegram and web show the same history.

## 5. Work breakdown

| Phase | Work | Output |
|---|---|---|
| **P0** Verify | Confirm an in-app reply reaches the thread through `send_message` (if the agent answers with plain text output instead, that is a gap to fix in P1). List every reader and writer of `agent_outbound_messages` and `GET /agents/:id/messages`. | Inventory in this plan's appendix. Go or no-go for retirement. |
| **P1** Store | Migration for the three tables. `ConversationService` with unit tests. Repository and DB tests. | Store and service, no callers yet. |
| **P2** Web | `POST /agents/:id/message` writes a row first. `GET /agents/:id/conversation`. Chat card, bubbles, composer, polling. Remove the collapsed section and the old read. | Working two-way chat in the app. Functional, component, and E2E tests. |
| **P3** Channels | Telegram inbound and outbound, broker and alert service through the service. Retire `agent_outbound_messages` readers and the old endpoint. Drop the old table. | One store. Telegram `/log` on the new read. |
| **P4** Close | Acceptance rows, translations placeholders (ar, hi), platform docs review, owner review. | Plan closed. |

Owner review after each phase. P3 is the largest and carries most risk; it starts only after P2 is accepted.

## 6. Gates

- `tsc --noEmit` for db, api, worker, and web.
- Focused unit tests for the service and the new routes; functional tests for POST idempotency, the 503 path, and ownership (another user's agent returns 404).
- Web component tests: bubble authorship, ordering, disabled and failed states.
- E2E journey: send a message, see it, see the agent's reply (using a test helper for the agent reply).
- `scripts/shell/tests/run-all-tests.sh --e2e` before P2 closes and before P3 closes.
- Migrations applied to the local stack only. Shared environments need explicit owner approval.

## 7. Estimate

Rough, to be confirmed after P0: P0 half a day, P1 two to three days, P2 four to five days, P3 four to six days, P4 one day. Total about two to three weeks.

## 8. Risks

- **R1 — retiring `agent_outbound_messages` has a wide blast radius.** Alert delivery, email fanout, Telegram `/log`, and the activity feed all read it. Mitigation: the P0 inventory is a gate, and P3 is reviewed separately.
- **R2 — the agent may not reply through `send_message`.** If it answers with plain output, the reply never reaches the thread. Mitigation: P0 checks this first.
- **R3 — polling load.** Three-second polling per open tab is acceptable for MVP. Push (SSE or WebSocket) is a later plan.
- **R4 — a stuck agent.** A message can be queued while the agent stops before processing it. The UI shows "no reply yet" after a timeout and does not retry automatically.
- **R5 — duplicate sends.** Covered by D5 and the unique ID.

## 9. Open questions for the owner

1. Retire `agent_outbound_messages` entirely (D2), or keep it as a delivery log behind a view? This plan assumes retirement.
2. Remove the "Messages to user" section in P2, or keep it until P3 closes?
3. Telegram in this plan (P3), as written?
4. Title "Chat with {name}" correct?
5. Approve the three new tables (`conversations`, `conversation_participants`, `conversation_messages`) and the removal of `GET /agents/:id/messages`?

## 10. Appendix — P0 inventory

Recorded 2026-10-25 (CH2W slice 1) from the code at commit `2062b0eb` (C1). Paths are relative to the repository root. "Test" rows only matter when the table is dropped.

### 10.1 Findings that differ from section 1

0. **P2 outcome (slice 2).** The "Messages to user" section was already gone from the web before P2 (one "Chat with {name}" card); P2 moved that card to `GET /agents/:id/conversation` and removed the web's old read and type. `GET /agents/:id/messages` stays on the server until P3. The agent-delete cleanup in 10.6 item 2 landed in P2 (`purgeAgentRows` deletes the agents' conversations). `conversation-turn` and the activity feed still read `agent_outbound_messages` until P3, so the POST also writes the old row and a worker mirror copies agent and platform rows into the conversation (both to be deleted in P3).
1. **User messages are already stored.** `POST /agents/:id/message` inserts an `agent_outbound_messages` row (`authored_by` = `user`, or `agent:{actingAgentId}` for a creator agent) before it publishes, and the row id is the envelope `messageId` (`apps/api/src/routes/agent-interactivity.ts`, around lines 405 to 423). The "never stores them" claim in section 1 is stale. Reload does not lose web messages today. What is missing is the unified store, correct authorship labels, and Telegram inbound.
2. **Telegram inbound is not recorded.** `ChatInboundRouter` (`apps/api/src/routes/chat-inbound-router.ts`, line 46) publishes to `agent:outbound:{id}` and writes no row.
3. **R2 is confirmed as a non-gap for replies, and a gap for plain output.** The agent reaches the user only through the `send_message` tool. The broker writes the row before the channel send (`agent-message-broker.ts`, `handleSendMessage`), so an in-app reply always reaches the thread, even when Telegram delivery fails. Plain-text output is never delivered; the worker logs `User message received but no send_message reply was made` (`apps/worker/src/agent.ts`, around line 4213). No P1 change is needed. Surfacing that case in the thread is an optional follow-up, not part of this plan.

### 10.2 Writers of `agent_outbound_messages`

| Writer | Where | Authorship | Moves to |
|---|---|---|---|
| Web POST (and creator agent to child) | `apps/api/src/routes/agent-interactivity.ts` ~409, via `AgentRepository.insertOutboundMessage` | `user`, `agent:{id}` | `recordUserMessage` / `recordAgentMessage` (P2) |
| Broker `send_message` | `apps/worker/src/agents/agent-message-broker.ts` ~535, then `markOutboundMessageFailed` / `markOutboundMessageSent` ~559-561 | `agent` | `recordAgentMessage` + `markDelivery` (P3) |
| Platform alert service | `apps/worker/src/alerting/platform-alert-service.ts` ~73, ~95, ~102 | `platform` | `recordPlatformMessage` + `markDelivery` (P3) |
| Session-started anchor | `apps/worker/src/index.ts` ~708-724 | `platform` | `recordPlatformMessage` + `markDelivery` (P3) |
| Repository methods | `packages/db/src/agent-repository.ts` 197, 756-811: `insertOutboundMessage`, `markOutboundMessageSent` (still records provider `telegram`), `markOutboundMessageFailed`, `markOutboundMessageEmailSent`, `markOutboundMessageEmailSkipped`, `markOutboundMessageEmailFailed`, `getOutboundMessages` | | Removed in P3. The three `…Email…` methods and `getOutboundMessages` have no non-test caller |
| Agent delete | `apps/api/src/routes/agents.ts` `purgeAgentRows` ~273 deletes the agent's rows | | Replaced by deleting the agent's conversations and participants (see 10.6) |

### 10.3 Readers of `agent_outbound_messages`

| Reader | Where | Use | Moves to |
|---|---|---|---|
| `GET /agents/:id/messages` | `apps/api/src/routes/agents.ts` ~2950-2970 | Web chat and "Messages to user" | `GET /agents/:id/conversation` (P2); the old route is removed (DEC-32) |
| `GET /agents/:id/conversation-turn` | `agents.ts` ~2983 | Latest `user` row id, so the runtime's tick events can name the message | `sender_type = 'user'`, newest row of the agent's conversation (P2) |
| Activity feed | `agents.ts` ~3043-3049, `mapOutboundMessage` in `apps/api/src/routes/agent-activity-mapper.ts` | Non-user rows as `message.authored` entries (uses `authoredBy`, `subject`, `body`, `messageClass`, `deliveryStatus`, `sessionId`) | `conversation_messages` where `sender_type <> 'user'` (P3). `sessionId` has no column in the schema note (see 10.6) |
| Telegram `/log` | `apps/api/src/routes/telegram-command-handlers.ts` ~297-306 (raw SQL `UNION ALL`) | Last 10 platform legs | `listThread` (P3) |
| Reply correlation | `AgentRepository.resolveAgentForChatReply`, `packages/db/src/agent-repository.ts` ~942-975, wired at `agent-interactivity.ts` ~878 | Finds the agent for a Telegram reply by (`delivery_provider`, `delivery_address`, `provider_message_id`) using `idx_agent_outbound_messages_delivery` | See 10.6 (needs a lookup key the schema note does not name) |
| Web | `apps/web/src/lib/api-client.ts` ~1108 (`AgentOutboundMessage`) and ~1339 (`messages`), `apps/web/src/features/agents/AgentConversation.tsx` (~17, ~96, ~327) | The only web caller; used by `AgentDetailPage.tsx` | New read and component (P2) |
| Script | `scripts/ts/run-connection-cycle.ts` ~78 | `GET /agents/{id}/messages?limit=50` | New read (P2) |

Not readers: `apps/worker/src/agents/outbound-message-reader.ts`, `runtime-pause.ts`, `agent.ts` `readOutboundMessages`. They read the Redis stream `agent:outbound:{id}` and share only a name. `notification_deliveries.event_key` is `{agentId}:{messageId}` by value, with no foreign key, so it follows the new row id unchanged.

### 10.4 Tests that touch the table

Update or remove with the code they cover: `packages/db/src/agent-repository.test.ts`, `chat-address-resolution.integration.test.ts` (outbound rows and the delivery columns), `chat-addresses-backfill.integration.test.ts` (migration test; keep reading the pre-0083 shape, drop only if the migrations are retired); `apps/api/src/__tests__/functional/{helpers.ts,agents.functional.test.ts,telegram-slash-commands.functional.test.ts}`, `apps/api/src/routes/{agent-activity-mapper.test.ts,telegram-command-handlers.test.ts,agent-creator-actions.integration.test.ts}` (the last reads the stored creator message) and `agent-audit`, `agent-child-allowance`, `agent-delete-subtree` `.integration.test.ts` (a `TRUNCATE` only); `apps/worker/src/agents/{agent-message-broker.test.ts,agent-broker.test.ts}`, `apps/worker/src/alerting/platform-alert-service.test.ts`, `apps/worker/src/__tests__/integration/{config-propagation,session-lifecycle}.integration.test.ts` (`TRUNCATE` only); `apps/web/src/features/agents/AgentConversation.test.tsx`. Historical migrations (0000, 0003, 0076, 0077, 0083) keep their references.

### 10.5 Go or no-go

- **P1: go.** Additive only: three tables, one `users` column, no caller, nothing removed.
- **P2: go**, with the delete-path condition in 10.6 item 2 met in the same phase, because P2 is the first phase that writes rows.
- **Retirement of `agent_outbound_messages` (P3): conditional go.** Every reader and writer above has a destination. It stays blocked until the owner answers the two questions in 10.6 (items 1 and 3).

### 10.6 Gaps between the schema note and the readers

1. **Reply correlation needs a lookup key (open question, owner).** Reply routing finds a message by (`delivery_provider`, `delivery_address`, `provider_message_id`). `conversation_messages` keeps `channel` and `provider_message_id`, which is enough to match, because a Telegram message id is unique within one chat and the owner can be checked through `conversations.owner_user_id` and the resolved chat address. But the schema note names no index that serves this lookup, so the query would scan the messages table on every Telegram reply. Recommendation: approve one non-unique partial index in the P3 migration, on (`channel`, `provider_message_id`) where `provider_message_id` is not null. No new column.
2. **Agent delete must clear conversations.** `conversation_participants.participant_id` has no foreign key to `agents` (by design, the type column decides the table). Deleting an agent therefore leaves its `user_agent` conversation and messages behind unless `purgeAgentRows` deletes them. Fix in P2, using the derived conversation id, and extend it to peer threads in A2A-B. No schema change.
3. **`session_id` and `context_ref` have no column (open question, owner).** The activity feed shows `sessionId` on message entries. `context_ref` is written by the broker and returned by the old endpoint, but no UI reads it. Recommendation: drop both. Message entries in the feed then carry `sessionId: null`, which the feed type already allows.
4. **Delivery detail.** `delivery_provider` and `delivery_address` are dropped. `channel` carries the provider. The address stays in `chat_addresses`.
5. **Status vocabulary.** Old `pending` becomes `queued`. The web type maps it in P2.

## 11. Owner decisions (2026-10-25)

- Q1: retire `agent_outbound_messages`.
- Q2: remove "Messages to user" in the first phase.
- Q3: include Telegram in the Telegram phase.
- Q4: keep "Chat with {name}".
- Q5: approve the three tables, and remove `GET /agents/:id/messages`.
- Gate: the P0 inventory of readers and writers is recorded before any table is removed.
- Sequence: after the address cutover (C1). C1 drops only two Telegram columns from `agent_outbound_messages`.

Source: [DECISIONS](../../../10/10/007-multi-provider-chat-messaging/DECISIONS.md), DEC-31 and DEC-32.
