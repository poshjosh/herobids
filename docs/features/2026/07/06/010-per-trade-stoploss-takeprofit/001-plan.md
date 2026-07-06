# Per-Trade Stop-Loss and Take-Profit

**Created:** 2026-07-06
**Status:** in-progress

## Goal

Agents set stopLoss and takeProfit price levels on every `submit_decision` that opens or increases a position. These provide trade-specific protection that works even if the agent becomes incapacitated (crash, LLM budget exhausted, paused, stopped). When per-trade levels are absent, the engine returns a non-blocking reminder to set them.

## Motivation

- The existing portfolio-level `stopLossPct` is a blunt percentage-of-equity tool. It doesn't know about individual trade thesis or market structure.
- Portfolio-level stop-loss only fires while the engine is running. If the worker crashes or the agent stops, positions drift unprotected.
- Per-trade levels are strategy-aligned: only the agent knows why it entered a position and at what price it should exit.
- The reminder pattern (non-blocking note in the sync reply) teaches the agent to set stops without ever rejecting a valid trade.

## What Changes

### 1. Add `stopLoss` and `takeProfit` to the `submit_decision` schema

**Files:**
- `packages/domain/src/agent-protocol.ts` — `DecisionSubmitPayloadSchema`: add optional `stopLoss` and `takeProfit`
- `packages/domain/src/models/decision.ts` — `Decision`: add optional `stopLoss?` and `takeProfit?` as `Price`
- `apps/worker/src/tools/trading.ts` — `SubmitDecisionParamsSchema`: add optional `stopLoss` and `takeProfit` (handled in Item 2)

**Details:**
```ts
// submit_decision tool
stopLoss: z.string().regex(/^\d+(\.\d+)?$/).optional()
  .describe('Stop-loss price level. Fires only if you become unable to trade (crash, manual stop, LLM budget exhausted). Omit at your own risk.'),
takeProfit: z.string().regex(/^\d+(\.\d+)?$/).optional()
  .describe('Take-profit price level. Fires only if you become unable to trade (crash, manual stop, LLM budget exhausted). Omit at your own risk.'),
```

Both pass through the intake pipeline into the `Decision` object. The levels are stored alongside the decision for audit.

### 2. Add non-blocking reminder in the sync reply

**File:** `apps/worker/src/agents/agent-decision-handler.ts`

When a decision is accepted (`setSyncReply('accepted', ...)`) and:
- The intent is `go_long`, `go_short`, or `increase` (position-growing intents only)
- At least one of `stopLoss`/`takeProfit` is missing

Append a reminder to the accepted message:

| Missing | Message |
|---------|---------|
| Both | `"Accepted. Note: no stopLoss or takeProfit set — this position is unprotected if you're unable to trade."` |
| `stopLoss` only | `"Accepted. Note: no stopLoss set — this position has no downside protection if you're unable to trade."` |
| `takeProfit` only | `"Accepted. Note: no takeProfit set — profits won't be captured if you're unable to trade."` |

When both are present, the message is unchanged (`"Accepted"`).

### 3. Hide portfolio-level `stopLossPct` from the agent

**Files:**
- `apps/worker/src/tools/risk-limits.ts` — remove `stopLossPct` from `get_risk_limits` output
- `apps/worker/src/tools/risk-limits.ts` — remove `stopLossPct` from `adjust_risk_limits` params
- `apps/worker/src/runtime-composition.ts` — remove the `Stop-loss: {x}%` line from guardrails block

**Keep visible:** `stopLossCooldownMs` stays in both tools and system prompt, because cooldown after a forced exit directly constrains the agent's ability to re-enter.

**Backstop still active:** The portfolio-level `stopLossMaxUnrealizedLossPct` continues to be enforced by the risk gate and the stop-loss monitor. It's just not surfaced to the agent. If the agent sets unreasonably wide per-trade levels (or sets none), the operator backstop still catches it.

### 4. Update tests

**Files:**
- `apps/worker/src/tools/trading.test.ts` — add tests for `stopLoss`/`takeProfit` params
- `apps/worker/src/agents/agent-decision-handler.test.ts` — add tests for reminder messages on accepted decisions
- `apps/worker/src/tools/risk-limits.test.ts` — update to expect `stopLossPct` removed from output
- `apps/worker/src/runtime-composition.test.ts` — update to expect `Stop-loss` line removed
- `packages/engine/src/risk-gate.test.ts` — no changes needed (backstop still functions)
- `packages/engine/src/stop-loss-monitor.test.ts` — no changes needed

### 5. Update system prompt

**File:** `apps/worker/src/runtime-composition.ts`

In the trading guardrails block, add a note after the capital line:
```
"Per-trade stop-loss and take-profit should be set via submit_decision. An operator backstop applies if levels are missing."
```

### 6. Contingency triggers — execute stored levels when agent is incapacitated

The existing stop-loss monitor loop (`isStopLossTriggered` in `agent-trading-actor.ts`) already runs on every `submit_decision` intake and has access to mark price, position state, and the `executeAgentStopLoss` go_flat path. We extend this loop to also check per-trade price levels — no separate heartbeat or liveness checker is needed because the monitor fires regardless of agent activity.

**Storage: per-position exit levels**

Add a new in-memory map alongside the position map:

```ts
// agent-trading-actor.ts
private readonly exitLevels = new Map<string, { stopLoss?: Price; takeProfit?: Price }>();
```

When a decision with `stopLoss`/`takeProfit` is accepted and the position is open, upsert into `exitLevels`. When a position goes flat (fill, stop-loss exit, take-profit exit), delete the entry.

Persist to DB alongside the decision (already handled by Section 1 — stored on the `Decision` row). The in-memory map is rehydrated on actor startup from the most recent decision per open position that carries exit levels.

**Files:**
- `apps/worker/src/agent-trading-actor.ts` — add `exitLevels` map, extend `isStopLossTriggered` to check per-trade levels, add `executePerTradeTakeProfit`
- `packages/engine/src/stop-loss-monitor.ts` — add `checkPerTradeLevels()` pure function
- `packages/db/src/repositories/decision-repository.ts` — add query to fetch latest exit levels per open position (for rehydration)

**Logic in `checkPerTradeLevels`:**

```ts
export interface PerTradeLevelCheck {
  instrument: string;
  side: 'long' | 'short';
  markPrice: Price;
  stopLoss?: Price;
  takeProfit?: Price;
}

export interface PerTradeLevelResult {
  triggered: boolean;
  instrument?: string;
  reason?: 'stop_loss' | 'take_profit';
  markPrice?: Price;
  level?: Price;
}

export function checkPerTradeLevels(checks: PerTradeLevelCheck[]): PerTradeLevelResult {
  for (const check of checks) {
    if (check.stopLoss) {
      const hit = check.side === 'long'
        ? check.markPrice.lte(check.stopLoss)   // long stop: price fell to/below stop
        : check.markPrice.gte(check.stopLoss);   // short stop: price rose to/above stop
      if (hit) return { triggered: true, instrument: check.instrument, reason: 'stop_loss', markPrice: check.markPrice, level: check.stopLoss };
    }
    if (check.takeProfit) {
      const hit = check.side === 'long'
        ? check.markPrice.gte(check.takeProfit)  // long TP: price rose to/above TP
        : check.markPrice.lte(check.takeProfit); // short TP: price fell to/below TP
      if (hit) return { triggered: true, instrument: check.instrument, reason: 'take_profit', markPrice: check.markPrice, level: check.takeProfit };
    }
  }
  return { triggered: false };
}
```

**Integration in `isStopLossTriggered`:**

After the existing portfolio-level check, call `checkPerTradeLevels` with the stored exit levels for the instrument. If triggered, fire `executeAgentStopLoss` (same path — go_flat with metadata `{ trigger: 'per_trade_stop_loss' }` or `{ trigger: 'per_trade_take_profit' }`).

**Continuous monitoring (agent incapacitated):**

The current check only fires on `submit_decision`. To protect an incapacitated agent, add a periodic tick loop:

```ts
// agent-trading-actor.ts — startPerTradeLevelMonitor()
private perTradeLevelInterval?: ReturnType<typeof setInterval>;

private startPerTradeLevelMonitor(): void {
  // Check every 5 seconds (configurable via operator config)
  this.perTradeLevelInterval = setInterval(() => this.checkAllPerTradeLevels(), 5_000);
}
```

The interval checks ALL open positions with stored exit levels. This fires even when the agent is idle/crashed/paused.

**Lifecycle:**
- Start the monitor in `start()` after rehydrating positions and exit levels.
- Clear the interval in `stop()`.
- On position going flat (any reason), remove from `exitLevels`.
- On new decision with levels for an already-open position, update `exitLevels` (the agent can tighten or widen stops).

**Journal events:**
- `per_trade_stop_loss.triggered` — logs instrument, mark price, stop level
- `per_trade_take_profit.triggered` — logs instrument, mark price, TP level

### 7. Price validation — reject nonsensical stop/TP levels at submit time

Validate `stopLoss` and `takeProfit` against the current mark price at `submit_decision` time. If validation fails, reject the entire decision with an actionable error message telling the agent what went wrong.

**Rules (symmetric):**

| Side | stopLoss | takeProfit |
|------|----------|------------|
| Long (`go_long`, `increase` from long) | Must be < mark price | Must be > mark price |
| Short (`go_short`, `increase` from short) | Must be > mark price | Must be < mark price |

**Files:**
- `packages/engine/src/per-trade-level-validator.ts` — new pure function
- `apps/worker/src/agents/agent-decision-handler.ts` — call validator before accepting decision

**Validator signature:**

```ts
export interface LevelValidationInput {
  side: 'long' | 'short';
  markPrice: Price;
  stopLoss?: Price;
  takeProfit?: Price;
}

export type LevelValidationError =
  | { field: 'stopLoss'; reason: 'above_mark_for_long' | 'below_mark_for_short'; markPrice: string; level: string }
  | { field: 'takeProfit'; reason: 'below_mark_for_long' | 'above_mark_for_short'; markPrice: string; level: string };

export function validatePerTradeLevels(input: LevelValidationInput): LevelValidationError | null {
  if (input.stopLoss) {
    if (input.side === 'long' && input.stopLoss.gte(input.markPrice)) {
      return { field: 'stopLoss', reason: 'above_mark_for_long', markPrice: input.markPrice.toString(), level: input.stopLoss.toString() };
    }
    if (input.side === 'short' && input.stopLoss.lte(input.markPrice)) {
      return { field: 'stopLoss', reason: 'below_mark_for_short', markPrice: input.markPrice.toString(), level: input.stopLoss.toString() };
    }
  }
  if (input.takeProfit) {
    if (input.side === 'long' && input.takeProfit.lte(input.markPrice)) {
      return { field: 'takeProfit', reason: 'below_mark_for_long', markPrice: input.markPrice.toString(), level: input.takeProfit.toString() };
    }
    if (input.side === 'short' && input.takeProfit.gte(input.markPrice)) {
      return { field: 'takeProfit', reason: 'above_mark_for_short', markPrice: input.markPrice.toString(), level: input.takeProfit.toString() };
    }
  }
  return null;
}
```

**Error messages (returned to agent via sync reply):**

| Error | Message |
|-------|---------|
| `above_mark_for_long` | `"Rejected: stopLoss ({level}) must be below current price ({markPrice}) for a long position."` |
| `below_mark_for_short` | `"Rejected: stopLoss ({level}) must be above current price ({markPrice}) for a short position."` |
| `below_mark_for_long` | `"Rejected: takeProfit ({level}) must be above current price ({markPrice}) for a long position."` |
| `above_mark_for_short` | `"Rejected: takeProfit ({level}) must be below current price ({markPrice}) for a short position."` |

**Edge cases:**
- `go_flat` / `reduce` intents: skip validation (exit levels are irrelevant when closing)
- Level exactly equal to mark: rejected (same direction trigger would fire immediately)
- No mark price available: skip validation with a log warning (don't block the trade for missing market data)

**Tests:**
- `packages/engine/src/per-trade-level-validator.test.ts` — unit tests for all 4 error cases + happy paths
- `apps/worker/src/agents/agent-decision-handler.test.ts` — integration test for rejection flow

## What Does NOT Change

- **No venue-level stop orders yet.** The per-trade levels are stored and enforced in-engine. Venue-level order placement (Hyperliquid trigger orders, Jupiter limit orders) is a separate optimization.
- **No change to bot trading.** Bots continue using the existing portfolio-level stop-loss mechanism. Per-trade levels are agent-only.
- **Portfolio backstop remains.** The operator `stopLossMaxUnrealizedLossPct` fires independently — if per-trade levels are set too wide, the portfolio-level backstop still catches catastrophic drawdown.

## Out of Scope (Future)

- Venue-level stop-loss/take-profit order placement on Hyperliquid/Jupiter
- Per-trade levels for bots and user decisions

## Implementation Order

1. [DONE] Add `stopLoss`/`takeProfit` to domain types (`Decision`, `DecisionSubmitPayloadSchema`)
2. [DONE] Add params to `submit_decision` tool schema and passthrough
3. [DONE] Propagate through `agent-decision-handler.ts` into the `Decision` object
4. [DONE] Add reminder logic in sync reply
5. [PENDING] Implement `validatePerTradeLevels` pure function + tests
6. [PENDING] Integrate price validation in `agent-decision-handler.ts` (reject before accept)
7. [DONE] Implement `checkPerTradeLevels` pure function in stop-loss-monitor + tests
8. [PENDING] Add `exitLevels` map to `agent-trading-actor.ts` with rehydration
9. [PENDING] Add periodic per-trade level monitor loop
10. [PENDING] Hide `stopLossPct` from agent surfaces
11. [PENDING] Update system prompt guardrails
12. [PENDING] Update all remaining tests
13. [PENDING] `pnpm lint` + `pnpm test`

## Outstanding Issues

### [Item 1] Add stopLoss/takeProfit to domain types
- **LOW**: Regex `/^\d+(\.\d+)?$/` accepts zero price values (`"0"`, `"0.0"`) — deferred to Item 5 (`validatePerTradeLevels`) for semantic validation.
- **LOW**: Inconsistent `.describe()` usage in `agent-protocol.ts` — new `stopLoss`/`takeProfit` fields have `.describe()` but adjacent `limitPrice` does not. Pre-existing cosmetic issue, not worth fixing now.

### [Item 2] Add params to submit_decision tool schema and passthrough
- **LOW**: Regex accepts zero-price values (same as Item 1, deferred to Item 5).
- **LOW**: No test changes in this changeset — tests are separate plan items (Items 4, 12).

### [Item 4] Add reminder logic in sync reply
- **LOW**: `positionGrowingIntents` Set recreated on every invocation — could be hoisted to module scope as a static constant.
- **LOW**: `message: undefined` passed into spread when both levels are set — `JSON.stringify` drops it correctly, but debugging shows `undefined`.

### [Item 7] Implement checkPerTradeLevels in stop-loss-monitor + tests
- **MEDIUM**: Missing test for stop-loss priority within a single instrument (documentation of the order-invariant contract).
- **MEDIUM**: Missing test for empty array input (`checkPerTradeLevels([])`).
- **LOW**: Misleading comment in multiple-instruments test (SOL entry comment says "would trigger" but actually wouldn't).
- **LOW**: `mkCheck` helper has long-biased defaults that make short-side tests fragile.
- **LOW**: No short-side test for "neither stopLoss nor takeProfit is set".