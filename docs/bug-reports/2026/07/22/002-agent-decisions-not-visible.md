# Bug Report: Agent Decision Visible in Activity Feed but Not in Decisions/Trade History

**Date:** 2026-07-22  
**Severity:** HIGH (core observability gap — users can't see their agent's trading decisions)  
**Status:** Root cause confirmed

## Root Cause (Confirmed via live DB inspection)

The decision was **rejected** by `AgentDecisionHandler` due to a missing mark price. It was never passed to `submitDecisionForExecution`, so it was never persisted to the `decisions` table.

### Evidence chain

1. `agent_messages` table — contains the `agent.decision.submit` event ✅
2. `decision_failures` table — contains:
   ```
   failure_code: no_context
   failure_message: No decision context available — actor may still be initializing or mark price unavailable
   instrument_id: LIT-PERP
   ```
3. Worker log:
   ```
   [06:21:09] WARN (agent-actor-2c3cb331): Failed to fetch mark for decision context
   ```
4. Worker log detail:
   ```
   "No mark available for LIT-PERP: fill source (No fills found for instrument: LIT-PERP),
    fallback (No CoinGecko mapping for instrument: LIT-PERP)"
   ```
5. `decisions` table — **0 rows total** (confirmed via `SELECT COUNT(*)`)

### Execution flow that led to the bug

```
1. Agent scans → finds LIT-PERP candidate
2. Agent submits go_long LIT-PERP → recorded in agent_messages ✅
3. AgentDecisionHandler.handleDecisionSubmit() called
4. getDecisionContext('LIT-PERP') called on AgentTradingActor
5. markSource.fetchMark('LIT-PERP') returns error:
   - Fill source: No fills (agent hasn't traded this instrument yet)
   - Fallback (CoinGecko): No mapping for LIT-PERP (it's a Hyperliquid perp)
6. getDecisionContext returns undefined
7. Handler rejects with 'no_context' → persisted to decision_failures ✅
8. submitDecisionForExecution is NEVER called → decisions table remains empty ❌
9. Activity feed shows decision.accepted (records protocol message receipt, not outcome)
```

### Why the activity feed shows "accepted" but the decision was rejected

The activity feed (`/agents/:id/activity-feed`) pulls from `agent_messages` — it records that the protocol message was received and dispatched. It does NOT reflect whether the decision was ultimately accepted or rejected by the intake pipeline. This is a **UI observability gap**: the activity feed should show the actual decision outcome (accepted vs rejected), not just message receipt.

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

### Confirmed: Decision rejected — never persisted

All three diagnostic queries confirmed:
1. **`decisions` table: 0 rows total** — decision was never persisted
2. **`decision_failures`: 1 row** — `failure_code: no_context`, `instrument_id: LIT-PERP`
3. **Worker log**: `WARN Failed to fetch mark for decision context`
4. **Worker log detail**: `No mark available for LIT-PERP: fill source (No fills found for instrument: LIT-PERP), fallback (No CoinGecko mapping for instrument: LIT-PERP)`

### Execution flow

```
1. Agent scans → finds LIT-PERP candidate
2. Agent submits go_long LIT-PERP → recorded in agent_messages ✅
3. AgentDecisionHandler.handleDecisionSubmit() called
4. getDecisionContext('LIT-PERP') called on AgentTradingActor
5. markSource.fetchMark('LIT-PERP') returns error:
   - Fill source: No fills (agent hasn't traded this instrument yet)
   - Fallback (CoinGecko): No mapping for LIT-PERP (it's a Hyperliquid perp)
6. getDecisionContext returns undefined
7. Handler rejects with 'no_context' → persisted to decision_failures ✅
8. submitDecisionForExecution is NEVER called → decisions table remains empty ❌
9. Activity feed shows decision.accepted (records protocol message receipt, not outcome)
```

### Why the activity feed shows "accepted" but the decision was rejected

The activity feed (`/agents/:id/activity-feed`) pulls from `agent_messages` — it records that the protocol message was received and dispatched. It does NOT reflect whether the decision was ultimately accepted or rejected by the intake pipeline. This is a **UI observability gap**.

## Recommended Fix (advisory — do not implement yet)

Two separate problems:

### Problem A: Mark price unavailable for newly scanned perp instruments

**File:** `apps/worker/src/agent-trading-actor.ts:913` — `getDecisionContext()`

The mark source (`FillFirstMarkSource`) relies on:
1. Recent fills (not available for a new agent that hasn't traded yet)
2. CoinGecko fallback (doesn't map perp symbols like `LIT-PERP`)

**Possible fix approaches:**
- Add a third fallback: use the Hyperliquid venue's own mark price / oracle price API
- Pre-warm the mark source on session start by fetching marks for all candidate instruments
- Add a startup readiness gate: don't process decisions until at least one mark fetch succeeds

### Problem B: Rejected decisions are invisible in the UI

**Files:** `apps/api/src/routes/agents.ts:2084`, `apps/web/src/features/agents/AgentDetailPage.tsx`

The decisions endpoint only queries the `decisions` table. Rejected decisions are stored in `decision_failures` but never surfaced.

**Possible fix approach:**
- Merge `decision_failures` into the decisions endpoint response
- Make the activity feed reflect the actual decision outcome (accepted vs rejected)

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
