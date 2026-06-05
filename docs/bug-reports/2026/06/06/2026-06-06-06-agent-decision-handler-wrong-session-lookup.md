# 2026-06-06-06 — AgentDecisionHandler: Calls getActiveSession Instead of getSessionForAgentAndInstance

**Date:** 2026-06-06  
**Severity:** High  
**Files:** `apps/worker/src/agents/agent-decision-handler.ts`

## Summary

`AgentDecisionHandler.handleDecisionSubmit` called `this.agentRepo.getActiveSession(agentId)` but the repository protocol has `getSessionForAgentAndInstance(agentId, tradingInstanceId)`. All 5 handler tests failed with "not a function".

Additionally, all event publisher calls (`emitDecisionRejected`, `emitDecisionAccepted`, etc.) used `agentId` but tests expected them to use `tradingInstanceId`.

## Root Cause

Stale code not updated after the session lookup API changed to be scoped per trading instance.

## Fix

- Changed session lookup to `getSessionForAgentAndInstance(effectiveAgentId, effectiveTradingInstanceId)`
- Updated all event publisher calls to use `effectiveTradingInstanceId`
- Derived `effectiveAgentId = envelope.agentId ?? envelope.initiatorId`
- Derived `effectiveTradingInstanceId = envelope.tradingInstanceId ?? envelope.botId`

## Tests Fixed

`apps/worker/src/agents/agent-decision-handler.test.ts` — 5 tests
