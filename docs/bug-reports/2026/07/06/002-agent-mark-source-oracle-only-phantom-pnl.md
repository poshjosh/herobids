# Bug Report: Agent mark source uses CoinGecko only, causing phantom P&L

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-06
- **Summary:** The `AgentTradingActor` was wired with a bare `OracleMarkSource` (CoinGecko) as its mark source, instead of the `MarkSelector(LastFillMarkSource, OracleMarkSource)` that bot actors already use. For instruments where the CoinGecko spot price diverges from the Hyperliquid perp execution price, the agent's `getDecisionContext()` returned the wrong reference mark — causing the agent to compute phantom unrealized P&L and act on it.

## Root Cause

In `apps/worker/src/index.ts`, the `AgentTradingActor` was constructed with:

```typescript
markSource: oracleMarkSource,  // bare CoinGecko
```

Bot actors use:

```typescript
markSource: new MarkSelector(
  { stalenessThresholdMs: appConfig.marking.stalenessThresholdMs },
  new LastFillMarkSource(fillRepo, botId),
  oracleMarkSource,
),
```

`MarkSelector` uses the most recent fill price as the primary mark (anchored to actual execution), falling back to CoinGecko only when no fills exist or they are stale. The agent path skipped this entirely and always called CoinGecko.

`getDecisionContext()` in `AgentTradingActor` calls `this.deps.markSource.fetchMark(instrumentId)` to set `referenceMark.price` in the `DecisionContext`. This value feeds the engine's risk gate unrealized P&L calculation. More critically, it is the price the agent receives in its context when the stream feed has no cached ticker (the "known limitation" for multi-instrument agents), which the agent uses to compute its own P&L estimate.

## Observed Impact (agent `6842606f`, session 2026-07-06)

The agent held a BONK position entered via Hyperliquid execution at **$0.00000484** per token. CoinGecko returned BONK spot at **$0.00002099**. The agent's context showed `entry=$0.00000484` (fill-confirmed) against a CoinGecko mark of `$0.00002099`, producing a phantom gain of:

$$\frac{0.00002099 - 0.00000484}{0.00000484} \approx +334\%$$

The agent then:
1. Executed 5 sequential BONK "profit-taking" trims, claiming it was "locking in ~$312–$474 in realized gains" that did not exist.
2. Redeployed the imaginary proceeds into SOL (scaled from 2.48 → 10.54 units), creating a real $15 loss when the BTC watch triggered.
3. Contributed to breaching the $50 daily loss limit.

Actual realized P&L on BONK: **-$0.00134** (effectively $0).

## Contributing Factor

The "known limitation" in `computeUnrealizedPnl()` — where missing stream feed tickers cause `unrealizedPnlUsd` to show as `—` in the agent's prompt — left a gap the agent filled using whatever price data was available. The wrong CoinGecko price was the data it used. Fixing the mark source eliminates the discrepancy; the "known limitation" is a separate medium-priority issue.

## Fix

**`apps/worker/src/index.ts`** — Changed `AgentTradingActor` construction to use the same `MarkSelector` pattern as bots:

```typescript
// Before
markSource: oracleMarkSource,

// After
markSource: new MarkSelector(
  { stalenessThresholdMs: appConfig.marking.stalenessThresholdMs },
  new LastFillMarkSource(fillRepo, agentId),
  oracleMarkSource,
),
```

`LastFillMarkSource` already accepts an optional `actorId` and `getLatestFillByInstrument` filters by both `symbol` and `actorId`, so the agent's own fills are correctly scoped. No schema or repository changes were needed.

## Files Changed

- `apps/worker/src/index.ts`

## Verification

- `pnpm lint` passes (tsc --noEmit, no errors).
- Regression analysis: agent-trading-actor unit tests inject their own `markSource` stub directly — unaffected. The integration test (`agent-native-decision.integration.test.ts`) targets `AgentIntakeResolver` (paper-mode fallback path) — unaffected.
- New unit test coverage needed: `getDecisionContext()` should return `referenceMark.source === 'last_fill'` when a recent fill exists, and fall back to `'oracle'` when no fill exists. Handed off to UnitTester.
