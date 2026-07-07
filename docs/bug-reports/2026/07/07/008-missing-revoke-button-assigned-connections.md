# 008 — Missing "Revoke" Button on Assigned Connections

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-07
- **Summary:** The Connections page does not show the "Revoke" button for connections that are actively assigned to agents. Users see only "Delete", which fails with `connection.in_use` (409) because the backend correctly blocks hard-deletion of assigned connections. The Revoke button is hidden due to stale query cache data and an overly restrictive visibility condition.

## Root Cause

Two compounding issues:

### 1. Revoke button condition is too restrictive (`ConnectionsPage.tsx:119`)

The Revoke button was only rendered when `assignedAgentCount > 0 || referencingBotCount > 0`:

```tsx
{conn.status === 'active' && (conn.assignedAgentCount > 0 || conn.referencingBotCount > 0) && (
  <Button variant="danger">Revoke</Button>
)}
```

This is backwards — Revoke (soft-delete) is the standard way to deactivate a connection and should **always** be available for active connections. The design plan (`docs/features/2026/07/01/001-simplify-platform-link-ux/001-plan.md` lines 146–155) explicitly shows Revoke for connections with "Used by: (none)".

### 2. `['connections']` query never invalidated (`AgentCapabilityPage.tsx:56-63, 243-244, 255-258`)

When connections are assigned/unassigned to agents via the Agent Capability page, the mutation `onSuccess` callback invalidates several query keys — but **not** `['connections']`, which is the key used by `ConnectionsPage`:

```tsx
// Invalidates — but missing ['connections']:
qc.invalidateQueries({ queryKey: ['agents', agentId, 'capabilities', family] }),
qc.invalidateQueries({ queryKey: ['agents', agentId, 'capabilities', 'trading', 'connections'] }),
qc.invalidateQueries({ queryKey: ['agents', agentId] }),
qc.invalidateQueries({ queryKey: ['capabilities', 'trading', 'connections'] }),
```

This means if connections were assigned via any path other than the Connections page itself (e.g., direct API calls, `quick-setup.sh`, or the Agent Capability page), the Connections page continues to show `assignedAgentCount: 0` — hiding the Revoke button even when the backend correctly reports active assignments.

## Fix

### File 1: `apps/web/src/features/connections/ConnectionsPage.tsx`

**Changed Revoke visibility:** Now shows for ALL active connections, not just assigned ones.

```diff
- {conn.status === 'active' && (conn.assignedAgentCount > 0 || conn.referencingBotCount > 0) && (
+ {conn.status === 'active' && (
```

**Changed Delete visibility:** Now only shows when there are no active assignments (hard-delete would succeed). Previously it always showed, leading to misleading 409 errors.

```diff
- <Button variant="danger" ...>Delete</Button>
+ {conn.assignedAgentCount === 0 && conn.referencingBotCount === 0 && (
+   <Button variant="danger" ...>Delete</Button>
+ )}
```

### File 2: `apps/web/src/features/agents/AgentCapabilityPage.tsx`

Added `qc.invalidateQueries({ queryKey: ['connections'] })` in three locations:

1. **`updateConnectionsMutation.onSuccess`** (line 60) — when binding/unbinding connections to an agent
2. **`ProviderSetupForm.onSuccess`** (line 247) — after creating a new connection
3. **Auto-assign callback** (line 263) — after auto-assigning a new connection to the agent

## Files Changed

- `apps/web/src/features/connections/ConnectionsPage.tsx` — Revoke always visible for active connections; Delete only visible when safe
- `apps/web/src/features/agents/AgentCapabilityPage.tsx` — Added `['connections']` query invalidation in three places

## Verification

1. Navigate to Connections page — active connections should always show a "Revoke" button
2. Assign a connection to an agent via the Agent Capability page, then return to Connections page — `assignedAgentCount` should update immediately (no stale data)
3. For connections with active assignments, only "Revoke" should be visible (not "Delete")
4. For unassigned active connections, both "Revoke" and "Delete" should be visible
5. Clicking "Revoke" on any active connection should succeed (soft-delete to `status: 'revoked'`)
6. Clicking "Delete" on an unassigned connection should hard-delete it
