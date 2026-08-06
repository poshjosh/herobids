import {
  enrichDexScreenerBoostTokens,
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
import {
  fetchBirdeyeTrending,
  type BirdeyeConfig,
} from './birdeye.js';
import type { DiscoveredToken } from './types.js';
import type { DiscoverySeenTracker } from './discovery-seen-tracker.js';

export interface DiscoveryLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export interface DiscoveryConfig {
  dexscreener: DexScreenerConfig;
  geckoterminal: GeckoTerminalConfig;
  coinmarketcap?: CoinMarketCapConfig;
  birdeye?: BirdeyeConfig;
  networks: string[];
  maxResults?: number;
  minLiquidityUsd?: number;
  extraGeckoTerminalPages?: number;
  antistalenessCooldownHours?: number;
  seenTracker?: DiscoverySeenTracker;
  logger?: DiscoveryLogger;
}

function tokenKey(token: DiscoveredToken): string {
  return `${token.network}:${token.address}`;
}

function filterByRequestedNetworks(
  tokens: DiscoveredToken[],
  normalizedNetworks: ReadonlySet<string>,
): DiscoveredToken[] {
  return tokens.filter((token) => normalizedNetworks.has(token.network.toLowerCase()));
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
      // Atomic pool identity — take the entire pool object from the higher-liquidity
      // record, never independently merge poolAddress/baseToken/quoteToken from different sources.
      pool: higherLiquidity.pool ?? existing.pool,
      marketCapUsd: existing.marketCapUsd ?? token.marketCapUsd,
      fullyDilutedValuationUsd: existing.fullyDilutedValuationUsd ?? token.fullyDilutedValuationUsd,
      holderCount: existing.holderCount ?? token.holderCount,
      cexListings: existing.cexListings ?? token.cexListings,
      riskLevel: existing.riskLevel ?? token.riskLevel,
    });
  }
  return Array.from(merged.values());
}

interface RejectionLabel {
  provider: string;
  network?: string;
  vector: string;
}

export async function discoverTokens(config: DiscoveryConfig): Promise<DiscoveredToken[]> {
  const networks = (config.networks.length > 0 ? config.networks : ['solana', 'base']).map((n) => n.toLowerCase());
  const normalizedNetworks = new Set(networks);
  const maxResults = config.maxResults ?? 20;
  const minLiquidityUsd = config.minLiquidityUsd ?? 10_000;

  const extraPages = config.extraGeckoTerminalPages ?? 0;
  const pageNumbers = [1, ...Array.from({ length: extraPages }, (_, i) => i + 2)];

  // Build a labeled fanout array so rejected provider results can be attributed
  // to a specific provider / network / endpoint vector.
  const labeled: Array<{ promise: Promise<DiscoveredToken[]>; label: RejectionLabel }> = [];

  // DexScreener — global vectors (no per-network fanout)
  labeled.push({ promise: fetchDexScreenerTrending(config.dexscreener), label: { provider: 'dexscreener', vector: 'trending' } });
  labeled.push({ promise: fetchDexScreenerBoostsLatest(config.dexscreener), label: { provider: 'dexscreener', vector: 'boosts-latest' } });
  labeled.push({ promise: fetchDexScreenerProfilesLatest(config.dexscreener), label: { provider: 'dexscreener', vector: 'profiles-latest' } });

  // GeckoTerminal — per-network vectors
  for (const network of networks) {
    for (const page of pageNumbers) {
      const pageSuffix = page > 1 ? `_p${page}` : '';
      labeled.push({ promise: fetchGeckoTerminalTrendingPools(network, config.geckoterminal, page), label: { provider: 'geckoterminal', network, vector: `trending_pools${pageSuffix}` } });
      labeled.push({ promise: fetchGeckoTerminalTopPools(network, config.geckoterminal, page), label: { provider: 'geckoterminal', network, vector: `top_pools${pageSuffix}` } });
    }
    labeled.push({ promise: fetchGeckoTerminalNewPools(network, config.geckoterminal), label: { provider: 'geckoterminal', network, vector: 'new_pools' } });
  }

  // CoinMarketCap — optional, global vectors
  if (config.coinmarketcap) {
    labeled.push({ promise: fetchCmcTrending(networks, config.coinmarketcap), label: { provider: 'coinmarketcap', vector: 'trending' } });
    labeled.push({ promise: fetchCmcNewListings(networks, config.coinmarketcap), label: { provider: 'coinmarketcap', vector: 'new-listings' } });
  }

  // Birdeye — Solana-only, opt-in
  if (config.birdeye && networks.includes('solana')) {
    labeled.push({ promise: fetchBirdeyeTrending('solana', config.birdeye), label: { provider: 'birdeye', network: 'solana', vector: 'trending' } });
  }

  const results = await Promise.allSettled(labeled.map((l) => l.promise));

  // Surface rejected provider results instead of silently dropping them.
  // Promise.allSettled swallows rejections; without this logging, provider
  // failures (rate limits, timeouts, auth errors) are invisible and can cause
  // a network to silently return zero tokens (e.g. base). Log each rejection
  // with a stable provider/network/vector label so operators can see exactly
  // which provider endpoint failed.
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === 'rejected') {
      const entry = labeled[i]!;
      const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      (config.logger ?? console).warn(
        `[Discovery] provider request rejected: ${entry.label.provider}/${entry.label.network ?? 'global'}/${entry.label.vector}: ${err.message}`,
        { provider: entry.label.provider, network: entry.label.network, vector: entry.label.vector, name: err.name },
      );
    }
  }

  const fulfilled = results
    .filter((result): result is PromiseFulfilledResult<DiscoveredToken[]> => result.status === 'fulfilled')
    .flatMap((result) => result.value);

  if (fulfilled.length === 0) {
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    throw rejected?.reason instanceof Error ? rejected.reason : new Error('No discovery providers returned data');
  }

  // Post-fanout network filter — DexScreener's global vectors can return tokens
  // from any network, so we must drop tokens whose network is not in the
  // requested set before merging (e.g. a base-only discovery call should not
  // include Solana tokens that DexScreener returned).
  const networkFiltered = filterByRequestedNetworks(fulfilled, normalizedNetworks);

  const merged = mergeDiscoveredTokens(networkFiltered);

  // Enrich DexScreener boost/profile tokens that have no liquidity yet.
  // This runs before the threshold filter so enriched tokens can enter the pool.
  const enrichedMerge = await enrichDexScreenerBoostTokens(merged, networks, config.dexscreener);

  const filtered = enrichedMerge
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
    ? await config.seenTracker.applyAntiStaleness(filtered, cooldownMs)
    : filtered;

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
