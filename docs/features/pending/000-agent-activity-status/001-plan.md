# Agent Activity Status

## Problem

While an agent works on a message, the chat shows "<agent name> is thinking" and nothing else. The user cannot tell whether the agent is making progress, calling tools, or stuck.

## Goals

- Show one short status line under "<agent name> is thinking" that says what the agent is doing now.
- Example sequence for one turn: "Using tool list_tasks", "Sent message to you", "Completed turn".
- Use only events the platform already records. No new worker events.

## Non-goals

- Showing tool arguments or tool output.
- Showing a history of statuses. Only the latest line is visible.
- Changing how messages are stored or how agents are run.
- Pushing statuses over the event stream (see Open questions).

## Design

### 1. Data source

The worker already persists these tick events (see `emitActivityEvent` in [agent.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agent.ts) and the audit-only cases in [agent-message-broker.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agents/agent-message-broker.ts)):

| Event | Payload fields used | Status line |
|---|---|---|
| `agent.tool.call` | `tickId`, `toolName`, `correlationId` | "Using tool {toolName}" |
| `agent.tool.call` with `toolName = send_message` | same | "Sending message" |
| `agent.tool.result` with `toolName = send_message` and `status = ok` | `correlationId` | "Sent message to you" |
| `tick.completed` | `tickId`, `outcome` | "Completed turn" |

No schema changes are needed. `RuntimeToolCallPayloadSchema` and `RuntimeToolResultPayloadSchema` already carry `tickId`, `toolName`, and `correlationId`.

### 2. API: turn endpoint

[agents.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/agents.ts) (`GET /agents/:id/turn`, around line 3180) derives turn state from tick events:

1. Keep the existing `deriveSubjectTurnState` result for `message` and `connection`.
2. When `message` is `working`, find the `tickId` of the tick that handled the latest user message (the `TICK_STARTED` event whose `userMessageIds` includes it).
3. Query the newest tool events for the agent with that `tickId` (for example the latest 20 `agent.tool.call` and `agent.tool.result` rows). Pick the most recent one and map it to a status line.
4. Return it as a new optional field, for example `activity: { kind, toolName?, at } | null`. `kind` is one of `tool`, `sending_message`, `sent_message`, `completed`.

The existing query uses `TURN_EVENT_TYPES` and a 300-row window. Tool events add roughly one to three rows per tick, so the tool query needs its own bounded select rather than widening the shared window.

Map the status in the API, not the web, so the web does not need to know tool names or event types.

### 3. Web

- [AgentConversation.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/agents/AgentConversation.tsx) renders one line below the "is thinking" text when `turn.activity` is set. The line replaces the previous one; there is no list.
- The turn query already polls every `CONVERSATION_POLL_MS` (3 seconds) while the agent is conversable, so the line updates without new plumbing.
- Add a type for `activity` in the turn response in [api-client.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/lib/api-client.ts).
- Add i18n keys for the four kinds in `en`, `ar`, and `hi` under `agentDetail.conversation.activity.*`. Tool names are shown as-is.
- Put the line inside the existing thinking block, which already has `role="status"`, so screen readers announce changes without a second live region.

### 4. Lifecycle of the line

- Visible only while `isAwaitingReply` is true.
- Cleared when the turn leaves `working` (replied, no_reply, failed, stale). The line is not kept after the reply arrives.

## Work breakdown

1. API: add the tool-event query and mapping to the turn endpoint. Unit-test the mapping with fixed event rows (tool call, send_message ok, tick completed, tick from another turn ignored).
2. API: extend the turn response with `activity`. Test with the existing route test setup in `agents.test.ts`.
3. Web: add the type, the line, and the i18n keys. DOM test that the line shows the latest activity only and disappears when the turn ends.
4. Docs: add a UAT row to [user-acceptance-tests.md](/Users/chinomso.ikwuagwu/dev_ai/herobids/docs/tech/user-acceptance-tests.md) (send a message that uses a tool, watch the line change). Add a CHANGELOG entry under Unreleased.

## Gates

- `apps/api` and `apps/web` type-check and their tests pass.
- The turn endpoint response for an agent that is not working is unchanged (`activity: null`).
- No new rows are written to `agent_messages`.

## Estimate

About 1–2 days: API 0.5 day, web 0.5 day, tests and docs 0.5 day. Live push would add about 1 more day.

## Risks

- **Tool events are tick-scoped and may arrive after the turn is marked done.** The line may skip a final step. Acceptable, since the reply itself is shown.
- **Event volume.** One tool call per row can make the tool query large for busy agents. The bounded query and tick filter keep it small.
- **Wording of the "Sent message" line.** "Sent message to you" assumes a user recipient. Peer messages use a different path and are out of scope.
- **Polling lag.** Statuses can appear up to 3 seconds late.

## Open questions

1. **Live or polled?** Polling at 3 seconds is the proposal. Pushing each status over the event stream is nicer but needs a new event type.
2. **Show "Completed turn"?** The line disappears when the reply arrives, so "Completed turn" may never be seen. Options: keep it for about 2 seconds, or drop it.
3. **Show every tool call or only the latest?** The proposal shows only the latest, as requested. Confirm that a long run of tool calls should still show only the newest one.
4. **Connection-request turns.** Should the same line show for connection-request turns, or only for user messages?
