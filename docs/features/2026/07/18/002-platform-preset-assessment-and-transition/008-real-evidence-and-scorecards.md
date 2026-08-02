# Implementation Plan: Evidence Contracts And Deterministic Preset Scorecards

**Status:** Done - rewritten after implementation review
**Depends on:** [005-implementation-checklist-per-symbol-on-demand.md](./005-implementation-checklist-per-symbol-on-demand.md)
**Unblocks:** [009-llm-preset-ranking.md](./009-llm-preset-ranking.md)
**Purpose:** Replace placeholder evidence and zero scorecards with auditable market evidence and deterministic dry-runs over one canonical assessment identity.

## Authoritative Plan

This section supersedes the archived draft below. Implement only this section.

### Scope And Boundaries

This plan implements the non-LLM portion of `PlatformAssessor`.

- A per-symbol artifact is shared by eligible agents, so its evidence and scorecards may depend only on canonical identity, resolved operator policy, the preset catalog, and assessment-time market data.
- Agent scan metrics, PnL, positions, capital, active preset, and transition policy are actor-local inputs. They must not influence shared artifact ranking.
- A scorecard is an actual dry-run of every candidate preset against the same immutable market-data window. It is neither a synthetic score nor a projection from aggregate `agent_scan_metrics`.
- Missing required evidence returns a structured failure before the LLM/provider call. Optional unavailable evidence is explicit and never represented as `0`, `normal`, or `adequate`.
- Billing and request settlement remain owned by [007-assessment-billing-completion-plan.md](./007-assessment-billing-completion-plan.md).

### Versioned Evidence Snapshot

Replace the all-numeric `EvidencePackage` with a versioned, persisted snapshot. Each metric must encode availability and provenance:

```ts
type EvidenceValue<T> =
  | {
      state: 'available';
      value: T;
      source: string;
      observedAt: string;
      expiresAt: string;
    }
  | {
      state: 'unavailable';
      reasonCode: string;
      message: string;
      observedAt: string;
    };

interface AssessmentEvidenceSnapshot {
  schemaVersion: 1;
  identity: MarketAssessmentIdentity;
  collectedAt: string;
  regime: EvidenceValue<RegimeResult>;
  symbolCandles: EvidenceValue<ReadonlyArray<PriceCandle>>;
  volatility: EvidenceValue<VolatilityEvidence>;
  liquidity: EvidenceValue<LiquidityEvidence>;
  breadth: EvidenceValue<BreadthEvidence>;
  scorecardInput: EvidenceValue<ScorecardInput>;
}
```

Persist the immutable snapshot, calculation versions, source timestamps, and source identifiers with `market_assessment_runs`, either as typed `evidence_snapshot` columns or in a first-class immutable evidence table. `evidenceRefs` alone is insufficient for replay and audit.

Regime, the required preset candle windows, and scorecard inputs are mandatory in phase 1. Liquidity is mandatory only for venue policies that require it. Breadth is optional until an explicit market cohort exists. The snapshot and later prompt must distinguish unavailable inputs from negative evidence.

### Explicit Market-Data Ports

`PlatformAssessor` must consume small worker-owned ports. It must not parse Redis caches or call venue APIs itself.

```ts
interface AssessmentCandleSource {
  getCandles(input: {
    identity: MarketAssessmentIdentity;
    interval: CandleInterval;
    minimumCandles: number;
  }): Promise<Result<AssessmentData<ReadonlyArray<PriceCandle>>>>;
}

interface AssessmentLiquiditySource {
  getLiquidity(identity: MarketAssessmentIdentity): Promise<Result<AssessmentData<LiquidityEvidence>>>;
}

interface AssessmentBreadthSource {
  getBreadth(input: {
    identity: MarketAssessmentIdentity;
    cohort: AssessmentMarketCohort;
  }): Promise<Result<AssessmentData<BreadthEvidence> | AssessmentUnavailable>>;
}

interface AssessmentRegimeSource {
  getRegime(identity: MarketAssessmentIdentity): Promise<Result<AssessmentData<RegimeResult>>>;
}
```

`AssessmentData` contains source, normalized provider identity, observed time, and expiry. Provider, malformed-response, rate-limit, stale-data, and unsupported-identity failures must keep distinct error codes.

The worker composition root resolves each canonical identity before provider work:

| Identity family | Required resolution | Failure behavior |
|---|---|---|
| Orderbook / perp | Map the venue symbol to the configured orderbook candle and timestamped orderbook-liquidity adapters. The current scanner candle fetcher is orderbook-oriented; do not claim that GeckoTerminal covers these instruments. | Return `assessment.evidence_unsupported_identity` until an explicit source mapping exists. |
| Swap / dex | Resolve canonical `network + token address` to an unambiguous current pool before fetching GeckoTerminal candles or pool liquidity. A token address is not itself a GeckoTerminal pool address. | Return `assessment.evidence_pool_unresolved`; never choose an arbitrary pool. |

The discovery cache may assist DEX pool resolution when fresh. It is not a generic candle cache, orderbook depth source, or orderbook universe.

### Evidence Calculations And Configuration

- Calculate ATR and volatility from persisted assessment candles. Use configured lookbacks and percentile boundaries; persist formula/calculation version, interval, candle count, and evaluated window.
- Classify liquidity only from timestamped spread/depth inputs and configured threshold versions. Unavailable data stays unavailable.
- Calculate breadth only from an explicit `AssessmentMarketCohort`: venue family, instrument kind, normalized symbol universe, lookback, membership timestamp, and moving-average policy. A style tier is not a market cohort. Until a valid cohort source exists, breadth is optional and unavailable.
- Read a benchmark regime snapshot only when fresh and explicitly applicable to the identity. Otherwise use the configured identity/cohort implementation or return unavailable.

Extend resolved `platformAssessor` config with source mappings, maximum ages, timeouts, candle policies, ATR/volatility policies, liquidity policies, optional breadth cohort policy, and evidence payload limits. All defaults belong in `PlatformAssessorConfigSchema` and `config/default.yaml`; runtime data failures return `Result` values.

### Headless Deterministic Scorecard Runner

Create a side-effect-free `PresetScorecardRunner` that reuses validated technical-strategy primitives but never instantiates `AgentTradingActor`, writes scan metrics, creates wakes, submits decisions, or mutates account state.

For every catalog preset in the identity style tier:

1. Load it with `listPresets(styleTier)` and derive its version with `computePresetBehaviorVersion(preset)`.
2. Apply deterministic venue/instrument eligibility. Persist an explicit ineligible outcome rather than inventing a score.
3. Select the exact saved candle window required by the preset. Fetch any bounded additional window before evidence persistence if the initial window cannot satisfy all configured preset intervals.
4. Run the actual signal/scoring primitives and persist input range, indicator outcomes, candidate/score/signal counts, top confidence, and calculation version.
5. Mark every scorecard with `evaluationScope: 'single_symbol_dry_run'` or an equivalent versioned scope so its counters cannot be confused with aggregate agent scan metrics.

Do not query `agent_scan_metrics` to construct a shared scorecard. Preserve it for later actor-local analytics and recommendation work.

### Assessor Control Flow

1. Resolve supported provider policy for the identity.
2. Collect evidence through ports and return a structured error if a required item is unavailable or stale.
3. Persist immutable evidence before LLM work.
4. Generate and persist deterministic scorecards.
5. Pass the complete snapshot and scorecards to the LLM ranker in `009`.

`collectEvidence()` and `generateScorecards()` return `Result`; remove `PLACEHOLDER_REGIME` and all placeholder data. Use stable errors such as `assessment.evidence_unavailable`, `assessment.evidence_stale`, and `assessment.scorecard_failed` so `007` can settle the request correctly.

### Required Changes And Tests

| Surface | Change |
|---|---|
| `apps/worker/src/market-intelligence/platform-assessor.ts` | Replace placeholders with port-driven evidence collection and scorecard orchestration. |
| New evidence and scorecard modules | Define ports, adapters, calculations, and deterministic fixtures. |
| `packages/domain/src/market-assessment.ts` | Add versioned evidence/scorecard schemas and stable availability/error types. |
| DB schema | Persist immutable evidence snapshot/version and scorecard provenance. |
| Config schema and YAML | Add typed evidence policy and source mappings. |

Unit tests must cover supported and unsupported identity routing; stale, malformed, rate-limited, and unavailable evidence; configured calculations; behavior-version derivation; and a proof that the runner has no actor, trade, wake, or DB-write side effects. Integration tests must persist and reload one evidence snapshot, reproduce scorecards from it, and prove a second requesting agent cannot influence the shared result.

This plan is complete only when `PlatformAssessor` produces no placeholder evidence/scorecards and [006-followup-plan.md](./006-followup-plan.md) C1 has executable proof.

## Archived Draft - Do Not Implement

---

## 0. Scope

This plan covers the **deterministic** (non-LLM) intelligence layer of the platform assessor. It replaces the current zero-filled placeholders in `collectEvidence()` and `generateScorecards()` with data drawn from the worker's existing market-data infrastructure (Redis caches, venue APIs, scanner metrics, agent scan metrics table).

LLM ranking / narrative generation is covered by [009-llm-preset-ranking.md](./009-llm-preset-ranking.md).

Billing is out of scope (covered by [007-assessment-billing-completion-plan.md](./007-assessment-billing-completion-plan.md)).

---

## 1. Current State (what's broken)

### `collectEvidence(identity)` — `platform-assessor.ts`

Returns a fully hardcoded `EvidencePackage` — every field except `regime` is zero or a sentinel string:

```ts
return {
  identity,
  collectedAt: new Date().toISOString(),
  regime,                             // ← real (from getRegimeSnapshot), but with PLACEHOLDER_REGIME fallback
  breadth: {
    symbolsAboveMA: 0,               // ← placeholder
    totalSymbols: 0,                 // ← placeholder
    breadthRatio: 0,                 // ← placeholder
  },
  volatility: {
    averageTrueRange: 0,             // ← placeholder
    volatilityRegime: 'normal',       // ← placeholder
  },
  liquidityQuality: {
    averageSpreadBps: 0,             // ← placeholder
    averageDepthUsd: 0,              // ← placeholder
    quality: 'adequate',             // ← placeholder
  },
  scanHealth: {
    candidatesDiscovered: 0,         // ← placeholder
    candidatesScored: 0,             // ← placeholder
    signalsGenerated: 0,             // ← placeholder
    health: 'stale',                 // ← placeholder
  },
};
```

### `generateScorecards(identity, evidence, presetKeys)` — `platform-assessor.ts`

Returns per-preset entries where every metric is zero:

```ts
return presetKeys.map((presetKey) => ({
  presetKey,
  presetBehaviorVersion: '000000000000', // ← placeholder
  candidatesDiscovered: 0,              // ← placeholder
  candidatesScored: 0,                  // ← placeholder
  signalsGenerated: 0,                  // ← placeholder
  topConfidence: null,                  // ← placeholder
  scanHealth: 'stale',                  // ← placeholder
}));
```

---

## 2. What Needs to Change

### 2.1 Breadth Evidence

**Source:** Redis discovery cache (`market-intel:discovery:latest`) or venue instrument cache.

**Logic:**
- For the given identity (venueFamily, styleTier):
  - Fetch the latest discovery snapshot from Redis (`market-intel:discovery:latest`)
  - Filter tokens/instruments matching the venue family and style tier
  - For each instrument, check whether its current price is above a moving average (e.g. 50-period or 200-period SMA)
  - Compute `breadthRatio = symbolsAboveMA / totalSymbols`
- If Redis data is stale or unavailable, return a structured `unavailable` sentinel with a clear reason — do NOT silently fall back to zeros.

**Resolved:** Use GeckoTerminal OHLCV candles as the primary data source. The coordinator already polls GeckoTerminal for regime data; extend the benchmark symbol set to include the assessed symbol. Compute SMA (e.g. 50-period) from the cached candle data in Redis. If GeckoTerminal doesn't cover the symbol, fall back to the venue's mark price via `VenueInstrumentCache` — but log `breadth.unavailable` since a single-point price lacks a moving average.

### 2.2 Volatility Evidence

**Source:** Redis regime cache (`market-intel:regime:latest` or similar) or venue candle data.

**Logic:**
- For the given identity's symbol:
  - Compute ATR (Average True Range) from recent candles (venue-specific or from market-data cache)
  - Classify `volatilityRegime` based on ATR percentile vs. recent history:
    - `low` — ATR below 25th percentile of last 30 periods
    - `normal` — ATR between 25th and 75th percentile
    - `high` — ATR between 75th and 95th percentile
    - `extreme` — ATR above 95th percentile
- If ATR data is unavailable, fall back to `normal` with an explicit `unavailable` reason logged.

**Resolved:** Use the same GeckoTerminal OHLCV pipeline as breadth (§2.1). ATR is computed from the same candle data — two metrics, one data pipeline. For symbols GeckoTerminal doesn't cover, fall back to venue-specific candle APIs (Hyperliquid `candleSnapshot`, Bybit `getKline`) via the existing `VenueCandleFetcher` in `packages/venues/`. Percentile boundaries for volatility regime classification (`low`/`normal`/`high`/`extreme`) must come from config, not hardcoded constants.

### 2.3 Liquidity Quality Evidence

**Source:** Redis discovery cache (`market-intel:discovery:latest`) or venue instrument cache.

**Logic:**
- For the given identity's symbol:
  - Look up `averageSpreadBps` from venue data (spread = ask − bid, in basis points)
  - Look up `averageDepthUsd` from venue orderbook depth data
  - Classify `quality`:
    - `good` — spread ≤ 5 bps AND depth ≥ $50,000
    - `adequate` — spread ≤ 25 bps AND depth ≥ $10,000
    - `poor` — anything worse
  - Thresholds must come from config, not hardcoded constants.
- For swap/dex instruments, spread can be inferred from pool liquidity depth; use dexscreener data from Redis cache.
- If liquidity data is unavailable, return `adequate` with `unavailable` reason logged.

### 2.4 Scan Health Evidence

**Source:** `agent_scan_metrics` database table (existing).

**Logic:**
- Query the most recent scan metrics for the agent + identity's style tier
- Extract `candidatesDiscovered`, `candidatesScored`, `signalsGenerated`
- Compute `health`:
  - `healthy` — signalsGenerated > 0 AND candidatesScored >= some minimum (config-driven)
  - `degraded` — signalsGenerated > 0 but below threshold
  - `no_signal` — signalsGenerated === 0 AND candidatesScored > 0
  - `stale` — no scan metrics in the last scan window

**Resolved:** Aggregate per (agentId, styleTier) for Phase 1. The `agent_scan_metrics` table is already scoped this way. Scan health is a **coarse health signal** that tells the LLM "scanners are working well for this tier" vs. "scanners are struggling." Per-symbol granularity would require new scanner instrumentation and is not needed for preset ranking decisions. This can be revisited if operators report aggregate scan health isn't actionable enough.

### 2.5 Per-Preset Scorecard Generation

**Source:** `agent_scan_metrics` database table (existing) + preset catalog.

**Logic:**
For each preset key in the given style tier:
- Query `agent_scan_metrics` for the most recent row matching `(agentId, presetKey)` within the freshness window
- Read `presetBehaviorVersion` from the preset catalog (via deps.getPresetKeys or a new catalog lookup)
- Populate `candidatesDiscovered`, `candidatesScored`, `signalsGenerated`, `topConfidence` from the metrics row
- If no recent metrics exist for a preset, set `scanHealth = 'stale'` and leave metrics at 0 (this is valid — not every preset is constantly scanned)
- **IMPORTANT:** Scorecards reflect actual observed scan performance per preset. Do not invent synthetic scores. If data is stale or missing, that IS the signal — the LLM sees "this preset has been stale for X hours."

### 2.6 PLACEHOLDER_REGIME Fallback

The current `collectEvidence` catches regime failures and falls back to a hardcoded `PLACEHOLDER_REGIME` constant. This is dangerous — it could feed fake bullish signals into the LLM.

**Change:** If regime snapshot fails, return a structured error from `assessIdentity()` instead of proceeding with placeholder data. The assessment either has real evidence or it fails cleanly.

---

## 3. Files Changed

| File | Change |
|------|--------|
| `apps/worker/src/market-intelligence/platform-assessor.ts` | Rewrite `collectEvidence()` and `generateScorecards()`. Remove `PLACEHOLDER_REGIME`. Add config-driven thresholds for liquidity quality classification. |
| `apps/worker/src/market-intelligence/platform-assessor.test.ts` | Add tests for real evidence collection with mocked deps (Redis, DB, regime). Add tests for scorecard generation with real scan metrics. Remove tests that assert placeholder values. |
| `packages/domain/src/config/schema.ts` | Add liquidity quality threshold fields to `PlatformAssessorConfigSchema` (optional, with sensible defaults). |
| `config/default.yaml` | Add `liquidityQuality` thresholds under `platformAssessor`. |

---

## 4. Dependencies

- The existing market-data coordinator must be running (Redis caches populated).
- `agent_scan_metrics` table must have data (scanner must be running for the agent).
- No dependency on LLM integration (Plan 009).
- No dependency on billing (Plan 007).

---

## 5. Test Strategy

- **Unit tests:** Mock `deps.getRegimeSnapshot()`, Redis `get()`, and DB queries. Assert evidence struct has real values from mocks.
- **Unit tests:** Assert that when Redis/DB data is unavailable, evidence reports `unavailable` reason rather than silent zeros.
- **Unit tests:** Verify `generateScorecards()` reads from `agent_scan_metrics` and maps correctly.
- **Integration tests:** Run against a real DB with seeded scan metrics. Verify scorecards reflect seeded data.
- **No visual/browser testing needed.**

---

## 6. Completion Bar

- `collectEvidence()` returns real values (not zeros) for breadth, volatility, liquidity, scan health when data is available.
- `collectEvidence()` returns explicit `unavailable` sentinels (never silent zeros) when data is unavailable.
- `generateScorecards()` returns per-preset entries derived from `agent_scan_metrics`, not hardcoded zeros.
- `PLACEHOLDER_REGIME` constant is removed.
- `pnpm lint` and `pnpm build` pass.
- Tests pass and cover both available-data and unavailable-data paths.

---

## 7. Resolved Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Breadth data source: GeckoTerminal OHLCV** | Reuses existing coordinator pipeline. Extend benchmark symbol set to cover the assessed symbol. Fall back to venue mark price (log `breadth.unavailable`) if unsupported. |
| 2 | **Volatility data source: same GeckoTerminal pipeline as breadth** | One data pipeline for both metrics. Fall back to venue-specific candle APIs (`VenueCandleFetcher`) for unsupported symbols. |
| 3 | **Scan health granularity: aggregate per (agentId, styleTier)** | Already available in `agent_scan_metrics`. Per-symbol would require new scanner instrumentation — not needed for Phase 1 ranking decisions. |
