# Bug Report: Inverted Lifecycle Timestamps — `startedAt` > `stoppedAt` After Restart

**Bug ID:** 001-bot-startedAt-after-stoppedAt  
**Severity:** High  
**Date:** 2026-06-27  
**Status:** Fixed (commit: `4f24cbe`)

## Summary

`markBotRunning` does not clear `stoppedAt`, causing inverted lifecycle timestamps when a bot is stopped and then restarted. After restart, the bot row shows `startedAt > stoppedAt` (new start, old stop), which is semantically invalid — a running bot should never have a `stoppedAt` value.

## Root Cause

`packages/db/src/repositories.ts` — `markBotRunning` only set `status`, `startedAt`, and `updatedAt`; it never nulled out `stoppedAt`:

```ts
// BEFORE (buggy)
async markBotRunning(botId: string): Promise<void> {
    await this.db
      .update(bots)
      .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
      .where(eq(bots.id, botId));
  }
```

## Fix

Added `stoppedAt: null` to the `.set()` call in `markBotRunning`:

```ts
// AFTER (fixed)
async markBotRunning(botId: string): Promise<void> {
    await this.db
      .update(bots)
      .set({ status: 'running', startedAt: new Date(), stoppedAt: null, updatedAt: new Date() })
      .where(eq(bots.id, botId));
  }
```

## Verification

- **Unit test:** `packages/db/src/__tests__/bot-lifecycle.test.ts` — `markBotRunning clears stoppedAt`
- **Acceptance criteria:** AC1 — After starting a previously-stopped bot, `stoppedAt` is `null` and `startedAt > stoppedAt` is never true

## Impact

| Transition | `status` | `startedAt` | `stoppedAt` |
|---|---|---|---|
| Stop then Restart (before fix) | `running` | set to now | old value (bug!) |
| Stop then Restart (after fix) | `running` | set to now | `null` ✅ |
