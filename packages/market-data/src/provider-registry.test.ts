import { describe, expect, it, vi } from 'vitest';
import { createProviderRegistry } from './provider-registry.js';
import { InMemoryProviderResponseCache, loadWithCache } from './cache.js';
import { type SharedBudgetAcquireRequest, type SharedRateBudgetCoordinator } from './rate-limiter.js';

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
      tickers: { requestsPerMinute: 30 },
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
    discovery: { maxResults: 50, geckoTerminalExtraPages: 0, antistalenessCooldownHours: 4, antistalenessTokenTtlHours: 24 },
  };
}

describe('createProviderRegistry', () => {
  it('returns cached provider responses with freshness metadata', async () => {
    let now = 0;
    let fetchCalls = 0;
    const registry = await createProviderRegistry(createConfig(), {
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

  it('uses config.discovery.maxResults as the default when discoveryOptions.maxResults is absent', async () => {
    const config = {
      ...createConfig(),
      discovery: { maxResults: 3, geckoTerminalExtraPages: 0, antistalenessCooldownHours: 0, antistalenessTokenTtlHours: 24 },
    };
    const registry = await createProviderRegistry(config, {
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('token-boosts') || url.includes('token-profiles')) {
          return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
        }
        if (url.includes('trending_pools')) {
          return {
            ok: true, status: 200, statusText: 'OK',
            json: async () => ({
              data: Array.from({ length: 5 }, (_, i) => ({
                id: `pool-${i}`,
                attributes: { address: `pool-${i}`, base_token_price_usd: '1.0', volume_usd: { h24: '10000' }, reserve_in_usd: '20000' },
                relationships: { base_token: { data: { id: `bt-${i}` } }, quote_token: { data: { id: 'qt-u' } } },
              })),
              included: [
                ...Array.from({ length: 5 }, (_, i) => ({ id: `bt-${i}`, attributes: { address: `token-${i}`, symbol: `TK${i}`, name: `Token${i}` } })),
                { id: 'qt-u', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
              ],
            }),
          } as Response;
        }
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
      },
    });
    const result = await registry.discovery.discover({ networks: ['solana'], minLiquidityUsd: 0 });
    expect(result.data).toHaveLength(3);
  });

  it('uses discoveryOptions.maxResults when explicitly provided, overriding the config default', async () => {
    const registry = await createProviderRegistry(createConfig(), {
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('token-boosts') || url.includes('token-profiles')) {
          return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
        }
        if (url.includes('trending_pools')) {
          return {
            ok: true, status: 200, statusText: 'OK',
            json: async () => ({
              data: Array.from({ length: 5 }, (_, i) => ({
                id: `pool-${i}`,
                attributes: { address: `pool-${i}`, base_token_price_usd: '1.0', volume_usd: { h24: '10000' }, reserve_in_usd: '20000' },
                relationships: { base_token: { data: { id: `bt-${i}` } }, quote_token: { data: { id: 'qt-u' } } },
              })),
              included: [
                ...Array.from({ length: 5 }, (_, i) => ({ id: `bt-${i}`, attributes: { address: `token-${i}`, symbol: `TK${i}`, name: `Token${i}` } })),
                { id: 'qt-u', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
              ],
            }),
          } as Response;
        }
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
      },
    });
    const result = await registry.discovery.discover({ networks: ['solana'], maxResults: 2, minLiquidityUsd: 0 });
    expect(result.data).toHaveLength(2);
  });

  it('creates a RedisDiscoverySeenTracker and calls markSeen when discoverySeenClient is provided and antistalenessCooldownHours > 0', async () => {
    const zadd = vi.fn().mockResolvedValue(1);
    const zrangebyscore = vi.fn().mockResolvedValue([]);
    const zremrangebyscore = vi.fn().mockResolvedValue(1);
    const config = {
      ...createConfig(),
      discovery: { maxResults: 50, geckoTerminalExtraPages: 0, antistalenessCooldownHours: 1, antistalenessTokenTtlHours: 24 },
    };
    const registry = await createProviderRegistry(config, {
      discoverySeenClient: { zadd, zrangebyscore, zremrangebyscore },
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('token-boosts') || url.includes('token-profiles')) {
          return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
        }
        if (url.includes('trending_pools')) {
          return {
            ok: true, status: 200, statusText: 'OK',
            json: async () => ({
              data: [{ id: 'pool-1', attributes: { address: 'pool-1', base_token_price_usd: '1.0', volume_usd: { h24: '10000' }, reserve_in_usd: '20000' }, relationships: { base_token: { data: { id: 'bt-1' } }, quote_token: { data: { id: 'qt-u' } } } }],
              included: [{ id: 'bt-1', attributes: { address: 'token-1', symbol: 'TK1', name: 'Token1' } }, { id: 'qt-u', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } }],
            }),
          } as Response;
        }
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
      },
    });
    await registry.discovery.discover({ networks: ['solana'], minLiquidityUsd: 0 });
    expect(zadd).toHaveBeenCalled();
  });

  it('uses NoopDiscoverySeenTracker and does not call discoverySeenClient methods when antistalenessCooldownHours is 0', async () => {
    const zadd = vi.fn().mockResolvedValue(1);
    const zrangebyscore = vi.fn().mockResolvedValue([]);
    const zremrangebyscore = vi.fn().mockResolvedValue(1);
    const config = {
      ...createConfig(),
      discovery: { maxResults: 50, geckoTerminalExtraPages: 0, antistalenessCooldownHours: 0, antistalenessTokenTtlHours: 24 },
    };
    const registry = await createProviderRegistry(config, {
      discoverySeenClient: { zadd, zrangebyscore, zremrangebyscore },
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('token-boosts') || url.includes('token-profiles')) {
          return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
        }
        if (url.includes('trending_pools')) {
          return {
            ok: true, status: 200, statusText: 'OK',
            json: async () => ({
              data: [{ id: 'pool-1', attributes: { address: 'pool-1', base_token_price_usd: '1.0', volume_usd: { h24: '10000' }, reserve_in_usd: '20000' }, relationships: { base_token: { data: { id: 'bt-1' } }, quote_token: { data: { id: 'qt-u' } } } }],
              included: [{ id: 'bt-1', attributes: { address: 'token-1', symbol: 'TK1', name: 'Token1' } }, { id: 'qt-u', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } }],
            }),
          } as Response;
        }
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
      },
    });
    await registry.discovery.discover({ networks: ['solana'], minLiquidityUsd: 0 });
    expect(zadd).not.toHaveBeenCalled();
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

describe('createProviderRegistry — CMC disabled-provider skipping', () => {
  it('does not call CMC when coinMarketCap.enabled is false', async () => {
    let cmcCalled = false;

    const registry = await createProviderRegistry(createConfig(), {
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('coinmarketcap.com')) {
          cmcCalled = true;
        }
        // Return empty DexScreener lists
        if (url.includes('token-boosts') || url.includes('token-profiles')) {
          return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
        }
        // Return a valid GeckoTerminal pool so discovery doesn't throw
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            data: [{
              id: 'pool-reg',
              attributes: { address: 'pool-reg', base_token_price_usd: '1.0', volume_usd: { h24: '50000' }, reserve_in_usd: '100000' },
              relationships: { base_token: { data: { id: 'bt-r' } }, quote_token: { data: { id: 'qt-r' } } },
            }],
            included: [
              { id: 'bt-r', attributes: { address: 'reg-addr', symbol: 'REG', name: 'RegToken' } },
              { id: 'qt-r', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
            ],
          }),
        } as Response;
      },
    });

    await registry.discovery.discover({ networks: ['solana'], minLiquidityUsd: 0 });

    expect(cmcCalled).toBe(false);
  });

  it('throws when coinMarketCap.enabled is true and apiKey is empty', async () => {
    await expect(createProviderRegistry({
      ...createConfig(),
      coinMarketCap: {
        enabled: true,
        baseUrl: 'https://pro-api.coinmarketcap.com',
        requestsPerMinute: 30,
        apiKey: '',
        cacheTtlMs: 3_600_000,
      },
    })).rejects.toThrow('CoinMarketCap is enabled but no API key is configured');
  });
});

describe('createProviderRegistry — CMC shared budget', () => {
  it('passes the configured CMC RPM to both discovery and enrichment limiters', async () => {
    const requests: SharedBudgetAcquireRequest[] = [];
    const coordinator: SharedRateBudgetCoordinator = {
      async acquire(request) {
        requests.push(request);
        return { waitMs: 0, remainingTokens: 1 };
      },
    };

    const registry = await createProviderRegistry({
      ...createConfig(),
      coinMarketCap: {
        enabled: true,
        baseUrl: 'https://pro-api.coinmarketcap.com',
        requestsPerMinute: 30,
        apiKey: 'test-key',
        cacheTtlMs: 3_600_000,
      },
    }, {
      coordinator,
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('coinmarketcap.com') && url.includes('quotes/latest')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ data: { REG: [{ symbol: 'REG', platform: { slug: 'solana', token_address: 'reg-addr' }, quote: { USD: { market_cap: 1_000_000 } } }] } }),
          } as Response;
        }
        if (url.includes('coinmarketcap.com')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ data: [{ symbol: 'REG', platform: { slug: 'solana', token_address: 'reg-addr' }, quote: { USD: { market_cap: 1_000_000 } } }] }),
          } as Response;
        }
        if (url.includes('token-boosts') || url.includes('token-profiles')) {
          return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
        }
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            data: [{
              id: 'pool-reg',
              attributes: { address: 'pool-reg', base_token_price_usd: '1.0', volume_usd: { h24: '50000' }, reserve_in_usd: '100000' },
              relationships: { base_token: { data: { id: 'bt-r' } }, quote_token: { data: { id: 'qt-r' } } },
            }],
            included: [
              { id: 'bt-r', attributes: { address: 'reg-addr', symbol: 'REG', name: 'RegToken' } },
              { id: 'qt-r', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
            ],
          }),
        } as Response;
      },
    });

    await registry.discovery.discover({ networks: ['solana'], minLiquidityUsd: 0 });

    const cmcRequests = requests.filter((request) => request.provider === 'coinmarketcap');
    expect(cmcRequests).toHaveLength(3);
    expect(new Set(cmcRequests.map((request) => request.requestClass))).toEqual(new Set(['discovery', 'enrichment']));
    expect(cmcRequests.every((request) => request.budget.requestsPerMinute === 30)).toBe(true);
  });
});