# 2026-06-06-02 — Engine Types: ManagedOrder/FillEvent/ExecutionPlan Missing tradingInstanceId

**Date:** 2026-06-06  
**Severity:** High  
**Files:** `packages/engine/src/order-state.ts`, `packages/engine/src/order-manager.ts`, `packages/engine/src/planner.ts`, `packages/engine/src/paper-executor.ts`

## Summary

`ManagedOrder` and `FillEvent` interfaces were missing the `tradingInstanceId?: string` field, causing fills and orders to not carry instance attribution. `CreateOrderParams` had the same omission. `ExecutionPlan` was also missing `tradingInstanceId`.

## Root Cause

Incomplete migration — these interfaces were defined before the `tradingInstanceId` concept was introduced and never updated.

## Fix

- Added `tradingInstanceId?: string` to `ManagedOrder`, `FillEvent`, `CreateOrderParams`, `ExecutionPlan`
- Propagated `tradingInstanceId` from `CreateOrderParams` → `ManagedOrder` in `OrderManager.create()`
- Propagated `tradingInstanceId` from order → fill in `OrderManager.applyFill()`
- Set `tradingInstanceId: plan.tradingInstanceId` on orders and fills in `PaperExecutor`
- Set `tradingInstanceId: decision.tradingInstanceId` on plan in `planDecision()`

## Tests Fixed

`packages/engine/src/order-manager.test.ts`, `packages/engine/src/paper-executor.test.ts`
