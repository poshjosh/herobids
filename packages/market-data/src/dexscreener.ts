import type { DiscoveredToken, RequestGate, TokenInfo } from './types.js';
import { fetchJson } from './http.js';

interface DexScreenerPair {
  baseToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  priceChange?: { h24?: number };
  dexId?: string;
  chainId?: string;
  /** DexScreener returns pairCreatedAt as epoch milliseconds. */
  pairCreatedAt?: number;
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[];
}

interface DexScreenerDiscoveryItem {
  chainId?: string;
  tokenAddress?: string;
  amount?: number;
  totalAmount?: number;
  description?: string;
  url?: string;
}

export interface DexScreenerConfig {
  baseUrl: string;
  rateLimiter: RequestGate;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

function mapPairToTokenInfo(pair: DexScreenerPair): TokenInfo {
  return {
    address: pair.baseToken?.address ?? '',
    symbol: pair.baseToken?.symbol ?? '',
    name: pair.baseToken?.name ?? '',
    network: pair.chainId ?? '',
    priceUsd: parseFloat(pair.priceUsd ?? '0') || 0,
    volume24hUsd: pair.volume?.h24 ?? 0,
    liquidityUsd: pair.liquidity?.usd ?? 0,
    priceChange24hPct: pair.priceChange?.h24 ?? 0,
    dexId: pair.dexId ?? '',
    poolCreatedAt: pair.pairCreatedAt != null
      ? new Date(pair.pairCreatedAt).toISOString()
      : undefined,
  };
}

function mapDiscoveryItemToToken(item: DexScreenerDiscoveryItem, vector: string): DiscoveredToken {
  const address = item.tokenAddress ?? '';
  const fallbackName = item.description?.trim() || address.slice(0, 8) || 'unknown';
  return {
    address,
    symbol: address.slice(0, 6) || 'unknown',
    name: fallbackName,
    network: item.chainId ?? 'unknown',
    priceUsd: 0,
    volume24hUsd: item.amount ?? item.totalAmount ?? 0,
    liquidityUsd: 0,
    source: 'dexscreener',
    discoveryVectors: [vector],
  };
}

async function fetchDiscoveryVector(
  path: string,
  vector: string,
  config: DexScreenerConfig,
): Promise<DiscoveredToken[]> {
  await config.rateLimiter.acquire();

  const data = await fetchJson<DexScreenerDiscoveryItem[]>({
    url: `${config.baseUrl}${path}`,
    timeoutMs: config.timeoutMs,
    headers: { Accept: 'application/json' },
    fetchFn: config.fetchFn,
  });

  return data.map((item) => mapDiscoveryItemToToken(item, vector));
}

export async function fetchDexScreenerSearch(
  query: string,
  config: DexScreenerConfig,
): Promise<TokenInfo[]> {
  await config.rateLimiter.acquire();

  const url = `${config.baseUrl}/latest/dex/search?q=${encodeURIComponent(query)}`;

  const data = await fetchJson<DexScreenerResponse>({
    url,
    timeoutMs: config.timeoutMs,
    fetchFn: config.fetchFn,
  });

  return (data.pairs ?? []).map(mapPairToTokenInfo);
}

export function normalizeDexScreenerSearchResults(tokens: TokenInfo[], vector = 'search'): DiscoveredToken[] {
  return tokens.map((token) => ({
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    network: token.network,
    priceUsd: token.priceUsd,
    volume24hUsd: token.volume24hUsd,
    liquidityUsd: token.liquidityUsd,
    priceChange24hPct: token.priceChange24hPct,
    source: 'dexscreener',
    discoveryVectors: [vector],
  }));
}

export function mergeDexScreenerDiscoveryTokens(tokens: DiscoveredToken[]): DiscoveredToken[] {
  const merged = new Map<string, DiscoveredToken>();
  for (const token of tokens) {
    const key = `${token.network}:${token.address}`;
    const existing = merged.get(key);
    if (!existing || token.liquidityUsd > existing.liquidityUsd) {
      merged.set(key, existing
        ? { ...token, discoveryVectors: Array.from(new Set([...existing.discoveryVectors, ...token.discoveryVectors])) }
        : token);
      continue;
    }

    existing.discoveryVectors = Array.from(new Set([...existing.discoveryVectors, ...token.discoveryVectors]));
  }
  return Array.from(merged.values());
}

export function convertDexScreenerSearchToDiscovery(tokens: TokenInfo[]): DiscoveredToken[] {
  return mergeDexScreenerDiscoveryTokens(normalizeDexScreenerSearchResults(tokens));
}

export function mergeDexScreenerSearchAndDiscovery(
  searchResults: TokenInfo[],
  discoveryResults: DiscoveredToken[],
): DiscoveredToken[] {
  return mergeDexScreenerDiscoveryTokens([
    ...normalizeDexScreenerSearchResults(searchResults),
    ...discoveryResults,
  ]);
}

export async function fetchDexScreenerTrending(config: DexScreenerConfig): Promise<DiscoveredToken[]> {
  return fetchDiscoveryVector('/token-boosts/top/v1', 'boosts_top', config);
}

export async function fetchDexScreenerBoostsLatest(config: DexScreenerConfig): Promise<DiscoveredToken[]> {
  return fetchDiscoveryVector('/token-boosts/latest/v1', 'boosts_latest', config);
}

export async function fetchDexScreenerProfilesLatest(config: DexScreenerConfig): Promise<DiscoveredToken[]> {
  return fetchDiscoveryVector('/token-profiles/latest/v1', 'profiles_latest', config);
}
