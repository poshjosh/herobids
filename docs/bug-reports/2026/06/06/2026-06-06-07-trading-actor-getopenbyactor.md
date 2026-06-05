# 2026-06-06-07 — TradingActor: Uses getOpenByActor Instead of getOpenByInstance

**Date:** 2026-06-06  
**Severity:** High  
**Files:** `apps/worker/src/trading-actor.ts`, `apps/worker/src/trading-actor.test.ts`

## Summary

`TradingActor` called `positionRepo.getOpenByActor('bot', tradingInstanceId)` and `orderRepo.getOpenByActor('bot', tradingInstanceId)` in three places (rehydratePosition, loadLocalState). Tests provided mocks with `getOpenByInstance` not `getOpenByActor`, causing reconciliation to fail with "not a function" for all live-mode and cross-venue tests.

`stubRepo()` in the test file was also missing `getOpenByActor`.

## Root Cause

The repository API evolved from actor-scoped to instance-scoped lookups. The actor implementation was not updated.

## Fix

- Changed all `getOpenByActor('bot', tradingInstanceId)` calls to `getOpenByInstance(tradingInstanceId)`
- Updated `stubRepo()` in the test to provide `getOpenByInstance`
- Added `tradingInstanceId: this.tradingInstanceId` to the `runTradingCycle` deps call

## Tests Fixed

`apps/worker/src/trading-actor.test.ts` (10 tests), `apps/worker/src/cross-venue-lifecycle.test.ts`
