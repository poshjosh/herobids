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

  const pipeline = {
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return pipeline;
    }),
    exec: vi.fn().mockResolvedValue([]),
  };

  return {
    _store: store,
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
    scan: vi.fn(async () => ['0', []]),
    pipeline: vi.fn(() => pipeline),
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
    emitAgentMarketWake: vi.fn(),
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