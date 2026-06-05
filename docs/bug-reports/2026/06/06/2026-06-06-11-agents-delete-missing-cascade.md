# 2026-06-06-11 — Agents DELETE Route: Missing Cascade Deletes (FK Violation)

**Date:** 2026-06-06  
**Severity:** Medium  
**Files:** `apps/api/src/routes/agents.ts`

## Summary

The DELETE `/agents/:id` route deleted the `agents` row directly without first deleting dependent rows in `agentOutboundMessages`, `agentArtifacts`, and `agentRuntimeSessions`. This resulted in a foreign-key constraint violation, causing a 500 error.

## Root Cause

The route was written before cascade deletes were considered. The DB schema uses explicit FK constraints without `ON DELETE CASCADE`.

## Fix

Added explicit cascade deletes before the main agent delete:

```ts
await db.delete(agentOutboundMessages).where(eq(agentOutboundMessages.agentId, id));
await db.delete(agentArtifacts).where(eq(agentArtifacts.agentId, id));
await db.delete(agentRuntimeSessions).where(eq(agentRuntimeSessions.agentId, id));
await db.delete(agents).where(eq(agents.id, id));
```

## Tests Fixed

`apps/api/src/routes/agents.test.ts` — DELETE test
