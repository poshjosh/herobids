# Plan: Asset-Class-Aware Hyperliquid Perp Preset Tuning

**Date:** 2026-08-01  
**Status:** Draft

## Problem

The current technical strategy presets are style-tiered (`economy`, `standard`, `premium`) but not market-segment-aware. The same indicator thresholds are applied to every Hyperliquid perp candidate regardless of whether the symbol behaves like BTC, SOL, or a thin high-beta tail asset.

That is a mismatch with the current scanner reality:

- `config/strategy-presets/{economy,standard,premium}.yaml` defines one parameter set per strategy per style tier.
- `apps/worker/src/scanner-candidate-discovery.ts` discovers Hyperliquid candidates from `assetContexts()`, filters by `minVolume24hUsd`, and sorts by `volume24hUsd`, but does not classify symbols into market segments.
- `packages/strategy/src/scan-engine.ts` scores all candidates with the same `ScanConfig` and has no asset-class or volatility-tier concept.
- `packages/domain/src/config/presets.ts` / `presets-loader.ts` load and map presets, but currently pass through one flat indicator set.

Today this does not prevent the system from functioning, but it creates predictable quality problems:

1. swing and range thresholds can be tuned too tightly for high-volatility perps or too loosely for BTC/ETH majors
2. confidence gates can over-fire on noisy symbols or under-fire on stable majors
3. platform assessments can compare presets against a symbol using a config that was never meant for that symbol's volatility/liquidity profile

## Scope

This plan covers only:

- Hyperliquid orderbook/perp scanning
- mechanical indicator presets used by scanner-gated technical evaluation
- preset YAML, preset loading, runtime preset resolution, and validation

This plan does not cover:

- swap venues
- a generic cross-venue asset taxonomy
- fully automated parameter optimization
- changing the high-level preset catalog (`momentum`, `momentum-position`, `range`, `swing`, `scalper`, `contrarian`)

## Verified Current State

The current codebase already has the right extension points, but not the tuning layer:

- Presets already live in operator YAML and load through `packages/domain/src/config/presets-loader.ts`.
- Preset application for agents already passes through `applyPresetToAgent()` in `packages/domain/src/config/presets.ts`.
- Candidate discovery already surfaces `volume24hUsd` and `priceChange24hPct` for Hyperliquid in `apps/worker/src/scanner-candidate-discovery.ts`.
- The technical phase already builds per-candidate `CandidateContext` objects before scoring in `apps/worker/src/technical-phase.ts`.
- `CandidateContext.meta` already has optional `volume24hUsd`, `liquidityUsd`, and `priceChange24hPct` fields in `packages/strategy/src/scan-engine.ts`.

The main missing pieces are:

- a defined market-segmentation model for Hyperliquid perps
- a way for presets to express segment-specific overrides
- runtime resolution of the effective config for a given symbol before scoring
- validation that the tuning is based on the actual Hyperliquid universe rather than hand-picked assumptions

## Goals

1. Tune scanner presets against measurable properties of the current Hyperliquid perp universe.
2. Preserve the existing style-tier model while adding a second dimension for market segment.
3. Keep the scan engine generic; resolve segment-aware config before scoring rather than hard-coding venue logic into indicator math.
4. Make the behavior deterministic and auditable so preset assessments, tests, and future migrations remain stable.

## Key Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Scope the first implementation to Hyperliquid perps only | The problem statement is specifically about the Hyperliquid perp universe; generalization can follow after evidence exists |
| 2 | Segment by measurable trading behavior, not token labels | We have runtime access to volume, 24h move, and candles; we do not have a reliable semantic asset taxonomy |
| 3 | Keep style tier and market segment separate | `economy/standard/premium` describes risk appetite; segment describes market behavior |
| 4 | Resolve effective config in the worker before calling `scoreCandidate()` | Avoid contaminating generic indicator code with venue-specific branching |
| 5 | Add explicit preset overrides with fallback to `default` | Missing segment data should degrade to known current behavior, not fail open silently |
| 6 | Validate tuning with repeatable measurements and tests | Preset changes without evidence will drift back into guesswork |

## Proposed Market Segmentation Model

The first version should avoid invented asset classes like "forex-like" or "micro-cap" and instead use a deterministic classifier based on data already available during scanning.

Recommended initial segments for Hyperliquid perps:

| Segment | Intended population | Suggested classifier inputs |
|---|---|---|
| `core` | BTC/ETH/SOL-style deep, comparatively stable perps | very high 24h volume, lower realized volatility |
| `liquid_beta` | liquid alt perps with meaningful movement but still tradable depth | high 24h volume, moderate-to-high realized volatility |
| `high_vol_tail` | noisier, fast-moving, lower-volume tail | lower 24h volume and/or very high realized volatility |

Important constraint: Hyperliquid candidate discovery currently exposes `volume24hUsd` and `priceChange24hPct`, but not a reliable orderbook liquidity metric. The initial classifier should therefore use:

- `volume24hUsd` from discovery metadata
- absolute `priceChange24hPct` from discovery metadata
- realized volatility computed from fetched candles in the technical phase

Do not block this feature on adding a new liquidity metric unless later evidence proves volume-plus-volatility is insufficient.

## Preset Shape Changes

Add segment-aware overrides to preset definitions while preserving the existing top-level structure.

### Target shape

```yaml
presets:
  swing:
    name: "Swing"
    description: "Medium-term swing trading."
    strategy:
      type: swing
      decisionMode: mechanical
      params:
        candleInterval: "4h"
        candleLimit: 48
        minCandleCount: 20
        stopLossPct: 5
        takeProfitPct: 15
        signalBias: trend-following
        positionSize: "5"
        positionSizeMode: percent_equity
        indicators:
          rsi: { enabled: true, period: 14, healthyMin: 48, healthyMax: 68 }
          macd: { enabled: true, fast: 12, slow: 26, signal: 9 }
          volume: { enabled: true, strongRatio: 1.5, weakRatio: 0.8 }
          supportResistance: { enabled: true, lookback: 24, breakoutThreshold: 0.01 }
          priceAction: { enabled: true, minChange24hPct: 5, maxChange24hPct: 50 }
          choch: { enabled: true, swingLookback: 3, minSwingPct: 0.015, rejectOnBearish: true }
          confidence:
            minConfidence: 0.40
            minReasons: 2
        marketSegments:
          core:
            indicators:
              supportResistance: { breakoutThreshold: 0.006 }
              choch: { minSwingPct: 0.010 }
          liquid_beta:
            indicators:
              priceAction: { minChange24hPct: 7, maxChange24hPct: 60 }
              choch: { minSwingPct: 0.018 }
          high_vol_tail:
            indicators:
              rsi: { healthyMin: 50, healthyMax: 62 }
              volume: { strongRatio: 2.0 }
              supportResistance: { breakoutThreshold: 0.015 }
              confidence: { minConfidence: 0.50, minReasons: 3 }
```

### Design rules

- The existing flat `params` block remains the baseline default.
- `marketSegments.<segment>` contains partial overrides only.
- Resolution is deep-merge with `params` as the base.
- Unknown segment keys fail validation loudly at preset-load time.
- Missing classifier inputs fall back to the baseline `params` block.

## Phase 0 — Baseline Measurement and Segment Design

**Goal:** stop guessing. Derive segment boundaries and tuning candidates from the actual Hyperliquid perp universe.

### Deliverables

- a one-off calibration script or report generator
- a checked-in summary document with the measured universe distribution
- proposed segment thresholds with justification

### Candidate file surfaces

- new script under `scripts/ts/` for Hyperliquid preset calibration
- `apps/worker/src/scanner-candidate-discovery.ts` for confirming available metadata inputs
- `packages/market-data` Hyperliquid adapter surfaces if additional metadata is needed

### Work

1. Build a calibration script that:
   - fetches the current Hyperliquid perp universe from `assetContexts()`
   - samples candles for the strategy intervals already used by presets (`5m`, `15m`, `1h`, `4h`)
   - computes summary stats per symbol: `volume24hUsd`, absolute `priceChange24hPct`, realized volatility, wickiness/noise proxy if easy
2. Bucket symbols into candidate segments and produce histograms / percentile tables.
3. For each strategy, compare current preset thresholds against each bucket to estimate likely over-filtering and under-filtering.
4. Record the recommended first-cut boundaries in a companion note.

### Exit criteria

- Segment boundaries are written down and justified with actual universe data.
- We can name which strategies need differentiated thresholds and why.

## Phase 1 — Add Segment-Aware Preset Schema

**Goal:** allow YAML presets to express market-segment-specific overrides without breaking existing presets.

### Candidate file surfaces

- `packages/domain/src/config/presets.ts`
- `packages/domain/src/config/presets-loader.ts`
- `packages/domain/src/config/presets.test.ts`
- `config/strategy-presets/{economy,standard,premium}.yaml`

### Work

1. Extend `PresetEntrySchema` to validate an optional `marketSegments` block inside `strategy.params` or a sibling typed location.
2. Define a narrow allowed segment-key enum for the first version: `core`, `liquid_beta`, `high_vol_tail`.
3. Add a typed helper that deep-merges baseline params with a segment override.
4. Keep all current presets valid by making the new block optional.
5. Add unit tests for:
   - valid segment overrides
   - unknown segment keys rejected
   - override merge preserves unspecified baseline fields

### Decision note

Prefer a typed, explicit segment key enum over free-form user-defined keys in the first version. This keeps validation, behavior versioning, and assessment comparability under control.

## Phase 2 — Runtime Segment Classification and Effective Config Resolution

**Goal:** score each candidate with the config intended for its market behavior.

### Candidate file surfaces

- `apps/worker/src/technical-phase.ts`
- `packages/strategy/src/scan-engine.ts`
- new worker helper for segment classification and config resolution
- `apps/worker/src/market-intelligence/platform-assessor.ts`
- `apps/worker/src/market-intelligence/preset-catalog-adapter.ts`

### Work

1. Introduce a worker-level classifier that takes:
   - discovery metadata (`volume24hUsd`, `priceChange24hPct`)
   - fetched candles
   - operator-configured thresholds if externalized later
2. Resolve an effective per-candidate strategy params object before calling `scoreCandidate()`.
3. Pass the resolved `ScanConfig` to `scoreCandidate()`; keep `scan-engine.ts` generic.
4. Include the resolved segment in scanner logs / observability output so tuning decisions are inspectable.
5. Ensure platform preset assessment paths use the same config-resolution logic, not a second copy.

### Important invariant

There must be one shared resolver for:

- live technical scans
- preset assessments
- any future replay or offline evaluation

Do not allow multiple independent implementations of "which segment does this symbol fall into?" or "which overrides apply?". That would create silent drift.

## Phase 3 — Retune Presets for the Hyperliquid Universe

**Goal:** replace flat, one-size-fits-all thresholds with strategy-specific defaults plus segment-specific overrides.

### Candidate file surfaces

- `config/strategy-presets/economy.yaml`
- `config/strategy-presets/standard.yaml`
- `config/strategy-presets/premium.yaml`

### Tuning direction by strategy

| Strategy | Expected tuning focus |
|---|---|
| `momentum` | loosen/tighten healthy RSI and price-action gates by segment so majors are not under-signalled and noisy tails are not over-signalled |
| `momentum-position` | widen swing/price-action expectations for higher-volatility perps while avoiding low-quality tail churn |
| `range` | tighten range eligibility for high-volatility tail names; avoid treating trend days as range days |
| `swing` | differentiate breakout threshold, CHOCH swing size, and confidence floor by segment |
| `scalper` | increase noise rejection on high-volatility tail names; avoid over-constraining core liquid names |
| `contrarian` | if present in active presets, review reversal thresholds with the same segment model |

### Work

1. Keep baseline defaults close to the current behavior for safety.
2. Add only the overrides justified by the calibration output.
3. Avoid rewriting unrelated strategy semantics while tuning thresholds.
4. Document why each override exists so future edits are evidence-based.

## Phase 4 — Validation and Evidence

**Goal:** prove the new presets are both valid and useful.

### Tests

- preset schema unit tests for the new `marketSegments` structure
- config-resolution tests for deep-merge correctness
- technical-phase tests showing different effective configs for representative symbols
- scan-engine or worker tests proving fallback to baseline config when segment data is missing
- preset assessment tests proving shared resolution logic is used consistently

### Evidence checks

1. Offline comparison on a representative snapshot of Hyperliquid symbols:
   - majors such as BTC/ETH/SOL
   - liquid alts
   - volatile tail names
2. Compare signal-rate and rejection-rate distributions before vs after tuning.
3. Manually inspect a few symbols per segment to ensure the resolved config is plausible.
4. Run at least a narrow worker test slice plus `pnpm lint` before merge.

## Risks

1. **Overfitting risk**
   If tuning is derived from too narrow a time window, presets can become brittle.
2. **Classifier drift risk**
   If segment assignment depends on noisy short-term inputs without stable thresholds, the same symbol can flip segments too often.
3. **Assessment mismatch risk**
   If platform assessment uses raw presets while live scanning uses resolved presets, ranking results become misleading.
4. **Silent fallback risk**
   If missing segment inputs quietly strip overrides without observability, quality degrades invisibly.
5. **Schema sprawl risk**
   If segment overrides become a second full preset tree, the YAML becomes hard to maintain.

## Rollout Recommendation

1. Ship Phase 0 and land the calibration evidence first.
2. Ship schema + runtime resolution with no material threshold changes beyond a tiny pilot slice if needed.
3. Tune one or two strategies first, preferably `swing` and `scalper`, because they are most sensitive to volatility mismatch.
4. Expand to the rest of the preset catalog after evidence and tests are stable.

## Done When

- Hyperliquid perp presets are tuned against measured universe behavior rather than generic assumptions.
- The same strategy/style preset can resolve to different thresholds for different market segments in a deterministic, validated way.
- Scanner execution and preset assessment use the same resolution path.
- Preset YAML remains operator-editable and backward-compatible for entries that do not use segment overrides.
