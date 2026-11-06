# Plan 002: Judge Prompt Conversation, Slimmed Phase 1

Date: 2026-11-06

Supersedes [001-plan.md](./001-plan.md). Keep 001 for the history of why the reply-link design was rejected.

---

## Overview

The judge prompt must let a long-running, employee-like agent understand the user's latest message in context, and recover older context on demand. The failing example was a bare reply, `2`, whose question (`Reply with 1 or 2`) was cut to a truncated `DECISION` line.

Scope:

1. A dedicated **conversation window** (user and agent messages, chronological, own buffer), separate from the 10-event `activityTimeline`.
2. The agent's own messages appear in that window, from both reply paths.
3. Per-message **short IDs** (display only), an "earlier messages not shown" line, and truncation markers that point at the fetch tool.
4. Two read tools: `get_thread` and `get_message`.
5. Performance section cleanup (no score; trading metrics for trading agents only).
6. Multi-line indentation.

### Why this replaces 001

| 001 | 002 | Reason |
|---|---|---|
| `in_reply_to` on `send_message`, answered status from links | Dropped | Replaces a deterministic marker with model-supplied bookkeeping. A forgotten or mistyped link leaves a message `open` forever. A single link cannot answer several user messages. Web and Telegram supply no usable user-side link. |
| Remove `answeredUpToTs` | **Kept** | System-computed, monotonic, persisted in Redis. Per-message "awaiting" is derived from it. |
| AGENT events pushed into `activityTimeline` | Own window | The timeline is shared (default `maxEvents: 10`, [default.yaml](../../../../../../config/default.yaml)); extra AGENT events would evict the user's original request. |
| DB migration for `inReplyTo` | None | No new column. |
| Short IDs for `in_reply_to` resolution | Display and fetch only | Used by `get_message` and `get_thread` cursors. |

---

## Verified current state

- `ActivityTimelineEvent` has `USER`, `PEER`, `MEMORY`, `DECISION`; no IDs (`apps/worker/src/runtime-composition.ts:418`).
- The timeline is in memory (`runtimeState.metrics.activityTimeline`), so a worker restart empties it. Only the answered marker survives, via Redis key `agent:conversation:answered_at:<agentId>` (hydrate `apps/worker/src/agent.ts:2862`, advance `:4125`).
- USER messages are pushed at `agent.ts:2877-2892`, trimmed to `maxEvents` (default 10, max 30; `packages/domain/src/config/schema.ts:1475`).
- `buildConversationSection` (`runtime-composition.ts:~2606`) splits USER events by the marker into "Awaiting your reply" and "Answered". `computeAdvancedAnsweredMarker` (`:~2646`) reads USER timestamps from the timeline.
- **There are two agent-reply paths**: the `send_message` tool (`apps/worker/src/tools/messaging.ts`, success handled in `agent.ts` `onToolResult`, `:~4240`) and the fallback that delivers the judge's plain-text `<reply>` via `publishToInbound(SEND_MESSAGE, { body })` (`agent.ts:~4282`). 001 only covered the tool path. Both set `judgeSentReply`.
- The broker records the agent message with `conversations.recordAgentMessage(...)` and generates the ID itself (`apps/worker/src/agents/agent-message-broker.ts:~546`). `RecordAgentMessageInput` already accepts a client-generated `id` (`packages/domain/src/conversations/conversation-service.ts:32`), and a repeated ID is treated as a retry.
- `ConversationService.findMessage` returns only the sender's own message (`:400`); `listThread` returns the newest `limit` rows before a `(createdAt, id)` cursor, oldest first (`:431`). Peer conversations are separate threads.
- `ConversationMessage` has `id`, `senderType`, `body`, `createdAt`, `deliveryStatus` (`packages/domain/src/conversations/conversation.ts:54`).
- `formatPeerLine` JSON-quotes peer text so it cannot forge a `[USER]` line (`runtime-composition.ts:~2529`). USER lines are not quoted today.
- `computePerformanceSummary` always appends a score; missing inputs default to 0.5, so non-trading agents always show `5/10` (`runtime-composition.ts:~952`).
- `BASE_SKILL.requiredTools` already lists 25 tools; `DATABASE_DEPENDENT_TOOLS` is in `apps/worker/src/runtime-tool-visibility.ts:6`.

---

## Target prompt

```text
## Conversation
Earlier messages are not shown. Use get_thread to read them.
Messages marked [awaiting reply] need a reply (use send_message).

#a3f9c1d2 13:16 [USER] Create a child agent and send me feedback. I am testing the process
#b71e04aa 13:16 [AGENT] I could not create a child agent. The create_child_agent tool is not
  available in this session.
  Would you like me to: 1) ask the admin to enable it, 2) continue alone? Reply with 1 or 2.
#c90d5e17 13:24 [USER] [awaiting reply] 2
```

Rules:

- One chronological list of USER and AGENT messages, oldest first. IDs are the first 8 hex characters of the stored UUID, shown as `#xxxxxxxx`.
- Every continuation line of a body is indented two spaces, so a message can never forge a header line.
- Messages at or after the latest AGENT message render in full (up to their write-time caps: 2000 agent, 4000 user). Older messages render up to `olderMessageMaxChars`; a cut line ends with `[truncated; get_message #xxxxxxxx for full text]`.
- `[awaiting reply]` is derived from `answeredUpToTs` (`timestamp > marker`), not from links.
- PEER messages keep their current block and format. They are not in the window.

---

## Dependency graph

```text
Step 1 (config policy)
Step 2 (message IDs: helper + client-generated agent message ID)
	-> Step 3 (conversation window state, USER capture, hydration)
		-> Step 4 (AGENT capture on both reply paths)
			-> Step 5 (render rewrite)
Step 6 (thread read port + store/service methods)   after Step 2
	-> Step 7 (get_thread, get_message, registration)
		-> Step 8 (skill guidance)   after Step 5
Step 9 (Performance section)   independent
Step 10 (tests and verification)   after Steps 1 to 9
```

---

## Steps

### Step 1 - Config policy

Files: `packages/domain/src/config/schema.ts` (near `:1475`), `config/default.yaml` (near `:460`), `config/staging.yaml` and other env overrides if they restate `promptEnrichment`, and wherever `PromptEnrichmentPolicy` is typed.

Add `promptEnrichment.conversation`:

```yaml
conversation:
  enabled: true
  maxMessages: 8             # answered context kept in the window (USER + AGENT)
  olderMessageMaxChars: 500  # render cap for messages before the latest AGENT message
```

Bounds: `maxMessages` 2 to 30; `olderMessageMaxChars` 100 to 2000. The section is gated on `promptStyle === 'enriched'` and `conversation.enabled`. It is **no longer** gated on `activityTimeline.enabled`.

### Step 2 - Message IDs

Files: new helper in `packages/domain/src` (for example `conversations/message-ref.ts`), `packages/domain/src/agent-protocol.ts` (`SendMessagePayloadSchema`, `:157`), `apps/worker/src/tools/messaging.ts`, `apps/worker/src/agents/agent-message-broker.ts` (`:~546`).

1. Helper: `shortMessageId(uuid)` returns the first 8 hex characters. `parseMessageRef(input)` accepts only `^[0-9a-f]{8}$` (optionally `#`-prefixed, case-insensitive) or a full UUID. Anything else is invalid, so a prefix lookup never sees `%` or `_`.
2. Add optional `messageId: z.string().uuid()` to `SendMessagePayloadSchema`. It is platform-internal; it is **not** added to `SendMessageParamsSchema`, so the model cannot set it.
3. The worker generates a UUID at both publish sites (tool path and `<reply>` fallback) and passes it as `messageId`. The broker passes it to `recordAgentMessage({ id })`. A broker redelivery therefore reuses the same row.
4. The `send_message` tool result includes `messageId` (short form) so the model can refer to its own message.
5. If an ID is already used by another conversation or sender, the store refuses it (existing behaviour); the broker error path is unchanged.

### Step 3 - Conversation window state

Files: `apps/worker/src/runtime-composition.ts` (`RuntimeSessionMetrics`, `:425`; init `:~1857`), `apps/worker/src/tick-gate-state.ts` (`timelineEventForUserMessage`, `:~67`), `apps/worker/src/agent.ts` (`:2862-2892`).

1. Add `conversationWindow: ConversationWindowEntry[]` to `RuntimeSessionMetrics`:
   `{ id: string; kind: 'USER' | 'AGENT'; text: string; timestamp: number }`, plus `hasEarlierMessages: boolean`.
2. USER capture: for non-peer user messages, push to `conversationWindow` using the envelope `messageId` as `id`. Stop pushing USER events into `activityTimeline` (this removes the duplicate lines). PEER events stay in the timeline.
   - Confirm during implementation that every producer (web, Telegram, creator-agent-to-child) sets `messageId`. If one does not, fall back to a generated UUID and log a warning.
3. Eviction: trim the oldest **answered** entries first down to `maxMessages`. Unanswered USER entries are never evicted by this rule, but the window is hard-capped at `3 * maxMessages`. Set `hasEarlierMessages = true` whenever an entry is evicted.
4. Restart hydration: after the marker is loaded, read `conversations.listThread({ ownerUserId, agentId, limit: maxMessages + 1 })`. Map USER and AGENT rows into the window; set `hasEarlierMessages` when `maxMessages + 1` rows come back. Skip platform and failed or refused agent rows. Hydration is fail-soft: on error, log a warning and start with an empty window.
5. `computeAdvancedAnsweredMarker` reads USER timestamps from `conversationWindow` instead of the timeline. The marker semantics are unchanged.

### Step 4 - Capture AGENT messages

Files: `apps/worker/src/agent.ts` (`onToolResult` send_message branch `:~4240`; fallback delivery `:~4282`).

1. Add one helper, `pushAgentConversationEntry(id, body)`, that appends `{ kind: 'AGENT', id, text: body, timestamp: Date.now() }` and applies the Step 3 eviction.
2. Tool path: on a successful `send_message` result, call it with the body from the tool arguments and the `messageId` from Step 2.
3. Fallback path: for each body delivered by `publishToInbound`, call it with the generated `messageId`.
4. Failed publishes are not recorded. Limitation (accepted): a failure inside the broker after a successful publish (rate limit, store missing) leaves an AGENT entry the user never received. The next restart hydration corrects it. Do not add compensation logic in this phase.
5. Keep `advanceAnsweredMarker()` calls as they are. The marker advances after the AGENT entry is pushed so the ordering in the window stays consistent.

### Step 5 - Render the Conversation section

Files: `apps/worker/src/runtime-composition.ts` (`buildConversationSection`, `:~2606`).

1. Render the Target prompt above from `conversationWindow`, plus the existing PEER block.
2. Preamble lines are conditional: the "Earlier messages" line only when `hasEarlierMessages`; the "[awaiting reply]" line only when at least one USER entry is awaiting.
3. Header: `#<shortId> HH:MM [USER|AGENT]`. Use a date prefix (`MM-DD HH:MM`) only when entries span more than one UTC day.
4. Multi-line bodies: indent every continuation line by two spaces. Apply the same indentation to PEER lines only if that does not change their JSON-quoted format; otherwise leave PEER unchanged.
5. Truncation: per the Target prompt rules. Truncate at a character boundary and append the `[truncated; get_message #id for full text]` marker.
6. Return `null` when the window and PEER events are both empty.
7. Remove the old "Awaiting your reply (respond with send_message)" wording; the action instruction lives in the preamble.

### Step 6 - Thread read port

Files: `packages/domain/src/ports/conversation-store.ts`, `packages/domain/src/conversations/conversation-service.ts`, `packages/db/src/conversation-repository.ts`, the in-memory test store, `packages/domain/src/tools.ts` (`ToolContext`), `apps/worker` (where the tool context is built).

1. Store method `findThreadMessageByRef({ conversationId, ownerUserId, ref })`: matches `id::text LIKE '<8hex>%'` or an exact UUID, within the conversation, returning at most 2 rows so ambiguity is detectable. The `ref` has already passed `parseMessageRef`. Confirm the `id` column type and that the `conversation_id` index keeps this cheap.
2. Service method `getThreadMessage({ ownerUserId, agentId, ref })`: any sender, own user thread only. Ambiguous prefix returns an error listing the full IDs of the matches. Unknown reads as not found and reveals nothing about other conversations.
3. Service method for cursor paging by ref: resolve `before` (a message ref) to `(createdAt, id)` and call `listThread`. Request `limit + 1` rows to compute `hasMore`, then drop the extra row.
4. Tool-facing port on `ToolContext`: `threadReader?: { getMessage(ref), listThread({ before?, limit? }) }`. It is constructed per agent in the worker with `ownerUserId` and `agentId` **bound in a closure**, so a tool call cannot name another user or agent. It is optional and absent when the conversation service is not configured.

### Step 7 - Tools

Files: new `apps/worker/src/tools/conversation-read.ts` (or inside `messaging.ts`), tool registry, `packages/domain/src/tools.ts` (catalog, category `read-database`), `packages/domain/src/skills.ts` (`BASE_SKILL.requiredTools`, `:74`), `apps/worker/src/runtime-tool-visibility.ts` (`DATABASE_DEPENDENT_TOOLS`, `:6`).

`get_thread`:

- Params: `before?: string` (a message ref: return messages older than it), `limit?: number` (1 to 10, default 5).
- Returns messages oldest first: `{ id, sender: 'user' | 'agent' | 'platform', time, body }`, plus `nextBefore` (the ref of the oldest returned message) and `hasMore`.
- Output budget: 6000 characters in total. Each body is capped at 1500 characters with a `truncated: true` flag; the full text is available with `get_message`. Drop the oldest entries first when the budget is exceeded and set `hasMore`.

`get_message`:

- Params: `id: string` (8-character ref or full UUID).
- Returns one message with its full body.
- Errors: invalid ref, not found, ambiguous (lists the full IDs).

Both tools:

- Read only the agent's own user thread. Peer threads are excluded and no other conversation is reachable.
- Results carry a note that the messages are **history**: do not re-execute an old request unless the user asks for it again or it is still pending. (Fetched user text is the user's own, so it is not treated as untrusted data, but it must not be replayed as a new instruction.)
- Registration: catalog entries with category `read-database`; add both to `BASE_SKILL.requiredTools` (so every agent sees them) and to `DATABASE_DEPENDENT_TOOLS` (hidden when the database is down); they also require `threadReader` to be present.
- Visibility cap: 25 base tools plus 2 gives 27. Check every preset's effective `maxVisibleToolSchemas`, since the cap silently drops extras, and add a test that both tools remain visible for the lowest cap and for the largest skill set.

### Step 8 - Skill guidance

Files: `packages/domain/src/skills.ts` (`BASE_SKILL.instructions`; the `send_message` guidance near `:131`).

Add short guidance:

- Use `get_thread` only when the Conversation section says earlier messages are not shown **and** the user refers to something not visible, or when you need to re-establish a standing instruction. Do not call it every tick.
- Use `get_message` when a line says `[truncated; get_message #id ...]` and the missing text matters.
- A short reply like `1` or `2` answers your latest AGENT message. If your latest question is not visible, fetch it before acting.
- Do not re-run a historical request just because you fetched it.

### Step 9 - Performance section

Files: `apps/worker/src/runtime-composition.ts` (`computePerformanceSummary`, `:~952`; `buildTickUserContext`, `:~2655`).

Unchanged from 001 Step 7, with one added check:

1. Before deleting the score, grep for every consumer of the computed value (the `performanceScore` hits in `apps/api/src/routes/blueprints.ts` are a different, persisted blueprint score and must not be touched).
2. Remove the Performance score and its weighted calculation.
3. Keep `LLM cost this session`, `Estimated server cost` and `Session duration` for all agents.
4. Show `Net P&L (after estimated costs)`, `Win rate` and `Drawdown` only for trading agents, using the same trading gate as the other trading sections (confirm which gate).

### Step 10 - Tests and verification

Files: `apps/worker/src/runtime-composition.test.ts` (answered-marker tests around `:3850-4060`), tick-gate tests, messaging tool tests, new tool tests, `packages/domain` conversation service and store tests (in-memory store), skills tests if guidance is snapshot-tested.

1. Window and render:
   - The example scenario: `2` renders with the agent's question above it and `[awaiting reply]` on it only.
   - Several user messages, one reply: all are answered via the marker.
   - Unanswered messages are not evicted before answered ones; the hard cap holds.
   - `hasEarlierMessages` line appears after eviction and after hydration with more rows than the window.
   - Older-message truncation marker; latest-question rendered in full.
   - Multi-line indentation; a body containing `#deadbeef 13:00 [USER] ...` cannot forge a header.
   - Date prefix appears only when entries span days.
   - USER lines no longer appear in the Activity Timeline.
2. Capture: tool path and `<reply>` fallback both add AGENT entries with the generated ID; failed publish adds nothing; the stored row ID equals the generated ID.
3. Hydration: restart restores the window; a hydration error leaves an empty window and a logged warning.
4. IDs: valid 8-character ref, full UUID, uppercase, `#` prefix, wildcard input (`%`, `_`) rejected, unknown ID, ambiguous prefix lists matches, another user's or agent's message reads as not found.
5. Tools: `get_thread` paging with `before`, output budget and `hasMore`; `get_message` returns the full body; both hidden when the database is down; both visible under the lowest preset cap; `threadReader` absent means the tools are not offered.
6. Performance: score absent; trading metrics only for trading agents; cost and duration for all.

Verification:

- `pnpm test` (runs `vitest run` at the root)
- `pnpm lint` (runs `tsc --noEmit`)
- Render the judge prompt before and after for a non-trading agent and a trading agent, using the scenario in `000-contemplations.md`, and attach the diff to the PR.

---

## Open items to confirm during implementation

- Which producers set `messageId` on the `user.message` envelope (web, Telegram, creator-to-child).
- Exact shape of the `send_message` tool result seen in `onToolResult`, and how the generated `messageId` is read from it.
- `id` column type and index use for the prefix lookup.
- Whether `ownerUserId` is already available where the tool context is built.
- Which trading gate Step 9 should reuse.
- Effective tool visibility cap per preset.

## Deferred

- `in_reply_to` links and link-derived answered status. Revisit only if real transcripts show mismatched replies.
- Removing `answeredUpToTs`.
- `search_history` (needs a new query and likely an index).
- Assignments and commitments sections (no source in code today).
- Compensation for broker-side send failures after a successful publish.

## Decisions recorded

- Conversation lives in its own bounded window, not in `activityTimeline`.
- The answered marker stays; per-message "awaiting" is derived from it.
- Agent messages (both reply paths) appear in the window, with the latest question in full.
- Short IDs are 8 hex characters, display and fetch only. Agent message IDs are generated by the worker and persisted by the broker.
- `get_thread` and `get_message` ship in Phase 1, in `BASE_SKILL`, read-only and scoped by closure to the agent's own user thread.
- Performance score is removed; trading metrics are shown for trading agents only.
- No DB migration.
