import type { Result } from '@herobids/domain';
import type {
  MarketAssessmentIdentity,
  AssessmentData,
  LiquidityEvidence,
  BreadthEvidence,
  AssessmentUnavailable,
  AssessmentMarketCohort,
} from '@herobids/domain';
import type { PriceCandle, RegimeResult } from '@herobids/market-data';

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
 * Fetches candles for a given assessment identity.
 *
 * Orderbook/perp identities route to the configured orderbook candle adapter.
 * Swap/dex identities must first resolve `network + token address` to a pool
 * address before fetching.
 *
 * Unsupported identities → `assessment.evidence_unsupported_identity`
 * Unresolved DEX pools → `assessment.evidence_pool_unresolved`
 */
export interface AssessmentCandleSource {
  getCandles(input: {
    identity: MarketAssessmentIdentity;
    interval: CandleInterval;
    minimumCandles: number;
  }): Promise<Result<AssessmentData<ReadonlyArray<PriceCandle>>>>;
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
