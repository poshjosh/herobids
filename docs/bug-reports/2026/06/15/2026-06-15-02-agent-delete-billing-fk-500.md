# 2026-06-15-02 — Agent Delete 500: billing_usage_events FK Violation

**Date:** 2026-06-15
**Severity:** Medium
**Files:** `apps/api/src/routes/agents.ts`

## Summary

`DELETE /agents/:id` returned HTTP 500 with the message:
```
Failed query: delete from "agent_runtime_sessions" where "agent_runtime_sessions"."agent_id" = $1
params: <agentId>
```

## Root Cause

The `billing_usage_events` table has a `session_id` foreign-key referencing `agent_runtime_sessions.id` with `ON DELETE NO ACTION`. When the delete handler tried to remove `agent_runtime_sessions` rows for the agent, the database rejected the delete because `billing_usage_events` rows still referenced those session IDs.

The prior fix (2026-06-06-11) added explicit cascade-deletes for `agentOutboundMessages`, `agentArtifacts`, and `agentRuntimeSessions`, but missed the `billing_usage_events → agent_runtime_sessions` FK.

## Fix

Before deleting `agent_runtime_sessions`, collect the session IDs for the agent and null out `billing_usage_events.session_id` for those sessions. This preserves billing history while removing the FK constraint.

```ts
const sessionIds = await db
  .select({ id: agentRuntimeSessions.id })
  .from(agentRuntimeSessions)
  .where(eq(agentRuntimeSessions.agentId, id));
if (sessionIds.length > 0) {
  await db
    .update(billingUsageEvents)
    .set({ sessionId: null })
    .where(inArray(billingUsageEvents.sessionId, sessionIds.map((s) => s.id)));
}
await db.delete(agentOutboundMessages).where(eq(agentOutboundMessages.agentId, id));
await db.delete(agentArtifacts).where(eq(agentArtifacts.agentId, id));
await db.delete(agentRuntimeSessions).where(eq(agentRuntimeSessions.agentId, id));
await db.delete(agents).where(eq(agents.id, id));
```

`billingUsageEvents` was added to the imports from `@herobids/db`.

## Tests

Existing E2E journey 06 (delete-agent) covers this path; no new tests required.
