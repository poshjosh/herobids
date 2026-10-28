# Agent Conversation Hydration

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

This phase is a stopgap. It removes the inconsistency but does not restore agent memory. Decide at Phase 2 review whether to keep the filter once the thread is rehydrated.

## Phase 2: Hydrate the agent on start (not started)

Worker side (`apps/worker`):

1. On start, before the first tick, load the most recent user and agent messages for the agent from the database.
2. Map them to `USER` activity-timeline events (the same shape the runtime uses) and set `answeredUpToTs` from the persisted Redis marker.
3. Exclude judge decisions and tool activity. They are internal, not conversation.
4. Cap by message count and total characters so the prompt stays within budget and `maxEvents`.

Open questions:

- How many messages to load, and the character budget.
- Whether to load only the current-run messages or the last N regardless of run (the latter gives continuity across restarts).
- Where the query lives (worker reads the DB directly, or the API serves it).

## Verification

- Unit tests: message-to-event mapping, count and character caps, marker handling.
- Docker check: chat, stop, start, ask about the earlier topic. The agent should recall it.
- Phase 1: web unit tests for `latestRunStartMs` and `currentRunHistory`.

## Estimated effort

Phase 1: done. Phase 2: about 1 to 3 days.
