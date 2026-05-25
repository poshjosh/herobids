# BUG-007: Stream Pool Subscriber Leak on Connect Failure (Waiter Path)

**Status:** CLOSED

**Severity:** Medium

**Date:** 2026-05-24

## Summary

In `PublicStreamPool`, when a second subscriber joins while a WebSocket connection is still being established (the "waiter" path), a failed connection leaves the subscriber's entry in the `conn.subscribers` map permanently. The symbols it requested also remain in `conn.subscribedSymbols`. Over time, accumulated leaked entries prevent garbage collection of connection state and may cause `unsubscribe()` logic to malfunction.

## Root Cause

The waiter path in `subscribe()` awaited the existing connection promise but had no cleanup on rejection:

```typescript
// Waiter path — connection in progress
conn.subscribers.set(subId, { symbols, onEvent });
for (const s of symbols) conn.subscribedSymbols.add(s);
await conn.connectingPromise; // throws if WS fails
// ...send subscriptions
```

If `connectingPromise` rejected:
1. The subscriber entry remained in `conn.subscribers`
2. Its symbols remained in `conn.subscribedSymbols`
3. The subscriber's `unsubscribe()` callback was never returned to the caller (since the promise threw)
4. No way to clean up the leaked state

## Fix

Wrapped the waiter path's `await` in a try/catch. On failure:

```typescript
try {
  await conn.connectingPromise;
  sendSubscriptions(conn.ws!, symbols);
} catch (err) {
  conn.subscribers.delete(subId);
  for (const s of symbols) {
    const stillNeeded = [...conn.subscribers.values()].some(sub =>
      sub.symbols.includes(s),
    );
    if (!stillNeeded) conn.subscribedSymbols.delete(s);
  }
  throw err;
}
```

Key points:
- Only removes symbols that no other active subscriber still needs
- Re-throws the error so callers (StreamMarketDataFeed) still see the failure
- The initiator path (first subscriber that triggers the connection) already handled this correctly

## Files Changed

- `packages/venues/src/stream-pool.ts` (waiter path, ~line 133)

## Verification

- Stream pool tests pass
- Full test suite: 157 tests pass
- TypeScript compiles cleanly
