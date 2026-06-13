- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-13
- **Summary:** `AgentDecisionHandler` silently rejected all `submit_decision` calls with `agent_paused` when the `agents` table had no row for the agent, even though the agent container was actively running and sending heartbeats.

## Root Cause

`handleDecisionSubmit` checked `const agent = await this.agentRepo.getAgent(effectiveAgentId)` and treated `!agent` (null return) identically to a paused or stopped agent:

```ts
if (!agent || agent.status === 'paused' || agent.status === 'stopped') {
  // rejected with code: 'agent_paused'
}
```

An agent container running without a corresponding `agents` DB row (see bug #015) would fail this check on every single decision. The rejection was emitted to the outbound Redis stream, but the agent container's `submit_decision` tool is fire-and-forget — it publishes to the inbound stream and immediately returns `{ ok: true }` to the LLM. The LLM therefore never saw the rejection, continued believing trades were submitted, and kept managing a position that never existed.

Observed in production: agents `534e9792` and `228d8bd0` submitted decisions on tick 1 and received no errors. But no journal events or positions were created. The `agents` table was empty (0 rows) while the containers were running.

## Fix

**File:** `apps/worker/src/agents/agent-decision-handler.ts`

Changed the agent status check to only reject if an agent row EXISTS and has a terminal status. A missing row falls through to the session check (step 2), which verifies an `agent_runtime_sessions` row with `status='running'` — that is the true liveness gate.

```ts
// Before:
if (!agent || agent.status === 'paused' || agent.status === 'stopped') { ... }

// After:
if (agent && (agent.status === 'paused' || agent.status === 'stopped')) { ... }
```

## Files Changed

- `apps/worker/src/agents/agent-decision-handler.ts`

## Verification

Lint passes. Unit tests pass (23/23). The session check at step 2 remains as the authoritative liveness guard — decisions from containers with no `agents` row but an active session now proceed correctly.
