import {
  fetchDexScreenerBoostsLatest,
  fetchDexScreenerProfilesLatest,
  fetchDexScreenerTrending,
  type DexScreenerConfig,
} from './dexscreener.js';
import {
  fetchGeckoTerminalNewPools,
  fetchGeckoTerminalTopPools,
  fetchGeckoTerminalTrendingPools,
  type GeckoTerminalConfig,
} from './geckoterminal.js';
import {
  enrichWithCmc,
  fetchCmcNewListings,
  fetchCmcTrending,
  type CoinMarketCapConfig,
} from './coinmarketcap.js';
import type { DiscoveredToken } from './types.js';
import type { DiscoverySeenTracker } from './discovery-seen-tracker.js';

export interface DiscoveryConfig {
  dexscreener: DexScreenerConfig;
  geckoterminal: GeckoTerminalConfig;
  coinmarketcap?: CoinMarketCapConfig;
  networks: string[];
  maxResults?: number;
  minLiquidityUsd?: number;
  extraGeckoTerminalPages?: number;
  antistalenessCooldownHours?: number;
  seenTracker?: DiscoverySeenTracker;
}

function tokenKey(token: DiscoveredToken): string {
  return `${token.network}:${token.address}`;
}

function passesDiscoveryThreshold(token: DiscoveredToken, minLiquidityUsd: number): boolean {
  // minLiquidityUsd is a hard floor for regular discovery sources.
  // CMC-only tokens can still enter when the caller explicitly uses a zero floor.
  if (token.liquidityUsd > 0 && token.liquidityUsd >= minLiquidityUsd) {
    return true;
  }

  return token.source === 'coinmarketcap' && minLiquidityUsd === 0 && (token.marketCapUsd ?? 0) > 0;
}

function discoveryScoreUsd(token: DiscoveredToken): number {
  if (token.liquidityUsd > 0) {
    return token.liquidityUsd;
  }

  if (token.source === 'coinmarketcap') {
    return token.marketCapUsd ?? 0;
  }

  return 0;
}

async function enrichByNetworkSlice(
  tokens: DiscoveredToken[],
  config: CoinMarketCapConfig,
): Promise<DiscoveredToken[]> {
  const tokensByNetwork = new Map<string, DiscoveredToken[]>();
  for (const token of tokens) {
    const current = tokensByNetwork.get(token.network) ?? [];
    current.push(token);
    tokensByNetwork.set(token.network, current);
  }

  const enrichedByKey = new Map<string, DiscoveredToken>();
  for (const networkTokens of tokensByNetwork.values()) {
    try {
      const enrichedSlice = await enrichWithCmc(networkTokens, config);
      for (const token of enrichedSlice) {
        enrichedByKey.set(tokenKey(token), token);
      }
    } catch {
      for (const token of networkTokens) {
        if (!enrichedByKey.has(tokenKey(token))) {
          enrichedByKey.set(tokenKey(token), token);
        }
      }
    }
  }

  return tokens.map((token) => enrichedByKey.get(tokenKey(token)) ?? token);
}

function mergeDiscoveredTokens(tokens: DiscoveredToken[]): DiscoveredToken[] {
  const merged = new Map<string, DiscoveredToken>();
  for (const token of tokens) {
    const key = `${token.network}:${token.address}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...token, discoveryVectors: [...token.discoveryVectors] });
      continue;
    }

    const higherLiquidity = token.liquidityUsd > existing.liquidityUsd ? token : existing;
    merged.set(key, {
      ...higherLiquidity,
      discoveryVectors: Array.from(new Set([...existing.discoveryVectors, ...token.discoveryVectors])),
      volume24hUsd: Math.max(existing.volume24hUsd, token.volume24hUsd),
      liquidityUsd: Math.max(existing.liquidityUsd, token.liquidityUsd),
      priceUsd: higherLiquidity.priceUsd,
      poolAddress: higherLiquidity.poolAddress ?? existing.poolAddress,
      poolCreatedAt: higherLiquidity.poolCreatedAt ?? existing.poolCreatedAt,
      marketCapUsd: existing.marketCapUsd ?? token.marketCapUsd,
      fullyDilutedValuationUsd: existing.fullyDilutedValuationUsd ?? token.fullyDilutedValuationUsd,
      holderCount: existing.holderCount ?? token.holderCount,
      cexListings: existing.cexListings ?? token.cexListings,
      riskLevel: existing.riskLevel ?? token.riskLevel,
    });
  }
  return Array.from(merged.values());
}

export async function discoverTokens(config: DiscoveryConfig): Promise<DiscoveredToken[]> {
  const networks = config.networks.length > 0 ? config.networks : ['solana', 'base'];
  const maxResults = config.maxResults ?? 20;
  const minLiquidityUsd = config.minLiquidityUsd ?? 10_000;

  const cmcFanOut = config.coinmarketcap
    ? [
        fetchCmcTrending(networks, config.coinmarketcap),
        fetchCmcNewListings(networks, config.coinmarketcap),
      ]
    : [];

  const extraPages = config.extraGeckoTerminalPages ?? 0;
  const pageNumbers = [1, ...Array.from({ length: extraPages }, (_, i) => i + 2)];

  const results = await Promise.allSettled([
    fetchDexScreenerTrending(config.dexscreener),
    fetchDexScreenerBoostsLatest(config.dexscreener),
    fetchDexScreenerProfilesLatest(config.dexscreener),
    ...networks.flatMap((network) => [
      ...pageNumbers.map((page) => fetchGeckoTerminalTrendingPools(network, config.geckoterminal, page)),
      ...pageNumbers.map((page) => fetchGeckoTerminalTopPools(network, config.geckoterminal, page)),
      fetchGeckoTerminalNewPools(network, config.geckoterminal),
    ]),
    ...cmcFanOut,
  ]);

  const fulfilled = results
    .filter((result): result is PromiseFulfilledResult<DiscoveredToken[]> => result.status === 'fulfilled')
    .flatMap((result) => result.value);

  if (fulfilled.length === 0) {
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    throw rejected?.reason instanceof Error ? rejected.reason : new Error('No discovery providers returned data');
  }

  const merged = mergeDiscoveredTokens(fulfilled)
    .filter((token) => passesDiscoveryThreshold(token, minLiquidityUsd))
    .sort((left, right) => {
      const rightScore = discoveryScoreUsd(right);
      const leftScore = discoveryScoreUsd(left);

      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }

      if (right.volume24hUsd !== left.volume24hUsd) {
        return right.volume24hUsd - left.volume24hUsd;
      }
      return right.liquidityUsd - left.liquidityUsd;
    });

  const cooldownMs = (config.antistalenessCooldownHours ?? 0) * 60 * 60 * 1000;
  const reordered = (config.seenTracker && cooldownMs > 0)
    ? await config.seenTracker.applyAntiStaleness(merged, cooldownMs)
    : merged;

  const sliced = reordered.slice(0, maxResults);

  if (config.seenTracker && cooldownMs > 0) {
    await config.seenTracker.markSeen(sliced);
  }

  if (!config.coinmarketcap) return sliced;

  // Enrichment pass — runs after merge/filter/sort, one batch call per network slice, fail-soft
  try {
    return await enrichByNetworkSlice(sliced, config.coinmarketcap);
  } catch {
    // CMC enrichment failure must not abort discovery results from other providers
    return sliced;
  }
}
