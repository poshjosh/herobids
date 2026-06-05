# 2026-06-06-13 — Reconciliation & Fills: Missing tradingInstanceId in Persist Calls

**Date:** 2026-06-06  
**Severity:** High  
**Files:** `apps/worker/src/trading-actor.ts`, `packages/engine/src/decision-intake.ts`

## Summary

Multiple persist/insert calls were missing `tradingInstanceId`:

1. `reconciliationRepo.insert()` in `TradingActor.reconcile()` did not include `tradingInstanceId`, causing reconciliation records to have no instance attribution.

2. `fillRepo.insertFill()` (shadow executor path and private stream fill path) in `TradingActor` did not set `tradingInstanceId`.

3. `persistFill`, `persistPosition`, `persistOrder` in `decision-intake.ts` did not pass `tradingInstanceId` from the resolved decision or order.

## Root Cause

`tradingInstanceId` was added to the repo insert signatures after these call sites were written and the call sites were not updated.

## Fix

- Added `tradingInstanceId: this.tradingInstanceId` to `reconciliationRepo.insert()`
- Added `tradingInstanceId: this.tradingInstanceId` to both `fillRepo.insertFill()` calls in `TradingActor`
- Added `tradingInstanceId: fill.tradingInstanceId ?? resolvedDecision.tradingInstanceId` to `persistFill`
- Added `tradingInstanceId: resolvedDecision.tradingInstanceId` to `persistPosition`
- Added `tradingInstanceId: order.tradingInstanceId ?? resolvedDecision.tradingInstanceId` to `persistOrder`

## Tests Fixed

`apps/worker/src/cross-venue-lifecycle.test.ts` — 3 tests  
`apps/worker/src/trading-actor.test.ts` — 2 tests
