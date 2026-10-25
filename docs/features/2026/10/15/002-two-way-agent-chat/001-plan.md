# Plan: Two-way agent chat

**Status:** approved 2026-10-25 (DEC-31, DEC-32). Not started. Runs after the address cutover (C1). The answers to section 9 are in the decision register.
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

_To be filled in during P0._

## 11. Owner decisions (2026-10-25)

- Q1: retire `agent_outbound_messages`.
- Q2: remove "Messages to user" in the first phase.
- Q3: include Telegram in the Telegram phase.
- Q4: keep "Chat with {name}".
- Q5: approve the three tables, and remove `GET /agents/:id/messages`.
- Gate: the P0 inventory of readers and writers is recorded before any table is removed.
- Sequence: after the address cutover (C1). C1 drops only two Telegram columns from `agent_outbound_messages`.

Source: [DECISIONS](../../../10/10/007-multi-provider-chat-messaging/DECISIONS.md), DEC-31 and DEC-32.
