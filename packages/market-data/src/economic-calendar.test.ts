import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ForexFactoryCalendarAdapter,
  CompositeEconomicCalendarProvider,
  type ForexFactoryAdapterConfig,
  type CompositeEconomicCalendarConfig,
} from './economic-calendar.js';
import { RedisProviderResponseCache, type RedisCacheClient } from './redis-cache.js';
import type { RequestGate } from './types.js';
import type { EconomicEvent } from '@herobids/domain';

// ============================================================================
// Helpers
// ============================================================================

function createNoopRateLimiter(): RequestGate {
  return { acquire: vi.fn().mockResolvedValue(undefined) };
}

function createMockFetch(
  body: string,
  status = 200,
  contentType = 'text/html',
): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => {
      try {
        return JSON.parse(body);
      } catch {
        throw new Error('Invalid JSON');
      }
    },
  })) as unknown as typeof fetch;
}

function makeEvent(overrides: Partial<EconomicEvent> & { time: string; currency: string; event: string }): EconomicEvent {
  return {
    impact: 'medium',
    forecast: null,
    previous: null,
    sources: ['forex-factory'],
    ...overrides,
  };
}

function baseForexFactoryConfig(overrides: Partial<ForexFactoryAdapterConfig> = {}): ForexFactoryAdapterConfig {
  return {
    baseUrl: 'https://www.forexfactory.com',
    requestTimeoutMs: 10_000,
    requestsPerMinute: 60,
    userAgent: 'Mozilla/5.0',
    rateLimiter: createNoopRateLimiter(),
    ...overrides,
  };
}

function baseCompositeConfig(overrides: Partial<CompositeEconomicCalendarConfig> = {}): CompositeEconomicCalendarConfig {
  return {
    daysForward: 7,
    minImpact: 'low',
    currencies: [],
    maxEvents: 50,
    forexFactory: baseForexFactoryConfig(),
    ...overrides,
  };
}

function createMockRedisClient(): RedisCacheClient & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, _expiryMode?: 'PX' | 'EX', _time?: number) {
      store.set(key, value);
      return 'OK';
    },
    async del(key: string) {
      store.delete(key);
      return 1;
    },
  };
}

// ============================================================================
// ForexFactoryCalendarAdapter — LLM parser
// ============================================================================

describe('ForexFactoryCalendarAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mockEvents(events: EconomicEvent[]): (html: string) => Promise<EconomicEvent[]> {
    return async () => events;
  }

  it('delegates to parseHtmlFn and returns events', async () => {
    const adapter = new ForexFactoryCalendarAdapter(
      baseForexFactoryConfig({
        fetchFn: createMockFetch('<html>calendar</html>'),
        parseHtmlFn: mockEvents([
          makeEvent({ time: '2026-07-09T18:00:00Z', currency: 'USD', event: 'FOMC Statement', impact: 'high', previous: '5.50%' }),
          makeEvent({ time: '2026-07-10T12:30:00Z', currency: 'EUR', event: 'CPI m/m', impact: 'medium', forecast: '0.2%', previous: '0.1%' }),
        ]),
      }),
    );

    const result = await adapter.getUpcomingEvents({ daysForward: 365 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    expect(result.data.events).toHaveLength(2);
    expect(result.data.events[0]!.event).toBe('FOMC Statement');
  });

  it('applies currency filter', async () => {
    const adapter = new ForexFactoryCalendarAdapter(
      baseForexFactoryConfig({
        fetchFn: createMockFetch('<html>x</html>'),
        parseHtmlFn: mockEvents([
          makeEvent({ time: '2026-07-09T14:00:00Z', currency: 'USD', event: 'FOMC', impact: 'high' }),
          makeEvent({ time: '2026-07-09T15:00:00Z', currency: 'EUR', event: 'ECB', impact: 'medium' }),
        ]),
      }),
    );

    const result = await adapter.getUpcomingEvents({ currencies: ['USD'], daysForward: 365 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    expect(result.data.events).toHaveLength(1);
    expect(result.data.events[0]!.currency).toBe('USD');
  });

  it('returns error when no parseHtmlFn configured', async () => {
    const adapter = new ForexFactoryCalendarAdapter(
      baseForexFactoryConfig({ fetchFn: createMockFetch('<html>x</html>') }),
    );

    const result = await adapter.getUpcomingEvents();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.error.code).toBe('economic-calendar.no_parser');
  });

  it('returns error when fetch fails', async () => {
    const adapter = new ForexFactoryCalendarAdapter(
      baseForexFactoryConfig({
        fetchFn: createMockFetch('', 500),
        parseHtmlFn: mockEvents([]),
      }),
    );

    const result = await adapter.getUpcomingEvents();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.error.code).toBe('economic-calendar.fetch_failed');
  });

  it('returns error when parseHtmlFn throws', async () => {
    const adapter = new ForexFactoryCalendarAdapter(
      baseForexFactoryConfig({
        fetchFn: createMockFetch('<html>x</html>'),
        parseHtmlFn: async () => { throw new Error('LLM down'); },
      }),
    );

    const result = await adapter.getUpcomingEvents();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.error.code).toBe('economic-calendar.fetch_failed');
  });
});

// ============================================================================
// Composite — single-source (Forex Factory)
// ============================================================================

describe('CompositeEconomicCalendarProvider — single source', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mockParser(events: EconomicEvent[]) {
    return async () => events;
  }

  it('delegates to adapter and returns events', async () => {
    const provider = new CompositeEconomicCalendarProvider(
      baseCompositeConfig({
        daysForward: 365,
        forexFactory: baseForexFactoryConfig({
          fetchFn: createMockFetch('<html>x</html>'),
          parseHtmlFn: mockParser([
            makeEvent({ time: '2026-07-09T18:00:00Z', currency: 'USD', event: 'FOMC Statement', impact: 'high', previous: '5.50%' }),
          ]),
        }),
      }),
    );

    const result = await provider.getUpcomingEvents();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    expect(result.data.events).toHaveLength(1);
    expect(result.data.events[0]!.event).toBe('FOMC Statement');
    expect(result.data.sources).toEqual(['forex-factory']);
  });

  it('sorts events by time ascending', async () => {
    const provider = new CompositeEconomicCalendarProvider(
      baseCompositeConfig({
        daysForward: 365,
        forexFactory: baseForexFactoryConfig({
          fetchFn: createMockFetch('<html>x</html>'),
          parseHtmlFn: mockParser([
            makeEvent({ time: '2026-07-10T14:00:00Z', currency: 'USD', event: 'CPI m/m', impact: 'high' }),
            makeEvent({ time: '2026-07-09T18:00:00Z', currency: 'USD', event: 'FOMC Statement', impact: 'high' }),
          ]),
        }),
      }),
    );

    const result = await provider.getUpcomingEvents();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    expect(result.data.events[0]!.event).toBe('FOMC Statement');
    expect(result.data.events[1]!.event).toBe('CPI m/m');
  });

  it('truncates to maxEvents', async () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ time: `2026-07-${String(8 + i).padStart(2, '0')}T14:00:00Z`, currency: 'USD', event: `Event ${i}`, impact: 'high' }),
    );

    const provider = new CompositeEconomicCalendarProvider(
      baseCompositeConfig({
        daysForward: 365,
        maxEvents: 3,
        forexFactory: baseForexFactoryConfig({
          fetchFn: createMockFetch('<html>x</html>'),
          parseHtmlFn: mockParser(events),
        }),
      }),
    );

    const result = await provider.getUpcomingEvents();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    expect(result.data.events).toHaveLength(3);
  });

  it('returns error when Forex Factory fails', async () => {
    const provider = new CompositeEconomicCalendarProvider(
      baseCompositeConfig({
        forexFactory: baseForexFactoryConfig({
          fetchFn: createMockFetch('', 500),
          parseHtmlFn: mockParser([]),
        }),
      }),
    );

    const result = await provider.getUpcomingEvents();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.error.code).toBe('economic-calendar.fetch_failed');
  });
});

// ============================================================================
// Redis cache behavior
// ============================================================================

describe('RedisProviderResponseCache', () => {
  let redis: RedisCacheClient & { _store: Map<string, string> };
  let cache: RedisProviderResponseCache;

  beforeEach(() => {
    redis = createMockRedisClient();
    cache = new RedisProviderResponseCache(redis, 'test:');
  });

  it('cache miss returns undefined', async () => {
    const result = await cache.get('nonexistent');
    expect(result).toBeUndefined();
  });

  it('cache hit (fresh) returns cached value with isStale=false', async () => {
    const now = Date.now();
    await cache.set('key1', { hello: 'world' }, { ttlMs: 60_000, staleWhileRevalidateMs: 30_000 }, now);

    const result = await cache.get('key1', now + 10_000);
    expect(result).toBeDefined();
    expect(result!.value).toEqual({ hello: 'world' });
    expect(result!.isStale).toBe(false);
  });

  it('cache hit (stale) returns stale value with isStale=true', async () => {
    const now = Date.now();
    await cache.set('key2', { foo: 'bar' }, { ttlMs: 60_000, staleWhileRevalidateMs: 30_000 }, now);

    const result = await cache.get('key2', now + 70_000); // Past TTL but within stale window
    expect(result).toBeDefined();
    expect(result!.value).toEqual({ foo: 'bar' });
    expect(result!.isStale).toBe(true);
  });

  it('cache fully expired (beyond staleAt) returns undefined', async () => {
    const now = Date.now();
    await cache.set('key3', { baz: 'qux' }, { ttlMs: 60_000, staleWhileRevalidateMs: 30_000 }, now);

    const result = await cache.get('key3', now + 100_000); // Past staleAt
    expect(result).toBeUndefined();
    // Should also be evicted from store
    expect(redis._store.has('test:key3')).toBe(false);
  });

  it('set stores value with correct TTL', async () => {
    const now = Date.now();
    await cache.set('key4', { a: 1 }, { ttlMs: 120_000, staleWhileRevalidateMs: 60_000 }, now);

    const raw = redis._store.get('test:key4');
    expect(raw).toBeDefined();

    const parsed = JSON.parse(raw!);
    expect(parsed.value).toEqual({ a: 1 });
    expect(parsed.storedAt).toBe(now);
    expect(parsed.expiresAt).toBe(now + 120_000);
    expect(parsed.staleAt).toBe(now + 180_000);
  });

  it('Redis error on get returns undefined (graceful degradation)', async () => {
    const brokenRedis: RedisCacheClient = {
      get: async () => { throw new Error('Connection lost'); },
      set: async () => 'OK',
      del: async () => 1,
    };
    const brokenCache = new RedisProviderResponseCache(brokenRedis, 'test:');

    const result = await brokenCache.get('anything');
    expect(result).toBeUndefined();
  });

  it('Redis error on set does not throw (graceful degradation)', async () => {
    const brokenRedis: RedisCacheClient = {
      get: async () => null,
      set: async () => { throw new Error('Connection lost'); },
      del: async () => 1,
    };
    const brokenCache = new RedisProviderResponseCache(brokenRedis, 'test:');

    await expect(
      brokenCache.set('key', { x: 1 }, { ttlMs: 60_000 }),
    ).resolves.toBeUndefined();
  });

  it('delete removes the key', async () => {
    await cache.set('key5', { val: 1 }, { ttlMs: 60_000 });
    expect(redis._store.has('test:key5')).toBe(true);

    await cache.delete('key5');
    expect(redis._store.has('test:key5')).toBe(false);
  });

  it('get with zero TTL returns undefined if expired immediately', async () => {
    const now = Date.now();
    await cache.set('key6', { val: 1 }, { ttlMs: 0, staleWhileRevalidateMs: 0 }, now);

    const result = await cache.get('key6', now + 1);
    expect(result).toBeUndefined();
  });
});

// ============================================================================
// Composite with Redis cache
// ============================================================================

describe('CompositeEconomicCalendarProvider — cache integration', () => {
  let redis: RedisCacheClient & { _store: Map<string, string> };
  let cache: RedisProviderResponseCache;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    redis = createMockRedisClient();
    cache = new RedisProviderResponseCache(redis, 'test:');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves from cache on second call (fresh hit)', async () => {
    const config = baseCompositeConfig({
      cache,
      cacheTtlMs: 300_000,
      forexFactory: baseForexFactoryConfig({
        fetchFn: createMockFetch('<html>x</html>'),
        parseHtmlFn: async () => [
          makeEvent({ time: '2026-07-09T18:00:00Z', currency: 'USD', event: 'FOMC', impact: 'high' }),
        ],
      }),
    });

    const provider = new CompositeEconomicCalendarProvider(config);

    // First call — should fetch
    const result1 = await provider.getUpcomingEvents({ daysForward: 365 });
    expect(result1.ok).toBe(true);

    // Second call — should hit cache (no extra fetch needed)
    const result2 = await provider.getUpcomingEvents({ daysForward: 365 });
    expect(result2.ok).toBe(true);
    if (!result2.ok) throw new Error('Expected ok result');
    expect(result2.data.events).toHaveLength(1);
    expect(result2.data.events[0]!.event).toBe('FOMC');
  });
});
