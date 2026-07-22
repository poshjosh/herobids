import type { Result, DomainError } from '../result.js';
import type { Price } from '../values/money.js';

export interface MarkError extends DomainError {
  code: string;
}

export interface Mark {
  price: Price;
  source: 'last_fill' | 'oracle' | 'ticker' | 'hyperliquid_mid';
  instrument: string;
  timestamp: string;
  /** True when the mark is a stale fallback (e.g. old fill when oracle is unavailable). Callers with a fresher price source should prefer their own. */
  stale?: boolean;
}

/**
 * Port interface for fetching a canonical mark price.
 * Used for P&L, risk checks, and reconciliation.
 * Implementations: LastFillMarkSource, OracleMarkSource, TickerMarkSource.
 */
export interface MarkSource {
  fetchMark(instrument: string): Promise<Result<Mark, MarkError>>;
}
