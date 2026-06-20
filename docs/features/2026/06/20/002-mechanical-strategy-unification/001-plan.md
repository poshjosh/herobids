# Mechanical Strategy Unification

Make `MechanicalStrategy` the single execution engine for all rule-based
(non-LLM) bot trading styles, starting with `momentum`. Remove `MomentumStrategy`
once `MechanicalStrategy` is verified to cover its use case.

**Backward compatibility is not a constraint.**

**Depends on:** `docs/features/2026/06/20/001-bot-config-integrity/001-plan.md` (the
`strategy.type` / `strategy.decisionMode` split must be in place first)

---

## Problem

We have four strategy classes: `MomentumStrategy`, `MechanicalStrategy`,
`LlmStrategy`, `HybridStrategy`.

`MomentumStrategy` does one thing: it compares the current price to a simple moving
average (SMA) over a lookback window and goes long/short when the deviation exceeds
a threshold. This is a narrow, primitive version of momentum trading.

`MechanicalStrategy` already does momentum trading — it uses MACD (which is an
EMA-based trend signal), RSI (which filters choppy/overbought conditions), and volume
confirmation. With `signalBias: 'trend-following'`, it answers exactly the same
question as `MomentumStrategy` ("is this asset in an upward trend?") with higher
confidence and fewer false signals.

The result is two separate code paths for what is effectively the same trading style,
with `MomentumStrategy` being the weaker, less maintained one.

---

## Where We Want to Be

An agent or user that wants to trade using a momentum strategy configures a bot with:

```json
{
  "strategy": {
    "type": "momentum",
    "decisionMode": "mechanical",
    "params": { ... }
  }
}
```

The worker routes this to `MechanicalStrategy` with a `trend-following` signal bias
and sensible default indicator params. The agent gets momentum trading with proper
indicator confluence, not a raw price comparison.

`MomentumStrategy` class no longer exists. `LlmStrategy` and `HybridStrategy` remain
(they handle `decisionMode: 'llm'` and `decisionMode: 'hybrid'`).

---

## The Gap

`MomentumStrategy` uses **live price ticks** accumulated in memory.
`MechanicalStrategy` uses **candles fetched on each evaluation**.

Despite the class comment calling it an SMA strategy, `MomentumStrategy` actually
computes a **Rate of Change (ROC)**: `(price_now - price_N_ticks_ago) / price_N_ticks_ago`.
It fires when the ROC exceeds a fixed threshold (default 2% over 5 ticks).

**MACD is sufficient — no SMA or ROC indicator needs to be added.** MACD with signal
line crossover and increasing histogram is a strictly superior momentum signal:

- ROC is noisy: one bad tick corrupts the reading; no noise filtering; no volume or
  trend confirmation
- MACD uses exponential smoothing on both inputs; the histogram crossover filters
  false signals that ROC fires on in choppy markets

`MechanicalStrategy` with `signalBias: 'trend-following'` and MACD + RSI + volume
enabled fully covers the momentum trading use case.

**The one real behavioral gap is short selling.** `MomentumStrategy` emits `go_short`.
`MechanicalStrategy` only emits `go_long` and `go_flat` (noted in a comment in
`scan-engine.ts`: "Only long signals emitted in Phase 2; go_short not yet
implemented"). Deleting `MomentumStrategy` without closing this gap would be a
behavioural regression — short capability is included in this plan.

---

## Steps (high level)

1. **Add `go_short` to `MechanicalStrategy`** — Mirror the existing bearish scoring
   logic in `scan-engine.ts`:
   - `ScoredSignal.intent` changes from `'go_long'` literal to `'go_long' | 'go_short'`
   - Bearish path: MACD histogram crosses below zero (+confidence), RSI in overbought
     range (instead of hard-rejecting, treat as entry confirmation for short),
     volume direction-agnostic
   - `makeDecision` in `mechanical-strategy.ts` passes `signal.intent` through
     (already accepts `'go_long' | 'go_flat'`, extend to `| 'go_short'`)
   - Verify `Decision.intent` in `@herobids/domain` already includes `'go_short'`

2. **Route `type: 'momentum'` to `MechanicalStrategy`** — In `createStrategy()`,
   when `strategy.type = 'momentum'` and `strategy.decisionMode = 'mechanical'`,
   construct a `MechanicalStrategy` with translated params (lookbackPeriod → candleLimit,
   positionSize carried over; threshold is no longer used — MACD/RSI handle signal
   quality). No new indicator needed.

3. **Delete `MomentumStrategy`** — Remove the class, its params schema, its tests,
   and its imports. Update `packages/strategy/src/index.ts` exports. Also update
   `apps/worker/src/backtest-runtime.ts` which directly imports and instantiates
   `MomentumStrategy` — replace with `MechanicalStrategy` using the same param
   translation as step 2.

4. **Remove `MomentumParamsSchema`** — Bots previously using `momentum` type now
   supply `MechanicalParams` (or a translated subset). The factory handles param
   translation in step 2 during the transition period.

---

## Definition of Done

- A bot configured with `strategy: { type: 'momentum', decisionMode: 'mechanical' }`
  starts and trades using `MechanicalStrategy` with trend-following bias
- `MechanicalStrategy` emits `go_short` when bearish indicator confluence is met
- `MomentumStrategy` class does not exist in the codebase
- `pnpm lint` passes, `pnpm test` passes
- No behaviour regression: both long and short signals are available, equivalent to
  or better than what `MomentumStrategy` provided
