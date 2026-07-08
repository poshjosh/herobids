# Bug Report — 011: Wake-scheduler test race condition — enqueueWake races Phase 3 cleanup

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-07-07
- **Summary:** The unit test `wake-scheduler.test.ts > preserves a new wake enqueued while a flush is in flight` was failing consistently because of a deterministic race condition in the test's async ordering, not a bug in the production code.

## Root Cause

The test was structured as:
```ts
const evaluatePromise = monitor.evaluate();
deferred.resolve();           // unblocks Phase 2 → Phase 3 runs
await firstFlush;
await evaluatePromise;        // evaluate finishes AFTER Phase 3
```

The generation-based CAS (compare-and-swap) in Phase 3 of `flushPendingWakes` is designed to preserve a wake bucket when a concurrent `enqueueWake` has updated the generation. However, Phase 3 runs after Phase 2 (publish) completes, and the mutex chain (`withWakeMutationLock`) ensures Phase 3 waits for Phase 1 to complete — not for concurrent `enqueueWake` calls from evaluate.

Since `monitor.evaluate()` must traverse many async points (scan, hgetall, redis.get, redis.hset, checkDedupe, checkRateLimit, emitMarketWatchTriggered, recordDedupe, incrementRateCounter) before reaching `enqueueWake`, and Phase 3 only needs Phase 2 + 1 async tick after `deferred.resolve()`, Phase 3 deterministically acquired the mutex first. It then compared the current generation (0, unchanged) with the claimed generation (0) and deleted the bucket. When `enqueueWake` finally ran, it found no key and created a fresh bucket with only the new event (1 eventId), while the test expected 2.

## Fix

The test's async ordering was corrected by awaiting `evaluatePromise` BEFORE calling `deferred.resolve()`:

```ts
const evaluatePromise = monitor.evaluate();
// Let evaluate (and enqueueWake) complete while the flush is still in-flight.
// This ensures enqueueWake acquires the mutex BEFORE Phase 3 does.
await evaluatePromise;
deferred.resolve();    // only then unblock Phase 2 → Phase 3
await firstFlush;
```

This still tests the intended scenario (enqueue while flush is in flight — `deferred` hasn't resolved when `enqueueWake` runs), but makes the ordering deterministic: enqueue always beats Phase 3 to the mutex.

## Files Changed

- `apps/worker/src/market-intelligence/wake-scheduler.test.ts`

## Verification

- The test now passes consistently (verified 5/5 runs)
- The wake-scheduler test suite passes all 12 tests
- Full test suite passes including `Agent-bot LLM inheritance` tier which previously failed due to the same underlying test failure
