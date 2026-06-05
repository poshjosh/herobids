# 2026-06-06-04 — TradingCycleDeps: actorType/actorId Required but Tests Use tradingInstanceId

**Date:** 2026-06-06  
**Severity:** High  
**Files:** `packages/engine/src/trading-cycle.ts`

## Summary

`TradingCycleDeps` had `actorType: string` and `actorId: string` as required fields. Tests called `runTradingCycle` with `{ tradingInstanceId: 'my-instance-99', ... }` and no `actorType`/`actorId`. The function would execute with undefined actor fields, producing incorrect journal entries and not stamping `tradingInstanceId` on the decision.

## Root Cause

Interface not migrated to use `tradingInstanceId`.

## Fix

- Made `actorType?` and `actorId?` optional in `TradingCycleDeps`
- Added `tradingInstanceId?: string` to `TradingCycleDeps`
- Added fallback derivation: `actorType ?? 'bot'`, `actorId ?? tradingInstanceId ?? ''`
- Stamped `tradingInstanceId: deps.tradingInstanceId ?? decision.tradingInstanceId` onto the decision
- Added `tradingInstanceId` to `PersistFillParams`, `PersistPositionParams`, `PersistOrderParams`

## Tests Fixed

`packages/engine/src/trading-cycle.test.ts`
