# Bug Report: Agent Decision Visible in Activity Feed but Not in Decisions/Trade History

**Date:** 2026-07-22  
**Severity:** HIGH (core observability gap — users can't see their agent's trading decisions)  
**Status:** Root cause confirmed

## Root Cause (Confirmed via live DB inspection)

The new venue-aware scanner (introduced by the platform-preset-assessment feature, commits `86f660eb` / `79326f83`) discovers candidates directly from Hyperliquid's full perp market. But the `OracleMarkSource`'s CoinGecko fallback (`COIN_ID_MAP` in `packages/venues/src/oracle-mark-source.ts`) has only 12 hardcoded coin IDs. **Zero** of the 5 instruments the new scanner discovered are in the map. And since the agent has no fill history, `LastFillMarkSource` also fails. Result: every decision is rejected with `no_context`.

### Evidence

| Source | Data |
|--------|------|
| `agent_scan_candidates` | 5 instruments: `AAVE(30)`, `KAITO(16)`, `LIT(38)`, `ONDO(12)`, `XMR(38)` |
| `COIN_ID_MAP` (hardcoded) | 12 IDs: `BTC, ETH, SOL, HYPE, DOGE, AVAX, LINK, ARB, OP, SUI, JUP, BONK` |
| Worker logs | `"No mark available for LIT-PERP: fill source (No fills), fallback (No CoinGecko mapping)"` |
| Worker logs | `"No mark available for KAITO-PERP: fill source (No fills), fallback (No CoinGecko mapping)"` |
| `decision_failures` | 1 row: `failure_code: no_context`, `instrument_id: LIT-PERP` |
| `decisions` | **0 rows total** |

### Pre-feature vs post-feature

| | Before feature (July 15) | After feature (July 22) |
|---|---|---|
| **Instruments traded** | `BTC`, `ETH` | `LIT`, `KAITO`, `AAVE`, `XMR`, `ONDO` |
| **In CoinGecko map?** | ✅ Both are | ❌ Zero of five are |
| **Mark resolution** | Works | Always fails |

### Why this is a regression from the feature

The scanner changes (`86f660eb` — venue-aware discovery, `79326f83` — wire into AgentTradingActor) expanded candidate discovery to the full Hyperliquid perp universe. The `COIN_ID_MAP` was never expanded to match. This is a **coverage gap created by expanding the scanner without expanding the mark source**.

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

## Recommended Fix

### Problem A (root cause): Scanner discovers instruments the mark source can't price

**Files:**
- `packages/venues/src/oracle-mark-source.ts:13` — `COIN_ID_MAP` only has 12 entries
- `apps/worker/src/index.ts:~79326f83` — venue-aware scanner discovers full Hyperliquid perp universe

**Fix:** Expand `COIN_ID_MAP` to include all Hyperliquid perps the scanner may discover. At minimum, add the 5 instruments currently being scanned: `AAVE`, `KAITO`, `LIT`, `ONDO`, `XMR`. The correct CoinGecko IDs are:
- `AAVE` → `aave`
- `XMR` → `monero`
- `LIT` → `litentry`
- `KAITO` → needs research (may not exist on CoinGecko)
- `ONDO` → `ondo-finance`

Alternatively: add a venue-level mark source (Hyperliquid's own `/info` or oracle price endpoint) so the mark source doesn't depend on CoinGecko at all for perp instruments.

### Problem B: Rejected decisions are invisible in the UI

(Same as before — decisions endpoint only queries `decisions` table, `decision_failures` never surfaced)

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

**Yes — by the platform-preset-assessment feature's scanner changes.**

The timeline:
1. **Before July 19:** Agents traded `BTC`/`ETH` using the old scanner. Both are in `COIN_ID_MAP`. Mark resolution worked.
2. **July 19:** Commits `86f660eb` (venue-aware discovery) and `79326f83` (wire scanner into AgentTradingActor) expanded candidate discovery to the full Hyperliquid perp universe. The `COIN_ID_MAP` (12 hardcoded IDs) was not expanded.
3. **July 19-21:** Bug 001 (RC1 — `actor.start()` deleted) masked this gap — no agent could trade at all.
4. **July 21:** Bug 001 fixed → agents can trade. Scanner discovers `LIT`, `KAITO`, `AAVE`, `XMR`, `ONDO`. None in `COIN_ID_MAP`. All decisions rejected.
5. **July 22:** Bug discovered.

The regression is in the **scanner expansion** (commits `86f660eb` and `79326f83`), not in the mark source itself. The mark source was never broken — it was simply never given the new instruments to resolve. The scanner now feeds it instruments it can't handle.

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
