import type { DiscoveredToken, PriceCandle, RequestGate } from './types.js';
import { fetchJson, HttpError } from './http.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BirdeyeConfig {
  baseUrl: string;
  apiKey: string;
  rateLimiter: RequestGate;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Birdeye API shapes
// ---------------------------------------------------------------------------

interface BirdeyeTrendingToken {
  address: string;
  decimals?: number;
  liquidity?: number;
  logoURI?: string;
  name?: string;
  symbol?: string;
  volume24hUSD?: number;
  rank?: number;
}

interface BirdeyeTrendingResponse {
  success: boolean;
  data?: {
    updateUnixTime?: number;
    updateTime?: string;
    tokens?: BirdeyeTrendingToken[];
    total?: number;
  };
  message?: string;
}

interface BirdeyeOverviewResponse {
  success: boolean;
  data?: {
    address?: string;
    decimals?: number;
    symbol?: string;
    name?: string;
    extensions?: Record<string, unknown>;
    logoURI?: string;
    liquidity?: number;
    price?: number;
    priceChange24hPercent?: number;
    supply?: number;
    mc?: number;
    v24hUSD?: number;
    numberMarkets?: number;
  };
  message?: string;
}

interface BirdeyeOhlcvItem {
  unixTime: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface BirdeyeOhlcvResponse {
  success: boolean;
  data?: {
    items?: BirdeyeOhlcvItem[];
  };
  message?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function birdeyeHeaders(apiKey: string, chain: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-API-KEY': apiKey,
    'x-chain': chain,
  };
}

/**
 * Birdeye returns HTTP 400 for both unsupported tokens and rate quota
 * exhaustion.  Treat 400 as a warn-and-skip signal rather than a fatal error.
 */
async function birdeyeFetch<T>(
  params: {
    url: string;
    config: BirdeyeConfig;
    chain: string;
  },
): Promise<T | null> {
  try {
    return await fetchJson<T>({
      url: params.url,
      timeoutMs: params.config.timeoutMs,
      headers: birdeyeHeaders(params.config.apiKey, params.chain),
      fetchFn: params.config.fetchFn,
    });
  } catch (err: unknown) {
    // HTTP 400 → rate limit or unsupported token → skip, not crash.
    // Birdeye returns 400 for both quota exhaustion and invalid tokens,
    // unlike most APIs that use 429 for rate limits.
    if (err instanceof HttpError && err.status === 400) {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public fetchers
// ---------------------------------------------------------------------------

/**
 * Fetches trending tokens from Birdeye for the given chain (Solana-only per
 * the current scope).
 *
 * Returns an empty array when the chain is not Solana or when the Birdeye
 * API returns no tokens (including HTTP 400 rate-limit responses).
 */
export async function fetchBirdeyeTrending(
  chain: string,
  config: BirdeyeConfig,
): Promise<DiscoveredToken[]> {
  if (chain !== 'solana') return [];

  await config.rateLimiter.acquire();

  const data = await birdeyeFetch<BirdeyeTrendingResponse>({
    url: `${config.baseUrl}/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20`,
    config,
    chain,
  });

  const tokens = data?.data?.tokens ?? [];
  return tokens
    .filter((t) => t.address && t.symbol)
    .map((t) => mapTrendingToken(t, chain));
}

function mapTrendingToken(t: BirdeyeTrendingToken, chain: string): DiscoveredToken {
  return {
    address: t.address,
    symbol: t.symbol ?? '',
    name: t.name ?? t.symbol ?? '',
    network: chain,
    priceUsd: 0, // trending endpoint does not include price
    volume24hUsd: t.volume24hUSD ?? 0,
    liquidityUsd: t.liquidity ?? 0,
    source: 'birdeye',
    discoveryVectors: ['birdeye_trending'],
  };
}

// ---------------------------------------------------------------------------
// Token overview
// ---------------------------------------------------------------------------

export interface BirdeyeTokenOverview {
  address: string;
  symbol: string;
  name: string;
  network: string;
  priceUsd: number;
  volume24hUsd: number;
  liquidityUsd: number;
  priceChange24hPct: number;
  marketCapUsd?: number;
  supply?: number;
}

/**
 * Fetches a token overview from Birdeye.
 *
 * Returns null when the chain is not Solana or when the API returns a 400
 * (unsupported token / rate limit).
 */
export async function fetchBirdeyeTokenOverview(
  address: string,
  chain: string,
  config: BirdeyeConfig,
): Promise<BirdeyeTokenOverview | null> {
  if (chain !== 'solana') return null;

  await config.rateLimiter.acquire();

  const data = await birdeyeFetch<BirdeyeOverviewResponse>({
    url: `${config.baseUrl}/defi/token_overview?address=${encodeURIComponent(address)}`,
    config,
    chain,
  });

  const d = data?.data;
  if (!d || !d.address) return null;

  return {
    address: d.address,
    symbol: d.symbol ?? '',
    name: d.name ?? d.symbol ?? '',
    network: chain,
    priceUsd: d.price ?? 0,
    volume24hUsd: d.v24hUSD ?? 0,
    liquidityUsd: d.liquidity ?? 0,
    priceChange24hPct: d.priceChange24hPercent ?? 0,
    marketCapUsd: d.mc,
    supply: d.supply,
  };
}

// ---------------------------------------------------------------------------
// OHLCV
// ---------------------------------------------------------------------------

const SUPPORTED_BIRDEYE_INTERVALS = new Set([
  '1m', '3m', '5m', '15m', '30m',
  '1H', '2H', '4H', '6H', '8H', '12H',
  '1D', '3D', '1W', '1M',
]);

/**
 * Fetches OHLCV candles from Birdeye for a token address.
 *
 * Returns an empty array when the chain is not Solana, when the interval is
 * unsupported, or when the API returns a 400 (rate limit / unsupported token).
 */
export async function fetchBirdeyeOhlcv(
  address: string,
  chain: string,
  interval: string,
  config: BirdeyeConfig,
): Promise<PriceCandle[]> {
  if (chain !== 'solana') return [];
  if (!SUPPORTED_BIRDEYE_INTERVALS.has(interval)) return [];

  await config.rateLimiter.acquire();

  const data = await birdeyeFetch<BirdeyeOhlcvResponse>({
    url: `${config.baseUrl}/defi/ohlcv?address=${encodeURIComponent(address)}&type=${encodeURIComponent(interval)}`,
    config,
    chain,
  });

  const items = data?.data?.items ?? [];
  return items
    .filter((i) => i.unixTime > 0)
    .sort((a, b) => a.unixTime - b.unixTime)
    .map(mapOhlcvItem);
}

function mapOhlcvItem(item: BirdeyeOhlcvItem): PriceCandle {
  return {
    timestamp: new Date(item.unixTime * 1000).toISOString(),
    open: item.o,
    high: item.h,
    low: item.l,
    close: item.c,
    volume: item.v,
  };
}
