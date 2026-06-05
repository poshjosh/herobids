# 2026-06-06-05 — MessageEnvelopeSchema: agentId Required but Tests Use initiatorId

**Date:** 2026-06-06  
**Severity:** High  
**Files:** `packages/domain/src/agent-protocol.ts`

## Summary

`MessageEnvelopeSchema` had `agentId: z.string().min(1)` as a **required** field. Agent message tests use envelopes with `{ initiatorType: 'agent', initiatorId: 'agent-1', tradingInstanceId: 'inst-1' }` and no `agentId`. This caused schema validation to fail for all messages, short-circuiting the broker before any processing occurred.

## Root Cause

The schema was tightened during a refactor to require `agentId`, but the calling protocol was not updated — callers use `initiatorId` as the agent ID.

## Fix

- Made `agentId` optional: `agentId: z.string().optional()`
- Added `tradingInstanceId: z.string().optional()` to support the new protocol
- Updated broker to resolve `effectiveAgentId = envelope.agentId ?? envelope.initiatorId`

## Tests Fixed

`packages/domain/src/agent-protocol.test.ts`, `apps/worker/src/agents/agent-broker.test.ts` (11/13 tests)
