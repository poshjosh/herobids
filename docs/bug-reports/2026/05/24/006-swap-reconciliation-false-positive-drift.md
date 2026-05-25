# BUG-006: Swap Reconciliation False-Positive Drift from Synthetic Positions

**Status:** CLOSED

**Severity:** High

**Date:** 2026-05-24

## Summary

`createSwapVenueStateLoader` was synthesizing position objects from token balances. These fake positions had `entryPrice: 0` and `side: 'long'`, which never matched the engine's internal position tracker state. This caused the reconciliation system to report constant drift for swap venues — triggering unnecessary alerts and potential position-flattening actions.

## Root Cause

The loader mapped each non-zero token balance to a position-like object:

```typescript
positions: balances
  .filter(b => !b.amount.isZero())
  .map(b => ({
    symbol: b.asset,
    side: 'long' as const,
    size: b.amount,
    entryPrice: price('0'),
  }))
```

But swap venues don't have directional positions — they have token balances. The reconciliation engine compared these synthetic positions against the engine's position tracker (which correctly had nothing for swap venues), found a mismatch, and reported drift.

## Fix

Changed `createSwapVenueStateLoader` to return `positions: []` (empty array). Token balance drift is detected separately via the balance comparison path in the reconciliation system, which already existed and worked correctly.

Added a code comment explaining the rationale:

```typescript
// Token holdings are tracked via balance comparison, NOT position comparison.
// Synthesizing positions from balances causes false drift because the engine
// position tracker never holds swap-balance entries.
positions: [],
```

Also updated two unit tests that asserted the old (incorrect) behavior:
- "maps balances to positions" → renamed to "does not synthesize positions from balances"
- "filters zero-balance assets from positions" → renamed to "always returns empty positions array"

## Files Changed

- `packages/engine/src/reconciliation/venue-state-loaders.ts`
- `packages/engine/src/reconciliation/venue-state-loaders.test.ts`

## Verification

- All venue-state-loaders tests pass (6 tests)
- Full test suite: 157 tests pass, 0 failures
- TypeScript compiles cleanly
