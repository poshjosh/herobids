# 002 — Billing threshold warnings persist after top-up

**Status:** CLOSED
**Created:** 2026-08-03
**Severity:** Medium
**Category:** Billing / UX

## Summary

When a user reaches billing spend thresholds (e.g. 80% and 100% of hard cap), threshold warning chips are displayed on the billing page. After topping up enough credit to clear these thresholds, the warning messages should disappear. Two bugs caused them to persist incorrectly.

**Bug A — Mock provider top-up silently swallows processing failures.** When using the `mock` payment provider (the default in local Docker), the top-up checkout flow calls `entitlementSync.processEvent()` to apply the credit. If processing fails for any reason (missing account, plan config mismatch, DB error), the method returns `{ processed: false, error: '...' }` — but the billing route ignored the return value and always returned a success URL. The user was redirected believing the top-up succeeded, but the balance was never updated, so threshold warnings persisted.

**Bug B — Zero hard cap makes all threshold warnings show permanently.** The warning computation used `hardCap != null` as the gate, but a hard cap of `0` is a valid value (meaning "no out-of-pocket spend allowed"). When `hardCap = 0`, the comparison `netOutOfPocket >= (0 * pct) / 100` simplifies to `netOutOfPocket >= 0`, which is always `true`. All configured threshold warnings (e.g. 80%, 100%) would display permanently regardless of the actual balance.

## Reproduction

### Bug A

1. Configure the app with `billing.primaryProvider: mock` (default in local Docker).
2. Trigger usage events to push the balance below the hard cap thresholds.
3. On the billing page, observe "80% threshold reached" and "100% threshold reached" chips.
4. Click a top-up pack (any mock pack).
5. If `entitlementSync.processEvent()` fails silently (e.g. billing account not found), the browser still redirects to `?session=success`.
6. The billing page reloads, but the balance is unchanged — warnings persist.

### Bug B

1. Set the hard cap to $0.00 (either via plan config or account-level spend caps).
2. Observe the billing page — "80% threshold reached" and "100% threshold reached" chips are displayed regardless of the actual balance.

## Root Cause

### Bug A

**File:** `apps/api/src/routes/billing.ts:1133–1142` (before fix)

```typescript
if (usedProvider === 'mock') {
    const mockProvider = providerManager.getProvider('mock') as MockProvider;
    const syntheticTopUpEvent = mockProvider.createSyntheticTopUpEvent({ ... });
    await entitlementSync.processEvent(syntheticTopUpEvent);  // ← return value ignored
}
```

`EntitlementSync.processEvent()` returns `{ processed: boolean; error?: string }`. If `processed` is `false` (duplicate event, missing dependencies, or caught exception), the balance was never updated but the route still returned a `200` with a checkout URL.

### Bug B

**File:** `apps/api/src/routes/billing.ts:613–619` (before fix)

```typescript
const hardCap = period?.hardCapMicrousd;
const warnings = warningThresholds.map((pct) => ({
  thresholdPct: pct,
  reached: hardCap != null ? netOutOfPocket >= (hardCap * pct) / 100 : false,
}));
```

`hardCap != null` passes for `hardCap = 0`. The expression `(0 * pct) / 100` equals `0`, so `netOutOfPocket >= 0` is always `true` (since `netOutOfPocket` is `Math.max(0, ...)`).

The corresponding `computeSpendStatus()` function in `packages/db/src/usage-billing-repository.ts` does not have this bug because it uses `>` (strictly greater than) — `netOutOfPocket > 0` is `false` when `netOutOfPocket = 0`.

## Fix

### Bug A — Check `processEvent` return value

```typescript
const result = await entitlementSync.processEvent(syntheticTopUpEvent);
if (!result.processed) {
  return reply.status(500).send(errorPayload(
    'billing.top_up.processing_failed',
    result.error ?? 'Failed to process top-up credit',
  ));
}
```

### Bug B — Treat hard cap of 0 as no effective cap

```typescript
const effectiveHardCap = hardCap != null && hardCap > 0 ? hardCap : null;
const warnings = warningThresholds.map((pct) => ({
  thresholdPct: pct,
  reached: effectiveHardCap != null ? netOutOfPocket >= (effectiveHardCap * pct) / 100 : false,
}));
```

## Tests Added

- `usage-summary warning thresholds are not reached when hard cap is zero` — verifies that all warnings show `reached: false` when `hardCapMicrousd = 0` regardless of balance.
- `mock top-up returns 500 when synthetic event processing fails` — verifies that the route returns a 500 error when `processEvent` returns `{ processed: false }`.
