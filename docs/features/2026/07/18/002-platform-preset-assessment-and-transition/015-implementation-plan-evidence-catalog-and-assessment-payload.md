# Implementation Plan: Evidence Adapters, Preset Catalog, And Assessment Payload

**Status:** Draft
**Date:** 2026-07-19
**Depends on:** [014-corrected-gap-table.md](./014-corrected-gap-table.md)
**Related plans:** [008-real-evidence-and-scorecards.md](./008-real-evidence-and-scorecards.md), [009-llm-preset-ranking.md](./009-llm-preset-ranking.md), [006b-followup-plan-2.md](./006b-followup-plan-2.md)
**Purpose:** Close the three highest-priority implementation gaps that currently prevent the platform preset-assessment flow from being end-to-end usable.

## Scope

This plan covers only these three items:

1. wire real evidence adapters and evidence/scorecard persistence;
2. wire the real preset catalog;
3. fix `assess_strategy_preset` so it returns the full assessment payload promised by the schema.

This plan does **not** attempt to finish:

- cross-worker provider lease durability;
- worker-restart reconciliation for in-flight preset transitions;
- full `entries_and_tighten_existing` position-action support;
- final legacy cleanup from `013`.

## Current Code-Checked Baseline

The following is the relevant current state in code:

1. Worker composition still installs stub evidence ports that always return `assessment.evidence_unavailable` and still passes an empty `getPresets()` catalog into the assessor.
2. `PlatformAssessor.collectEvidence()` and `generateScorecards()` already have the right structural split, but evidence/scorecard persistence is still a TODO.
3. `PresetScorecardRunner` exists and produces single-symbol deterministic scorecards from candles plus preset strategy config.
4. `AssessmentRequestService` already persists runs, artifacts, and billing outcomes, but its public port only returns request/outcome metadata, not the artifact payload required by the tool schema.
5. `assess_strategy_preset` currently maps `cache_hit` / `assessment_completed` outcomes into `transitionReference` plus `billing`, but does not populate `canonicalIdentity` or `assessment` on success.

## Goal State

After this plan lands:

1. `PlatformAssessor` receives real evidence through worker-owned adapters instead of unconditional stubs.
2. Evidence snapshots and deterministic scorecards are persisted with the run before LLM ranking.
3. The assessor receives the real preset catalog for the requested style tier.
4. `assess_strategy_preset` returns the full success shape required by `AssessmentResultEntrySchema` for both `cache_hit` and `assessment_completed` outcomes.
5. The worker can execute a real single-instrument assessment request end to end without placeholder evidence, empty preset sets, or incomplete tool responses.

## Implementation Strategy

Implement in this order:

1. wire the real preset catalog first;
2. wire evidence adapters and persistence next;
3. then expand the request/tool contract so the assessment tool can return the full payload.

Reason:

- evidence and ranking are meaningless if the assessor sees `[]` presets;
- the tool payload should be fixed after the worker can reliably produce a real artifact;
- this keeps the tool contract aligned with the actual artifact shape rather than reworking a placeholder response twice.

## Locked Implementation Choices

The following decisions are fixed for this plan and should not be re-opened during implementation.

1. **Orderbook/perp candle path**
   Use the same worker candle path already used by technical scanning: the worker-owned `scannerCandleFetcher` / `VenueCandleFetcher` path. For orderbook/perp identities, this continues to route to Binance-backed candles through the existing venue candle fetcher.

2. **Orderbook/perp regime path**
   Compute regime directly from the fetched assessment candle window using `evaluateRegime(...)` and `getRequiredRegimeCandleCount(...)` from the shared market-data regime module. Do not use a benchmark-style shared regime snapshot as the phase-1 source of truth.

3. **Request-port success payload**
   `AssessmentRequestService` returns the artifact summary directly in the port outcome. The tool must not do a second artifact lookup after a successful request.

4. **First-slice liquidity model for orderbook/perp**
   Implement liquidity now from venue-native normalized orderbook data. Use best-bid / best-ask spread plus top-1 displayed notional depth on both sides.

5. **First-slice breadth model**
   Keep breadth explicitly unavailable in the first shipped slice. Do not derive breadth from the existing discovery snapshot or market-overview tool.

## Workstream 1: Real Preset Catalog

### Objective

Replace the worker-local `getPresets()` stub with a real adapter over the domain preset loader.

### Current gap

- `apps/worker/src/index.ts` still provides `getPresets = () => []`.
- The domain already has `listPresets(style)` and `getPreset(strategy, style)` in `packages/domain/src/config/presets-loader.ts`.

### Planned changes

1. Create a tiny worker adapter that calls `listPresets(styleTier)` and maps its result into:

```ts
Array<{ key: string; entry: PresetEntry }>
```

2. Keep the preset source as the validated YAML-backed domain loader for this slice. Do not introduce a new DB-backed preset home here.

3. Fail loudly at worker startup if preset loading fails for any style tier. An empty catalog should not be silently accepted.

4. Preserve the current behavior of excluding unsupported/bot-only DCA presets at scorecard time rather than stripping them from the catalog adapter itself.

### Files

| Surface | Change |
|---|---|
| `apps/worker/src/index.ts` | Replace the inline empty `getPresets()` stub with a real adapter. |
| optional new helper under `apps/worker/src/market-intelligence/` | Encapsulate preset catalog loading if needed for testability. |

### Tests

- unit test that the adapter returns presets for each style tier;
- worker composition test that assessor construction no longer receives an empty preset list under normal config;
- failure-path test that invalid preset loading fails loudly rather than degrading to `[]`.

### Completion bar

- no runtime path passes an empty hardcoded preset list to `PlatformAssessor`;
- scorecard/ranking tests execute with the real catalog adapter wired from the worker composition root.

## Workstream 2: Real Evidence Adapters And Evidence/Scorecard Persistence

### Objective

Replace unconditional evidence stubs with minimal real adapters and persist the evidence/scorecard artifacts that the assessor actually uses.

### Current gap

- worker startup still installs unconditional `assessment.evidence_unavailable` ports;
- `PlatformAssessor.assessIdentity()` still leaves evidence persistence as a TODO;
- `market_assessment_runs` already has `evidenceSnapshot`, `scorecardSnapshots`, and `calculationVersions` columns ready to use.

### Minimum viable evidence slice

Implement the smallest real slice that can satisfy the current artifact contract for orderbook/perp symbols first.

#### Required for this slice

- regime evidence;
- candle evidence;
- volatility derived from candles;
- deterministic scorecards;
- persistence of evidence snapshot and scorecards into `market_assessment_runs`.

#### Optional/unavailable allowed for this slice

- liquidity may remain explicit unavailable if no safe source mapping exists for an identity;
- breadth may remain explicit unavailable until a real cohort implementation is wired.

The important rule is: unavailable must be truthful and structured, not stubbed unconditionally.

### Adapter direction

1. **Candles, orderbook/perp**
   Reuse the existing worker candle-fetching infrastructure already used by scanner/runtime flows. Concretely, wrap the existing `scannerCandleFetcher` / `VenueCandleFetcher` path and do not invent a second candle path.

2. **Regime**
   Compute regime directly from the fetched assessment candle window using the shared regime evaluator. Use the same persisted candle window that the scorecards consume so regime remains identity-correct and reproducible from stored evidence.

3. **Liquidity**
   For orderbook/perp identities, use venue-native normalized orderbook data as the source of truth. Compute:

   - `spreadBps = ((bestAsk - bestBid) / midPrice) * 10_000`
   - `bidDepthUsd = bestBidPrice * bestBidQuantity`
   - `askDepthUsd = bestAskPrice * bestAskQuantity`
   - `averageDepthUsd = (bidDepthUsd + askDepthUsd) / 2`

   Use top-1 level only for the first slice so semantics are consistent across Hyperliquid and Bybit. If either side of book is missing or stale, return structured unavailable.

4. **Breadth**
   Keep explicit unavailable for the first slice. The existing discovery snapshot and market-overview path are not an acceptable breadth cohort.

### Persistence direction

Persist evidence and scorecards into the existing run row before LLM ranking.

At minimum write:

- `evidenceSnapshot`
- `scorecardSnapshots`
- `calculationVersions`
- `evidenceRefs`

Do this in the same assessment execution that created the run intent so later artifact review can replay what the LLM saw.

### Files

| Surface | Change |
|---|---|
| `apps/worker/src/index.ts` | Replace stub evidence port wiring with real adapter construction. |
| `apps/worker/src/market-intelligence/platform-assessor.ts` | Persist evidence snapshots and deterministic scorecards into the run before ranking. |
| optional new adapter modules under `apps/worker/src/market-intelligence/` | Encapsulate regime/candle/liquidity/breadth sources and mapping logic. |

### Tests

- unit tests for each evidence adapter path: available, unavailable, stale, malformed;
- integration test that `assessIdentity()` writes `evidenceSnapshot` and `scorecardSnapshots` into `market_assessment_runs`;
- integration test that a persisted run can be reloaded and its snapshot shape matches the domain schema;
- regression test that unavailable breadth/liquidity remain explicit unavailable rather than fabricated neutral values.

### Completion bar

- worker composition no longer installs unconditional stub evidence ports for supported orderbook/perp identities;
- `PlatformAssessor` persists evidence snapshot and scorecards before LLM ranking;
- a real assessment run produces non-placeholder evidence for the supported identity path.

## Workstream 3: Full `assess_strategy_preset` Success Payload

### Objective

Make the tool return the full success shape already defined in `AssessmentResultEntrySchema`.

### Current gap

- the tool schema expects:
  - `canonicalIdentity`
  - `assessment.artifactId`
  - `assessment.assessedAt`
  - `assessment.expiresAt`
  - `assessment.marketSummary`
  - `assessment.regimeSummary`
  - `assessment.scanHealthSummary`
  - `assessment.rankings`
  - `assessment.recommendedPreset`
  - `assessment.confidence`
  - `assessment.urgency`
- the current port returns only outcome metadata such as `kind`, `requestId`, and `assessmentArtifactId`.
- the tool currently converts success outcomes into only `transitionReference` + `billing`.

### Required contract change

The typed request port must expose enough data for the tool to build the schema-complete response.

### Locked request-port direction

Return the canonical identity and a summarized artifact payload directly from the request port rather than forcing the tool to issue a second DB lookup.

Success outcome shape:

```ts
type AssessmentRequestPortOutcome =
  | {
      kind: 'cache_hit' | 'assessment_completed';
      requestId: string;
      assessmentArtifactId: string;
      canonicalIdentity: MarketAssessmentIdentity;
      artifact: {
        assessedAt: string;
        expiresAt: string;
        currentMarketSummary: string;
        regimeSummary: string;
        scanHealthSummary: string;
        presetRankings: MarketAssessmentPresetRanking[];
        recommendedPreset: string | null;
        confidence: number;
        urgency: 'low' | 'medium' | 'high';
      };
    }
  | ...blocked / failure variants;
```

This keeps the request service authoritative for both fresh-run and cache-hit paths and avoids duplicating artifact mapping logic in the tool.

### Additional required fixes in this slice

1. Stop narrowing `instrumentKind` in the tool to `'orderbook' | 'perp'`.
   The current cast drops `swap` / `dex` support even though the request schema allows them.

2. Return `canonicalIdentity` on success and on any failure where identity resolution already succeeded.

3. Preserve the anti-redundancy rule from `006b`: recommendation facts live inside `assessment`, not in a duplicated top-level recommendation object.

### Files

| Surface | Change |
|---|---|
| `packages/domain/src/ports/assessment-request.ts` | Expand port outcome type to carry canonical identity and summarized artifact payload on success. |
| `apps/worker/src/market-intelligence/assessment-request-service.ts` | Populate the expanded success outcomes from cache-hit and completed-run paths. |
| `apps/worker/src/tools/assess-strategy-preset.ts` | Map the expanded port outcome into the full `AssessmentResultEntrySchema` success shape. |

### Tests

- unit test for tool success entries proving `canonicalIdentity`, `assessment`, `transitionReference`, and `billing` are all present;
- cache-hit and fresh-run tests proving both produce the same response shape;
- response-shape test ensuring no duplicated recommendation object is returned;
- regression test covering `swap` / `dex` request preservation through the tool boundary.

### Completion bar

- `assess_strategy_preset` success entries satisfy the existing domain response schema without leaving `assessment` undefined;
- both `cache_hit` and `assessment_completed` paths return the full assessment payload;
- the tool remains a thin adapter over the request service rather than reimplementing assessment lookup rules.

## Ordered Delivery Steps

1. Replace the empty preset catalog with the real `listPresets()` adapter.
2. Wire real evidence adapters for the first supported identity slice.
3. Persist evidence snapshots and scorecards into `market_assessment_runs` before ranking.
4. Extend the request port success outcome to include canonical identity and artifact summary.
5. Update `assess_strategy_preset` to return the full success payload.
6. Run focused unit/integration validation for all three workstreams together.

## Out Of Scope For This Plan

- DB/provider lease redesign beyond the current same-process join optimization;
- transition restart reconciliation;
- full `entries_and_tighten_existing` behavior;
- final legacy segment-key cleanup.

## Completion Bar

This plan is complete only when all of the following are true:

1. Supported orderbook/perp assessment requests no longer fail because worker startup installed unconditional evidence stubs.
2. The assessor no longer receives an empty preset catalog from the worker composition root.
3. Evidence snapshots and deterministic scorecards are persisted with each successful run before LLM ranking.
4. `assess_strategy_preset` success results contain the full schema-defined `assessment` object and `canonicalIdentity`.
5. Focused tests prove both cache-hit and fresh-run flows return identical success structure.

## Resolved Questions

The previously open questions are resolved by the locked implementation choices above. No additional open questions remain for this plan.
   - keep swap/dex liquidity as a separate concern;
   - if no recent orderbook snapshot exists for the identity, return structured unavailable rather than stale fabricated values.

4. **Breadth for the first shipped slice**

   Keep breadth intentionally unavailable in the first shipped slice.

   Reason:

   - the existing discovery snapshot is provider-merged, ranked, filtered, anti-staleness-adjusted, and capped, so it is not a stable or semantically correct breadth cohort;
   - the current worker `get_market_overview` implementation does not compute real breadth, only asset-context summaries;
   - adding breadth now would risk smuggling heuristic discovery semantics into what should be a tested market-cohort metric.

   Breadth should be added only after a real cohort definition exists for the relevant venue/instrument family and the above-MA style calculation is explicitly tested against that cohort.