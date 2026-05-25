# BUG-009: Stream Fallback Only Covers Initial Connect Failure

**Status:** CLOSED

**Severity:** High

**Date:** 2026-05-24

## Summary

The `StreamMarketDataFeed` fallback polling only activates when the initial `connect()` promise rejects. If the stream connects successfully but later disconnects fatally (max reconnect attempts exhausted), the feed goes dead with no fallback — the shadow executor receives stale/missing ticker data indefinitely.

## Root Cause

In `packages/engine/src/stream-market-data-feed.ts`, the `onError` handler in the `connect()` method was a no-op:

```typescript
onError: () => {
  // Stream errors are handled by the pool's reconnection logic
},
```

When the underlying connector exhausts max reconnect attempts, it fires an error event through the pool's `fanOutError`. This error is delivered to the feed's `onError` handler, but since it did nothing, the feed remained in a "connected but dead" state with no data flowing.

## Fix

Updated the `onError` handler to activate fallback polling when an error is received and no fallback is already running:

```typescript
onError: (_error: Error) => {
  // If the error indicates fatal stream failure (max reconnect exhausted),
  // activate fallback polling so the feed doesn't go dead.
  if (!this.fallbackTimer && this.running) {
    this.startFallbackPolling();
  }
},
```

This ensures the feed degrades gracefully to polling on any fatal stream error, maintaining data flow for the shadow executor.

## Files Changed

- `packages/engine/src/stream-market-data-feed.ts` (connect method, onError handler)

## Verification

- 167 tests pass, 0 failures
- TypeScript compiles cleanly
