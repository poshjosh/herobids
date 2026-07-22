# Bug Report: Agent Decision Visible in Activity Feed but Not in Decisions/Trade History

**Date:** 2026-07-22  
**Severity:** HIGH (core observability gap — users can't see their agent's trading decisions)  
**Status:** Open

## Summary

An agent (`balanced-agent-1`, id `2c3cb331-95c8-4419-b7b7-8bff49d7a4c0`) submitted a `go_long LIT-PERP` decision that was accepted (`decision.accepted` visible in the activity feed), but the decision does NOT appear in the "Recent Decisions" section or "Trade History" section on the agent detail page.

## Reproduction

1. Start the dev stack: `scripts/shell/run/reset-and-run.sh`
2. Create and start an agent (e.g. `balanced-agent-1`)
3. Wait for the agent to submit a decision (visible in activity feed as `decision.accepted`)
4. Navigate to the agent detail page → "Recent Decisions" section
5. **Expected:** Decision appears in the list
6. **Actual:** "No recent decisions" shown

## Investigation

### Two different data sources

The **activity feed** and the **decisions list** pull from different database tables:

| UI Section | Data Source | API Endpoint |
|---|---|---|
| Activity Feed | `agent_messages` (protocol messages) | `GET /agents/:id/activity-feed` |
| Recent Decisions | `decisions` table | `GET /agents/:id/decisions` |
| Trade History | `positions` / `fills` tables | N/A (positions endpoint) |

The activity feed shows the decision because the `agent.decision.submit` protocol message is recorded in `agent_messages` regardless of downstream persistence. The decisions endpoint queries the `decisions` table directly.

### Decision persistence flow traced

The code path for persisting an agent decision is:

1. Agent runtime → `agent_messages` stream (records protocol message in `agent_messages`)  
2. `AgentDecisionHandler.handleDecisionSubmit()` (line 174, `agent-decision-handler.ts`)  
3. Builds `Decision` object with `actorType: initiatorType, actorId: initiatorId` (lines 337-338)  
4. Calls `submitDecisionForExecution()` → `deps.persistence.persistDecision()`  
5. `agent-intake-resolver.ts → buildPersistence()` calls `decisionRepo.insertDecision()` (line 217)  
6. `DecisionRepository.insertDecision()` (repositories.ts line 767) stores:  
   ```typescript
   actorType: decision.actorType ?? 'system',
   actorId: decision.actorId ?? null,
   ```

The decisions API endpoint queries:
```typescript
and(eq(decisions.actorType, 'agent'), eq(decisions.actorId, id))
```

### Potential root causes (unconfirmed)

1. **The decision may not have been persisted.** If `submitDecisionForExecution` threw or returned early (e.g., planner produced no orders for a `go_flat` from flat position), the decision might not have reached `persistDecision`. However, persistence happens at step 1 of the pipeline, before planning/risk/execution, so this is unlikely unless there's an uncaught exception.

2. **The decision may have been stored with a different `actorType`/`actorId`.** If `initiatorType` or `initiatorId` from the envelope is somehow different from expected (e.g., the envelope's `initiatorId` is the trading instance ID rather than the agent UUID), the query filter would not match.

3. **The decision may have been stored but the query filters it out.** If `actorType` defaulted to `'system'` (the fallback in `insertDecision` when `decision.actorType` is falsy), the query for `actorType = 'agent'` would miss it.

### Recommended diagnostic steps

1. **Check the `decisions` table directly** for the agent's ID:
   ```sql
   SELECT id, actor_type, actor_id, instrument_id, intent, created_at
   FROM decisions
   WHERE actor_id = '2c3cb331-95c8-4419-b7b7-8bff49d7a4c0'
   ORDER BY created_at DESC
   LIMIT 10;
   ```

2. **Check what `actor_type` the decision was stored with.** If it's `'system'` instead of `'agent'`, the query filter is the issue (see potential cause #3).

3. **Check the worker logs** for any errors during decision intake (look for "Agent decision handler" or "Failed to persist" messages).

4. **Verify the API response** directly:
   ```bash
   curl -H "Authorization: Bearer <token>" \
     http://localhost:3000/agents/2c3cb331-95c8-4419-b7b7-8bff49d7a4c0/decisions
   ```

## Impact

- Agent trading decisions are invisible in the UI's "Recent Decisions" panel, making it impossible for users to audit what their agent is doing.
- The activity feed shows the event, creating confusion — the user can see the agent IS trading, but can't see the trade details.
- Trade history also won't show because a decision must be persisted before it can be executed and result in fills/positions.

## Related Files

| File | Role |
|------|------|
| `apps/worker/src/agents/agent-decision-handler.ts` | Builds Decision object, calls submitDecisionForExecution |
| `apps/worker/src/agents/agent-intake-resolver.ts` | Provides persistDecision for agent intake |
| `packages/engine/src/decision-intake.ts` | Shared submitDecisionForExecution pipeline |
| `packages/db/src/repositories.ts` | DecisionRepository.insertDecision (line 767) |
| `apps/api/src/routes/agents.ts` | GET /agents/:id/decisions (line 2084) |
| `apps/worker/src/agent.ts` | Agent runtime envelope construction (line 1184) |
