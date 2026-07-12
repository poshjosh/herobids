# Bug Report: Agent-direct protection state diverges from watch coverage, making protective watch linkage unsatisfiable

- **Status:** OPEN
- **Severity:** High
- **Date:** 2026-07-12
- **Summary:** An agent-direct Hyperliquid short was already carrying persisted `stopLoss` and `takeProfit` levels and the `AgentTradingActor` was actively monitoring those levels, but the runtime still escalated `open_position_uncovered`. When the agent tried to add watch-based protection, the canonical `instrumentId` had already been stripped from the open position row, `list_positions` misreported `symbol` as `instrumentId`, and `watch_token` either rejected explicit `coverage.targetPosition` with `No open position found` or created unlinked `schemaVersion: 2` protective watches that do not satisfy coverage matching.

## Root Cause

There are three coupled defects, plus one contract mismatch.

### 1. The coverage model ignores actor-native `stopLoss` / `takeProfit`

`AgentTradingActor` persists accepted per-trade exit levels onto the position row and rehydrates them into its in-memory `exitLevels` map. It actively monitors those levels in both `isStopLossTriggered()` and the periodic `checkAllPerTradeLevels()` loop.

But `evaluatePositionCoverage()` only counts structured watches that match a live position via:

1. `coverage.positionKey`, or
2. `instrument.instrumentId` + venue.

It does not consider the position row’s own `stopLoss` / `takeProfit` at all. That means the runtime can declare a position “uncovered” even when the agent actor already has native protective exits armed.

### 2. Agent-direct private-stream persistence drops canonical `instrumentId`

The positions schema and repository already support `instrumentId`; this is not a storage-model limitation.

However, the agent-direct private-stream path loses it:

- `packages/engine/src/position-tracker.ts` defines `PositionState` with `symbol`, but no `instrumentId`
- `apps/worker/src/agent-trading-actor.ts` `persistPrivateStreamPositionState()` upserts rows without `instrumentId`
- the same file’s `rehydratePositions()` rebuilds the actor-local position map from `symbol` only

Observed evidence from the eval artifacts:

- `journal.json` shows `decision.created.payload.instrumentId = "SOL/USDC:USDC"`
- `positions.json` ends with the same position still open but `instrumentId = null`

So canonical identity existed on entry and was later erased by the runtime update path.

### 3. `list_positions` mislabels `symbol` as `instrumentId`

Both agent-facing `list_positions` surfaces do this:

- `apps/worker/src/tools/analytics.ts`
- `apps/worker/src/agents/agent-message-broker.ts`

They emit `instrumentId: position.symbol` instead of the real DB `position.instrumentId`. That makes the agent more likely to construct a `coverage.targetPosition` payload that cannot match the row the worker actually stores.

### 4. `watch_token` can create protective V2 watches that are not coverage-matchable

`watch_token` only auto-links protective watches when canonical instrument resolution succeeds and yields `instrument?.venue`. Its instrument lookup is an exact symbol match against instrument-repo search results.

In the evaluated session, the agent worked with `SOL`, while the live position row used `SOL/USDC:USDC`. When exact instrument resolution misses:

- no canonical `instrument` is attached to the watch,
- auto-link is skipped,
- the tool can still persist a `stop_loss` / `take_profit` watch with `schemaVersion: 2` but no `instrument` and no `coverage`.

The stored Redis payloads for the two SOL watches show exactly that shape.

Those watches can still fire threshold alerts, but they do not satisfy `evaluatePositionCoverage()` because they have neither `coverage.positionKey` nor `instrument.instrumentId`.

## Observed Impact

Session: `.ignore/eval/2026/07/12/tsonnet-61946a6c-629f-434b-aa5e-88644ca353b5/`

Observed facts:

1. The SOL short position stayed open with `stopLoss = 80.93` and `takeProfit = 65.52` persisted on the row.
2. The agent still treated the position as `open_position_uncovered` later in the session.
3. The agent tried multiple coverage-attach variations and hit `No open position found` despite the row existing.
4. The fallback manual SOL watches were persisted without `instrument` or `coverage`, so they can alert but will not clear watch-based uncovered status.

Likely consequences:

1. False or repeated judge escalations for positions that already have actor-native protection.
2. Wasted LLM budget and agent attention on a protection state the runtime already partially satisfied.
3. Misleading agent guidance from `list_positions`, which steers the caller toward unsatisfiable `targetPosition` payloads.
4. A dangerous false-success mode where protective watches are accepted but do not actually count as protective coverage.

## Fix Direction

### Required runtime fixes

1. Preserve canonical `instrumentId` end-to-end for agent-direct positions, including private-stream persistence and rehydrate paths.
2. Return separate `symbol` and real DB `instrumentId` from all `list_positions` surfaces.
3. Fail closed when a protective watch cannot be linked to a concrete position or canonical instrument. Do not persist `stop_loss` / `take_profit` watches that the coverage matcher cannot ever match.
4. Decide whether actor-native per-trade exit levels should count as valid protective coverage. If yes, include them in coverage/gating. If no, remove any agent/runtime guidance that implies `submit_decision(stopLoss/takeProfit)` resolves uncovered-position handling.

### Files involved

- `packages/engine/src/position-tracker.ts`
- `apps/worker/src/agent-trading-actor.ts`
- `apps/worker/src/tools/analytics.ts`
- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/worker/src/tools/watch.ts`
- `apps/worker/src/position-coverage.ts`
- `apps/worker/src/runtime-composition.ts`
- `apps/worker/src/scout-gating.ts`

## Regression Coverage Needed

1. `AgentTradingActor` test: private-stream position updates preserve an existing canonical `instrumentId` instead of nulling it out.
2. `list_positions` tests: responses expose the true DB `instrumentId` and a separate `symbol` field.
3. `watch_token` test: protective watch creation fails when neither canonical instrument identity nor resolvable target coverage can be derived.
4. Coverage/gating test: a position with persisted actor-native `stopLoss` / `takeProfit` is either treated as covered, or the runtime/tool contract explicitly continues to mark it uncovered by design.

## Notes

The July 7 watch follow-up plan correctly anticipated the canonical-identity problem, but one detail in that note is now stale: the current `positions` schema already has an `instrumentId` column and the repository already supports null-to-known promotion. The live defect is in the worker/runtime path that fails to preserve and expose that identity consistently.