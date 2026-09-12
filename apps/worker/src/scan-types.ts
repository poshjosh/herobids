// Scan DTO field-types consumed by the LIVE technical-scan surface.
//
// B1 (dead-scan-pipeline deletion): these types were defined in the now-deleted
// `technical-phase.ts` (the in-process scan producer, removed with the L3d-5
// actor slice). They are RELOCATED here because they remain part of the LIVE
// `TechnicalScanState` DTO (runtime-composition.ts), which herobids still
// consumes from the `agent.technical.scan_completed` boundary message that
// Traderton now produces. Types only — no trading behaviour. Mirrors the
// Traderton-side `scan-types.ts`.

/** Classification of a single candle-fetch attempt in the technical scan. */
export type CandleFetchStatus =
  | 'eligible_fetched'
  | 'eligible_empty'
  | 'unsupported'
  | 'transient_failure'
  | 'skipped_breaker_open';

/** Structured per-symbol fetch outcome carried on TechnicalScanState for scanner-health observability. */
export interface SymbolFetchOutcome {
  symbol: string;
  /** Exact instrument ID this outcome corresponds to. */
  instrumentId: string;
  /** For orderbook targets, the provider symbol used for candle fetching. Undefined for swap targets. */
  resolvedProviderSymbol?: string;
  status: CandleFetchStatus;
  candleCount?: number;
  errorDetail?: string;
}

/** A per-position indicator update carried on TechnicalScanState. */
export interface PositionIndicatorUpdate {
  symbol: string;
  side: 'long' | 'flat';
  /** Venue-specific instrument identifier for this position. Falls back to symbol when unavailable. */
  instrumentId?: string;
  entryPrice?: number;
  currentPrice?: number;
  unrealizedPnlPct?: number;
  rsi?: number;
  signalNote?: string;
  /** Set to true when the scanner found this position should exit but advisory mode held back the direct submission. */
  exitAdvisory?: boolean;
}
