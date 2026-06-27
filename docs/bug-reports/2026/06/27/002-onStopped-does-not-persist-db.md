# Bug Report: `onStopped` Callback Does Not Persist DB State

**Bug ID:** 002-onStopped-does-not-persist-db  
**Severity:** High  
**Date:** 2026-06-27  
**Status:** Fixed (commit: `4f24cbe`)

## Summary

Worker's `onStopped` callback never updates the bot's DB row, so bots stopped via BullMQ jobs or worker shutdown remain `status='running'` in the database indefinitely. The callback only performed in-memory cleanup (actor registry, event publishing) without persisting the `stopped` state.

## Root Cause

`apps/worker/src/index.ts` — The `onStopped` callback in `WorkerRuntimeConfig` only did in-memory cleanup and WebSocket publishing; it never called `botRepo.markBotStopped()`:

```ts
// BEFORE (buggy)
onStopped: async (instanceId: string) => {
      actorRegistry.delete(instanceId);
      agentStreamConsumer.unsubscribe(instanceId);
      // ... publish events, clean up maps ...
    },
```

When a bot was stopped via:
- API `POST /bots/:id/stop` → enqueue stop job → worker processes it → actor stopped → `onStopped` called
- Worker graceful shutdown → all instances stopped → `onStopped` called

…the DB row remained `status='running'` because nothing wrote the stopped state.

## Fix

Added `await botRepo.markBotStopped(instanceId)` at the top of `onStopped`, wrapped in try/catch to prevent a DB failure from blocking in-memory cleanup:

```ts
// AFTER (fixed)
onStopped: async (instanceId: string) => {
      try {
        await botRepo.markBotStopped(instanceId);
      } catch (err) {
        logger.error({ err, instanceId }, 'Failed to persist stopped state to DB');
      }
      actorRegistry.delete(instanceId);
      agentStreamConsumer.unsubscribe(instanceId);
      // ... publish events, clean up maps ...
    },
```

## Risk Consideration

The plan's risk assessment explicitly called for catch-and-continue: if the DB write fails (e.g., DB down), the in-memory cleanup still runs, and the reclaim sweep will detect the orphaned actor. A subsequent start will clear stale state.

## Verification

- **Acceptance criteria:** AC2 — After stopping a running bot (via API, agent tool, or worker shutdown), DB shows `status='stopped'` with `stoppedAt` set
- **Bot trade test:** Phase 3 verifies stop → DB invariants end-to-end
