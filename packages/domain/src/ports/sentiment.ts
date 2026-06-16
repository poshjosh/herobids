import type { Result, DomainError } from '../result.js';

export interface SentimentResult {
  symbol: string;
  score: number;        // -1 (very bearish) to +1 (very bullish)
  confidence: number;   // 0–1
  source: string;
  fetchedAt: number;    // unix ms
}

export interface SentimentError extends DomainError {
  code: string;
}

/**
 * Port interface for fetching a sentiment score for a given symbol.
 * Returns `null` inside the `Result` when no opinion is available (not an error).
 * Implementations are responsible for circuit-breaking, retries, and caching —
 * those concerns belong in the concrete adapter, not in the port.
 */
export interface SentimentProvider {
  getScore(symbol: string, tokenName?: string): Promise<Result<SentimentResult | null, SentimentError>>;
}
