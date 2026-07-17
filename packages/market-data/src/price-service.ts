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

/**
 * Identity + price snapshot returned by the resolver.
 *
 * `symbol` and `chain` represent the **resolved** (effective) identity —
 * the concrete asset the resolver selected, not necessarily what the caller
 * requested.  Use these fields for stable repricing.
 *
 * `address` is the pinned token address when available.  When present,
 * repricing should supply it for exact-identity lookups.
 *
 * `name` is the human-readable token name from the data source (may be
 * absent for some providers).
 */
export interface ResolvedPriceTarget {
  symbol: string;
  chain: string;
  address?: string;
  name?: string;
  priceUsd: number;
  source: PriceSource;
  fetchedAt: string;
  stale: boolean;
}

export type ResolvePriceTargetResult =
  | { ok: true; data: ResolvedPriceTarget }
  | { ok: false; error: PriceLookupError };

export interface PriceService {
  getPrice(symbol: string, chain: string, address?: string): Promise<PriceResult>;
  resolvePriceTarget(symbol: string, chain: string, address?: string): Promise<ResolvePriceTargetResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Maximum age (ms) of a cached price entry before it is considered expired. */
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedPriceEntry {
  priceUsd: number;
  fetchedAt: string;
  cachedAtMs: number;
  /** Resolved identity so stale fallback can return the correct asset, not the requested query. */
  symbol: string;
  chain: string;
  address?: string;
}

/**
 * In-memory last-known-price cache.
 * Keyed by `${chain}:${identity}`.
 */
const priceCache = new Map<string, CachedPriceEntry>();

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

// ---------------------------------------------------------------------------
// Resolution helpers — identity-aware candidate selection
// ---------------------------------------------------------------------------

/**
 * Searches DexScreener for a token, filters by chain and optional address,
 * selects the highest-liquidity candidate, and returns the full resolved
 * identity plus price.
 */
async function resolveDexScreenerTarget(
  registry: ProviderRegistry,
  symbol: string,
  chain: string,
  address?: string,
): Promise<ResolvePriceTargetResult> {
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
        error: {
          code: 'price.not_found',
          message: `${symbol} not found via DexScreener${chainLower !== 'any' ? ` on ${chain}` : ''}`,
        },
      };
    }

    return {
      ok: true,
      data: {
        symbol: best.symbol,
        chain: best.network,
        address: best.address,
        name: best.name,
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

/**
 * Resolves a token identity on Hyperliquid by matching the symbol against
 * available asset contexts.  Returns the resolved identity with chain fixed
 * to `hyperliquid` and source `execution`.
 */
async function resolveHyperliquidTarget(
  registry: ProviderRegistry,
  symbol: string,
): Promise<ResolvePriceTargetResult> {
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
        symbol: asset.asset,
        chain: 'hyperliquid',
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

/**
 * Resolves a token identity on Bybit by matching the symbol against
 * available linear tickers.  Returns the resolved identity with chain fixed
 * to `bybit` and source `execution`.
 *
 * Fails closed when markPrice is null — no fallback to DexScreener.
 */
async function resolveBybitTarget(
  registry: ProviderRegistry,
  symbol: string,
): Promise<ResolvePriceTargetResult> {
  try {
    const result = await registry.bybit.tickers();
    const normalized = symbol.toUpperCase();
    const ticker = result.data.find(
      (t) => t.symbol.toUpperCase() === normalized,
    );
    if (!ticker || ticker.markPrice === null) {
      return {
        ok: false,
        error: { code: 'price.not_found', message: `${symbol} not found on Bybit` },
      };
    }
    return {
      ok: true,
      data: {
        symbol: ticker.symbol,
        chain: 'bybit',
        priceUsd: ticker.markPrice,
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
        message: err instanceof Error ? err.message : 'Bybit fetch failed',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Composite price service — source selection + stale-cache fallback
// ---------------------------------------------------------------------------

/**
 * CompositePriceService selects sources by chain:
 *   - "hyperliquid": execution → oracle → cached
 *   - "bybit":       execution → cached (fail closed, no oracle fallback)
 *   - all others:    oracle → cached
 *
 * Results are cached in memory so failed live lookups can fall back to stale data.
 */
export function createPriceService(registry: ProviderRegistry): PriceService {

  /**
   * Resolves a full identity + price for the requested symbol.
   *
   * Follows the same source → cache fallback priority as `getPrice` but
   * returns the chosen candidate's identity (chain, address, symbol, name)
   * alongside the price so callers can pin subsequent lookups to the exact
   * asset that was resolved.
   */
  async function resolvePriceTarget(
    symbol: string,
    chain: string,
    address?: string,
  ): Promise<ResolvePriceTargetResult> {
    const key = cacheKey(symbol, chain, address);
    const chainLower = chain.toLowerCase();
    let lastError: PriceLookupError | null = null;

    // Source order: execution (perps only) → oracle → cached
    const sources: Array<() => Promise<ResolvePriceTargetResult>> = [];

    if (chainLower === 'hyperliquid') {
      sources.push(() => resolveHyperliquidTarget(registry, symbol));
      // DexScreener has no 'hyperliquid' network — use 'any' as the oracle fallback.
      sources.push(() => resolveDexScreenerTarget(registry, symbol, 'any', address));
    } else if (chainLower === 'bybit') {
      sources.push(() => resolveBybitTarget(registry, symbol));
      // No DexScreener fallback for Bybit — fail closed.
    } else {
      sources.push(() => resolveDexScreenerTarget(registry, symbol, chain, address));
    }

    for (const source of sources) {
      const result = await source();
      if (result.ok) {
        priceCache.set(key, {
          priceUsd: result.data.priceUsd,
          fetchedAt: result.data.fetchedAt,
          cachedAtMs: Date.now(),
          symbol: result.data.symbol,
          chain: result.data.chain,
          address: result.data.address,
        });
        return result;
      }
      lastError = result.error;
    }

    // Stale cache fallback — last resort (bounded by TTL)
    // Returns the resolved identity from when the entry was originally cached,
    // not the requested query, so stale results still carry a concrete identity.
    const cached = priceCache.get(key);
    if (cached && (Date.now() - cached.cachedAtMs) < CACHE_TTL_MS) {
      return {
        ok: true,
        data: {
          symbol: cached.symbol,
          chain: cached.chain,
          address: cached.address,
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

  /**
   * Returns a price snapshot for the requested symbol.
   *
   * Delegates to `resolvePriceTarget` and projects the full identity down
   * to only the price fields, preserving the original behaviour.
   */
  async function getPrice(
    symbol: string,
    chain: string,
    address?: string,
  ): Promise<PriceResult> {
    const result = await resolvePriceTarget(symbol, chain, address);
    if (!result.ok) {
      return result;
    }
    const { priceUsd, source, fetchedAt, stale } = result.data;
    return {
      ok: true,
      data: { priceUsd, source, fetchedAt, stale },
    };
  }

  return { getPrice, resolvePriceTarget };
}
