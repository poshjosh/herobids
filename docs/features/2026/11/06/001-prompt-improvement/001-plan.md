# Plan: Judge Prompt Conversation and Performance Improvements

Date: 2026-11-06

> **Superseded by [002-plan.md](./002-plan.md).** Kept for history: the `in_reply_to` design was dropped in favour of a dedicated conversation window.

---

## Overview

Improve the judge prompt for herobids agents, which are long-running, employee-like workers rather than chat assistants. Four changes:

1. Replace the `answeredUpToTs` timestamp marker with explicit reply links (`in_reply_to`).
2. Show the agent's own `send_message` bodies in the Conversation section, so the judge sees the question it asked.
3. Show short IDs (first 12 hex characters of the stored UUID) instead of full UUIDs. Tools resolve them; an ambiguous prefix returns an error. The same IDs appear in fetch results.
4. Drop the Performance score. Show trading metrics only for trading agents. LLM cost and session duration stay for all agents.

Phase 2 (assignments, commitments, `search_history`) is out of scope here and is listed at the end. Fetch tools (`get_message`, `get_thread`) are in Phase 1.

### Current state (verified in code)

- `send_message` accepts `subject`, `body`, `messageClass`, `contextRef` only ([messaging.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/tools/messaging.ts:8), [agent-protocol.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/agent-protocol.ts:157)).
- The Conversation section renders only USER and PEER events ([buildConversationSection](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/runtime-composition.ts:2609)).
- `answeredUpToTs` is hydrated from Redis key `agent:conversation:answered_at:<agentId>` ([agent.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agent.ts:2868)) and advanced after a successful reply ([agent.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agent.ts:4134)).
- `ActivityTimelineEvent` has no ID field ([runtime-composition.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/runtime-composition.ts:418)).
- The `user.message` envelope carries `messageId` ([agent.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agent.ts:3010)). Stored UUIDs are validated by `ClientMessageIdSchema` ([conversation-http.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/conversation-http.ts:31)).
- `computePerformanceSummary` always appends a score; missing inputs default to 0.5, so non-trading agents always show 5/10 ([runtime-composition.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/runtime-composition.ts:952)).
- Length caps already in place: `send_message` body 2000, subject 200, `contextRef` 200; user message 4000 (`userMessageMaxChars`); peer message 4000 default, 20000 ceiling; decision `rationaleSummary` 400.

---

## Dependency Graph

```text
Step 1 (in_reply_to in send_message schema and payload)
	-> Step 2 (persist messageId and inReplyTo on timeline events)
		-> Step 3 (AGENT timeline event for send_message bodies)
			-> Step 4 (short ID display and resolution)
				-> Step 5 (Conversation section rewrite using links)
					-> Step 6 (remove answeredUpToTs marker)
Step 7 (Performance section: drop score, gate trading metrics) - independent
Step 8 (multi-line indentation) - independent, after Step 5
Step 9 (fetch tools) - after Steps 1 to 4
Step 10 (tests and snapshots) - after Steps 1 to 9
```

---

## Steps

### Step 1 - Add `in_reply_to` to `send_message`

Files:

- [messaging.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/tools/messaging.ts) (`SendMessageParamsSchema`, tool description)
- [agent-protocol.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/agent-protocol.ts) (`SendMessagePayloadSchema`)
- [skills.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/skills.ts) (send_message guidance, line ~131, which mentions `contextRef`)
- [tools audit](/Users/chinomso.ikwuagwu/dev_ai/herobids/docs/tech/agents/tools/audits/2026/06/001-tools-audit.md) (parameter table)

Changes:

1. Add optional `in_reply_to: z.string().min(1).max(64)`. It takes a short ID (12-character prefix) or a full UUID. The max length is a proposal; confirm it during implementation.
2. Pass it through the payload and the publish call in `execute` ([messaging.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/tools/messaging.ts:27)).
3. Update the skill guidance so the agent sets `in_reply_to` when it answers a specific message.
4. Leave `contextRef` unchanged.

### Step 2 - Persist message IDs and reply links on timeline events

Files:

- [runtime-composition.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/runtime-composition.ts) (`ActivityTimelineEvent`, line ~418)
- [tick-gate-state.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/tick-gate-state.ts) (`timelineEventForUserMessage`, line ~67)
- [agent.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agent.ts) (USER push, line ~2884)

Changes:

1. Add `id: string` to USER and PEER events, taken from the envelope `messageId`.
2. Add `inReplyTo?: string` to USER events. Set it only when the user's message names a message it replies to. Read it from the envelope, and confirm during implementation that the API and Telegram producers can set it.
3. Keep `timestamp` for ordering only. It no longer determines answered status.

### Step 3 - Add an AGENT timeline event for `send_message`

Files:

- [agent.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agent.ts) (`send_message` handling, around line ~4247)
- [runtime-composition.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/runtime-composition.ts) (`ActivityTimelineEvent`)
- [conversation-service.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/conversations/conversation-service.ts) and [conversation.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/conversations/conversation.ts) (store `inReplyTo` on agent messages)
- [packages/db/drizzle](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/drizzle) (migration, only if the conversation table needs a new column)

Changes:

1. Add `{ kind: 'AGENT'; id: string; text: string; inReplyTo?: string; timestamp: number }`.
2. On a successful `send_message`, push an AGENT event with the body and the new message ID, and store `inReplyTo` on the conversation row.
3. Apply the existing trim (`maxEvents`) to AGENT pushes as well. The USER push at [agent.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agent.ts:2884) currently has no trim; check this during implementation.
4. Failed sends are not recorded.

### Step 4 - Short ID display and resolution

Files:

- [messaging.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/tools/messaging.ts) (resolve `in_reply_to`)
- A shared helper in [packages/domain/src](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src) (prefix lookup, used by the tools and by fetch)

Changes:

1. Display each message as its first 12 hex characters of the stored UUID. The stored ID stays a full UUID. No migration.
2. A prefix lookup scoped to the agent's own conversation resolves the short ID. Accept a full UUID as-is.
3. If the prefix matches more than one message, return an error that lists the full IDs of the matches. Do not guess.
4. Unknown IDs return a tool error. The error must not reveal messages from other conversations.

### Step 5 - Rewrite the Conversation section

Files:

- [runtime-composition.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/runtime-composition.ts) (`buildConversationSection`, line ~2609)

Changes:

1. Render USER, AGENT, and PEER events in timeline order, one entry per message, with short ID, time, and kind.
2. Derive status from links: a USER or AGENT entry is `answered` when another entry's `inReplyTo` points to it, and `open` otherwise.
3. Show `answered by` and `replies to` lines under each entry, as in the example agreed in the discussion.

Expected output:

```text
Q1 [AGENT, 13:16] I could not create a child agent. Reply with 1 or 2: ...
U1 [USER, 13:16] Create a child agent and send me feedback. I am testing the process
  answered by: Q1
U2 [USER, 13:24] 2
  replies to: Q1
  status: answered
```

### Step 6 - Remove the `answeredUpToTs` marker

Files:

- [runtime-composition.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/runtime-composition.ts) (`answeredUpToTs` on `RuntimeSessionMetrics`, line ~471; `computeAdvancedAnsweredMarker`, line ~2646)
- [agent.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agent.ts) (hydrate at line ~2868; advance at line ~4134)

Changes:

1. Delete the field, the hydrate step, the advance step, and `computeAdvancedAnsweredMarker`.
2. Delete the Redis key `agent:conversation:answered_at:<agentId>` once no code reads it. Add a one-off cleanup or leave the key to expire. Decide during implementation.

### Step 7 - Performance section

Files:

- [runtime-composition.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/runtime-composition.ts) (`computePerformanceSummary`, line ~952; `buildTickUserContext`, line ~2655)

Changes:

1. Remove the Performance score and its weighted calculation.
2. Keep `LLM cost this session`, `Estimated server cost`, and `Session duration` for all agents.
3. Show `Net P&L`, `Win rate`, and `Drawdown` only for trading agents (agents with trading capability or trading connections). Use the same trading gate the other trading sections use. Check which gate that is during implementation.
4. Show the "Net P&L (after estimated costs)" line only for trading agents. Non-trading agents get the cost lines directly.

### Step 8 - Indent multi-line content

Files:

- [runtime-composition.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/runtime-composition.ts) (`formatLine` in `buildConversationSection`, line ~2614; `formatPeerLine`, line ~2529)

Changes:

1. Indent every continuation line of a message body by two spaces under its header line.
2. Do not truncate. Bodies are already capped at write time (agent messages 2000 chars, user messages 4000 chars).

### Step 9 - Fetch tools (Phase 1)

Files:

- [conversation-service.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/conversations/conversation-service.ts) (new any-sender read by ID; `listThread` reused for `get_thread`)
- [conversation-store.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/ports/conversation-store.ts) (new store method for the read by ID)
- [repository](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/src/conversation-repository.ts) and the in-memory test store
- [tool-contract.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/trading/tool-contract.ts) (add a conversations port to `ToolContext`)
- [index.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/index.ts) (pass the existing `conversations` service into the tool context)
- [tools.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/tools.ts) (catalog entries, category `read-database`)
- [skills.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/skills.ts) (`BASE_SKILL.requiredTools`; the base list already has 25 tools, and the visibility cap silently drops extras)
- [runtime-tool-visibility.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/runtime-tool-visibility.ts) (`DATABASE_DEPENDENT_TOOLS`)

Changes:

1. `get_thread(before?, limit?)`: reuses `listThread` for the agent's own user thread. Cap `limit` at 10 and total output at a fixed character budget. Use the `before` cursor to page.
2. `get_message(id)`: a new read that takes a short ID or full UUID, scoped to the agent's own user thread, and returns messages from either sender. `findMessage` is not reusable because it returns only the sender's own messages.
3. Fetched text is labelled as data, the same way peer text is.
4. Peer threads are excluded from these tools.
5. Add skill guidance telling the agent when to fetch.
6. Add both tools to `BASE_SKILL.requiredTools`, so every agent sees them.
7. Add both tools to `DATABASE_DEPENDENT_TOOLS`, so they are hidden when the database is down.
8. Use category `read-database`. Check the visibility cap after the change: `maxVisibleToolSchemas` is 40 in one preset, and the base list plus the new tools must fit within it.

### Step 10 - Tests

Files:

- [runtime-composition.test.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/runtime-composition.test.ts) (answered-marker tests, around lines 3850 to 4060)
- [messaging tool tests](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/tools) (new `in_reply_to` cases)
- [skills tests](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src) if guidance text is snapshot-tested

Changes:

1. Replace the answered-marker tests with link-based tests: answered, open, reply to an older message, two user messages with one reply.
2. Add short ID tests: valid 12-character prefix, full UUID, unknown ID (error), ambiguous prefix (error lists matches).
3. Add Performance tests: score absent; trading metrics shown only for trading agents; cost and duration shown for all.
4. Add multi-line indentation tests.

Verification:

- `pnpm test` (runs `vitest run` at the root)
- `pnpm lint` (runs `tsc --noEmit`)
- Compare a before and after judge prompt for a non-trading agent and a trading agent.

---

## Phase 2 (not in this plan)

- Assignments section (standing work items with status). No source exists in code today.
- Commitments section (promises the agent has made). No source exists in code today.
- `search_history`: needs a new query over message bodies and probably an index. Deferred.

---

## Decisions recorded

- Reply linking: typed `in_reply_to` field on `send_message`.
- IDs: first 12 hex characters of the stored UUID, shown in the prompt and in fetch results. Ambiguous prefixes return an error. No migration. Sequence aliases were rejected because they need atomic numbering across three writers and a backfill.
- Agent messages are included in the Conversation section as AGENT events.
- `answeredUpToTs` is removed.
- Fetch tools `get_message` and `get_thread` are in Phase 1. `search_history` is deferred.
- Performance score is removed. Trading metrics are shown only for trading agents. LLM cost and session duration are shown for all agents.
- Agent message length stays at the existing 2000-character `send_message` limit, with no further prompt truncation.
