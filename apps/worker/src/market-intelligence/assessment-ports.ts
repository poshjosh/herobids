import type { RegimeResult, Result } from '@herobids/domain';
import type {
  MarketAssessmentIdentity,
  AssessmentData,
  VolatilityEvidence,
  LiquidityEvidence,
  BreadthEvidence,
  AssessmentUnavailable,
  AssessmentMarketCohort,
} from '@herobids/domain';

// ── CandleInterval ──────────────────────────────────────────────────────────
//
// CandleInterval is not exported from @herobids/market-data or @herobids/domain.
// Defined locally to match the MechanicalParamsSchema candleInterval enum.
// Keep in sync with packages/domain/src/config/schema.ts.

export type CandleInterval = '5m' | '15m' | '1h' | '4h' | '1d';

// ── Assessment Evidence Ports ───────────────────────────────────────────────
//
// PlatformAssessor consumes these small worker-owned ports instead of parsing
// Redis caches or calling venue APIs directly. Each port defines the contract
// between the assessor and a specific data source.
//
// ── Identity Resolution Rules ───────────────────────────────────────────────
//
// Orderbook / perp:
//   Map the venue symbol to the configured orderbook candle and timestamped
//   orderbook-liquidity adapters. The current scanner candle fetcher is
//   orderbook-oriented; do not claim that GeckoTerminal covers these instruments.
//   Unsupported identities return `assessment.evidence_unsupported_identity`.
//
// Swap / dex:
//   Resolve canonical `network + token address` to an unambiguous current pool
//   before fetching GeckoTerminal candles or pool liquidity. A token address is
//   not itself a GeckoTerminal pool address.
//   Unresolved pools return `assessment.evidence_pool_unresolved`; never choose
//   an arbitrary pool.

/**
 * Derived candle evidence sourced over the Traderton read boundary — NEVER raw
 * OHLCV (D1-b re-point). The boundary fetches candles behind itself and returns
 * only derived scalars:
 *   - `volatility`: the derived VolatilityEvidence (absolute-units ATR +
 *     percentile-classified regime, derived Traderton-side from `get_volatility`),
 *     or null when the boundary reports no usable reading.
 *   - `candleWindow`: first/last candle timestamps of the scored series (from
 *     `score_candidate`), or null when zero candles were evaluated.
 *   - `candlesEvaluated`: the count of candles the boundary evaluated.
 *
 * `candlesEvaluated > 0` is the availability signal the assessor keeps as the
 * `symbolCandles` flag (no OHLCV bodies carried).
 */
export interface DerivedCandleEvidence {
  volatility: VolatilityEvidence | null;
  candleWindow: { start: string; end: string } | null;
  candlesEvaluated: number;
}

/**
 * Fetches DERIVED candle evidence for a given assessment identity over the
 * Traderton read boundary (D1-b). Raw candles are fetched behind the boundary
 * and reduced to the derived scalars in {@link DerivedCandleEvidence} — no OHLCV
 * bodies cross the boundary or enter this process.
 *
 * Orderbook/perp identities route to `get_volatility` + `score_candidate`.
 *
 * Unsupported identities → `assessment.evidence_unsupported_identity`
 */
export interface AssessmentCandleSource {
  getCandles(input: {
    identity: MarketAssessmentIdentity;
    interval: CandleInterval;
    minimumCandles: number;
  }): Promise<Result<AssessmentData<DerivedCandleEvidence>>>;
}

/**
 * Fetches liquidity evidence (spread, depth, quality) for a given assessment
 * identity.
 *
 * Orderbook/perp identities route to the timestamped orderbook-liquidity
 * adapter configured for the venue.
 * Swap/dex identities must first resolve `network + token address` to a pool
 * address before fetching pool liquidity.
 *
 * Unsupported identities → `assessment.evidence_unsupported_identity`
 * Unresolved DEX pools → `assessment.evidence_pool_unresolved`
 */
export interface AssessmentLiquiditySource {
  getLiquidity(identity: MarketAssessmentIdentity): Promise<Result<AssessmentData<LiquidityEvidence>>>;
}

/**
 * Fetches market breadth evidence for a given assessment identity and cohort.
 *
 * Returns `AssessmentUnavailable` when breadth data is not configured or the
 * cohort membership cannot be determined.
 *
 * Unsupported identities → `assessment.evidence_unsupported_identity`
 */
export interface AssessmentBreadthSource {
  getBreadth(input: {
    identity: MarketAssessmentIdentity;
    cohort: AssessmentMarketCohort;
  }): Promise<Result<AssessmentData<BreadthEvidence> | AssessmentUnavailable>>;
}

/**
 * Fetches the current market regime (trend, ADX, market structure, VWAP
 * alignment) for a given assessment identity.
 *
 * Unsupported identities → `assessment.evidence_unsupported_identity`
 */
export interface AssessmentRegimeSource {
  getRegime(identity: MarketAssessmentIdentity): Promise<Result<AssessmentData<RegimeResult>>>;
}

/**
 * Aggregated set of evidence ports consumed by PlatformAssessor.
 *
 * The worker composition root resolves each port to the appropriate adapter
 * based on the assessment identity's instrument kind and venue family.
 */
export interface AssessmentEvidencePorts {
  candles: AssessmentCandleSource;
  liquidity: AssessmentLiquiditySource;
  breadth: AssessmentBreadthSource;
  regime: AssessmentRegimeSource;
}
