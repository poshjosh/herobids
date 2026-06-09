# Bug 005: Stopped agent shows "Agent runtime is unhealthy" banner

**Date:** 2026-06-09  
**Severity:** Medium  
**Status:** Closed

**Tests added:** `apps/api/src/routes/agents.test.ts` — "GET /agents/:id — activeSession suppression for terminal-state agents (bug 005)"
- Stopped agent with lingering unhealthy session → `activeSession: null`; session SELECT not called
- Crashed agent with lingering unhealthy session → `activeSession: null`; session SELECT not called
- Active agent with unhealthy session → `activeSession` returned; two SELECTs issued
- 404 when agent not found

## Summary

An agent in the `stopped` state incorrectly displayed the red error banner "Agent runtime is unhealthy. Heartbeats are missing and the worker is recovering." This message is misleading — a stopped agent is not recovering; it was deliberately stopped.

## Reproduction Steps

1. Start an agent (creates a runtime session).
2. Allow the session to become `unhealthy` (e.g., worker is not running, so no heartbeats arrive).
3. Stop the agent via a mechanism that does **not** invoke `POST /agents/:id/stop` (e.g., direct DB update, worker reconciliation, or `POST /agents/:id/pause` followed by a side-effect).
4. Navigate to the agent detail page.

**Expected:** No alert banner for a stopped agent.  
**Actual:** Red banner "Agent runtime is unhealthy. Heartbeats are missing and the worker is recovering."

## Root Cause

Two layered issues:

### 1. API — stale `activeSession` returned for terminal agents
`GET /agents/:id` queried `agentRuntimeSessions` for rows with status in `['starting', 'launching', 'running', 'unhealthy']` unconditionally — even when the agent itself was in a `stopped` or `crashed` state. A lingering `unhealthy` session was returned as `activeSession`.

### 2. Frontend — `runtimeAlert` did not guard against `stopped` status
`AgentDetailPage.tsx` showed the unhealthy banner whenever `agent.activeSession?.status === 'unhealthy'`, without checking whether the agent itself was in a terminal state.

## Fix

**`apps/api/src/routes/agents.ts`** — skip the session query entirely for terminal-state agents:
```typescript
const isTerminalState = agent.status === 'stopped' || agent.status === 'crashed';
const [session] = isTerminalState ? [] : await db.select()...
```

**`apps/web/src/features/agents/AgentDetailPage.tsx`** — add `agent.status !== 'stopped'` guard:
```typescript
: (agent.activeSession?.status === 'unhealthy' && agent.status !== 'stopped')
  ? 'Agent runtime is unhealthy. Heartbeats are missing and the worker is recovering.'
```
