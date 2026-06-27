# Plan: Strategy Presets Expansion & Mechanical Parity

**Status:** Ready for implementation  
**Date:** 2026-06-27  
**Prior art:**
- `docs/features/2026/06/16/003-rich-strategy-parity/001-plan.md` — MechanicalStrategy implementation (completed)
- `docs/features/2026/06/20/001-bot-config-integrity/001-plan.md` — strategy.type + decisionMode separation
- `docs/product/sentiment-word-lists.md` — sentiment config design decision
- `docs/features/pending/exit-policy-scale-out-trail/001-plan.md` — exit policy (deferred, not in this plan)
- `aitradingbot/src/config/presets/*.ts` — reference preset values

---

## Summary

The runtime only supports `type: 'momentum'` for `decisionMode: 'mechanical'`.
DCA throws. The web UI has only 1 strategy preset. The `MechanicalStrategy`
is already fully implemented and type-agnostic — the gap is purely in the
factory guards, schema completeness, and UI preset catalogue.

This plan covers:
1. Expand `MechanicalParamsSchema` with missing strategy-level params
2. Add VWAP and price-action indicator scoring to `scoreCandidate()`
3. Remove the momentum-to-mechanical translation bridge
4. Remove artificial `type !== 'momentum'` guards from both factories
5. Add hybrid support to backtest-runtime
6. Add 7 strategy presets to the web UI
7. Align blueprint presets with mechanical params
8. Implement DCA strategy (separate sub-phase)

**Out of scope (deferred):**
- Exit policy (scale-out / trail remainder) → `docs/features/pending/exit-policy-scale-out-trail/001-plan.md`
- Sentiment word lists / concrete Twitter adapter → `docs/product/sentiment-word-lists.md`
- Regime gate for bots (already deferred in `003-rich-strategy-parity`)
- Backward compatibility with old momentum-style params

---

## Phase 0 — Expand `MechanicalParamsSchema` (domain)

**File:** `packages/domain/src/config/schema.ts`

### 0a — Add strategy-level params

`stopLossPct` and `takeProfitPct` are **required** (no defaults) — every strategy
must declare its exit targets. `trailingStopPct` is optional (`null` = disabled).
`minCandleCount` is optional with default 20.

```typescript
export const MechanicalParamsSchema = z.object({
  // Candle fetching
  candleInterval: z.enum(['5m', '15m', '1H', '4H', '1D']).default('15m'),
  candleLimit: z.number().int().min(20).max(500).default(48),  // changed from 100 → 48
  minCandleCount: z.number().int().min(5).default(20),         // NEW

  // Exit targets (strategy-level, not risk guards)
  stopLossPct: z.number().min(0).max(100),                     // NEW — required
  takeProfitPct: z.number().min(0),                            // NEW — required
  trailingStopPct: z.number().min(0).max(100).nullable().default(null), // NEW — optional

  // Indicator suite
  indicators: IndicatorConfigSchema.default({}),

  // Signal interpretation
  signalBias: z.enum(['trend-following', 'mean-reverting']).default('trend-following'),

  // Sentiment
  sentiment: SentimentConfigSchema,  // changed from inline object (see 0b)

  // Position sizing
  positionSize: z.string().min(1),
  positionSizeMode: z.enum(['fixed', 'percent_equity']).default('fixed'),
});
```

### 0b — Expand sentiment config (provider-agnostic thresholds)

Replace the inline `z.object({ enabled: z.boolean()... })` with a named schema:

```typescript
export const SentimentConfigSchema = z.object({
  enabled: z.boolean().default(false),
  minDataPoints: z.number().int().min(1).default(5),
  positiveThreshold: z.number().min(0).max(1).default(0.2),
  negativeThreshold: z.number().min(-1).max(0).default(-0.2),
  maxBoost: z.number().min(0).max(0.5).default(0.1),
}).default({});
```

### 0c — Add VWAP sub-schema to indicators

```typescript
export const VwapParamsSchema = z.object({
  enabled: z.boolean().default(false),
  period: z.number().int().min(2).default(24),
}).default({});
```

### 0d — Add price-action sub-schema to indicators

```typescript
export const PriceActionParamsSchema = z.object({
  enabled: z.boolean().default(true),
  minChange24hPct: z.number().default(3),
  maxChange24hPct: z.number().default(50),
}).default({});
```

### 0e — Add `vwapWeight` to confidence weights

```typescript
export const ConfidenceWeightsSchema = z.object({
  // ... existing weights ...
  vwapWeight: z.number().default(0),           // NEW — 0 = disabled by default
  // ... rest unchanged ...
}).default({});
```

### 0f — Update `IndicatorConfigSchema` to include VWAP and priceAction

```typescript
export const IndicatorConfigSchema = z.object({
  rsi: RsiParamsSchema,
  macd: MacdParamsSchema,
  volume: VolumeParamsSchema,
  choch: ChochParamsSchema,
  supportResistance: SupportResistanceParamsSchema,
  vwap: VwapParamsSchema,                    // NEW
  priceAction: PriceActionParamsSchema,      // NEW
  confidence: ConfidenceWeightsSchema,
});
```

### 0g — Update domain exports

Add new schemas and types to `packages/domain/src/config/index.ts`:
- `VwapParamsSchema`, `VwapParams`
- `PriceActionParamsSchema`, `PriceActionParams`
- `SentimentConfigSchema`, `SentimentConfig`

### Phase 0 checklist

- [ ] Add `stopLossPct`, `takeProfitPct`, `trailingStopPct`, `minCandleCount` to `MechanicalParamsSchema`
- [ ] Change `candleLimit` default from 100 → 48
- [ ] Extract `SentimentConfigSchema` as named schema with thresholds
- [ ] Add `VwapParamsSchema` (`{ enabled, period }`)
- [ ] Add `PriceActionParamsSchema` (`{ enabled, minChange24hPct, maxChange24hPct }`)
- [ ] Add `vwapWeight` (default 0) to `ConfidenceWeightsSchema`
- [ ] Add `vwap` and `priceAction` to `IndicatorConfigSchema`
- [ ] Export new schemas and inferred types from `packages/domain/src/config/index.ts`
- [ ] `pnpm lint` passes

---

## Phase 1 — Wire VWAP and Price Action into `scoreCandidate()`

**File:** `packages/strategy/src/scan-engine.ts`

### 1a — Add VWAP scoring block

After the volume block (line ~277), add:

```typescript
// ─── VWAP ─────────────────────────────────────────────────────────────────
const vwapCfg = {
  enabled: indicators.vwap?.enabled ?? false,
  period: indicators.vwap?.period ?? 24,
};

if (vwapCfg.enabled && candles.length >= vwapCfg.period) {
  const vwapWindow = candles.slice(-vwapCfg.period);
  const vwapValue = vwap(vwapWindow);
  const lastClose = candles[candles.length - 1]!.close;
  if (!isNaN(vwapValue) && vwapValue > 0 && lastClose > vwapValue) {
    bullishConfidence += (confCfg.vwapWeight ?? 0);
    bearishConfidence += (confCfg.vwapWeight ?? 0);
    bullishReasons.push('Price above VWAP');
    bearishReasons.push('Price above VWAP');
  }
}
```

Import `vwap` from `@herobids/market-data` (already exported at `packages/market-data/src/index.ts:38`).

### 1b — Add price-action scoring block

After the VWAP block, add:

```typescript
// ─── Price Action ─────────────────────────────────────────────────────────
const paCfg = {
  enabled: indicators.priceAction?.enabled ?? true,
  minChange24hPct: indicators.priceAction?.minChange24hPct ?? 3,
  maxChange24hPct: indicators.priceAction?.maxChange24hPct ?? 50,
};

if (paCfg.enabled && candidate.meta?.priceChange24hPct != null) {
  const change = candidate.meta.priceChange24hPct;
  if (change >= paCfg.minChange24hPct && change <= paCfg.maxChange24hPct) {
    bullishConfidence += (confCfg.priceActionWeight ?? 0.10);
    bullishReasons.push(`+${change.toFixed(1)}% in 24h`);
  }
}
```

### 1c — Update `IndicatorConfig` interface

Add `vwap` and `priceAction` to the local `IndicatorConfig` type in `scan-engine.ts`:

```typescript
export interface IndicatorConfig {
  // ... existing fields ...
  vwap?: {
    enabled?: boolean;
    period?: number;
  };
  priceAction?: {
    enabled?: boolean;
    minChange24hPct?: number;
    maxChange24hPct?: number;
  };
}
```

### 1d — Update `ScoredSignal.indicators`

Add `priceAboveVwap?: boolean` to the indicators output:

```typescript
export interface ScoredSignal {
  // ...
  indicators: {
    // ... existing ...
    priceAboveVwap?: boolean;   // NEW
  };
}
```

### 1e — Plumb `priceChange24hPct` into `MechanicalStrategy`

In `MechanicalStrategy.evaluate()`, when building the `CandidateContext`, populate
`meta.priceChange24hPct` from the snapshot. The `MarketSnapshot.data` may carry
this from the trading actor's enrichment step. If absent, skip price action scoring
(no error — the check is additive-only).

### Phase 1 checklist

- [ ] Import `vwap` from `@herobids/market-data` in `scan-engine.ts`
- [ ] Add VWAP scoring block to `scoreCandidate()`
- [ ] Add price-action scoring block to `scoreCandidate()`
- [ ] Add `vwap` and `priceAction` to `IndicatorConfig` interface
- [ ] Add `priceAboveVwap` to `ScoredSignal.indicators`
- [ ] Wire `priceChange24hPct` from snapshot → `CandidateContext.meta` in `MechanicalStrategy`
- [ ] Unit tests: VWAP above → confidence boost; VWAP below → no boost; price action in range → boost; price action out of range → no boost
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

---

## Phase 2 — Remove Translation Bridge + Fix Factories

### 2a — Delete momentum-to-mechanical bridge

| Action | File |
|---|---|
| Delete file | `packages/strategy/src/momentum-to-mechanical.ts` |
| Delete file | `packages/strategy/src/momentum-to-mechanical.test.ts` |
| Remove export | `packages/strategy/src/index.ts` line 8 |

### 2b — Fix `apps/worker/src/index.ts` `createStrategy()`

Replace the `mechanical` case (lines 769–797):

```typescript
// BEFORE (remove):
case 'mechanical': {
  if (strategyConfig.type !== 'momentum') {
    throw new Error(`'mechanical' decisionMode is only supported for strategyType='momentum'...`);
  }
  if (!candleFetcher) { throw ... }
  const mechanical = new MechanicalStrategy(candleFetcher, null, () => idGen.decisionId());
  const mechanicalWrapper: Strategy = {
    id: mechanical.id,
    name: mechanical.name,
    evaluate: async (snapshot, rawConfig) => {
      const translated = translateMomentumToMechanicalParams(rawConfig);
      return mechanical.evaluate(snapshot, translated);
    },
  };
  return mechanicalWrapper;
}

// AFTER (simplify):
case 'mechanical': {
  if (!candleFetcher) {
    throw new Error('mechanical strategy requires marketData (CandleFetcher unavailable)');
  }
  return new MechanicalStrategy(candleFetcher, null, () => idGen.decisionId());
}
```

Also keep the DCA throw for now (Phase 5 replaces it).

### 2c — Fix `apps/worker/src/backtest-runtime.ts` `createStrategy()`

Same changes as 2b for the `mechanical` case. Also add `hybrid` support:

```typescript
case 'hybrid': {
  // hybrid not yet wired for backtesting — backtesting does not run indicator pre-filtering
  throw new Error('hybrid decisionMode is not yet supported for backtesting');
}
```

Change from current behavior (falls through to `default` error) to explicit error
with guidance.

### 2d — Remove `translateMomentumToMechanicalParams` import in worker

Remove the import in `apps/worker/src/index.ts` (line referencing `momentum-to-mechanical`).

### Phase 2 checklist

- [ ] Delete `packages/strategy/src/momentum-to-mechanical.ts`
- [ ] Delete `packages/strategy/src/momentum-to-mechanical.test.ts`
- [ ] Remove export from `packages/strategy/src/index.ts`
- [ ] Remove `type !== 'momentum'` guard from `apps/worker/src/index.ts` `createStrategy()`
- [ ] Remove wrapper/translation from `mechanical` case, construct `MechanicalStrategy` directly
- [ ] Remove `type !== 'momentum'` guard from `apps/worker/src/backtest-runtime.ts` `createStrategy()`
- [ ] Same direct construction in backtest-runtime
- [ ] Add explicit `hybrid` error in backtest-runtime (replaces generic default error)
- [ ] Remove `translateMomentumToMechanicalParams` imports
- [ ] Update all test fixtures that use old momentum params format → mechanical format
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

---

## Phase 3 — Web UI Presets

**File:** `apps/web/src/features/bots/BotsPage.tsx`

### 3a — Expand `STRATEGY_PRESETS` from 1 to 7

Replace the single preset array with:

| # | `value` | Label | `strategy.type` | `decisionMode` |
|---|---|---|---|---|
| 1 | `momentum` | Momentum — Day | `momentum` | `mechanical` |
| 2 | `momentum-position` | Momentum — Position | `momentum` | `mechanical` |
| 3 | `swing` | Swing | `swing` | `mechanical` |
| 4 | `range` | Range Trading | `range` | `mechanical` |
| 5 | `contrarian` | Contrarian | `contrarian` | `mechanical` |
| 6 | `scalper` | Scalper | `scalper` | `mechanical` |
| 7 | `dca` | DCA | `dca` | *(omitted)* |

Note: Two presets share `type: 'momentum'` but differ in `value` (the preset key).
The `value` field is the UI selector key; `strategy.type` is what gets stored in
config. Both momentum presets set `strategy.type: 'momentum'` with different
`params` (candleInterval, stopLossPct, etc.).

### 3b — Preset params format

All presets must use mechanical-format params (no `lookbackPeriod`/`threshold`).
Each preset provides the full `MechanicalParamsSchema`-compatible object plus
`stopLossPct` and `takeProfitPct`:

```typescript
{
  value: 'swing',
  label: 'Swing',
  description: 'Medium-term swing trading. 4H candles, moderate risk.',
  config: {
    strategy: {
      type: 'swing',
      decisionMode: 'mechanical',
      params: {
        candleInterval: '4H',
        candleLimit: 48,
        minCandleCount: 20,
        stopLossPct: 5,
        takeProfitPct: 15,
        signalBias: 'trend-following',
        positionSize: '1',
        positionSizeMode: 'fixed',
        indicators: {
          rsi: { enabled: true, period: 14, healthyMin: 48, healthyMax: 68 },
          macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
          volume: { enabled: true, strongRatio: 1.5, weakRatio: 0.8 },
          supportResistance: { enabled: true, lookback: 24, breakoutThreshold: 0.01 },
          vwap: { enabled: false },
          priceAction: { enabled: true, minChange24hPct: 5, maxChange24hPct: 50 },
          choch: { enabled: true, swingLookback: 3, minSwingPct: 0.015, rejectOnBearish: true },
          confidence: {
            rsiWeight: 0.20, macdCrossoverWeight: 0.25, macdIncreasingWeight: 0.15,
            breakoutWeight: 0.25, volumeWeight: 0.20,
            vwapWeight: 0, priceActionWeight: 0.10,
            chochBullishWeight: 0.20, chochBearishPenalty: 0.15,
            minConfidence: 0.40, minReasons: 2,
          },
        },
      },
    },
  },
}
```

Full param tables for all 7 presets were specified in the earlier analysis.
See the conversation context for the complete preset definitions.

### 3c — Update `StrategyPresetValue` type

```typescript
type StrategyPresetValue = typeof STRATEGY_PRESETS[number]['value'];
```

This automatically updates from the array — no manual type change needed.

### 3d — DCA preset (no `decisionMode`)

DCA is the only preset that omits `decisionMode` (it's timer-driven). The
`CreateBotModal` submission logic needs to handle this — when the preset has
no `decisionMode`, don't include it in the config:

```typescript
const preset = STRATEGY_PRESETS.find((p) => p.value === form.strategyPreset)!;
let config = { ...preset.config, execution: { mode: form.executionMode }, venue, symbol: form.symbol };
// If preset has no decisionMode (e.g. DCA), ensure it's not in the config
if (!config.strategy.decisionMode) {
  delete config.strategy.decisionMode;
}
```

### Phase 3 checklist

- [ ] Replace `STRATEGY_PRESETS` array with 7 presets (all mechanical-format params)
- [ ] Handle DCA preset (no `decisionMode`) in `CreateBotModal` submission
- [ ] Verify preset radio group renders all 7 options
- [ ] Verify preset selection populates correct params
- [ ] `pnpm lint` passes (web package)

---

## Phase 4 — Align Blueprint Presets

**File:** `apps/api/src/routes/blueprints.ts`

### 4a — Update `PRESETS` to use mechanical-format params

The current blueprint presets use ad-hoc param shapes (`supportLevel`,
`resistanceLevel`, `entryRsi`, `exitRsi`, etc.) that won't match
`MechanicalParamsSchema`. Rewrite all 6 presets to use mechanical-format
params matching the web UI presets (minus the DCA one, which already
has its own format).

### 4b — DCA blueprint preset

Keep the DCA preset with its own param shape (`intervalHours`, `amount`).
This is the only non-mechanical preset and will be handled by the DCA
executor once implemented.

### Phase 4 checklist

- [ ] Rewrite momentum, range, swing, scalper, contrarian blueprint presets with mechanical-format params
- [ ] Verify `GET /blueprints/presets` returns updated configs
- [ ] `pnpm lint` passes (api package)

---

## Phase 5 — DCA Strategy Implementation

**Files:** New `packages/strategy/src/dca-strategy.ts`, factory changes

### 5a — DCA strategy class

DCA is fundamentally different from signal-based strategies:
- No signal evaluation — timer-driven buys at fixed intervals
- No `decisionMode` — the schema already accounts for this
- No candles/indicators — just "buy $X every Y ms"

```typescript
export class DcaStrategy implements Strategy {
  readonly id = 'dca-v1';
  readonly name = 'DCA Strategy';

  async evaluate(
    snapshot: MarketSnapshot,
    rawConfig: Record<string, unknown>,
  ): Promise<Result<Decision | null, StrategyError>> {
    const parsed = DcaParamsSchema.safeParse(rawConfig);
    if (!parsed.success) {
      return err({ code: 'strategy.config_invalid', message: parsed.error.message });
    }
    const { intervalMs, amountPerBuy } = parsed.data;

    // Check if enough time has passed since last buy
    const lastBuy = snapshot.data?.['lastDcaBuy'] as number | undefined;
    const now = Date.now();
    if (lastBuy != null && (now - lastBuy) < intervalMs) {
      return ok(null); // Not time yet
    }

    return ok({
      id: crypto.randomUUID() as DecisionId,
      intent: 'go_long',
      size: amountPerBuy,
      metadata: { strategy: 'dca', lastDcaBuy: now },
    });
  }
}
```

### 5b — DCA params schema

```typescript
export const DcaParamsSchema = z.object({
  intervalMs: z.number().int().min(60_000).default(86_400_000), // 24h default
  amountPerBuy: z.string().min(1),  // decimal string, e.g. "10"
});
```

### 5c — Factory integration

In both `createStrategy()` functions, replace the DCA throw with:

```typescript
if (strategyConfig.type === 'dca') {
  return new DcaStrategy();
}
```

### 5d — Backtest DCA support

In the backtest-runtime, DCA in backtesting doesn't make sense (no real time).
Throw a clearer error:

```typescript
if (strategyType === 'dca') {
  throw new Error('DCA strategy is not supported for backtesting — it requires real-time scheduling');
}
```

### Phase 5 checklist

- [ ] Create `packages/strategy/src/dca-strategy.ts` with `DcaStrategy` class
- [ ] Define `DcaParamsSchema` in `packages/domain/src/config/schema.ts`
- [ ] Export `DcaStrategy` from `packages/strategy/src/index.ts`
- [ ] Replace DCA throw with `DcaStrategy` construction in `apps/worker/src/index.ts`
- [ ] Replace DCA throw with clear backtest error in `apps/worker/src/backtest-runtime.ts`
- [ ] Unit tests: DCA returns `go_long` after interval; DCA returns `null` before interval
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

---

## Phase 6 — Fix `MechanicalStrategy` Sentiment Threshold Gating

**File:** `packages/strategy/src/mechanical-strategy.ts`

### 6a — Apply new sentiment thresholds

Update the sentiment adjustment block (lines 123–140) to use the new
`minDataPoints`, `positiveThreshold`, `negativeThreshold`, and `maxBoost`
from `SentimentConfigSchema`:

```typescript
// 4. Sentiment adjustment (optional)
let adjustedConfidence = signal.confidence;
if (params.sentiment.enabled && this.sentimentProvider != null) {
  const sentResult = await this.sentimentProvider.getScore(snapshot.symbol);
  if (sentResult.ok && sentResult.data != null) {
    // Hard veto: strongly negative sentiment with high confidence
    if (
      sentResult.data.score < params.sentiment.negativeThreshold &&
      sentResult.data.confidence > 0.5
    ) {
      return ok(null); // sentiment veto
    }
    // Boost: positive sentiment above threshold
    if (sentResult.data.score > params.sentiment.positiveThreshold) {
      const boost = sentResult.data.score * sentResult.data.confidence * params.sentiment.maxBoost;
      adjustedConfidence = Math.min(1, Math.max(0, signal.confidence + boost));
    }
  }
}
```

### Phase 6 checklist

- [ ] Replace simple boost logic with threshold-gated logic
- [ ] Add sentiment veto path (strong negative → return null)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

---

## Definition of Done

- [ ] `MechanicalParamsSchema` includes `stopLossPct` (required), `takeProfitPct` (required), `trailingStopPct` (optional), `minCandleCount` (optional)
- [ ] `SentimentConfigSchema` extracted with `minDataPoints`, `positiveThreshold`, `negativeThreshold`, `maxBoost`
- [ ] `VwapParamsSchema` and `PriceActionParamsSchema` defined and added to `IndicatorConfigSchema`
- [ ] `vwapWeight` added to `ConfidenceWeightsSchema`
- [ ] VWAP and price-action scoring wired in `scoreCandidate()`
- [ ] Momentum-to-mechanical translation bridge deleted
- [ ] Both `createStrategy()` functions: no `type !== 'momentum'` guard, no translation wrapper
- [ ] `MechanicalStrategy` constructed directly in both factories
- [ ] DCA strategy implemented (no longer throws)
- [ ] Sentiment threshold gating applied in `MechanicalStrategy`
- [ ] 7 strategy presets in web UI with mechanical-format params
- [ ] Blueprint presets aligned with mechanical params
- [ ] `pnpm lint` passes (all packages)
- [ ] `pnpm test` passes (all packages)
- [ ] `pnpm build` succeeds (all packages)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `stopLossPct`/`takeProfitPct` required → breaks existing test fixtures | Tests fail | Update all fixtures in Phase 2 — grep for `MechanicalParamsSchema` usage |
| Deleting translation bridge breaks agent-created bots with old momentum params | Runtime error on bot tick | No production bots exist with old format. Agents self-update config — they'll use new format after schema refresh. |
| `MechanicalStrategy` test fixtures rely on schema defaults | Tests fail | Update `mechanical-strategy.test.ts` fixtures with explicit `stopLossPct`/`takeProfitPct` |
| Web UI builds may fail if preset params don't match TypeScript types | Build failure | Preset `config` objects use `Record<string, unknown>` which is loose — no TS error expected |
| `pnpm lint` across all packages may reveal type errors in downstream consumers | CI failure | Phase 0 exports must include all new types; run lint after each phase |

---

## Phase Dependency Order

```
Phase 0 (schema) ──┬── Phase 1 (scoreCandidate VWAP/PA)
                   ├── Phase 2 (factory cleanup + bridge removal)
                   │      └── Phase 5 (DCA impl — needs factory)
                   ├── Phase 3 (web UI presets — needs schema + factory)
                   ├── Phase 4 (blueprint presets — needs schema)
                   └── Phase 6 (sentiment gating — needs schema)
```

Phases 1, 2, 3, 4, and 6 can run in parallel after Phase 0. Phase 5 depends on Phase 2.

---

## Outstanding Issues (Phase 0)

| # | Severity | Item | Issue |
|---|----------|------|-------|
| L1 | LOW | Phase 0 | Local vs domain `IndicatorConfig` structural divergence — scan-engine.ts has its own interface separate from domain. Consider deriving from domain type in a future cleanup. |
| L2 | LOW | Phase 0 | No schema-level unit tests for new required fields (`stopLossPct`, `takeProfitPct`). Dedicated `MechanicalParamsSchema` tests would be more robust. |
| L3 | LOW | Phase 0 | `trailingStopPct` declared in schema but not consumed by `MechanicalStrategy` or any engine code. Wire in a later phase. |
| L4 | LOW | Phase 1 | `noIndicators` fixture in scan-engine.test.ts omits explicit `vwap: { enabled: false }` and `priceAction: { enabled: false }`. Harmless today but may silently activate future indicators. |
| L5 | LOW | Phase 1 | Redundant nullish coalescing in VWAP/price-action scoring (`?? 0`, `?? 0.10`) — confCfg already provides defaults. Inconsistent with other indicators. |
| L6 | LOW | Phase 1 | Asymmetric defaults: vwap.enabled defaults false (opt-in), priceAction.enabled defaults true (opt-out). |
