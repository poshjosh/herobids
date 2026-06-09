import { describe, expect, it } from 'vitest';
import { createProviderRegistry } from './provider-registry.js';
import { InMemoryProviderResponseCache, loadWithCache } from './cache.js';

function createConfig() {
  return {
    timeoutMs: 5_000,
    dexscreener: {
      baseUrl: 'https://api.dexscreener.com',
      search: { requestsPerMinute: 30, cacheTtlMs: 15_000 },
      discovery: { requestsPerMinute: 30, cacheTtlMs: 60_000 },
    },
    geckoterminal: {
      baseUrl: 'https://api.geckoterminal.com',
      candles: { requestsPerMinute: 15, cacheTtlMs: 60_000 },
      discovery: { requestsPerMinute: 10, cacheTtlMs: 60_000 },
    },
    hyperliquid: {
      baseUrl: 'https://api.hyperliquid.xyz',
      intelligencePath: '/info',
      intelligence: { requestsPerMinute: 120, cacheTtlMs: 60_000 },
    },
    bybit: {
      baseUrl: 'https://api.bybit.com',
      longShortRatioPath: '/v5/market/account-ratio',
      intelligence: { requestsPerMinute: 120, cacheTtlMs: 60_000 },
    },
    binance: {
      baseUrl: 'https://api.binance.com',
      requestsPerMinute: 200,
    },
    birdeye: {
      enabled: false,
      baseUrl: 'https://public-api.birdeye.so',
      requestsPerMinute: 60,
      apiKey: '',
      cacheTtlMs: 3_600_000,
    },
    coinMarketCap: {
      enabled: false,
      baseUrl: 'https://pro-api.coinmarketcap.com',
      requestsPerMinute: 30,
      apiKey: '',
      cacheTtlMs: 3_600_000,
    },
  };
}

describe('createProviderRegistry', () => {
  it('returns cached provider responses with freshness metadata', async () => {
    let now = 0;
    let fetchCalls = 0;
    const registry = createProviderRegistry(createConfig(), {
      fetchFn: async () => {
        fetchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ([
            { universe: [{ name: 'BTC' }] },
            [{ funding: '0.0001', openInterest: '100', markPx: '100', oraclePx: '99', dayNtlVlm: '12345', prevDayPx: '95' }],
          ]),
        } as Response;
      },
      cache: {
        get(key) {
          const internal = (this as { state?: Map<string, { value: unknown; storedAt: number; expiresAt: number }> }).state ?? new Map();
          (this as { state: Map<string, { value: unknown; storedAt: number; expiresAt: number }> }).state = internal;
          const entry = internal.get(key);
          if (!entry || now > entry.expiresAt) {
            return undefined;
          }
          return {
            value: entry.value,
            storedAt: entry.storedAt,
            ageMs: now - entry.storedAt,
            ttlMs: entry.expiresAt - entry.storedAt,
            expiresAt: entry.expiresAt,
            isStale: false,
          };
        },
        set(key, value, policy) {
          const internal = (this as { state?: Map<string, { value: unknown; storedAt: number; expiresAt: number }> }).state ?? new Map();
          (this as { state: Map<string, { value: unknown; storedAt: number; expiresAt: number }> }).state = internal;
          internal.set(key, { value, storedAt: now, expiresAt: now + policy.ttlMs });
        },
        delete() {},
      },
    });

    const first = await registry.hyperliquid.assetContexts();
    now += 5_000;
    const second = await registry.hyperliquid.assetContexts();

    expect(fetchCalls).toBe(1);
    expect(first.meta.freshness.source).toBe('upstream');
    expect(second.meta.freshness.source).toBe('cache');
    expect(second.meta.freshness.ageMs).toBe(5_000);
    expect(second.data[0]?.annualizedFundingRatePct).toBeCloseTo(87.6, 5);
  });
});

describe('loadWithCache', () => {
  it('revalidates stale entries when refresh succeeds', async () => {
    const cache = new InMemoryProviderResponseCache();
    const now = 1_000;
    cache.set('k', 'old', { ttlMs: 100, staleWhileRevalidateMs: 100 }, now - 150);

    let loaderCalls = 0;
    const result = await loadWithCache({
      provider: 'dexscreener',
      requestClass: 'discovery',
      cache,
      cacheKey: 'k',
      policy: { ttlMs: 100, staleWhileRevalidateMs: 100 },
      allowStale: true,
      now,
      loader: async () => {
        loaderCalls += 1;
        return 'fresh';
      },
    });

    expect(loaderCalls).toBe(1);
    expect(result.data).toBe('fresh');
    expect(result.meta.freshness.source).toBe('upstream');
    expect(result.meta.freshness.isStale).toBe(false);
  });

  it('falls back to stale data when refresh fails inside the revalidate window', async () => {
    const cache = new InMemoryProviderResponseCache();
    const now = 1_000;
    cache.set('k', 'old', { ttlMs: 100, staleWhileRevalidateMs: 100 }, now - 150);

    let loaderCalls = 0;
    const result = await loadWithCache({
      provider: 'dexscreener',
      requestClass: 'discovery',
      cache,
      cacheKey: 'k',
      policy: { ttlMs: 100, staleWhileRevalidateMs: 100 },
      allowStale: true,
      now,
      loader: async () => {
        loaderCalls += 1;
        throw new Error('upstream down');
      },
    });

    expect(loaderCalls).toBe(1);
    expect(result.data).toBe('old');
    expect(result.meta.freshness.source).toBe('cache');
    expect(result.meta.freshness.isStale).toBe(true);
  });

  it('does not return stale data when allowStale is false', async () => {
    const cache = new InMemoryProviderResponseCache();
    const now = 1_000;
    cache.set('k', 'old', { ttlMs: 100, staleWhileRevalidateMs: 100 }, now - 150);

    await expect(loadWithCache({
      provider: 'dexscreener',
      requestClass: 'discovery',
      cache,
      cacheKey: 'k',
      policy: { ttlMs: 100, staleWhileRevalidateMs: 100 },
      allowStale: false,
      now,
      loader: async () => 'fresh',
    })).resolves.toMatchObject({ data: 'fresh', meta: { freshness: { source: 'upstream' } } });
  });
});

// Regression: bug — stale-while-revalidate window was treated as a terminal cache
// hit rather than a trigger for background refresh. loadWithCache() must attempt
// a refresh on stale entries and only serve stale data when the upstream fails.
describe('loadWithCache — stale-while-revalidate semantics', () => {
  function makeCache(seedValue?: string, seedTime?: number): InMemoryProviderResponseCache {
    const cache = new InMemoryProviderResponseCache();
    if (seedValue !== undefined && seedTime !== undefined) {
      // Seed with a short TTL so the entry is immediately stale but still within
      // the staleWhileRevalidateMs window.
      cache.set('k', seedValue, { ttlMs: 1_000, staleWhileRevalidateMs: 60_000 }, seedTime - 5_000);
    }
    return cache;
  }

  const baseParams = {
    provider: 'dexscreener' as const,
    requestClass: 'discovery' as const,
    cacheKey: 'k',
    policy: { ttlMs: 5_000, staleWhileRevalidateMs: 60_000 },
  };

  it('calls the loader and returns fresh upstream data when the cache is stale and the refresh succeeds', async () => {
    let loaderCalls = 0;
    const cache = makeCache('old-value', Date.now());

    const result = await loadWithCache({
      ...baseParams,
      cache,
      loader: async () => { loaderCalls++; return 'new-value'; },
      allowStale: true,
    });

    expect(loaderCalls).toBe(1);
    expect(result.data).toBe('new-value');
    expect(result.meta.freshness.source).toBe('upstream');
    expect(result.meta.freshness.isStale).toBe(false);
  });

  it('falls back to the stale entry when the cache is stale and the refresh fails', async () => {
    let loaderCalls = 0;
    const cache = makeCache('old-value', Date.now());

    const result = await loadWithCache({
      ...baseParams,
      cache,
      loader: async () => { loaderCalls++; throw new Error('upstream down'); },
      allowStale: true,
    });

    expect(loaderCalls).toBe(1);
    expect(result.data).toBe('old-value');
    expect(result.meta.freshness.source).toBe('cache');
    expect(result.meta.freshness.isStale).toBe(true);
  });

  it('propagates the refresh error when allowStale is false and the cache is stale', async () => {
    const cache = makeCache('old-value', Date.now());

    await expect(loadWithCache({
      ...baseParams,
      cache,
      loader: async () => { throw new Error('upstream down'); },
      allowStale: false,
    })).rejects.toThrow('upstream down');
  });
});