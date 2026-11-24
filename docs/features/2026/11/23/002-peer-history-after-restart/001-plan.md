# Plan: peer messages after a worker restart

Status: draft, not implemented. Owner decision needed on the options below.

## Correction to the earlier finding

The earlier note said that after a restart, peer replies are labelled as child reports. That is not what the code does.

- Live peer messages go to the in-memory `activityTimeline` as `PEER` entries ([agent.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agent.ts), around line 3088). Nothing about them is stored in the Conversation window.
- Peer messages are stored in a separate pair thread (`peerConversationId(from, to)`, channel `internal`). The worker never reads that thread.
- Hydration reads only the agent's user thread (`listThread`, which uses `userAgentConversationId`). Its only non-self agent rows are child reports, so the `CHILD_REPORT` label is correct for them.

So after a restart, peer messages are missing from the prompt. They are not mislabelled. `activityTimeline` starts empty each process ([runtime-composition.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/runtime-composition.ts), around line 1929). The gap predates the parent-child change.

## Options

| Option | What it does | Cost | Risk |
|---|---|---|---|
| A. Accept | Peer context is lost on restart. The messages stay visible in the peer-threads API. | None | The agent may not know about a peer message it received before the restart. |
| B. Hydrate peer threads (recommended) | On first tick, load recent peer messages received by this agent and push them into `activityTimeline` as `PEER` entries, oldest first, capped at `activityTimeline.maxEvents`. | Medium: a domain query, hydration code, tests | Duplicates with live messages if hydration overlaps a live capture. Needs a dedupe key. |
| C. Add a PEER window kind | Store peer messages in the Conversation window, as a new kind. | Larger: window kind, formatting, trimming, tests | Peers would compete with the user's messages for window space. Changes prompt layout. |

Option C is not recommended. It changes the prompt structure for a small gain.

## Option B: steps

1. **Domain query.** Add a method to the conversation service that lists the most recent peer messages received by one agent, across all its pair threads, owner-scoped, oldest first. Exclude messages the agent sent itself, and exclude `failed` and `refused` rows. Reuse the existing `listPeerThreads` store path if it fits; otherwise add a narrow query.
2. **Hydration.** In `hydrateConversationWindow` ([agent.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agent.ts), around line 1555), also load those peer messages. Convert each to a `PEER` event with the sender's name, using the same shape `timelineEventForUserMessage` produces, so `formatPeerLine` renders it unchanged.
3. **Dedupe.** Keep a set of stored message ids already in the timeline. Skip any hydrated message whose id is already present, so a live capture cannot appear twice.
4. **Budget.** Respect `activityTimeline.maxEvents`. Hydrated peer events are older than live ones, so they are dropped first when the cap is hit.
5. **Tests.**
   - Domain: the query returns received peer messages only, in order, owner-scoped, without failed or refused rows.
   - Worker: hydration pushes `PEER` events, skips duplicates, and respects the cap.
   - Keep the test set small. Do not repeat the same cases in mirrored test files.
6. **Docs.** Update the peer-messaging doc to say peer context now survives a restart, up to the timeline cap.

## Open questions for the owner

1. Accept option A, or implement option B?
2. Should peer context survive a restart at all? Peer messages can be stale. A reasonable limit is the timeline cap and no older history.
3. Should the restored messages be marked as restored, so the agent knows they predate the restart?

## Out of scope

- Changing how peer messages are stored.
- Changing the child-report path. That path already works after a restart.
