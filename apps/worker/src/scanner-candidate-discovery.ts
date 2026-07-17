import type { ProviderRegistry } from '@herobids/market-data';
import { resolveBinanceSymbol } from '@herobids/market-data';
import type { DiscoveredInstrument, FilterConfig } from './technical-phase.js';

/**
 * Venue-aware scanner candidate discovery.
 *
 * Discovers orderbook candidates from Hyperliquid asset contexts or Bybit tickers,
 * depending on the agent's active orderbook binding venue. Both paths apply the
 * same filtering, ordering, and capacity bounding contract.
 *
 * NOTE: {@link DiscoveredInstrument.pricingIdentity.symbol} format is venue-specific:
 *   - Hyperliquid: bare base asset (e.g. "BTC")
 *   - Bybit:       full pair ticker (e.g. "BTCUSDT") — required by resolveBybitTarget
 */
export async function discoverScannerCandidates(params: {
  registry: ProviderRegistry;
  filters: FilterConfig;
  bindingVenue: 'hyperliquid' | 'bybit';
  bindingVenueType: 'orderbook';
  maxCandidates: number;
}): Promise<DiscoveredInstrument[]> {
  const { registry, filters, bindingVenue, maxCandidates } = params;

  let results: DiscoveredInstrument[];

  if (bindingVenue === 'bybit') {
    const tickersResult = await registry.bybit.tickers();
    results = tickersResult.data.map((ticker) => {
      // Parse base from pair: BTCUSDT → BTC
      const base = ticker.symbol.replace(/USDT$|USD$|PERP$/i, '') || ticker.symbol;
      return {
        symbol: base,
        instrumentId: ticker.symbol,
        venue: 'bybit' as const,
        venueType: 'orderbook' as const,
        candleTarget: { venueType: 'orderbook' as const, providerSymbol: resolveBinanceSymbol(base) },
        pricingIdentity: { kind: 'perps' as const, symbol: ticker.symbol, chain: 'bybit' as const },
        volume24hUsd: ticker.volume24hUsd ?? undefined,
        priceChange24hPct: ticker.priceChange24hPct ?? undefined,
      };
    });
  } else {
    // Default: Hyperliquid
    const contexts = await registry.hyperliquid.assetContexts();
    results = contexts.data.map((ctx) => ({
      symbol: ctx.asset,
      instrumentId: `${ctx.asset}-PERP`,
      venue: 'hyperliquid' as const,
      venueType: 'orderbook' as const,
      candleTarget: { venueType: 'orderbook' as const, providerSymbol: resolveBinanceSymbol(ctx.asset) },
      pricingIdentity: { kind: 'perps' as const, symbol: ctx.asset, chain: 'hyperliquid' as const },
      volume24hUsd: ctx.volume24hUsd ?? undefined,
      priceChange24hPct: ctx.priceChange24hPct ?? undefined,
    }));
  }

  // Apply filters — extract after guard to narrow TypeScript types without non-null assertions.
  if (filters.minVolume24hUsd != null) {
    const minVolume24hUsd = filters.minVolume24hUsd;
    results = results.filter((r) => (r.volume24hUsd ?? 0) >= minVolume24hUsd);
  }
  if (filters.symbols?.length) {
    const symbols = filters.symbols;
    results = results.filter((r) => symbols.includes(r.symbol));
  }
  if (filters.excludeSymbols?.length) {
    const excludeSymbols = filters.excludeSymbols;
    results = results.filter((r) => !excludeSymbols.includes(r.symbol));
  }

  // Deterministic ordering by volume24hUsd descending before bounding.
  // This ensures reproducible candidate selection when capacity limits apply.
  results.sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));

  // Bound entry candidates to operator-configured max per scan.
  // Open-position exit-evaluation symbols are added downstream in technical-phase.ts,
  // so they are always preserved above this cap.
  if (results.length > maxCandidates) {
    results = results.slice(0, maxCandidates);
  }

  return results;
}
