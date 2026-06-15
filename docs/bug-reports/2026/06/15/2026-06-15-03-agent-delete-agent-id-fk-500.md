# Bug Report: Agent Delete 500 — billing_usage_events.agent_id FK (Partial Fix)

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-15
- **Discovered:** evaluate-agent-and-fix — agent delete during Phase 4 teardown
- **Summary:** After fixing the `session_id` FK in the previous commit, the DELETE /agents/:id route still returned 500 because `billing_usage_events.agent_id` also has `ON DELETE NO ACTION`.

## Symptoms

Phase 4 teardown: `DELETE /agents/:id` → 500 with:
```
Failed query: delete from "agents" where "agents"."id" = $1
params: 89feb728-b43c-4c9a-a53e-aefaf923f4f1
```

## Root Cause

The previous fix (session 2026-06-15-02) nulled out `billing_usage_events.session_id` by joining through `agent_runtime_sessions`, then deleted the sessions, then tried to delete `agents`. But `billing_usage_events.agent_id` → `agents.id` has `ON DELETE NO ACTION`, so the delete of `agents` itself was blocked.

## Fix

Simplified the pre-delete update to a single statement that nulls out **both** `billing_usage_events.agent_id` and `billing_usage_events.session_id` using `agentId` as the filter:

```ts
await db
  .update(billingUsageEvents)
  .set({ sessionId: null, agentId: null })
  .where(eq(billingUsageEvents.agentId, id));
```

This also eliminates the separate `SELECT session IDs` query that was needed for the old approach.

## Notes

The fix is committed but the running stack still uses the old API image. The stack must be rebuilt for the fix to take effect.
