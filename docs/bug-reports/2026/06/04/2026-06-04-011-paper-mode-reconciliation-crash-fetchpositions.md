# Bug Report: Paper mode TradingActor crashes on reconciliation — fetchPositions requires a wallet address

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-04
- **Summary:** A paper-mode trading instance started successfully but immediately crashed during reconciliation. `TradingActor.startReconciler()` called `venuePort.fetchPositions()` on the `HyperliquidAdapter`, which requires a wallet address. Paper mode has no credential and therefore no wallet address, causing an immediate runtime error and crashing the instance.

## Root Cause

In `apps/worker/src/index.ts`, the `TradingActor` dependency object was built with `venuePort` unconditionally set to the resolved `venueAdapter`:

```typescript
venuePort: venueAdapter ?? undefined,
```

For paper-mode instances, `venueAdapter` is constructed from the venue config but the credential resolution path skips actual credential loading (bug 010 fix). The adapter object exists but contains no wallet address. When `startReconciler()` ran, it passed the adapter to `fetchPositions()`, which threw:

```
hyperliquid fetchPositions() requires a user parameter inside 'params' or the wallet address set
```

## Fix

`venuePort` is now set to `undefined` for paper mode, preventing `startReconciler()` from attempting live venue reconciliation:

```typescript
venuePort: config.execution.mode === 'paper' ? undefined : (venueAdapter ?? undefined),
```

`startReconciler()` already has an early return guard (`if ((!venuePort && !swapVenue) || !reconciliationConfig) return;`), so passing `undefined` cleanly disables reconciliation without any further changes.

## Files Changed

- [apps/worker/src/index.ts](../../apps/worker/src/index.ts)

## Verification

- Paper-mode instance starts and stays `running` — no reconciliation crash.
- `startReconciler()` exits early for paper mode as intended.
- `pnpm lint` passes.
