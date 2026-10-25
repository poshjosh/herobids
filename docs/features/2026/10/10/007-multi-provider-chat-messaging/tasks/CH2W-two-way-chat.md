# CH2W: Two-way agent chat (002)

**Status:** approved 2026-10-25 (DEC-31, DEC-32). Not started.
**Depends on:** C1 ticked. **Schema:** [schema note](../../../15/002-two-way-agent-chat/002-schema-note.md) (DEC-47). Build only the tables and columns it names. **MVP scope:** owner view of peer threads and the conversation store (DEC-43, DEC-46). **Plan:** [002 two-way agent chat](../../../../10/15/002-two-way-agent-chat/001-plan.md).

## Why it matters

Agent-to-agent messaging (A2A-B) needs the conversation store this plan builds. The plan also fixes a user-visible problem: the chat box does not store messages, and Telegram messages are not in the app's history.

## Approved answers (DEC-32)

- Retire `agent_outbound_messages` (002 D2). Its Telegram-named columns are already gone after C1. Its delivery columns are retired with the table.
- Remove the "Messages to user" section in the first phase.
- Include Telegram in the Telegram phase, as written.
- Keep the title "Chat with {name}".
- Approve the three tables (`conversations`, `conversation_participants`, `conversation_messages`).
- Remove `GET /agents/:id/messages`. This is a public API removal, approved here.

## Steps

1. Confirm C1 is ticked. Do not start before it.
2. Run the P0 inventory from the 002 plan (readers and writers of the message stores). Record the list in PROGRESS.md before removing any table. This is a gate (DEC-32).
3. Build the 002 phases in the order the plan gives. Keep the Telegram and web paths working throughout.
4. Retire `agent_outbound_messages` only after its readers have moved. Keep `notification_deliveries`. It is a separate table for notification records and is not part of this plan.
5. Remove `GET /agents/:id/messages` and the "Messages to user" section as approved.

## Acceptance

- The gates in the 002 plan (section 6), as written.
- Telegram tests pass (I1).
- The grep for `agent_outbound_messages` in `apps` and `packages` returns no hits outside migrations after the table is retired.
- `pnpm test`, compared with the C0 baseline.
