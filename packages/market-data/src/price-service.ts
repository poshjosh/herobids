/**
 * Price service abstraction.
 *
 * Provides a single, consistent interface for non-execution price lookups:
 * valuation, watch threshold checks, and discovery enrichment.
 *
 * Source priority:
 *   1. execution  — venue mark price (Hyperliquid asset context)
 *   2. oracle     — DEX aggregator price (DexScreener)
 *   3. cached     — last known price, marked stale
 *
 * This is deliberately NOT used for actual trade sizing or swap execution.
 * Those flows continue to use venue mark or the latest executable quote.
 */

import type { ProviderRegistry } from './provider-registry.js';

const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type PriceSource = 'execution' | 'oracle' | 'cached';

export interface PriceLookupResult {
  priceUsd: number;
  source: PriceSource;
  fetchedAt: string;
  stale: boolean;
}

export interface PriceLookupError {
  code: string;
  message: string;
}

export type PriceResult =
  | { ok: true; data: PriceLookupResult }
  | { ok: false; error: PriceLookupError };

export interface PriceService {
  getPrice(symbol: string, chain: string, address?: string): Promise<PriceResult>;
}

// ---------------------------------------------------------------------------
// Hyperliquid execution-price source (perps)
// ---------------------------------------------------------------------------

async function fetchHyperliquidPrice(
  registry: ProviderRegistry,
  symbol: string,
): Promise<PriceResult> {
  try {
    const result = await registry.hyperliquid.assetContexts();
    const normalized = symbol.toUpperCase().replace(/-PERP$/i, '').replace(/USDT$/i, '');
    const asset = result.data.find(
      (a) => a.asset.toUpperCase() === normalized,
    );
    if (!asset || asset.markPrice === null) {
      return {
        ok: false,
        error: { code: 'price.not_found', message: `${symbol} not found on Hyperliquid` },
      };
    }
    return {
      ok: true,
      data: {
        priceUsd: asset.markPrice,
        source: 'execution',
        fetchedAt: result.meta.freshness.fetchedAt,
        stale: result.meta.freshness.isStale,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'price.source_failed',
        message: err instanceof Error ? err.message : 'Hyperliquid fetch failed',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// DexScreener oracle-price source (spot / DEX tokens)
// ---------------------------------------------------------------------------

async function fetchDexScreenerPrice(
  registry: ProviderRegistry,
  symbol: string,
  chain: string,
  address?: string,
): Promise<PriceResult> {
  try {
    const result = await registry.dexscreener.search(symbol);
    const chainLower = chain.toLowerCase();
    let candidates = chainLower === 'any'
      ? result.data
      : result.data.filter((t) => t.network.toLowerCase() === chainLower);

    // If an address is provided, prefer the exact match to avoid repricing
    // with a different token that happens to share the same symbol.
    if (address) {
      const normalizedAddress = normalizeAssetIdentity(address, chainLower);
      const exact = candidates.filter(
        (t) => normalizeAssetIdentity(t.address, t.network) === normalizedAddress,
      );
      if (exact.length === 0) {
        return {
          ok: false,
          error: {
            code: 'price.not_found',
            message: `${symbol} not found via DexScreener${chainLower !== 'any' ? ` on ${chain}` : ''}`,
          },
        };
      }
      candidates = exact;
    }

    // Prefer the highest-liquidity token to reduce noise.
    const best = [...candidates].sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
    if (!best || best.priceUsd === 0) {
      return {
        ok: false,
        error: { code: 'price.not_found', message: `${symbol} not found via DexScreener${chainLower !== 'any' ? ` on ${chain}` : ''}` },
      };
    }
    return {
      ok: true,
      data: {
        priceUsd: best.priceUsd,
        source: 'oracle',
        fetchedAt: result.meta.freshness.fetchedAt,
        stale: result.meta.freshness.isStale,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'price.source_failed',
        message: err instanceof Error ? err.message : 'DexScreener fetch failed',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Composite price service — source selection + stale-cache fallback
// ---------------------------------------------------------------------------

/** Maximum age (ms) of a cached price entry before it is considered expired. */
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * In-memory last-known-price cache.
 * Keyed by `${chain}:${symbol.toUpperCase()}`.
 */
const priceCache = new Map<string, { priceUsd: number; fetchedAt: string; cachedAtMs: number }>();

function normalizeAssetIdentity(identity: string, chain: string): string {
  const chainLower = chain.toLowerCase();
  if (EVM_ADDRESS_REGEX.test(identity)) {
    return identity.toLowerCase();
  }
  if (chainLower === 'solana' && SOLANA_ADDRESS_REGEX.test(identity)) {
    return identity;
  }
  return identity.toUpperCase();
}

function cacheKey(symbol: string, chain: string, address?: string): string {
  const chainLower = chain.toLowerCase();
  const identity = address
    ? `address:${normalizeAssetIdentity(address, chainLower)}`
    : `symbol:${normalizeAssetIdentity(symbol, chainLower)}`;
  return `${chainLower}:${identity}`;
}

/**
 * CompositePriceService selects sources by chain:
 *   - "hyperliquid": execution → oracle → cached
 *   - all others:    oracle → cached
 *
 * Results are cached in memory so failed live lookups can fall back to stale data.
 */
export function createPriceService(registry: ProviderRegistry): PriceService {
  async function getPrice(symbol: string, chain: string, address?: string): Promise<PriceResult> {
    const key = cacheKey(symbol, chain, address);
    const chainLower = chain.toLowerCase();
    let lastError: PriceLookupError | null = null;

    // Source order: execution (perps only) → oracle → cached
    const sources: Array<() => Promise<PriceResult>> = [];

    if (chainLower === 'hyperliquid') {
      sources.push(() => fetchHyperliquidPrice(registry, symbol));
      // DexScreener has no 'hyperliquid' network — use 'any' as the oracle fallback.
      sources.push(() => fetchDexScreenerPrice(registry, symbol, 'any', address));
    } else {
      sources.push(() => fetchDexScreenerPrice(registry, symbol, chain, address));
    }

    for (const source of sources) {
      const result = await source();
      if (result.ok) {
        priceCache.set(key, { priceUsd: result.data.priceUsd, fetchedAt: result.data.fetchedAt, cachedAtMs: Date.now() });
        return result;
      }
      lastError = result.error;
    }

    // Stale cache fallback — last resort (bounded by TTL)
    const cached = priceCache.get(key);
    if (cached && (Date.now() - cached.cachedAtMs) < CACHE_TTL_MS) {
      return {
        ok: true,
        data: {
          priceUsd: cached.priceUsd,
          source: 'cached',
          fetchedAt: cached.fetchedAt,
          stale: true,
        },
      };
    }

    // Expired or absent — remove stale entry
    if (cached) {
      priceCache.delete(key);
    }

    return lastError
      ? { ok: false, error: lastError }
      : {
          ok: false,
          error: {
            code: 'price.unavailable',
            message: `No price available for ${symbol} on ${chain}`,
          },
        };
  }

  return { getPrice };
}
