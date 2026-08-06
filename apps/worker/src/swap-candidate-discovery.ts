/**
 * Swap scanner candidate discovery — extracted from buildDiscoverCandidates for testability.
 *
 * Discovers swap candidates from the token discovery registry, filters by pool
 * coherence, quote asset matching, canonical address cross-validation, and
 * deduplication. Applies operator-configured post-filters (volume, symbols,
 * liquidity) and caps to maxCandidates.
 */

import type { DiscoveredInstrument, FilterConfig } from './technical-phase.js';

// ─── Minimal registry interface (testable without full ProviderRegistry) ──────

export interface SwapDiscoveryPort {
  discover(params: {
    networks: string[];
    maxResults: number;
    minLiquidityUsd: number;
  }): Promise<{ data: SwapDiscoveryToken[] }>;
}

export interface SwapDiscoveryToken {
  symbol: string;
  network: string;
  address: string;
  volume24hUsd: number;
  liquidityUsd: number;
  priceChange24hPct?: number;
  pool?: {
    network: string;
    poolAddress: string;
    baseToken: {
      symbol: string;
      address: string;
    };
    quoteToken: {
      symbol: string;
      address: string;
    };
  };
}

export interface SwapDiscoveryLogger {
  info: (obj: Record<string, unknown> | string, msg?: string) => void;
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  error: (obj: Record<string, unknown> | string, msg?: string) => void;
  debug: (obj: Record<string, unknown> | string, msg?: string) => void;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface DiscoverSwapScannerCandidatesParams {
  discovery: SwapDiscoveryPort;
  venue: 'jupiter' | '1inch';
  swapNetwork: string;
  quoteAssetSymbol: string;
  quoteAssetAddress?: string;
  filters: FilterConfig;
  maxCandidates: number;
  logger: SwapDiscoveryLogger;
}

/**
 * Discover and filter swap scanner candidates from the token discovery registry.
 *
 * Pipeline:
 *  1. Discover tokens from the registry (empty / error → return [])
 *  2. Filter to pool-backed tokens
 *  3. Filter by quote asset symbol
 *  4. Validate pool coherence + canonical quote, deduplicate by network:poolAddress
 *  5. Apply post-filters (minVolume24hUsd, symbols, excludeSymbols, minLiquidityUsd)
 *  6. Sort by volume descending, cap to maxCandidates
 */
export async function discoverSwapScannerCandidates(
  params: DiscoverSwapScannerCandidatesParams,
): Promise<DiscoveredInstrument[]> {
  const { discovery, venue, swapNetwork, quoteAssetSymbol, quoteAssetAddress, filters, maxCandidates, logger } =
    params;

  const minLiquidityUsd = filters.minLiquidityUsd ?? 0;

  // 1. Discover
  let discoveredTokens: SwapDiscoveryToken[];
  try {
    const discoveryResult = await discovery.discover({
      networks: [swapNetwork],
      maxResults: maxCandidates,
      minLiquidityUsd,
    });
    discoveredTokens = discoveryResult.data;

    if (discoveredTokens.length === 0) {
      logger.info(
        {
          venue,
          network: swapNetwork,
          event: 'scanner.swap_discovery_empty',
          message:
            'No tokens in discovery result — possible provider supply failure (rate limits, timeouts) or no qualifying tokens on this network',
        },
        'Swap scanner discovery returned no tokens',
      );
      return [];
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, venue, network: swapNetwork, event: 'scanner.swap_discovery_error' },
      `Swap scanner discovery failed: ${msg}`,
    );
    return [];
  }

  // 2. Filter to tokens with atomic pool identity
  const poolBackedTokens = discoveredTokens.filter((t) => t.pool);

  // 3. Filter by quote asset symbol
  const quoteFiltered = poolBackedTokens.filter((t) => {
    const pool = t.pool!;
    const matches = pool.quoteToken.symbol.toUpperCase() === quoteAssetSymbol.toUpperCase();
    if (!matches) {
      logger.debug(
        { token: t.symbol, poolQuote: pool.quoteToken.symbol, expected: quoteAssetSymbol },
        'Swap candidate skipped — non-matching quote asset',
      );
    }
    return matches;
  });

  // 4. Validate pool coherence + canonical quote, deduplicate by network:poolAddress
  const swapCandidates: DiscoveredInstrument[] = [];
  const skipped = new Set<string>();

  for (const token of quoteFiltered) {
    const pool = token.pool!;
    const poolKey = `${pool.network}:${pool.poolAddress}`;

    // Deduplicate by network:poolAddress
    if (skipped.has(poolKey)) continue;

    const reasons: string[] = [];

    if (!pool.baseToken?.address) reasons.push('missing_base_address');
    if (!pool.quoteToken?.address) reasons.push('missing_quote_address');
    if (!pool.poolAddress) reasons.push('missing_pool_address');

    // Validate quote address is canonical (cross-check with the resolved address)
    if (
      quoteAssetAddress &&
      pool.quoteToken.address &&
      pool.quoteToken.address.toLowerCase() !== quoteAssetAddress.toLowerCase()
    ) {
      reasons.push('non_canonical_quote');
    }

    // Incoherent pool: network mismatch
    if (pool.network.toLowerCase() !== swapNetwork.toLowerCase()) {
      reasons.push('incoherent_pool');
    }

    if (reasons.length > 0) {
      logger.warn(
        {
          venue,
          token: token.symbol,
          poolAddress: pool.poolAddress,
          network: pool.network,
          reasons,
          event: 'scanner.swap_candidate_skipped',
        },
        `Swap candidate skipped — ${reasons.join(', ')}`,
      );
      continue;
    }

    const baseSymbol = token.symbol;
    const baseAddress = pool.baseToken.address;
    const quoteAddress = pool.quoteToken.address;
    const instrumentId = `${baseSymbol}:${baseAddress}/${quoteAssetSymbol}:${quoteAddress}`;

    swapCandidates.push({
      symbol: baseSymbol,
      instrumentId,
      venue,
      venueType: 'swap',
      candleTarget: {
        venueType: 'swap',
        network: pool.network,
        poolAddress: pool.poolAddress,
      },
      pricingIdentity: {
        kind: 'dex',
        symbol: token.symbol,
        chain: pool.network,
        address: baseAddress,
      },
      swapExecutionIdentity: {
        network: pool.network,
        baseSymbol,
        baseAddress,
        quoteSymbol: quoteAssetSymbol,
        quoteAddress,
      },
      volume24hUsd: token.volume24hUsd > 0 ? token.volume24hUsd : undefined,
      liquidityUsd: token.liquidityUsd > 0 ? token.liquidityUsd : undefined,
      priceChange24hPct:
        token.priceChange24hPct && token.priceChange24hPct !== 0 ? token.priceChange24hPct : undefined,
    });

    skipped.add(poolKey);
  }

  // 5. Apply post-filters (minVolume24hUsd, symbols allowlist, excludeSymbols, minLiquidityUsd)
  let filtered = swapCandidates;
  if (filters.minVolume24hUsd != null) {
    const minVol = filters.minVolume24hUsd;
    filtered = filtered.filter((c) => (c.volume24hUsd ?? 0) >= minVol);
  }
  if (filters.symbols?.length) {
    const symbols = filters.symbols;
    filtered = filtered.filter((c) => symbols.includes(c.symbol));
  }
  if (filters.excludeSymbols?.length) {
    const excludeSymbols = filters.excludeSymbols;
    filtered = filtered.filter((c) => !excludeSymbols.includes(c.symbol));
  }
  if (filters.minLiquidityUsd != null) {
    const minLiq = filters.minLiquidityUsd;
    filtered = filtered.filter((c) => (c.liquidityUsd ?? 0) >= minLiq);
  }

  // 6. Sort by volume descending, cap to maxCandidates
  filtered.sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
  if (filtered.length > maxCandidates) {
    filtered = filtered.slice(0, maxCandidates);
  }

  return filtered;
}
