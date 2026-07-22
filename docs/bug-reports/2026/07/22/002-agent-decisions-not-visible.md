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
| `apps/worker/src/agent-trading-actor.ts:913` | `getDecisionContext()` returns undefined when mark fetch fails |
| `apps/worker/src/agents/agent-decision-handler.ts:174` | Handler rejects with `no_context` code |
| `packages/engine/src/mark-source.ts` | `FillFirstMarkSource` — no venue oracle fallback for perps |
| `packages/db/src/repositories.ts:767` | `DecisionRepository.insertDecision()` — never reached |
| `packages/engine/src/decision-intake.ts:141` | `submitDecisionForExecution()` — never reached |

## Related Bugs

- **Bug 001** (`docs/bug-reports/2026/07/21/001-staging-agents-not-trading-actor-start-never-called.md`): RC1 (`actor.start()` deleted) masked this gap — no agent could trade, so the mark-price issue was invisible. After RC1 was fixed on 2026-07-21, agents could trade again, exposing this pre-existing gap.

## Was This Bug Introduced Recently?

**No — it's a pre-existing gap masked by Bug 001 (RC1).**

Timeline:
1. **2026-07-19:** Platform-preset-assessment feature lands. `actor.start()` accidentally deleted → ALL agents dead, no decisions reach the pipeline.
2. **2026-07-21:** Bug 001 fixed → agents can start and submit decisions.
3. **2026-07-22:** Agent submits `go_long LIT-PERP`. Mark source fails (no fills, no CoinGecko mapping for perp). Decision rejected. This bug discovered.

The mark-source gap (`FillFirstMarkSource` lacks a venue-level oracle fallback for Hyperliquid perps) pre-dates the platform-preset-assessment feature. It was never reached because either (a) agents used a different path before the feature, or (b) RC1 blocked all trading.

## Why Existing Tests Did Not Prevent This

Three layers of missing coverage:

| Layer | What's tested | What's missing |
|-------|--------------|----------------|
| **Unit (mark source)** | No dedicated test file for `FillFirstMarkSource` | No test proves mark resolution for a perp with zero fills and no CoinGecko mapping |
| **Integration (decision intake)** | `agent-decision-handler.test.ts` mocks `getDecisionContext` → always succeeds | Never exercises the real mark-source failure path through the agent trading actor |
| **End-to-end** | `agent-trade-test.ts` exercises full pipeline BUT is explicitly *"NOT part of the routine test suite"* with no CI gating | The one test that would catch this isn't run automatically |

Same pattern as Bug 001: unit tests verify isolation; the bug is in the integration between layers, which nothing exercises automatically.

## Recommended Tests (All Levels)

### Level 1 — Unit: Mark source resolution for perps
**File:** `packages/engine/src/mark-source.test.ts` (new or extend)
```typescript
it('resolves mark for perp via venue oracle when no fills and no CoinGecko mapping')
it('returns structured error when all three sources fail')
```

### Level 2 — Integration: Agent actor decision context after start
**File:** `apps/worker/src/agent-trading-actor.test.ts` (extend)
```typescript
it('getDecisionContext returns defined for a freshly-scanned perp after start()')
it('getDecisionContext returns undefined with reason when all mark sources fail')
```

### Level 3 — Integration: Full decision pipeline end-to-end
**File:** `apps/worker/src/__tests__/integration/agent-decision-pipeline.integration.test.ts` (new)
```typescript
it('persists accepted decision to decisions table after agent submits')
it('persists rejected decision to decision_failures with failure code')
it('GET /agents/:id/decisions includes the persisted decision')
```

### Level 4 — Composition root wiring
**File:** Extract `onSessionActive` callback from `index.ts` for testability
```typescript
it('actor.getDecisionContext returns defined after onSessionActive completes')
```

### Level 5 — Promote agent-trade-test to CI gating
**File:** `.github/workflows/agent-trade-test.yml` (new)
Run `scripts/shell/tests/agent-trade-test.sh` in paper mode on every PR.

### Level 6 — Post-deploy smoke check
**File:** `infra/hetzner/scripts/smoke-check.sh` (extend)
Query `decisions` table after agent startup; fail deploy if no decisions appear within timeout.
