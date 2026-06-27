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

const BATCH_SIZE = 30;

function mapPairToDiscoveredToken(pair: DexScreenerPair): DiscoveredToken {
  return {
    address: pair.baseToken?.address ?? '',
    symbol: pair.baseToken?.symbol ?? '',
    name: pair.baseToken?.name ?? '',
    network: pair.chainId ?? '',
    priceUsd: parseFloat(pair.priceUsd ?? '0') || 0,
    volume24hUsd: pair.volume?.h24 ?? 0,
    liquidityUsd: pair.liquidity?.usd ?? 0,
    priceChange24hPct: pair.priceChange?.h24,
    source: 'dexscreener',
    discoveryVectors: [],
    poolCreatedAt: pair.pairCreatedAt != null
      ? new Date(pair.pairCreatedAt).toISOString()
      : undefined,
  };
}

export async function fetchDexScreenerTokensByAddress(
  chainId: string,
  addresses: string[],
  config: DexScreenerConfig,
): Promise<DiscoveredToken[]> {
  if (addresses.length === 0) {
    return [];
  }

  const results: DiscoveredToken[] = [];

  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const chunk = addresses.slice(i, i + BATCH_SIZE);

    await config.rateLimiter.acquire();

    const url = `${config.baseUrl}/tokens/v1/${chainId}/${chunk.join(',')}`;

    const data = await fetchJson<DexScreenerResponse>({
      url,
      timeoutMs: config.timeoutMs,
      fetchFn: config.fetchFn,
    });

    const pairs = data.pairs ?? [];
    if (pairs.length === 0) {
      continue;
    }

    // Group pairs by baseToken address (lowercased), pick the one with highest liquidity.
    const bestByAddress = new Map<string, DexScreenerPair>();
    for (const pair of pairs) {
      const addr = pair.baseToken?.address?.toLowerCase();
      if (!addr) continue;

      const existing = bestByAddress.get(addr);
      if (!existing || (pair.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) {
        bestByAddress.set(addr, pair);
      }
    }

    for (const pair of bestByAddress.values()) {
      results.push(mapPairToDiscoveredToken(pair));
    }
  }

  return results;
}

export async function enrichDexScreenerBoostTokens(
  tokens: DiscoveredToken[],
  networks: string[],
  config: DexScreenerConfig,
): Promise<DiscoveredToken[]> {
  try {
    // Identify tokens to enrich: dexscreener source, zero liquidity, in configured networks.
    const toEnrich = tokens.filter(
      (t) => t.source === 'dexscreener' && t.liquidityUsd === 0 && networks.includes(t.network),
    );

    if (toEnrich.length === 0) {
      return tokens;
    }

    // Group by network.
    const byNetwork = new Map<string, DiscoveredToken[]>();
    for (const token of toEnrich) {
      const group = byNetwork.get(token.network) ?? [];
      group.push(token);
      byNetwork.set(token.network, group);
    }

    // Fetch enriched data per network and build a lookup map.
    const enrichedByKey = new Map<string, DiscoveredToken>();
    for (const [network, networkTokens] of byNetwork) {
      const addresses = networkTokens.map((t) => t.address);
      const enriched = await fetchDexScreenerTokensByAddress(network, addresses, config);
      for (const token of enriched) {
        enrichedByKey.set(`${token.network}:${token.address}`, token);
      }
    }

    // Merge enriched data back into the original token list.
    return tokens.map((token) => {
      const key = `${token.network}:${token.address}`;
      const enriched = enrichedByKey.get(key);
      if (!enriched) {
        return token;
      }

      return {
        ...token,
        // Overwrite financials with real on-chain data.
        priceUsd: enriched.priceUsd,
        volume24hUsd: enriched.volume24hUsd,
        liquidityUsd: enriched.liquidityUsd,
        // Conditionally overwrite: only when the enriched value is present.
        priceChange24hPct:
          enriched.priceChange24hPct !== undefined
            ? enriched.priceChange24hPct
            : token.priceChange24hPct,
        symbol: enriched.symbol || token.symbol,
        name: enriched.name || token.name,
        poolCreatedAt: enriched.poolCreatedAt ?? token.poolCreatedAt,
        // Preserve: source, discoveryVectors, address, network (unchanged via spread).
      };
    });
  } catch (err) {
    console.warn('DexScreener boost enrichment failed, returning unenriched tokens:', err);
    return tokens;
  }
}
