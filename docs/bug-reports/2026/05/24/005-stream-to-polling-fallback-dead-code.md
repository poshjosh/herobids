# BUG-005: Stream-to-Polling Fallback Dead Code After Connect Failure

**Status:** CLOSED

**Severity:** High

**Date:** 2026-05-24

## Summary

When a WebSocket stream connection fails, `StreamMarketDataFeed` was supposed to fall back to REST polling via the `onConnectError` callback. However, the fallback was dead code because the callback was invoked in the actor (which creates a new `PollingMarketDataFeed`), but the `ShadowExecutor` still held a reference to the original (now-dead) `StreamMarketDataFeed` instance. Calls to `getTicker()` on the executor's feed would always return `null`.

## Root Cause

The architecture created `StreamMarketDataFeed` and passed it to `ShadowExecutor` at construction time. When a connect error occurred:

1. `onConnectError` was called on the `TradingActor`
2. Actor created a new `PollingMarketDataFeed` and swapped its internal reference
3. `ShadowExecutor` still pointed to the old dead `StreamMarketDataFeed`
4. No market data reached the executor → fills never simulated

## Fix

Moved fallback responsibility into `StreamMarketDataFeed` itself:

1. Added optional `fallbackFetcher` and `fallbackIntervalMs` constructor options
2. When `pool.subscribe()` rejects, the feed starts an internal polling timer
3. The timer calls `fallbackFetcher(symbol)` and writes results to the same `this.tickers` map
4. Consumers (ShadowExecutor) calling `getTicker()` get data regardless of whether it came from the stream or fallback polling
5. `stop()` clears the fallback timer

This keeps the same object reference alive, avoiding the stale-pointer problem.

## Files Changed

- `packages/engine/src/stream-market-data-feed.ts` — added `TickerFetcher` type, fallback fields, `startFallbackPolling()` method
- `packages/engine/src/index.ts` — export `TickerFetcher` type
- `apps/worker/src/trading-actor.ts` — passes `fallbackFetcher` and `fallbackIntervalMs` to `StreamMarketDataFeed`; removed standalone `onConnectError` → `createPollingFeed` path

## Verification

- 13 unit tests in `stream-market-data-feed.test.ts` pass
- 7 unit tests in `trading-actor.test.ts` pass
- TypeScript compiles cleanly
