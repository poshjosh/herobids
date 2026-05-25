# BUG-011: Swap Reconciliation Maps Wallet Transactions as Fills — False Unknown-Fill Diffs

**Status:** CLOSED

**Severity:** Medium

**Date:** 2026-05-24

## Summary

The swap venue state loader fetched recent wallet transactions and mapped them to "fill-like" records for reconciliation. In shadow mode, the system never executes real swaps (ShadowExecutor uses synthetic fills), so ANY real transaction on the wallet (external transfers, manual swaps) would be flagged as an "unknown fill" by the reconciler — creating misleading drift alerts.

## Root Cause

In `packages/engine/src/reconciliation/venue-state-loaders.ts`, the `createSwapVenueStateLoader` fetched transactions and mapped them:

```typescript
const [balResult, txResult] = await Promise.all([
  venue.fetchBalances(),
  venue.fetchRecentTransactions(since ?? undefined),
]);
// ...
const recentFills = txResult.data.map((tx) => ({
  venueRefId: tx.executionRef,  // opaque blockchain tx hash
  symbol: `${tx.inputAsset}/${tx.outputAsset}`,
  side: 'sell',
  quantity: quantity(tx.inputAmount.toString()),
  price: ...,
}));
```

Problems:
1. In shadow mode, no real swaps are executed — local fills have `shadow-xxx` venueRefIds that will never match blockchain tx hashes
2. External wallet activity (airdrops, manual trades) gets reported as "unknown fills"
3. The reconciler raises false drift alerts that require manual dismissal
4. Fetching transactions is an unnecessary RPC call that adds latency and can fail

## Fix

Removed transaction fetching from the swap venue state loader entirely. Swap venue reconciliation now relies solely on balance comparison (which is the semantically correct approach for token-based venues):

```typescript
return async (_since: Date | null): Promise<VenueState | null> => {
  const balResult = await venue.fetchBalances();
  // ...
  return {
    positions: [],
    balances,
    recentFills: [],  // No fill comparison for swap venues
    openOrders: [],
  };
};
```

Updated tests to reflect the new behavior:
- "maps transactions to fills" → "always returns empty recentFills (avoids false unknown-fill diffs)"
- "handles zero input amount" → "does not fetch transactions (not needed for balance-only reconciliation)"
- "returns null when transactions fail" → "succeeds even when transactions endpoint would fail (not called)"

## Files Changed

- `packages/engine/src/reconciliation/venue-state-loaders.ts`
- `packages/engine/src/reconciliation/venue-state-loaders.test.ts`

## Verification

- 167 tests pass, 0 failures
- TypeScript compiles cleanly
