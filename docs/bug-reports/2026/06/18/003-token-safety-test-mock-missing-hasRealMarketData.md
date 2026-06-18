# 003-token-safety-test-mock-missing-hasRealMarketData

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-18
- **Summary:** `token-safety-adapter.test.ts` — 2 tests fail because test mocks omit `hasRealMarketData`, causing `liquidityUsd`/`volume24hUsd` to be `undefined` in results.

## Root Cause

The source code in `token-safety-adapter.ts` gates `liquidityUsd` and `volume24hUsd` on `tokenData.hasRealMarketData`:

```ts
liquidityUsd: tokenData.hasRealMarketData ? tokenData.liquidityUsd : undefined,
```

The test helper `makeGoodToken()` did not include `hasRealMarketData: true`, so the field was `undefined` (falsy), omitting the values from both the success result and error details.

This was introduced when `hasRealMarketData` was added to the `TokenData` type to distinguish real DexScreener/GeckoTerminal data from canonical-token fallback data.

## Fix

Added `hasRealMarketData: true` to `makeGoodToken()` in the test file.

Since `makeBadToken()` spreads `makeGoodToken()`, both failing tests are fixed.

## Files Changed

- `apps/worker/src/token-safety-adapter.test.ts` — line 128: added `hasRealMarketData: true`

## Verification

```bash
npx vitest run apps/worker/src/token-safety-adapter.test.ts
# 24 passed, 0 failed
```
