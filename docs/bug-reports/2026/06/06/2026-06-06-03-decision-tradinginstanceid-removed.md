# 2026-06-06-03 — Decision Interface: tradingInstanceId Removed Prematurely

**Date:** 2026-06-06  
**Severity:** High  
**Files:** `packages/domain/src/models/decision.ts`

## Summary

`Decision` interface had a comment `// tradingInstanceId REMOVED — decisions are actor-scoped via actorType/actorId` and the field was absent. Tests (trading-cycle, agent-decision-handler) expected `decision.tradingInstanceId` to exist and be stamped during the trading cycle.

## Root Cause

The field was intentionally removed as part of a refactor that was either not completed or reverted without updating the Decision type.

## Fix

Re-added `tradingInstanceId?: string` to the `Decision` interface with a documentation comment.

## Tests Fixed

`packages/engine/src/trading-cycle.test.ts`, `apps/worker/src/agents/agent-decision-handler.test.ts`
