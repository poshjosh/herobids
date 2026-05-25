# BUG-003: StreamMarketDataFeed Unhandled Subscribe Failure

**Status:** CLOSED

**Severity:** High

**Date:** 2026-05-24

## Summary

`StreamMarketDataFeed.start()` fire-and-forgets the async `connect()` call. When `pool.subscribe()` throws (e.g. unknown venue, network error), the error is swallowed silently and the actor continues with no market data feed — no ticker updates, no trade events. There is no fallback to polling.

## Root Cause

- `start()` used `void this.connect()` which discards the rejected promise
- No error handler or callback was available to signal the failure to the actor
- The trading actor unconditionally preferred `StreamMarketDataFeed` whenever `deps.streamPool` was set, with no degradation path

## Fix

1. `StreamMarketDataFeed` now catches the connect error and invokes an `onConnectError` callback
2. `TradingActor` passes an `onConnectError` handler that logs a warning and starts a `PollingMarketDataFeed` as fallback
3. Extracted `createPollingFeed()` helper method for reuse

## Files Changed

- `packages/engine/src/stream-market-data-feed.ts`
- `apps/worker/src/trading-actor.ts`

## Regression Test

- `packages/engine/src/stream-market-data-feed.test.ts` — tests error callback on subscribe failure
