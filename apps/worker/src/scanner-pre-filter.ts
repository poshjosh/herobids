import { resolveBinanceSymbol } from '@herobids/market-data';
import type { DiscoveredInstrument } from './technical-phase.js';

/**
 * Result of normalizing orderbook scanner candidates against the configured
 * candle provider (Binance).
 */
export interface NormalizeResult {
  /** Candidates with normalized candle-provider symbols. */
  supported: DiscoveredInstrument[];
  /** Candidates dropped because their candle symbol could not be resolved.
   *  Currently always empty — resolveBinanceSymbol is pure string manipulation
   *  that always returns a string. Actual instrument-level filtering happens
   *  downstream at the HTTP level (classified by classifyCandleError). */
  unsupported: DiscoveredInstrument[];
  /** Count of unsupported candidates (always 0 with current validation). */
  unsupportedCount: number;
}

/**
 * Normalize orderbook scanner candidates before candle fetch.
 *
 * Normalizes each candidate's {@link ScannerCandleTarget.providerSymbol} via
 * {@link resolveBinanceSymbol} to the canonical Binance form. The current
 * implementation does NOT pre-filter against a supported-instrument list —
 * actual unsupported-symbol detection happens at the HTTP level when Binance
 * returns HTTP 400 (tracked via {@link classifyCandleError}).
 *
 * This function is intentionally venue-agnostic: it works for any orderbook
 * venue whose candle target resolves through the same Binance symbol mapping.
 */
export function normalizeOrderbookCandidates(
  candidates: DiscoveredInstrument[],
): NormalizeResult {
  const supported: DiscoveredInstrument[] = [];
  const unsupported: DiscoveredInstrument[] = [];

  for (const candidate of candidates) {
    const resolved = resolveBinanceSymbol(candidate.candleTarget.providerSymbol);
    if (!resolved) {
      unsupported.push(candidate);
      continue;
    }
    // Update the provider symbol to the normalized Binance form.
    supported.push({
      ...candidate,
      candleTarget: {
        ...candidate.candleTarget,
        providerSymbol: resolved,
      },
    });
  }

  return { supported, unsupported, unsupportedCount: unsupported.length };
}
