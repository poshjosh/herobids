# BUG-008: Swap Venue fetchPrice Returns Null — Strategy Never Evaluates

**Status:** CLOSED

**Severity:** High

**Date:** 2026-05-24

## Summary

Trading instances using swap venues in `shadow` mode never reach strategy evaluation. The `fetchPrice()` function returns `null` for swap venues because there is no orderbook `venueAdapter`, causing `tick()` to return early before evaluating the strategy.

## Root Cause

In `apps/worker/src/index.ts`, the `fetchPrice` closure is:

```typescript
const fetchPrice = async (): Promise<MarketSnapshot | null> => {
  if (!venueAdapter) return null; // Swap venues don't use orderbook ticker
  ...
};
```

For swap venues, `venueAdapter` is undefined (only orderbook venues create it), so `fetchPrice()` always returns `null`.

In `apps/worker/src/trading-actor.ts`, the `tick()` method has:

```typescript
const snapshot = await this.deps.fetchPrice();
if (!snapshot) return; // ← early exit, strategy never evaluates
```

This means the shadow executor's market data feed collects live ticker data, but the actor never uses it for strategy decisions.

## Fix

In `trading-actor.ts` `tick()`, when `fetchPrice()` returns null AND a `marketDataFeed` exists, derive a `MarketSnapshot` from the feed's ticker:

```typescript
let snapshot = await this.deps.fetchPrice();
if (!snapshot && this.marketDataFeed) {
  const ticker = this.marketDataFeed.getTicker(this.deps.symbol);
  if (ticker) {
    snapshot = { symbol: this.deps.symbol, price: ticker.last, timestamp: ticker.timestamp };
  }
}
if (!snapshot) return;
```

This allows swap venues in shadow mode to evaluate strategies using real-time price data from the stream/polling feed.

## Files Changed

- `apps/worker/src/trading-actor.ts` (tick method)

## Verification

- 167 tests pass, 0 failures
- TypeScript compiles cleanly
