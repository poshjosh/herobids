# Bug Report: `onStarted` Callback Does Not Persist Running Status to DB

**Bug ID:** 008-onStarted-does-not-persist-running-status
**Severity:** High
**Date:** 2026-06-27
**Status:** FIXED

## Summary

User-started bots (via `POST /bots/:id/start`) never transition to `status='running'` in the database. The API returns 202 with `status: 'starting'`, the worker successfully starts the actor, but the `onStarted` callback only publishes real-time events without calling `botRepo.markBotRunning()`. The bot-trade-test polls for `status === 'running'` and times out after 10 minutes.

The agent path (via `agent-message-broker.ts`) works because it calls `botRepo.markBotRunning(botId)` before enqueuing the lifecycle job.

## Root Cause

`apps/worker/src/index.ts` — The `onStarted` callback in `WorkerRuntimeConfig` only published real-time events (`userEventPublisher.publishBotStatus`, `actorHealthPublisher.publish`) but never persisted the `running` status to the database:

```ts
// BEFORE (buggy)
onStarted: (botId) => {
  // Publish running event after actor.start() has completed successfully.
  const userId = instanceUserIds.get(botId);
  if (userId) {
    userEventPublisher.publishBotStatus(userId, botId, 'running').catch(...);
  }
  void actorHealthPublisher.publish({...});
},
```

Additionally, `runtime.ts` called `onStarted` without `await`, so even an async callback would be fire-and-forget.

## Fix

### 1. `apps/worker/src/index.ts` — Add `botRepo.markBotRunning()` to `onStarted`

```ts
// AFTER (fixed)
onStarted: async (botId) => {
  // Persist running status to DB so user-started bots (API path) and
  // reclaim-rehydrated bots converge. Agent-created bots are pre-marked
  // by the broker, making this a no-op for that path.
  try {
    await botRepo.markBotRunning(botId);
  } catch (err) {
    logger.error({ err, botId }, 'Failed to persist running state to DB');
  }

  // Publish running event after actor.start() has completed successfully.
  const userId = instanceUserIds.get(botId);
  if (userId) {
    userEventPublisher.publishBotStatus(userId, botId, 'running').catch(...);
  }
  void actorHealthPublisher.publish({...});
},
```

### 2. `apps/worker/src/runtime.ts` — Update type and await the call

- Changed `onStarted` type from `(botId: string) => void` to `(botId: string) => void | Promise<void>`
- Changed `this.onStarted?.(id)` to `await this.onStarted?.(id)` in `startInstance()`

## Files Changed

- `apps/worker/src/index.ts` — Added `botRepo.markBotRunning(botId)` to `onStarted` callback
- `apps/worker/src/runtime.ts` — Updated `onStarted` type signature and added `await` at call site

## Verification

- **TypeScript:** `pnpm lint` (tsc --noEmit) passes
- **Unit tests:** `apps/worker/src/runtime.test.ts` — 6/6 pass
- **Functional test:** `bot-trade-test.sh` should now complete Phase 3 without timeout (requires running worker + stack)

## Related Bug Reports

- `002-onStopped-does-not-persist-db.md` — Same pattern: `onStopped` originally lacked `markBotStopped`. Fixed separately.
