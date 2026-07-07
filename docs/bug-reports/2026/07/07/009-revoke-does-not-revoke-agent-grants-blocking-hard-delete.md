# 009 — Revoking a Connection Does Not Revoke Agent Grants, Blocking Hard-Delete

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-07
- **Summary:** After revoking a connection (soft-delete), the hard-delete (`?permanent=true`) is still blocked with `connection.in_use` because `agent_connections` rows are not updated to `'revoked'` during the revoke. The revoke path only flips `connections.status` — leaving the guard check in the hard-delete path to find active `agent_connections` rows and reject the operation.

## Root Cause

In `apps/api/src/routes/connections.ts`, the soft-delete (revoke) path — `DELETE /connections/:id` without `?permanent=true` — only performed one mutation:

```ts
await db
  .update(connections)
  .set({ status: 'revoked', updatedAt: new Date() })
  .where(eq(connections.id, id));
```

It did **not** update the related `agent_connections` rows from `status = 'active'` to `status = 'revoked'`. When the user subsequently attempted a hard-delete (`?permanent=true`), the guard check at line 293 found `agent_connections` rows still in `'active'` status and blocked with:

```json
{ "error": "connection.in_use", "params": { "hint": "Revoke the connection instead, or remove it from all agents first." } }
```

This is a classic state inconsistency: the connection is semantically revoked but the agent grants still think they're active. The `assignedAgentCount` subquery in the list view also continued counting these stale active grants, so the Connections page still showed the connection as assigned even after revoke.

## Fix

### `apps/api/src/routes/connections.ts`

In the soft-delete path, added an update to mark all `agent_connections` rows for that connection as `'revoked'` — **before** the `connections` row itself is updated. Also moved the `affectedAgents` query above the updates so runtime refresh notifications still fire for the agents that just lost access.

```diff
-    await db
-      .update(connections)
-      .set({ status: 'revoked', updatedAt: new Date() })
-      .where(eq(connections.id, id));
-
-    if (redisClient) {
-      const affectedAgents = await db
-        .select({ agentId: agentConnections.agentId })
-        .from(agentConnections)
-        .where(and(eq(agentConnections.connectionId, id), eq(agentConnections.status, 'active')));
-
-      for (const row of affectedAgents) {
-        await publishRuntimeRefresh(row.agentId).catch(...);
-      }
-    }
+    // Capture affected agents before we flip agent_connections to revoked.
+    const affectedAgents = await db
+      .select({ agentId: agentConnections.agentId })
+      .from(agentConnections)
+      .where(and(eq(agentConnections.connectionId, id), eq(agentConnections.status, 'active')));
+
+    const now = new Date();
+
+    // Mark all agent grants for this connection as revoked so that a
+    // subsequent hard-delete is not blocked by still-active grants.
+    await db
+      .update(agentConnections)
+      .set({ status: 'revoked', revokedAt: now, updatedAt: now })
+      .where(and(eq(agentConnections.connectionId, id), eq(agentConnections.status, 'active')));
+
+    await db
+      .update(connections)
+      .set({ status: 'revoked', updatedAt: now })
+      .where(eq(connections.id, id));
+
+    if (redisClient) {
+      for (const row of affectedAgents) {
+        await publishRuntimeRefresh(row.agentId).catch(...);
+      }
+    }
```

## Files Changed

- `apps/api/src/routes/connections.ts` — Added `agent_connections.status` → `'revoked'` update in soft-delete path; reordered to capture affected agents before the mutation
- `apps/api/src/routes/connections.test.ts` — Added `updateSets` array to track all update calls; strengthened revoke test to assert two updates (agent_connections + connections); added new test `'allows hard-delete after a connection has been revoked'`

## Verification

1. TypeScript compilation: `pnpm lint` passes with zero errors
2. Unit tests: 25/25 pass in `connections.test.ts` (including the new test)
3. Full test suite: 4,125/4,126 pass (1 pre-existing flaky test in `wake-scheduler.test.ts` is unrelated)
4. Manual repro: Create a connection → assign it to an agent → revoke the connection → hard-delete (`?permanent=true`) → should now return 204 instead of 409
