# Bug Report: Silent fetchPrice Failure — No Log When Ticker Fetch Fails

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-05-30
- **Summary:** The `fetchPrice()` closure in the worker returned `null` without any logging when `venueAdapter.fetchTicker()` returned an error Result. Since `tick()` also exits silently on null snapshot, a failing ticker fetch produced zero diagnostic output. The actor appeared healthy from logs (reconciliation passing, no errors), making it impossible to distinguish "strategy hasn't fired yet" from "price data is completely broken."

## Root Cause

```typescript
// apps/worker/src/index.ts
const fetchPrice = async (): Promise<MarketSnapshot | null> => {
  if (!venueAdapter) return null;
  const result = await venueAdapter.fetchTicker(config.symbol);
  if (!result.ok) return null;  // ← silent discard of error
  return { symbol: config.symbol, price: result.data.last, timestamp: result.data.timestamp };
};
```

Combined with `tick()`:
```typescript
let snapshot = await this.deps.fetchPrice();
if (!snapshot) return;  // ← silent exit, no log
```

The error from `fetchTicker` (e.g., "does not have market symbol") was caught by `withRateLimit`'s try/catch, wrapped in `err(mapCcxtError(e))`, but then discarded without trace.

## Impact

- Bug 005 (wrong symbol format) went undiagnosed for over 7 minutes across multiple instance runs
- No way to distinguish from logs: "market is flat" vs "ticker endpoint is broken"
- Operator has no signal that the trading loop is non-functional

## Fix

**`apps/worker/src/index.ts`** — Added a `logger.warn` when `fetchTicker` returns an error:

```typescript
const fetchPrice = async (): Promise<MarketSnapshot | null> => {
  if (!venueAdapter) return null;
  const result = await venueAdapter.fetchTicker(config.symbol);
  if (!result.ok) {
    logger.warn({ tradingInstanceId, symbol: config.symbol, error: result.error }, 'fetchTicker failed');
    return null;
  }
  return { symbol: config.symbol, price: result.data.last, timestamp: result.data.timestamp };
};
```

## Lesson

- Never silently discard errors in a trading loop. If data is unavailable, log at warn level minimum.
- Reconciliation passing does not prove the tick loop is functional — they use different code paths.
- A trading system that looks healthy but isn't trading is more dangerous than one that crashes loudly.
