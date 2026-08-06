import { loadWithCache, InMemoryProviderResponseCache, type ProviderResponseCache } from './cache.js';
import { fetchBinanceCandles, type BinanceCandlesConfig } from './binance-candles.js';
import {
  fetchDexScreenerBoostsLatest,
  fetchDexScreenerProfilesLatest,
  fetchDexScreenerSearch,
  fetchDexScreenerTrending,
  type DexScreenerConfig,
} from './dexscreener.js';
import { discoverTokens } from './discovery.js';
import {
  NoopDiscoverySeenTracker,
  RedisDiscoverySeenTracker,
  type DiscoverySeenClient,
  type DiscoverySeenTracker,
} from './discovery-seen-tracker.js';
import {
  fetchGeckoTerminalCandles,
  fetchGeckoTerminalNewPools,
  fetchGeckoTerminalTopPools,
  fetchGeckoTerminalTrendingPools,
  validateApiKey as validateGeckoTerminalApiKey,
  type GeckoTerminalConfig,
} from './geckoterminal.js';
import { fetchHyperliquidAssetContexts, type HyperliquidInfoConfig } from './hyperliquid-info.js';
import { fetchBybitLongShortRatio, type BybitInfoConfig } from './bybit-info.js';
import { fetchBybitTickers, type BybitTickersConfig } from './bybit-tickers.js';
import { type CoinMarketCapConfig } from './coinmarketcap.js';
import {
  fetchBirdeyeTokenOverview,
  fetchBirdeyeOhlcv,
  type BirdeyeConfig,
  type BirdeyeTokenOverview,
} from './birdeye.js';
import type { PriceCandle } from './types.js';
import {
  CoordinatedRateLimiter,
  createSharedRateBudgetCoordinator,
  type RedisEvalClient,
  type SharedBudgetConfig,
  type SharedRateBudgetCoordinator,
} from './rate-limiter.js';
import type { MarketDataConfig, ProviderRequestClass } from './types.js';

export interface ProviderRegistryOptions {
  coordinator?: SharedRateBudgetCoordinator;
  redisClient?: RedisEvalClient;
  discoverySeenClient?: DiscoverySeenClient;
  cache?: ProviderResponseCache;
  fetchFn?: typeof fetch;
}

export interface ProviderRegistry {
  binance: {
    candles(symbol: string, options?: { interval?: string; limit?: number }): ReturnType<typeof loadWithCache<Awaited<ReturnType<typeof fetchBinanceCandles>>>>;
  };
  dexscreener: {
    search(query: string): ReturnType<typeof loadWithCache<Awaited<ReturnType<typeof fetchDexScreenerSearch>>>>;
    trending(): ReturnType<typeof loadWithCache<Awaited<ReturnType<typeof fetchDexScreenerTrending>>>>;
    boostsLatest(): ReturnType<typeof loadWithCache<Awaited<ReturnType<typeof fetchDexScreenerBoostsLatest>>>>;
    profilesLatest(): ReturnType<typeof loadWithCache<Awaited<ReturnType<typeof fetchDexScreenerProfilesLatest>>>>;
    searchConfig: DexScreenerConfig;
  };
  geckoterminal: {
    candles(network: string, poolAddress: string, options?: { timeframe?: 'minute' | 'hour' | 'day'; limit?: number }): ReturnType<typeof loadWithCache<Awaited<ReturnType<typeof fetchGeckoTerminalCandles>>>>;
    trendingPools(network: string): ReturnType<typeof loadWithCache<Awaited<ReturnType<typeof fetchGeckoTerminalTrendingPools>>>>;
    topPools(network: string): ReturnType<typeof loadWithCache<Awaited<ReturnType<typeof fetchGeckoTerminalTopPools>>>>;
    newPools(network: string): ReturnType<typeof loadWithCache<Awaited<ReturnType<typeof fetchGeckoTerminalNewPools>>>>;
  };
  hyperliquid: {
    assetContexts(): ReturnType<typeof loadWithCache<Awaited<ReturnType<typeof fetchHyperliquidAssetContexts>>>>;
  };
  bybit: {
    longShortRatio(symbol: string, options?: { period?: '5min' | '15min' | '30min' | '1h' | '4h' | '1d'; limit?: number }): ReturnType<typeof loadWithCache<Awaited<ReturnType<typeof fetchBybitLongShortRatio>>>>;
    tickers(): ReturnType<typeof loadWithCache<Awaited<ReturnType<typeof fetchBybitTickers>>>>;
  };
  birdeye: {
    tokenOverview(address: string, chain: string): ReturnType<typeof loadWithCache<BirdeyeTokenOverview | null>>;
    ohlcv(address: string, chain: string, interval: string): ReturnType<typeof loadWithCache<PriceCandle[]>>;
  };
  discovery: {
    discover(options?: { networks?: string[]; maxResults?: number; minLiquidityUsd?: number }): ReturnType<typeof loadWithCache<Awaited<ReturnType<typeof discoverTokens>>>>;
  };
  configs: {
    binance: BinanceCandlesConfig;
    geckoterminal: GeckoTerminalConfig;
  };
}

function splitBudget(total: number, burstCapacity: number | undefined, maxWaitMs: number | undefined, reservationClass: ProviderRequestClass, reserved: number): SharedBudgetConfig {
  return {
    requestsPerMinute: total,
    burstCapacity,
    maxWaitMs,
    classReservations: reserved > 0 ? { [reservationClass]: reserved } : undefined,
  };
}

function createLimiter(
  coordinator: SharedRateBudgetCoordinator,
  provider: string,
  requestClass: ProviderRequestClass,
  budget: SharedBudgetConfig,
) {
  return new CoordinatedRateLimiter(coordinator, { provider, requestClass, budget });
}

export async function createProviderRegistry(
  config: MarketDataConfig,
  options: ProviderRegistryOptions = {},
): Promise<ProviderRegistry> {
  const coordinator = options.coordinator ?? createSharedRateBudgetCoordinator({ redisClient: options.redisClient });
  const cache = options.cache ?? new InMemoryProviderResponseCache();
  const fetchFn = options.fetchFn;

  // Validate GeckoTerminal Pro API key at startup when one is configured.
  // An invalid/expired key would cause ALL requests to fail with 401/403
  // instead of falling back to the free tier — fail loudly at startup so
  // operators catch the misconfiguration immediately.
  if (config.geckoterminal.apiKey) {
    await validateGeckoTerminalApiKey({
      apiKey: config.geckoterminal.apiKey,
      proBaseUrl: config.geckoterminal.proBaseUrl,
      timeoutMs: config.timeoutMs,
      fetchFn,
    });
  }

  const seenTracker: DiscoverySeenTracker =
    options.discoverySeenClient && config.discovery.antistalenessCooldownHours > 0
      ? new RedisDiscoverySeenTracker(
          options.discoverySeenClient,
          config.discovery.antistalenessTokenTtlHours * 60 * 60 * 1000,
        )
      : new NoopDiscoverySeenTracker();

  const dexscreenerBudget = splitBudget(
    config.dexscreener.search.requestsPerMinute + config.dexscreener.discovery.requestsPerMinute,
    (config.dexscreener.search.burstCapacity ?? config.dexscreener.search.requestsPerMinute)
      + (config.dexscreener.discovery.burstCapacity ?? config.dexscreener.discovery.requestsPerMinute),
    Math.max(config.dexscreener.search.maxWaitMs ?? 5_000, config.dexscreener.discovery.maxWaitMs ?? 5_000),
    'price-support',
    config.dexscreener.search.requestsPerMinute,
  );
  const geckoBudget = splitBudget(
    config.geckoterminal.candles.requestsPerMinute + config.geckoterminal.discovery.requestsPerMinute,
    (config.geckoterminal.candles.burstCapacity ?? config.geckoterminal.candles.requestsPerMinute)
      + (config.geckoterminal.discovery.burstCapacity ?? config.geckoterminal.discovery.requestsPerMinute),
    Math.max(config.geckoterminal.candles.maxWaitMs ?? 5_000, config.geckoterminal.discovery.maxWaitMs ?? 5_000),
    'regime',
    config.geckoterminal.candles.requestsPerMinute,
  );
  const hyperliquidBudget: SharedBudgetConfig = {
    requestsPerMinute: config.hyperliquid.intelligence.requestsPerMinute,
    burstCapacity: config.hyperliquid.intelligence.burstCapacity,
    maxWaitMs: config.hyperliquid.intelligence.maxWaitMs,
  };
  const bybitBudget: SharedBudgetConfig = {
    requestsPerMinute: config.bybit.intelligence.requestsPerMinute,
    burstCapacity: config.bybit.intelligence.burstCapacity,
    maxWaitMs: config.bybit.intelligence.maxWaitMs,
  };
  const bybitTickersBudget: SharedBudgetConfig = {
    requestsPerMinute: config.bybit.tickers.requestsPerMinute,
    burstCapacity: config.bybit.tickers.burstCapacity,
    maxWaitMs: config.bybit.tickers.maxWaitMs,
  };
  const binanceBudget: SharedBudgetConfig = {
    requestsPerMinute: config.binance.requestsPerMinute,
    burstCapacity: config.binance.requestsPerMinute,
    maxWaitMs: config.binance.maxWaitMs,
  };

  const dexscreenerSearchConfig: DexScreenerConfig = {
    baseUrl: config.dexscreener.baseUrl,
    timeoutMs: config.timeoutMs,
    rateLimiter: createLimiter(coordinator, 'dexscreener', 'price-support', dexscreenerBudget),
    fetchFn,
  };
  const dexscreenerDiscoveryConfig: DexScreenerConfig = {
    baseUrl: config.dexscreener.baseUrl,
    timeoutMs: config.timeoutMs,
    rateLimiter: createLimiter(coordinator, 'dexscreener', 'discovery', dexscreenerBudget),
    fetchFn,
  };
  const geckoCandleConfig: GeckoTerminalConfig = {
    baseUrl: config.geckoterminal.baseUrl,
    proBaseUrl: config.geckoterminal.proBaseUrl,
    apiKey: config.geckoterminal.apiKey,
    timeoutMs: config.timeoutMs,
    rateLimiter: createLimiter(coordinator, 'geckoterminal', 'regime', geckoBudget),
    fetchFn,
  };
  const geckoDiscoveryConfig: GeckoTerminalConfig = {
    baseUrl: config.geckoterminal.baseUrl,
    proBaseUrl: config.geckoterminal.proBaseUrl,
    apiKey: config.geckoterminal.apiKey,
    timeoutMs: config.timeoutMs,
    rateLimiter: createLimiter(coordinator, 'geckoterminal', 'discovery', geckoBudget),
    fetchFn,
  };
  const hyperliquidConfig: HyperliquidInfoConfig = {
    baseUrl: config.hyperliquid.baseUrl,
    intelligencePath: config.hyperliquid.intelligencePath,
    timeoutMs: config.timeoutMs,
    rateLimiter: createLimiter(coordinator, 'hyperliquid', 'price-support', hyperliquidBudget),
    fetchFn,
  };
  const bybitConfig: BybitInfoConfig = {
    baseUrl: config.bybit.baseUrl,
    longShortRatioPath: config.bybit.longShortRatioPath,
    timeoutMs: config.timeoutMs,
    rateLimiter: createLimiter(coordinator, 'bybit', 'price-support', bybitBudget),
    fetchFn,
  };
  const bybitTickersConfig: BybitTickersConfig = {
    baseUrl: config.bybit.baseUrl,
    timeoutMs: config.timeoutMs,
    rateLimiter: createLimiter(coordinator, 'bybit', 'price-support', bybitTickersBudget),
    fetchFn,
  };
  const binanceConfig: BinanceCandlesConfig = {
    baseUrl: config.binance.baseUrl,
    timeoutMs: config.timeoutMs,
    rateLimiter: createLimiter(coordinator, 'binance', 'regime', binanceBudget),
    fetchFn,
  };

  // CMC is opt-in — enabled without an API key is a loud startup error
  const cmcConfig: CoinMarketCapConfig | undefined = config.coinMarketCap.enabled
    ? (() => {
        if (!config.coinMarketCap.apiKey) {
          throw new Error('CoinMarketCap is enabled but no API key is configured');
        }
        const cmcBudget: SharedBudgetConfig = {
          requestsPerMinute: config.coinMarketCap.requestsPerMinute,
          burstCapacity: config.coinMarketCap.requestsPerMinute,
          maxWaitMs: config.timeoutMs,
        };
        return {
          baseUrl: config.coinMarketCap.baseUrl,
          apiKey: config.coinMarketCap.apiKey,
          discoveryRateLimiter: createLimiter(coordinator, 'coinmarketcap', 'discovery', cmcBudget),
          enrichmentRateLimiter: createLimiter(coordinator, 'coinmarketcap', 'enrichment', cmcBudget),
          timeoutMs: config.timeoutMs,
          fetchFn,
        };
      })()
    : undefined;

  // Birdeye is opt-in — enabled without an API key is a loud startup error
  const birdeyeConfig: BirdeyeConfig | undefined = config.birdeye.enabled
    ? (() => {
        if (!config.birdeye.apiKey) {
          throw new Error('Birdeye is enabled but no API key is configured');
        }
        const birdeyeBudget: SharedBudgetConfig = {
          requestsPerMinute: config.birdeye.requestsPerMinute,
          burstCapacity: config.birdeye.requestsPerMinute,
          maxWaitMs: config.timeoutMs,
        };
        return {
          baseUrl: config.birdeye.baseUrl,
          apiKey: config.birdeye.apiKey,
          rateLimiter: createLimiter(coordinator, 'birdeye', 'discovery', birdeyeBudget),
          timeoutMs: config.timeoutMs,
          fetchFn,
        };
      })()
    : undefined;

  return {
    binance: {
      candles: (symbol, options) => loadWithCache({
        provider: 'binance',
        requestClass: 'regime',
        cache,
        cacheKey: `binance:candles:${symbol}:${options?.interval ?? '1h'}:${options?.limit ?? 100}`,
        policy: { ttlMs: 0 },
        loader: () => fetchBinanceCandles(symbol, binanceConfig, options),
      }),
    },
    dexscreener: {
      search: (query) => loadWithCache({
        provider: 'dexscreener',
        requestClass: 'price-support',
        cache,
        cacheKey: `dexscreener:search:${query}`,
        policy: { ttlMs: config.dexscreener.search.cacheTtlMs ?? 0 },
        loader: () => fetchDexScreenerSearch(query, dexscreenerSearchConfig),
      }),
      trending: () => loadWithCache({
        provider: 'dexscreener',
        requestClass: 'discovery',
        cache,
        cacheKey: 'dexscreener:trending',
        policy: { ttlMs: config.dexscreener.discovery.cacheTtlMs ?? 0, staleWhileRevalidateMs: config.dexscreener.discovery.cacheTtlMs ?? 0 },
        loader: () => fetchDexScreenerTrending(dexscreenerDiscoveryConfig),
        allowStale: true,
      }),
      boostsLatest: () => loadWithCache({
        provider: 'dexscreener',
        requestClass: 'discovery',
        cache,
        cacheKey: 'dexscreener:boosts-latest',
        policy: { ttlMs: config.dexscreener.discovery.cacheTtlMs ?? 0, staleWhileRevalidateMs: config.dexscreener.discovery.cacheTtlMs ?? 0 },
        loader: () => fetchDexScreenerBoostsLatest(dexscreenerDiscoveryConfig),
        allowStale: true,
      }),
      profilesLatest: () => loadWithCache({
        provider: 'dexscreener',
        requestClass: 'discovery',
        cache,
        cacheKey: 'dexscreener:profiles-latest',
        policy: { ttlMs: config.dexscreener.discovery.cacheTtlMs ?? 0, staleWhileRevalidateMs: config.dexscreener.discovery.cacheTtlMs ?? 0 },
        loader: () => fetchDexScreenerProfilesLatest(dexscreenerDiscoveryConfig),
        allowStale: true,
      }),
      searchConfig: dexscreenerSearchConfig,
    },
    geckoterminal: {
      candles: (network, poolAddress, options) => loadWithCache({
        provider: 'geckoterminal',
        requestClass: 'regime',
        cache,
        cacheKey: `geckoterminal:candles:${network}:${poolAddress}:${options?.timeframe ?? 'hour'}:${options?.limit ?? 100}`,
        policy: { ttlMs: config.geckoterminal.candles.cacheTtlMs ?? 0 },
        loader: () => fetchGeckoTerminalCandles(network, poolAddress, geckoCandleConfig, options),
      }),
      trendingPools: (network) => loadWithCache({
        provider: 'geckoterminal',
        requestClass: 'discovery',
        cache,
        cacheKey: `geckoterminal:trending:${network}`,
        policy: { ttlMs: config.geckoterminal.discovery.cacheTtlMs ?? 0, staleWhileRevalidateMs: config.geckoterminal.discovery.cacheTtlMs ?? 0 },
        loader: () => fetchGeckoTerminalTrendingPools(network, geckoDiscoveryConfig),
        allowStale: true,
      }),
      topPools: (network) => loadWithCache({
        provider: 'geckoterminal',
        requestClass: 'discovery',
        cache,
        cacheKey: `geckoterminal:top:${network}`,
        policy: { ttlMs: config.geckoterminal.discovery.cacheTtlMs ?? 0, staleWhileRevalidateMs: config.geckoterminal.discovery.cacheTtlMs ?? 0 },
        loader: () => fetchGeckoTerminalTopPools(network, geckoDiscoveryConfig),
        allowStale: true,
      }),
      newPools: (network) => loadWithCache({
        provider: 'geckoterminal',
        requestClass: 'discovery',
        cache,
        cacheKey: `geckoterminal:new:${network}`,
        policy: { ttlMs: config.geckoterminal.discovery.cacheTtlMs ?? 0, staleWhileRevalidateMs: config.geckoterminal.discovery.cacheTtlMs ?? 0 },
        loader: () => fetchGeckoTerminalNewPools(network, geckoDiscoveryConfig),
        allowStale: true,
      }),
    },
    hyperliquid: {
      assetContexts: () => loadWithCache({
        provider: 'hyperliquid',
        requestClass: 'price-support',
        cache,
        cacheKey: 'hyperliquid:asset-contexts',
        policy: { ttlMs: config.hyperliquid.intelligence.cacheTtlMs ?? 0, staleWhileRevalidateMs: config.hyperliquid.intelligence.cacheTtlMs ?? 0 },
        loader: () => fetchHyperliquidAssetContexts(hyperliquidConfig),
        allowStale: true,
      }),
    },
    bybit: {
      longShortRatio: (symbol, ratioOptions) => loadWithCache({
        provider: 'bybit',
        requestClass: 'price-support',
        cache,
        cacheKey: `bybit:long-short:${symbol}:${ratioOptions?.period ?? '1h'}:${ratioOptions?.limit ?? 10}`,
        policy: { ttlMs: config.bybit.intelligence.cacheTtlMs ?? 0, staleWhileRevalidateMs: config.bybit.intelligence.cacheTtlMs ?? 0 },
        loader: () => fetchBybitLongShortRatio(symbol, bybitConfig, ratioOptions),
        allowStale: true,
      }),
      tickers: () => loadWithCache({
        provider: 'bybit',
        requestClass: 'price-support',
        cache,
        cacheKey: 'bybit:tickers',
        policy: { ttlMs: config.bybit.tickers.cacheTtlMs ?? 0, staleWhileRevalidateMs: config.bybit.tickers.cacheTtlMs ?? 0 },
        loader: () => fetchBybitTickers(bybitTickersConfig),
        allowStale: true,
      }),
    },
    birdeye: {
      tokenOverview: (address, chain) => loadWithCache({
        provider: 'birdeye',
        requestClass: 'discovery',
        cache,
        cacheKey: `birdeye:overview:${chain}:${address}`,
        policy: { ttlMs: config.birdeye.cacheTtlMs },
        loader: () => {
          if (!birdeyeConfig) return Promise.resolve(null);
          return fetchBirdeyeTokenOverview(address, chain, birdeyeConfig);
        },
      }),
      ohlcv: (address, chain, interval) => loadWithCache({
        provider: 'birdeye',
        requestClass: 'discovery',
        cache,
        cacheKey: `birdeye:ohlcv:${chain}:${address}:${interval}`,
        policy: { ttlMs: config.birdeye.cacheTtlMs },
        loader: () => {
          if (!birdeyeConfig) return Promise.resolve([]);
          return fetchBirdeyeOhlcv(address, chain, interval, birdeyeConfig);
        },
      }),
    },
    discovery: {
      discover: (discoveryOptions) => {
        const maxResults = discoveryOptions?.maxResults ?? config.discovery.maxResults;
        return loadWithCache({
          provider: 'aggregated-discovery',
          requestClass: 'discovery',
          cache,
          cacheKey: `discovery:${(discoveryOptions?.networks ?? []).join(',')}:${maxResults}:${discoveryOptions?.minLiquidityUsd ?? 10_000}`,
          policy: (() => {
            const baseTtl = Math.min(
              config.dexscreener.discovery.cacheTtlMs ?? 0,
              config.geckoterminal.discovery.cacheTtlMs ?? 0,
            );
            const withCmc = config.coinMarketCap.enabled
              ? Math.min(baseTtl, config.coinMarketCap.cacheTtlMs)
              : baseTtl;
            const ttlMs = config.birdeye.enabled
              ? Math.min(withCmc, config.birdeye.cacheTtlMs)
              : withCmc;
            return { ttlMs, staleWhileRevalidateMs: ttlMs };
          })(),
          loader: () => discoverTokens({
            dexscreener: dexscreenerDiscoveryConfig,
            geckoterminal: geckoDiscoveryConfig,
            coinmarketcap: cmcConfig,
            birdeye: birdeyeConfig,
            networks: discoveryOptions?.networks ?? ['solana', 'base'],
            maxResults,
            minLiquidityUsd: discoveryOptions?.minLiquidityUsd,
            extraGeckoTerminalPages: config.discovery.geckoTerminalExtraPages,
            antistalenessCooldownHours: config.discovery.antistalenessCooldownHours,
            seenTracker,
          }),
          allowStale: true,
        });
      },
    },
    configs: {
      binance: binanceConfig,
      geckoterminal: geckoCandleConfig,
    },
  };
}
