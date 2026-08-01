import { resolveBinanceSymbol } from '@herobids/market-data';
import type { DiscoveredInstrument } from './technical-phase.js';

/**
 * Result of normalizing scanner candidates against the configured
 * candle provider (Binance for orderbook venues).
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
 * Normalize scanner candidates before candle fetch.
 *
 * Orderbook candidates have their {@link ScannerCandleTarget.providerSymbol}
 * normalized via {@link resolveBinanceSymbol} to the canonical Binance form.
 * Swap candidates pass through unchanged — they use network + pool address
 * identity and do not go through Binance symbol resolution.
 *
 * The current implementation does NOT pre-filter against a supported-instrument
 * list — actual unsupported-symbol detection happens at the HTTP level when
 * Binance returns HTTP 400 (tracked via {@link classifyCandleError}).
 */
export function normalizeScannerCandidates(
  candidates: DiscoveredInstrument[],
): NormalizeResult {
  const supported: DiscoveredInstrument[] = [];
  const unsupported: DiscoveredInstrument[] = [];

  for (const candidate of candidates) {
    // Swap candidates do not go through Binance symbol resolution — pass through unchanged.
    if (candidate.candleTarget.venueType !== 'orderbook') {
      supported.push(candidate);
      continue;
    }

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
        venueType: 'orderbook' as const,
        providerSymbol: resolved,
      },
    });
  }

  return { supported, unsupported, unsupportedCount: unsupported.length };
}
