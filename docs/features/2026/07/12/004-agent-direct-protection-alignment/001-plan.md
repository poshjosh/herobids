# Agent-Direct Protection Alignment

**Status:** Done  
**Created:** 2026-07-12

**Related reports and plans:**

1. [Bug report: agent-direct protection identity and watch linkage](../../../../../bug-reports/2026/07/12/002-agent-direct-protection-identity-and-watch-linkage.md)
2. [Watch system redesign follow-up](../../../07/07/002-watch-system-redesign/002-followup-plan.md)
3. [Per-trade stop-loss and take-profit](../../../07/06/010-per-trade-stoploss-takeprofit/001-plan.md)
4. [Per-trade level outage protection](../../../../pending/055-per-trade-level-outage-protection/001-plan.md)

## Goal

Eliminate the current divergence between:

1. agent-direct native per-trade exit protection
2. watch-based protective coverage
3. canonical position identity
4. the agent-facing `list_positions` contract

The immediate outcome should be:

1. no false-success protective watches
2. no misleading `instrumentId` values returned to agents
3. no loss of canonical `instrumentId` during agent-direct runtime updates
4. no repeated `open_position_uncovered` escalation for an actively running agent that already has native per-trade exit levels armed

This plan is intentionally narrower than the full watch follow-up redesign. It targets the concrete regression cluster observed on 2026-07-12.

---

## Summary

The July 12 evaluation exposed four coupled problems:

1. `AgentTradingActor` already arms per-trade `stopLoss` / `takeProfit` levels, but the watch-coverage model ignores them.
2. Agent-direct private-stream updates drop canonical `instrumentId` even though the DB schema already supports it.
3. `list_positions` returns `symbol` under the `instrumentId` field name, steering the agent into unsatisfiable payloads.
4. `watch_token` can accept a `stop_loss` / `take_profit` watch that looks structured (`schemaVersion: 2`) but has no canonical `instrument` and no `coverage`, so it can never satisfy protective coverage.

The fix is not a schema migration. The `positions.instrument_id` column already exists and the repository already supports null-to-known promotion. The broken pieces are runtime preservation, tool contracts, and protection semantics.

---

## Current Baseline

### Runtime protection

1. [apps/worker/src/agent-trading-actor.ts](../../../../../apps/worker/src/agent-trading-actor.ts) persists per-trade `stopLoss` / `takeProfit` and monitors them through the in-process actor loop.
2. That protection survives normal agent idle periods, LLM budget exhaustion, and worker restart after rehydration.
3. It does **not** survive actor stop or full worker crash. That remains the separate outage-protection follow-up.

### Coverage and gating

1. [apps/worker/src/position-coverage.ts](../../../../../apps/worker/src/position-coverage.ts) currently recognizes protective coverage only from structured watches.
2. [apps/worker/src/agent.ts](../../../../../apps/worker/src/agent.ts) uses that result to drive `open_position_uncovered` escalation.
3. The coverage model does not distinguish between:
   - active-session runtime protection
   - out-of-band watch protection

### Identity preservation

1. [packages/engine/src/position-tracker.ts](../../../../../packages/engine/src/position-tracker.ts) keeps `PositionState` symbol-only.
2. [apps/worker/src/agent-trading-actor.ts](../../../../../apps/worker/src/agent-trading-actor.ts) private-stream persistence upserts positions without canonical `instrumentId`.
3. Rehydration restores the actor’s runtime map from `symbol` and prices, but not explicit canonical identity metadata.

### Agent-facing tools

1. [apps/worker/src/tools/analytics.ts](../../../../../apps/worker/src/tools/analytics.ts) and [apps/worker/src/agents/agent-message-broker.ts](../../../../../apps/worker/src/agents/agent-message-broker.ts) return `instrumentId: position.symbol`.
2. Agents cannot reliably tell the difference between display symbol and canonical venue identity.
3. Agents also cannot see whether native per-trade levels are already armed on a position.

### Watch creation

1. [apps/worker/src/tools/watch.ts](../../../../../apps/worker/src/tools/watch.ts) auto-links protective watches only when canonical instrument resolution succeeds and/or `coverage.targetPosition` resolves.
2. If canonical instrument resolution misses, the tool can still create a protective-purpose watch without `instrument` and without `coverage`.
3. Such a watch can alert on thresholds but can never count as protective coverage.

---

## Desired Outcome

After this feature:

1. the agent-facing position contract exposes true identity and current protection state
2. agent-direct runtime updates preserve canonical `instrumentId` across fills, private-stream refreshes, and restart rehydration
3. protective watch creation fails closed when linkage cannot be proven
4. pre-scout gating treats active in-process native exit protection as sufficient to avoid repeated `open_position_uncovered` escalation
5. the runtime still does **not** claim crash-proof or stopped-agent protection unless the separate outage-protection feature is implemented

---

## Scope

In scope:

1. aligning active-session coverage semantics with agent-native per-trade exit levels
2. preserving canonical `instrumentId` in agent-direct runtime persistence paths
3. correcting `list_positions` payload semantics
4. rejecting unmatchable protective watches instead of persisting them as false-success records
5. tests and prompt/tool wording updates needed to keep contracts honest

Out of scope:

1. venue-native stop orders
2. full worker-crash / stopped-agent protection for per-trade levels
3. a broad removal of all legacy watch compatibility code
4. schema changes to add new position identity columns
5. redesigning scout/judge policy beyond this protection-alignment slice

---

## Product Decisions and Implementation Defaults

### Decisions encoded by this plan

1. **Active-session native exit levels count as protection for gating.**
   If an open agent-direct position has persisted per-trade `stopLoss` and/or `takeProfit` levels and the agent actor is actively running that in-process monitor, the runtime should not repeatedly force `open_position_uncovered` for that position.

2. **Native exit levels do not imply outage-proof protection.**
   This slice does not change the stopped/crash gap documented in the outage-protection follow-up. Any wording that implies otherwise must be corrected.

3. **Protective watch purposes must be provably linkable.**
   `stop_loss`, `take_profit`, and `exit` watches are not valid unless the worker can resolve canonical instrument identity or a live target position. Passive threshold reminders remain allowed through non-protective usage.

4. **The existing `positions.instrumentId` column remains the source of truth.**
   This fix should use and preserve the existing field rather than introducing a new schema layer.

5. **`list_positions` must separate identity from display.**
   The contract should expose both `symbol` and canonical `instrumentId` instead of overloading one field. It should also expose current native exit levels so the agent can reason about its real protection state.

### Default implementation direction

1. Prefer a worker-owned identity sidecar or equivalent preservation path over widening every engine position type unless the broader type change proves cheaper in practice.
2. Keep the runtime semantics conservative: never mark a watch as protective unless the worker can later match it deterministically.
3. Keep any backward-compatibility shims local and temporary. Do not preserve the wrong `instrumentId` meaning in new code.

---

## Likely Repo Surfaces

| Area | Likely files |
|---|---|
| Agent-direct runtime identity preservation | `apps/worker/src/agent-trading-actor.ts`, possibly `packages/engine/src/position-tracker.ts` |
| Coverage evaluation and gating | `apps/worker/src/position-coverage.ts`, `apps/worker/src/agent.ts`, `apps/worker/src/scout-gating.ts` |
| Agent-facing position contract | `apps/worker/src/tools/analytics.ts`, `apps/worker/src/agents/agent-message-broker.ts`, `apps/worker/src/runtime-composition.ts` |
| Protective watch creation | `apps/worker/src/tools/watch.ts` |
| Test coverage | `apps/worker/src/agent-trading-actor.test.ts`, `apps/worker/src/position-coverage.test.ts`, `apps/worker/src/tools/analytics.test.ts`, `apps/worker/src/tools/watch.test.ts`, runtime/gating tests |

---

## Implementation Plan

### Slice 1 — Define protection semantics for active sessions **[DONE]**

Goal: stop the runtime from treating an actively monitored, per-trade-protected position as fully uncovered.

Tasks:

1. extend the position-coverage input shape to accept native exit-level state from open positions
2. teach coverage evaluation to distinguish:
   - no protection
   - native active-session protection only
   - linked watch protection
   - both native and watch protection
3. update the pre-scout gating decision so native active-session protection prevents repeated `open_position_uncovered` escalation
4. keep outage-protection semantics explicit: native coverage here means "protected while the runtime is alive", not "protected during crash/stop"
5. update prompt/context wording so the agent can see whether protection is native-only, watch-backed, or both

Expected result:

The judge is no longer forced in a loop for positions that already have active per-trade levels armed in the live runtime, while the outage caveat remains visible and accurate.

### Slice 2 — Preserve canonical identity in the agent-direct runtime path **[DONE]**

Goal: ensure open positions keep their canonical `instrumentId` after fills, private-stream refreshes, increases, decreases, and restart rehydration.

Tasks:

1. choose and implement one worker-owned preservation strategy:
   - sidecar identity map keyed by the actor’s live position key, or
   - broader type propagation if that is truly smaller
2. populate that identity from decision-accepted / engine-persisted positions where canonical `instrumentId` is known
3. when private-stream position state arrives, preserve the last known canonical `instrumentId` instead of writing a null identity back to the row
4. rehydrate the preservation state on actor startup from the open positions table
5. verify null-to-known promotion still works for pre-existing rows without creating duplicates

Expected result:

The canonical `instrumentId` that existed at entry time remains attached to the open position row and is available to downstream watch linking and agent tools.

### Slice 3 — Correct the `list_positions` contract **[DONE]**

Goal: make the agent-facing position payload truthful and actionable.

Tasks:

1. change both `list_positions` surfaces to return:
   - `symbol`
   - `instrumentId` as the real DB canonical value, nullable when genuinely unknown
   - `venue`
   - `stopLoss` / `takeProfit`
   - existing ownership fields
2. update tests to stop asserting the old mislabelled contract
3. adjust runtime-composition parsing to prefer canonical `instrumentId` when present, while keeping `symbol` available for display
4. update any prompt/context summaries that currently assume `instrumentId` is always the display symbol

Expected result:

Agents can accurately target positions for watch linkage and can see whether a position already has native exit levels armed.

### Slice 4 — Fail closed on unmatchable protective watches **[DONE]**

Goal: eliminate the false-success mode where a watch is accepted as `stop_loss` or `take_profit` but can never count as protective coverage.

Tasks:

1. tighten `watch_token` so protective-purpose watches require one of:
   - canonical instrument identity that can be matched later, or
   - resolved `coverage.targetPosition` from a live open position
2. if neither can be proven, reject the request with an actionable error
3. keep passive/manual monitoring available by instructing callers to use non-protective watch intent when they only want an alert
4. ensure persisted protective watches always carry enough structured identity to satisfy later coverage matching
5. update tests for the rejected-path and successful linked-path behavior

Expected result:

Every persisted protective watch is matchable by design; threshold alerts that are not protective remain possible but are no longer misrepresented.

### Slice 5 — Align wording, context, and tests with the real contract **[DONE]**

Goal: remove the remaining semantic drift between docs, tool wording, and runtime behavior.

Tasks:

1. update `submit_decision` and related agent-facing strings so they accurately describe what per-trade levels do in the current architecture
2. clarify in runtime context whether protection is native-only or watch-backed
3. add or update tests covering:
   - native protection suppressing active-session uncovered escalation
   - identity preservation through private-stream updates
   - truthful `list_positions` payloads
   - rejection of unlinked protective watch creation
4. keep the outage-protection follow-up explicitly open rather than implicitly solved by this slice

Expected result:

The implementation, tests, and agent-visible wording all describe the same protection model.

---

## Validation Plan

### Automated

1. `agent-trading-actor` tests for identity preservation across private-stream updates and restart rehydration
2. `position-coverage` tests for native-only, watch-only, both, and none
3. `analytics` and agent-message-broker tests for truthful `list_positions` payloads
4. `watch` tool tests for fail-closed protective creation when linkage is impossible
5. runtime-composition and scout-gating tests for the revised active-session coverage semantics

### Commands

1. `pnpm lint`
2. focused worker tests, at minimum:
   - `pnpm --filter @herobids/worker run test -- agent-trading-actor`
   - `pnpm --filter @herobids/worker run test -- position-coverage`
   - `pnpm --filter @herobids/worker run test -- analytics`
   - `pnpm --filter @herobids/worker run test -- watch`
   - `pnpm --filter @herobids/worker run test -- runtime-composition`
   - `pnpm --filter @herobids/worker run test -- scout-gating`

---

## Risks and Mitigations

1. **Masking the outage gap.**
   If native exit levels are treated as full protection everywhere, the runtime may overstate safety. Mitigate by explicitly scoping native coverage to active-session gating and keeping the outage-protection follow-up open.

2. **Incorrect identity carry-forward across aliases.**
   Preserving the wrong `instrumentId` could create bad watch linkage. Mitigate by preferring previously persisted canonical identity over guessing from raw stream symbol text.

3. **Contract churn for agent prompts and tests.**
   Fixing `list_positions` will change downstream assumptions. Mitigate by updating runtime-composition parsing and the affected tests in the same slice.

4. **Silent drift between native and watch protection semantics.**
   If the runtime exposes one notion of protection and the agent sees another, the issue will recur. Mitigate by making protection source explicit in coverage evaluation and agent-facing summaries.

---

## Exit Criteria

1. canonical `instrumentId` is preserved for agent-direct open positions across the affected runtime paths
2. `list_positions` exposes truthful identity and native exit-level state
3. protective watches cannot be persisted without matchable structured linkage
4. active-session gating no longer forces `open_position_uncovered` for positions that already have native exit levels armed in the live runtime
5. wording and tests accurately reflect that crash/stopped-agent protection is still handled by the separate outage-protection follow-up

---

## Non-Blocking Follow-Up

This feature should not absorb the separate outage-protection problem. If implementation reveals that active-session native coverage and out-of-band protection need different runtime labels or prompt copy, that refinement should happen here, but the actual crash/stopped-agent protection work remains the responsibility of [pending/055-per-trade-level-outage-protection](../../../../pending/055-per-trade-level-outage-protection/001-plan.md).