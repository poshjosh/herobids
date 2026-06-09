import {
  fetchDexScreenerBoostsLatest,
  fetchDexScreenerProfilesLatest,
  fetchDexScreenerTrending,
  mergeDexScreenerDiscoveryTokens,
  type DexScreenerConfig,
} from './dexscreener.js';
import {
  fetchGeckoTerminalNewPools,
  fetchGeckoTerminalTopPools,
  fetchGeckoTerminalTrendingPools,
  type GeckoTerminalConfig,
} from './geckoterminal.js';
import type { DiscoveredToken } from './types.js';

export interface DiscoveryConfig {
  dexscreener: DexScreenerConfig;
  geckoterminal: GeckoTerminalConfig;
  networks: string[];
  maxResults?: number;
  minLiquidityUsd?: number;
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
    });
  }
  return Array.from(merged.values());
}

export async function discoverTokens(config: DiscoveryConfig): Promise<DiscoveredToken[]> {
  const networks = config.networks.length > 0 ? config.networks : ['solana', 'base'];
  const maxResults = config.maxResults ?? 20;
  const minLiquidityUsd = config.minLiquidityUsd ?? 10_000;

  const results = await Promise.allSettled([
    fetchDexScreenerTrending(config.dexscreener),
    fetchDexScreenerBoostsLatest(config.dexscreener),
    fetchDexScreenerProfilesLatest(config.dexscreener),
    ...networks.flatMap((network) => [
      fetchGeckoTerminalTrendingPools(network, config.geckoterminal),
      fetchGeckoTerminalTopPools(network, config.geckoterminal),
      fetchGeckoTerminalNewPools(network, config.geckoterminal),
    ]),
  ]);

  const fulfilled = results
    .filter((result): result is PromiseFulfilledResult<DiscoveredToken[]> => result.status === 'fulfilled')
    .flatMap((result) => result.value);

  if (fulfilled.length === 0) {
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    throw rejected?.reason instanceof Error ? rejected.reason : new Error('No discovery providers returned data');
  }

  return mergeDiscoveredTokens(mergeDexScreenerDiscoveryTokens(fulfilled))
    .filter((token) => token.liquidityUsd > 0 && token.liquidityUsd >= minLiquidityUsd)
    .sort((left, right) => {
      if (right.volume24hUsd !== left.volume24hUsd) {
        return right.volume24hUsd - left.volume24hUsd;
      }
      return right.liquidityUsd - left.liquidityUsd;
    })
    .slice(0, maxResults);
}