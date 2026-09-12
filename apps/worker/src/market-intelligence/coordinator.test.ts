import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  onLeaderAcquired: undefined as (() => void) | undefined,
  createLeaderElectionMock: vi.fn(() => ({
    acquire: vi.fn().mockResolvedValue(true),
    renew: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
    isLeader: vi.fn(() => false),
    start: vi.fn((acquired: () => void) => {
      mockState.onLeaderAcquired = acquired;
    }),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('./leader-election.js', () => ({
  createLeaderElection: mockState.createLeaderElectionMock,
}));

import { createMarketDataCoordinator } from './coordinator.js';

function makeRedisMock() {
  const store = new Map<string, string>();
  const hashStore = new Map<string, Map<string, string>>();

  const pipeline = {
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return pipeline;
    }),
    exec: vi.fn().mockResolvedValue([]),
  };

  const multi = {
    hincrby: vi.fn((key: string, field: string, by: number) => {
      let hash = hashStore.get(key);
      if (!hash) { hash = new Map(); hashStore.set(key, hash); }
      const prev = parseInt(hash.get(field) ?? '0', 10);
      hash.set(field, String(prev + by));
      return multi;
    }),
    hset: vi.fn((key: string, field: string, value: string) => {
      let hash = hashStore.get(key);
      if (!hash) { hash = new Map(); hashStore.set(key, hash); }
      hash.set(field, value);
      return multi;
    }),
    exec: vi.fn().mockResolvedValue([]),
  };

  return {
    _store: store,
    _hashStore: hashStore,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      let deleted = 0;
      for (const key of keys) {
        if (store.delete(key)) {
          deleted++;
        }
      }
      return deleted;
    }),
    hincrby: vi.fn(async (key: string, field: string, by: number) => {
      let hash = hashStore.get(key);
      if (!hash) { hash = new Map(); hashStore.set(key, hash); }
      const prev = parseInt(hash.get(field) ?? '0', 10);
      const next = prev + by;
      hash.set(field, String(next));
      return next;
    }),
    scan: vi.fn(async () => ['0', []]),
    pipeline: vi.fn(() => pipeline),
    multi: vi.fn(() => multi),
  } as any;
}

function makeProviderRegistryMock() {
  return {
    discovery: {
      discover: vi.fn(() => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('discovery failed')), 1_000);
      })),
    },
    binance: {
      candles: vi.fn().mockResolvedValue({ data: [] }),
    },
  } as any;
}

function makePublisherMock() {
  return {
    emitMarketWatchTriggered: vi.fn(),
    emitMarketDiscoveryDetected: vi.fn(),
    emitMarketRegimeChanged: vi.fn(),
    emitAgentWake: vi.fn(),
  } as any;
}

describe('createMarketDataCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T00:00:00.000Z'));
    mockState.onLeaderAcquired = undefined;
    mockState.createLeaderElectionMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  it('marks discovery stale with a real age after refresh failure', async () => {
    const redis = makeRedisMock();
    const providerRegistry = makeProviderRegistryMock();
    const publisher = makePublisherMock();

    redis._store.set('market-intel:discovery:latest', JSON.stringify({
      snapshotId: 'snap-1',
      capturedAt: '2026-06-10T00:00:00.000Z',
      freshness: { state: 'fresh', ageMs: 0, maxAllowedAgeMs: 600_000 },
      sources: { discovery: { ok: true, freshness: 'fresh' } },
      tokens: [],
    }));

    const coordinator = createMarketDataCoordinator(
      {
        workerId: 'worker-1',
        discoveryPollMs: 30_000,
        regimePollMs: 60_000,
        networks: ['solana'],
        benchmarkSymbols: ['BTC'],
        enabled: true,
      },
      { redis, providerRegistry, publisher },
    );

    coordinator.start();
    expect(mockState.onLeaderAcquired).toBeTypeOf('function');
    mockState.onLeaderAcquired?.();

    await vi.advanceTimersByTimeAsync(1_000);

    const latestRaw = redis._store.get('market-intel:discovery:latest');
    const metaRaw = redis._store.get('market-intel:discovery:meta');

    expect(latestRaw).toBeTruthy();
    expect(metaRaw).toBeTruthy();

    const latest = JSON.parse(latestRaw!);
    const meta = JSON.parse(metaRaw!);

    expect(latest.freshness.state).toBe('stale');
    expect(latest.freshness.ageMs).toBe(1_000);
    expect(latest.sources.discovery.freshness).toBe('stale');
    expect(meta.sourceStats.discovery.freshness).toBe('stale');
  });

  it('writes a fresh regime snapshot and records success + freshness from the boundary result', async () => {
    const redis = makeRedisMock();
    const providerRegistry = makeProviderRegistryMock();
    const publisher = makePublisherMock();
    const invoke = vi.fn(async () => ({
      kind: 'success' as const,
      data: {
        ok: true,
        pass: true,
        reasons: ['bullish'],
        details: { benchmarkSymbol: 'BTC' },
        freshness: { provider: 'binance', source: 'upstream', ageMs: 1234, isStale: false },
      },
    }));

    const coordinator = createMarketDataCoordinator(
      {
        workerId: 'worker-1',
        discoveryPollMs: 30_000,
        regimePollMs: 60_000,
        networks: ['solana'],
        benchmarkSymbols: ['BTC'],
        enabled: true,
      },
      { redis, providerRegistry, publisher, checkRegimeBoundary: { invoke } },
    );

    coordinator.start();
    mockState.onLeaderAcquired?.();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(invoke).toHaveBeenCalledWith({ toolName: 'check_regime', payload: { benchmarkSymbol: 'BTC' } });

    const regime = JSON.parse(redis._store.get('market-intel:regime:BTC')!);
    expect(regime.freshness.state).toBe('fresh');
    expect(regime.freshness.ageMs).toBe(1234);
    expect(regime.pass).toBe(true);
    expect(regime.reasons).toEqual(['bullish']);

    // Provider success + fresh freshness recorded from the boundary result (parity).
    const counters = redis._hashStore.get('market-intel:provider-counters:v2')!;
    expect(counters.get('binance:regime:success')).toBe('1');
    expect(counters.get('binance:regime:freshnessModeFresh')).toBe('1');
  });

  it('records a rate-limit throttle and unavailable snapshot when the boundary reports rate_limit.exceeded', async () => {
    const redis = makeRedisMock();
    const providerRegistry = makeProviderRegistryMock();
    const publisher = makePublisherMock();
    const invoke = vi.fn(async () => ({
      kind: 'failure' as const,
      code: 'rate_limit.exceeded' as const,
      message: 'throttled',
      retryable: true,
    }));

    const coordinator = createMarketDataCoordinator(
      {
        workerId: 'worker-1',
        discoveryPollMs: 30_000,
        regimePollMs: 60_000,
        networks: ['solana'],
        benchmarkSymbols: ['BTC'],
        enabled: true,
      },
      { redis, providerRegistry, publisher, checkRegimeBoundary: { invoke } },
    );

    coordinator.start();
    mockState.onLeaderAcquired?.();
    await vi.advanceTimersByTimeAsync(1_000);

    const regime = JSON.parse(redis._store.get('market-intel:regime:BTC')!);
    expect(regime.freshness.state).toBe('unavailable');

    const counters = redis._hashStore.get('market-intel:provider-counters:v2')!;
    expect(counters.get('binance:regime:rateLimitThrottleCount')).toBe('1');
    // NOT counted as a generic failure
    expect(counters.get('binance:regime:failure')).toBeUndefined();
  });

  it('records a provider failure and unavailable snapshot on a transport error', async () => {
    const redis = makeRedisMock();
    const providerRegistry = makeProviderRegistryMock();
    const publisher = makePublisherMock();
    const invoke = vi.fn(async () => ({ kind: 'transport_error' as const, message: 'unreachable', retryable: true as const }));

    const coordinator = createMarketDataCoordinator(
      {
        workerId: 'worker-1',
        discoveryPollMs: 30_000,
        regimePollMs: 60_000,
        networks: ['solana'],
        benchmarkSymbols: ['BTC'],
        enabled: true,
      },
      { redis, providerRegistry, publisher, checkRegimeBoundary: { invoke } },
    );

    coordinator.start();
    mockState.onLeaderAcquired?.();
    await vi.advanceTimersByTimeAsync(1_000);

    const regime = JSON.parse(redis._store.get('market-intel:regime:BTC')!);
    expect(regime.freshness.state).toBe('unavailable');

    const counters = redis._hashStore.get('market-intel:provider-counters:v2')!;
    expect(counters.get('binance:regime:failure')).toBe('1');
  });

  it('rewrites a parseable snapshot missing freshness as unavailable', async () => {
    const redis = makeRedisMock();
    const providerRegistry = makeProviderRegistryMock();
    const publisher = makePublisherMock();

    redis._store.set('market-intel:discovery:latest', JSON.stringify({
      snapshotId: 'snap-2',
      capturedAt: '2026-06-10T00:00:00.000Z',
      sources: { discovery: { ok: true, freshness: 'fresh' } },
      tokens: [],
    }));

    const coordinator = createMarketDataCoordinator(
      {
        workerId: 'worker-1',
        discoveryPollMs: 30_000,
        regimePollMs: 60_000,
        networks: ['solana'],
        benchmarkSymbols: ['BTC'],
        enabled: true,
      },
      { redis, providerRegistry, publisher },
    );

    coordinator.start();
    mockState.onLeaderAcquired?.();

    await vi.advanceTimersByTimeAsync(1_000);

    const latest = JSON.parse(redis._store.get('market-intel:discovery:latest')!);
    const meta = JSON.parse(redis._store.get('market-intel:discovery:meta')!);

    expect(latest.freshness.state).toBe('unavailable');
    expect(latest.sources.discovery.freshness).toBe('unavailable');
    expect(meta.sourceStats.discovery.freshness).toBe('unavailable');
  });
});