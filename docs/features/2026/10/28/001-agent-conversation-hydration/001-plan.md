# Agent Conversation Hydration

Status: done. Both phases shipped. The Phase 1 UI run-scope filter has since been removed now that Phase 2 rehydration makes it unnecessary (see "Phase 1 removal" below).

## Problem

When a user stops an agent and starts it again, the conversation thread still shows messages from before the stop. The agent does not remember them. Its timeline lives in the worker container's memory and is lost on restart. Only the `answeredUpToTs` marker is persisted (in Redis).

Result: the UI and the agent disagree about what was discussed, and the user sees context the agent cannot use.

## Goals

- The thread shows what the agent remembers: messages from the current run.
- The agent rebuilds its conversation context on start from stored messages, so continuity survives restarts.

## Non-goals

- Changing how messages are stored.
- Changing the stop behavior or deleting history.
- Summarising long history (a later iteration, if needed).

## Phase 1: UI scope to the current run (done)

Implemented in:

- `apps/web/src/features/agents/AgentConversation.tsx`: reads the agent's runtime sessions (`GET /agents/:id/sessions`) and hides messages created before the latest run's `startedAt`. Shares the cache key with the agent detail page.
- `apps/web/src/features/agents/conversation-thread.ts`: `latestRunStartMs` and `currentRunHistory` helpers.
- `apps/web/src/lib/api-client.ts`: `AgentRuntimeSession` type for the sessions response.

Behavior:

- The filter is display-only. Stored messages are unchanged and older pages still load.
- With no runs yet, every message is shown.
- While sessions are loading, all messages show briefly, then older ones drop out.

This phase was a stopgap. It removed the inconsistency but did not restore agent memory. It has now been removed — see "Phase 1 removal" below — because Phase 2 restores the memory the filter compensated for.

## Phase 2: Hydrate the agent on start (done)

Worker side (`apps/worker`):

1. On the first tick after start, `hydrateConversationWindow()` loads the most recent user and agent messages from the conversation store (`ConversationService.listThread`), guarded by a once-per-process `conversationWindowHydrated` latch.
2. `windowEntryFromConversationRow` (`apps/worker/src/conversation-window.ts`) maps each row to the same `USER`/`AGENT` window entry live capture produces; `answeredUpToTs` is restored from the Redis key `agent:conversation:answered_at:<AGENT_ID>`.
3. Platform rows and the agent's own failed/refused messages are excluded. Judge decisions and tool activity are never written to the conversation thread, so they are not loaded.
4. The window is capped by `promptEnrichment.conversation.maxMessages` (one extra row is read only to compute `hasEarlierMessages`). Hydration is fail-soft: on any error, or when the DB/userId/feature is absent, the window starts empty.

Resolved open questions:

- Load the last N messages regardless of run, so continuity survives restarts (not scoped to the current run).
- The worker reads the DB directly via `ConversationService`.

## Phase 1 removal (done)

With Phase 2 in place the agent recalls prior-run messages, so the UI run-scope filter was hiding context the agent could in fact use — the inverse of the original goal. Removed:

- `currentRunHistory` and `latestRunStartMs` from `apps/web/src/features/agents/conversation-thread.ts` and their tests.
- The `sessionsQuery`/`runStartMs` wiring in `AgentConversation.tsx`; the thread now renders the full stored history (`buildThread(history, pending)`).

`agentsApi.sessions` / `AgentRuntimeSession` remain — the agent detail page still uses them.

## Verification

- Unit tests: message-to-event mapping, count and character caps, marker handling.
- Docker check: chat, stop, start, ask about the earlier topic. The agent should recall it.
- Phase 1 removal: web unit tests no longer cover the dropped helpers; `conversation-thread.test.ts` keeps the `buildThread`/`mergeMessages` coverage.

## Estimated effort

Phase 1: done (later removed). Phase 2: done.
