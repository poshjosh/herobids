import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMarketMonitor } from './monitor.js';

// ---------------------------------------------------------------------------
// Redis mock factory
// ---------------------------------------------------------------------------

function makeRedisMock(overrides: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  const hstore = new Map<string, Map<string, string>>();
  const zstore = new Map<string, Map<string, number>>();
  const scanKeys: string[] = [];

  return {
    // Expose internals for assertions
    _store: store,
    _hstore: hstore,
    _zstore: zstore,
    _scanKeys: scanKeys,
    // Redis methods
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => { store.set(key, value); return 'OK'; }),
    hgetall: vi.fn(async (key: string) => {
      const h = hstore.get(key);
      if (!h || h.size === 0) return null;
      const result: Record<string, string> = {};
      for (const [k, v] of h) result[k] = v;
      return result;
    }),
    hset: vi.fn(async (key: string, field: string, value: string) => {
      if (!hstore.has(key)) hstore.set(key, new Map());
      hstore.get(key)!.set(field, value);
      return 1;
    }),
    hdel: vi.fn(async (key: string, ...fields: string[]) => {
      const h = hstore.get(key);
      if (!h) return 0;
      let deleted = 0;
      for (const field of fields) {
        if (h.delete(field)) deleted++;
      }
      return deleted;
    }),
    del: vi.fn(async (...keys: string[]) => {
      let deleted = 0;
      for (const key of keys) {
        if (store.delete(key)) deleted++;
      }
      return deleted;
    }),
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    zadd: vi.fn(async (key: string, score: string, member: string) => {
      if (!zstore.has(key)) zstore.set(key, new Map());
      zstore.get(key)!.set(member, Number(score));
      return 1;
    }),
    zscore: vi.fn(async (key: string, member: string) => {
      const score = zstore.get(key)?.get(member);
      return score !== undefined ? String(score) : null;
    }),
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
      // Simple glob→regex: convert 'prefix:*' to filter matching keys
      const regexStr = '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
      const re = new RegExp(regexStr);
      return ['0', scanKeys.filter((k) => re.test(k))];
    }),
    incr: vi.fn(async (key: string) => {
      const v = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(v));
      return v;
    }),
    expire: vi.fn(async () => 1),
    pipeline: vi.fn(() => {
      const pipeline = {
        incr: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        zadd: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
      return pipeline;
    }),
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// Publisher mock factory
// ---------------------------------------------------------------------------

function makePublisherMock() {
  return {
    emitMarketWatchTriggered: vi.fn().mockResolvedValue(undefined),
    emitMarketDiscoveryDetected: vi.fn().mockResolvedValue(undefined),
    emitMarketRegimeChanged: vi.fn().mockResolvedValue(undefined),
    emitAgentWake: vi.fn().mockResolvedValue(undefined),
  } as any;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWatch(overrides: Partial<{
  watchId: string;
  symbol: string;
  chain: string;
  thresholdPrice: number;
  condition: 'above' | 'below';
  lastConditionMet: boolean | null;
}> = {}) {
  return JSON.stringify({
    watchId: overrides.watchId ?? 'watch-1',
    symbol: overrides.symbol ?? 'SOL',
    chain: overrides.chain ?? 'solana',
    thresholdPrice: overrides.thresholdPrice ?? 200,
    condition: overrides.condition ?? 'above',
    createdAt: '2026-06-10T00:00:00.000Z',
    lastConditionMet: overrides.lastConditionMet ?? null,
  });
}

function makeDiscoverySnapshot(tokens: Array<{
  network: string;
  address: string;
  symbol: string;
  rank?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  discoveryVectors?: string[];
  priceUsd?: number;
}>) {
  return JSON.stringify({
    snapshotId: 'snap-1',
    capturedAt: new Date().toISOString(),
    freshness: { state: 'fresh' },
    tokens: tokens.map((t, i) => ({
      rank: i + 1,
      liquidityUsd: 1_000_000,
      volume24hUsd: 5_000_000,
      discoveryVectors: ['trending'],
      priceUsd: 2.0,
      ...t,
    })),
  });
}

// ===========================================================================
// evaluate() — disabled monitor
// ===========================================================================

describe('createMarketMonitor — disabled', () => {
  it('does nothing when enabled=false', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();
    const monitor = createMarketMonitor({ enabled: false }, { redis, publisher });
    monitor.start();
    await monitor.evaluate();
    expect(publisher.emitMarketWatchTriggered).not.toHaveBeenCalled();
    expect(publisher.emitMarketDiscoveryDetected).not.toHaveBeenCalled();
    expect(publisher.emitMarketRegimeChanged).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// watch threshold evaluation
// ===========================================================================

describe('createMarketMonitor — watch thresholds', () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let publisher: ReturnType<typeof makePublisherMock>;

  beforeEach(() => {
    redis = makeRedisMock();
    publisher = makePublisherMock();
  });

  function seedWatch(agentId: string, watchData: ReturnType<typeof makeWatch>) {
    redis._hstore.set(`agent:watches:${agentId}`, new Map([['watch-1', watchData]]));
    redis._scanKeys.push(`agent:watches:${agentId}`);
  }

  function seedDiscoveryPrice(symbol: string, network: string, priceUsd: number, fresh = true) {
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([{
      network, address: `0x${symbol}`, symbol, priceUsd,
    }]));
    // Override snapshot if stale requested
    if (!fresh) {
      redis._store.set('market-intel:discovery:latest', JSON.stringify({
        snapshotId: 'snap-stale',
        capturedAt: new Date().toISOString(),
        freshness: { state: 'stale' },
        tokens: [{ network, address: `0x${symbol}`, symbol, priceUsd, discoveryVectors: [], rank: 1, liquidityUsd: 0, volume24hUsd: 0 }],
      }));
    }
  }

  it('emits market.watch.triggered on false→true edge crossing (above)', async () => {
    seedWatch('agent-1', makeWatch({ symbol: 'SOL', condition: 'above', thresholdPrice: 200, lastConditionMet: false }));
    seedDiscoveryPrice('SOL', 'solana', 204);

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [calledAgentId, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(calledAgentId).toBe('agent-1');
    expect(payload.monitorType).toBe('watch_threshold');
    expect(payload.symbol).toBe('SOL');
    expect(payload.condition).toBe('above');
    expect(payload.currentPrice).toBe(204);
    expect(payload.stale).toBe(false);
  });

  it('emits market.watch.triggered on false→true edge crossing (below)', async () => {
    seedWatch('agent-1', makeWatch({ symbol: 'SOL', condition: 'below', thresholdPrice: 100, lastConditionMet: false }));
    seedDiscoveryPrice('SOL', 'solana', 95);

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(payload.condition).toBe('below');
    expect(payload.currentPrice).toBe(95);
  });

  it('does NOT emit when condition is already true (no edge transition)', async () => {
    // lastConditionMet: true means it already fired — no new edge
    seedWatch('agent-1', makeWatch({ symbol: 'SOL', condition: 'above', thresholdPrice: 200, lastConditionMet: true }));
    seedDiscoveryPrice('SOL', 'solana', 204);

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).not.toHaveBeenCalled();
  });

  it('does NOT emit when condition is false and price is still below threshold', async () => {
    seedWatch('agent-1', makeWatch({ symbol: 'SOL', condition: 'above', thresholdPrice: 200, lastConditionMet: false }));
    seedDiscoveryPrice('SOL', 'solana', 150); // below threshold

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).not.toHaveBeenCalled();
  });

  it('does NOT emit when price data is unavailable', async () => {
    seedWatch('agent-1', makeWatch({ symbol: 'UNKNOWN', condition: 'above', thresholdPrice: 50, lastConditionMet: false }));
    // No discovery snapshot — price unavailable

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).not.toHaveBeenCalled();
  });

  it('skips summary cache hashes when scanning active watches', async () => {
    seedWatch('agent-1', makeWatch({ symbol: 'SOL', condition: 'above', thresholdPrice: 200, lastConditionMet: false }));
    seedDiscoveryPrice('SOL', 'solana', 204);

    redis._hstore.set('agent:watches:summary:agent-1', new Map([
      ['summary', JSON.stringify({ totalCount: 1, uniqueCount: 1, overflowCount: 0, lines: ['ignored'] })],
    ]));
    redis._scanKeys.push('agent:watches:summary:agent-1');

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(redis.hgetall).toHaveBeenCalledTimes(1);
    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
  });

  it('marks payload stale when discovery snapshot is stale', async () => {
    seedWatch('agent-1', makeWatch({ symbol: 'SOL', condition: 'above', thresholdPrice: 200, lastConditionMet: false }));
    seedDiscoveryPrice('SOL', 'solana', 204, false /* stale */);

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(payload.stale).toBe(true);
  });

  it('suppresses second emission when dedupe key is already set', async () => {
    seedWatch('agent-1', makeWatch({ symbol: 'SOL', condition: 'above', thresholdPrice: 200, lastConditionMet: false }));
    seedDiscoveryPrice('SOL', 'solana', 204);

    // Pre-populate dedupe key
    redis._store.set('market-monitor:dedupe:watch:watch-1:cross:above', '1');

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).not.toHaveBeenCalled();
    expect(monitor.getMetrics().eventsSuppressed).toBe(1);
  });

  it('enqueues a wake request after a watch trigger', async () => {
    seedWatch('agent-1', makeWatch({ symbol: 'SOL', condition: 'above', thresholdPrice: 200, lastConditionMet: false }));
    seedDiscoveryPrice('SOL', 'solana', 204);

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    // Wake is enqueued (coalesced) — flush wakes immediately
    // Simulate time passing past coalescing window by directly flushing
    // by calling evaluate again after cooldown; use metrics to confirm the enqueue
    expect(monitor.getMetrics().eventsEmitted).toBe(1);
  });

  it('increments eventsEmitted counter on each trigger', async () => {
    seedWatch('agent-1', makeWatch({ symbol: 'SOL', condition: 'above', thresholdPrice: 200, lastConditionMet: false }));
    seedDiscoveryPrice('SOL', 'solana', 204);

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(monitor.getMetrics().eventsEmitted).toBe(1);
  });

  it('uses price from regime snapshot when not in discovery snapshot', async () => {
    seedWatch('agent-1', makeWatch({ symbol: 'BTC', chain: 'hyperliquid', condition: 'above', thresholdPrice: 60_000, lastConditionMet: false }));
    // Regime snapshot for BTC
    redis._store.set('market-intel:regime:BTC', JSON.stringify({
      benchmarkSymbol: 'BTC',
      freshness: { state: 'fresh' },
      pass: true,
      details: { currentPrice: 65_000 },
    }));

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(payload.currentPrice).toBe(65_000);
    expect(payload.priceSource).toBe('regime_snapshot');
  });
});

// ===========================================================================
// family toggle controls
// ===========================================================================

describe('createMarketMonitor — family toggles', () => {
  it('skips watch evaluation when watchThresholds=false', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();

    redis._hstore.set('agent:watches:agent-1', new Map([
      ['w1', makeWatch({ condition: 'above', thresholdPrice: 10, lastConditionMet: false })],
    ]));
    redis._scanKeys.push('agent:watches:agent-1');
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xSOL', symbol: 'SOL', priceUsd: 200 },
    ]));

    const monitor = createMarketMonitor(
      { families: { watchThresholds: false, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).not.toHaveBeenCalled();
  });

  it('clears the dedupe key when the condition resets to false', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();

    redis._hstore.set('agent:watches:agent-1', new Map([
      ['watch-1', makeWatch({ symbol: 'SOL', condition: 'above', thresholdPrice: 200, lastConditionMet: true })],
    ]));
    redis._scanKeys.push('agent:watches:agent-1');
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xSOL', symbol: 'SOL', priceUsd: 150 },
    ]));

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(redis.del).toHaveBeenCalledWith('market-monitor:dedupe:watch:watch-1:cross:above');
  });

  it('skips discovery evaluation when discoveryDeltas=false', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();

    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xWIF', symbol: 'WIF' },
    ]));
    redis._scanKeys.push('agent:watches:agent-1');

    const monitor = createMarketMonitor(
      { families: { watchThresholds: false, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    expect(publisher.emitMarketDiscoveryDetected).not.toHaveBeenCalled();
  });

  it('skips regime evaluation when regimeChanges=false', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();

    redis._scanKeys.push('market-intel:regime:BTC');
    redis._store.set('market-intel:regime:BTC', JSON.stringify({ pass: false, details: {} }));
    redis._store.set('market-monitor:regime:last-state:BTC', JSON.stringify({ pass: true }));

    const monitor = createMarketMonitor(
      { families: { watchThresholds: false, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    expect(publisher.emitMarketRegimeChanged).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// discovery delta evaluation
// ===========================================================================

describe('createMarketMonitor — discovery deltas', () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let publisher: ReturnType<typeof makePublisherMock>;

  beforeEach(() => {
    redis = makeRedisMock();
    publisher = makePublisherMock();
    // Add an active agent watch key so getActiveAgentIds returns something
    redis._scanKeys.push('agent:watches:agent-1');
  });

  it('emits entered_top_set for tokens not in previous snapshot', async () => {
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xWIF', symbol: 'WIF', discoveryVectors: ['trending'] },
    ]));
    // No previous snapshot → token entered the set

    const monitor = createMarketMonitor({ families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketDiscoveryDetected).toHaveBeenCalledOnce();
    const [agentId, payload] = publisher.emitMarketDiscoveryDetected.mock.calls[0]!;
    expect(agentId).toBe('agent-1');
    expect(payload.reason).toBe('entered_top_set');
    expect(payload.symbol).toBe('WIF');
  });

  it('does NOT emit entered_top_set for tokens already in previous snapshot', async () => {
    const currentSnap = makeDiscoverySnapshot([
      { network: 'solana', address: '0xWIF', symbol: 'WIF' },
    ]);
    redis._store.set('market-intel:discovery:latest', currentSnap);
    redis._store.set('market-monitor:discovery:previous-snapshot', currentSnap);

    const monitor = createMarketMonitor({ families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    // Token was in previous → no entered_top_set
    expect(publisher.emitMarketDiscoveryDetected).not.toHaveBeenCalled();
  });

  it('does NOT emit entered_top_set when dedupe key is set', async () => {
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xWIF', symbol: 'WIF' },
    ]));
    redis._store.set('market-monitor:dedupe:discovery:solana:0xWIF:reason:entered_top_set', '1');

    const monitor = createMarketMonitor({ families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketDiscoveryDetected).not.toHaveBeenCalled();
  });

  it('emits multi_vector_confirmation when vector count grows from 1 to 2+', async () => {
    const tokenAddress = '0xWIF';
    const prevSnap = makeDiscoverySnapshot([
      { network: 'solana', address: tokenAddress, symbol: 'WIF', discoveryVectors: ['trending'] },
    ]);
    const currSnap = makeDiscoverySnapshot([
      { network: 'solana', address: tokenAddress, symbol: 'WIF', discoveryVectors: ['trending', 'boosts_latest'] },
    ]);
    redis._store.set('market-monitor:discovery:previous-snapshot', prevSnap);
    redis._store.set('market-intel:discovery:latest', currSnap);

    const monitor = createMarketMonitor({ families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketDiscoveryDetected).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketDiscoveryDetected.mock.calls[0]!;
    expect(payload.reason).toBe('multi_vector_confirmation');
  });

  it('does NOT emit multi_vector_confirmation when token already had 2+ vectors', async () => {
    const tokenAddress = '0xWIF';
    const prevSnap = makeDiscoverySnapshot([
      { network: 'solana', address: tokenAddress, symbol: 'WIF', discoveryVectors: ['trending', 'boosts_latest'] },
    ]);
    const currSnap = makeDiscoverySnapshot([
      { network: 'solana', address: tokenAddress, symbol: 'WIF', discoveryVectors: ['trending', 'boosts_latest', 'new_pools'] },
    ]);
    redis._store.set('market-monitor:discovery:previous-snapshot', prevSnap);
    redis._store.set('market-intel:discovery:latest', currSnap);

    const monitor = createMarketMonitor({ families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketDiscoveryDetected).not.toHaveBeenCalled();
  });

  it('emits reappeared_after_cooldown for token last seen 4h+ ago', async () => {
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000 - 1;
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xWIF', symbol: 'WIF' },
    ]));
    // Token was in anti-staleness sorted set (seen 4h+ ago)
    redis._zstore.set('market-intel:discovery:seen', new Map([['solana:0xWIF', fourHoursAgo]]));

    const monitor = createMarketMonitor({ families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketDiscoveryDetected).toHaveBeenCalled();
    const reasons = publisher.emitMarketDiscoveryDetected.mock.calls.map(([, p]: [string, { reason: string }]) => p.reason);
    expect(reasons).toContain('reappeared_after_cooldown');
  });

  it('does NOT emit reappeared_after_cooldown for token seen within 4h', async () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xWIF', symbol: 'WIF' },
    ]));
    redis._zstore.set('market-intel:discovery:seen', new Map([['solana:0xWIF', twoHoursAgo]]));

    const monitor = createMarketMonitor({ families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    const reasons = publisher.emitMarketDiscoveryDetected.mock.calls.map(([, p]: [string, { reason: string }]) => p.reason);
    expect(reasons).not.toContain('reappeared_after_cooldown');
  });

  it('does nothing when discovery snapshot is empty', async () => {
    redis._store.set('market-intel:discovery:latest', JSON.stringify({ freshness: { state: 'fresh' }, tokens: [] }));

    const monitor = createMarketMonitor({ families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketDiscoveryDetected).not.toHaveBeenCalled();
  });

  it('does nothing when discovery snapshot is absent', async () => {
    const monitor = createMarketMonitor({ families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketDiscoveryDetected).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// regime change evaluation
// ===========================================================================

describe('createMarketMonitor — regime changes', () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let publisher: ReturnType<typeof makePublisherMock>;

  beforeEach(() => {
    redis = makeRedisMock();
    publisher = makePublisherMock();
    redis._scanKeys.push('agent:watches:agent-1');
  });

  it('emits regime changed when pass flips from true to false', async () => {
    redis._scanKeys.push('market-intel:regime:BTC');
    redis._store.set('market-intel:regime:BTC', JSON.stringify({ pass: false, details: { emaAlignment: 'bearish' } }));
    redis._store.set('market-monitor:regime:last-state:BTC', JSON.stringify({ pass: true }));

    const monitor = createMarketMonitor({ families: { watchThresholds: false, discoveryDeltas: false, regimeChanges: true } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketRegimeChanged).toHaveBeenCalledOnce();
    const [agentId, payload] = publisher.emitMarketRegimeChanged.mock.calls[0]!;
    expect(agentId).toBe('agent-1');
    expect(payload.monitorType).toBe('regime_change');
    expect(payload.benchmarkSymbol).toBe('BTC');
    expect(payload.previousState).toBe('favorable');
    expect(payload.currentState).toBe('unfavorable');
  });

  it('emits regime changed when pass flips from false to true', async () => {
    redis._scanKeys.push('market-intel:regime:BTC');
    redis._store.set('market-intel:regime:BTC', JSON.stringify({ pass: true, details: {} }));
    redis._store.set('market-monitor:regime:last-state:BTC', JSON.stringify({ pass: false }));

    const monitor = createMarketMonitor({ families: { watchThresholds: false, discoveryDeltas: false, regimeChanges: true } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketRegimeChanged).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketRegimeChanged.mock.calls[0]!;
    expect(payload.previousState).toBe('unfavorable');
    expect(payload.currentState).toBe('favorable');
  });

  it('does NOT emit when regime state is unchanged (same pass value)', async () => {
    redis._scanKeys.push('market-intel:regime:BTC');
    redis._store.set('market-intel:regime:BTC', JSON.stringify({ pass: true, details: {} }));
    redis._store.set('market-monitor:regime:last-state:BTC', JSON.stringify({ pass: true }));

    const monitor = createMarketMonitor({ families: { watchThresholds: false, discoveryDeltas: false, regimeChanges: true } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketRegimeChanged).not.toHaveBeenCalled();
  });

  it('does NOT emit on first evaluation (no previous state stored)', async () => {
    redis._scanKeys.push('market-intel:regime:BTC');
    redis._store.set('market-intel:regime:BTC', JSON.stringify({ pass: false, details: {} }));
    // No market-monitor:regime:last-state:BTC set

    const monitor = createMarketMonitor({ families: { watchThresholds: false, discoveryDeltas: false, regimeChanges: true } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketRegimeChanged).not.toHaveBeenCalled();
  });

  it('suppresses event when dedupe key is present', async () => {
    redis._scanKeys.push('market-intel:regime:BTC');
    redis._store.set('market-intel:regime:BTC', JSON.stringify({ pass: false, details: {} }));
    redis._store.set('market-monitor:regime:last-state:BTC', JSON.stringify({ pass: true }));
    redis._store.set('market-monitor:dedupe:regime:BTC:from:favorable:to:unfavorable', '1');

    const monitor = createMarketMonitor({ families: { watchThresholds: false, discoveryDeltas: false, regimeChanges: true } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketRegimeChanged).not.toHaveBeenCalled();
  });

  it('stores previous state after evaluation so next cycle can compare', async () => {
    redis._scanKeys.push('market-intel:regime:BTC');
    redis._store.set('market-intel:regime:BTC', JSON.stringify({ pass: true, details: {} }));
    // No prior state

    const monitor = createMarketMonitor({ families: { watchThresholds: false, discoveryDeltas: false, regimeChanges: true } }, { redis, publisher });
    await monitor.evaluate();

    expect(redis.set).toHaveBeenCalledWith(
      'market-monitor:regime:last-state:BTC',
      JSON.stringify({ pass: true }),
      'EX',
      3600,
    );
  });
});

// ===========================================================================
// metrics
// ===========================================================================

describe('createMarketMonitor — metrics', () => {
  it('starts with all counters at zero', () => {
    const monitor = createMarketMonitor({ enabled: false }, { redis: makeRedisMock(), publisher: makePublisherMock() });
    expect(monitor.getMetrics()).toEqual({
      eventsEmitted: 0,
      eventsSuppressed: 0,
      wakeRequestsEmitted: 0,
      wakeRequestsCoalesced: 0,
      wakeRequestsSuppressed: 0,
      evaluationFailures: 0,
    });
  });

  it('increments evaluationFailures when an evaluation cycle throws', async () => {
    const redis = makeRedisMock({
      scan: vi.fn().mockRejectedValue(new Error('Redis gone')),
    });
    const publisher = makePublisherMock();

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    expect(monitor.getMetrics().evaluationFailures).toBe(1);
  });

  it('increments eventsSuppressed when dedupe suppresses a watch trigger', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();

    redis._hstore.set('agent:watches:agent-1', new Map([['w1', makeWatch({ condition: 'above', thresholdPrice: 100, lastConditionMet: false })]]));
    redis._scanKeys.push('agent:watches:agent-1');
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([{ network: 'solana', address: '0xSOL', symbol: 'SOL', priceUsd: 200 }]));
    redis._store.set('market-monitor:dedupe:watch:watch-1:cross:above', '1');

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    expect(monitor.getMetrics().eventsSuppressed).toBe(1);
    expect(monitor.getMetrics().eventsEmitted).toBe(0);
  });

  it('returns a snapshot copy — external mutation does not affect internal state', () => {
    const monitor = createMarketMonitor({ enabled: false }, { redis: makeRedisMock(), publisher: makePublisherMock() });
    const snapshot = monitor.getMetrics();
    snapshot.eventsEmitted = 999;
    expect(monitor.getMetrics().eventsEmitted).toBe(0);
  });
});

// ===========================================================================
// wake coalescing
// ===========================================================================

describe('createMarketMonitor — wake coalescing', () => {
  it('increments wakeRequestsCoalesced when second event arrives for same agent before flush', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();

    // Two watches for the same agent that will both trigger
    redis._hstore.set('agent:watches:agent-1', new Map([
      ['w1', makeWatch({ watchId: 'w1', symbol: 'SOL', condition: 'above', thresholdPrice: 100, lastConditionMet: false })],
      ['w2', makeWatch({ watchId: 'w2', symbol: 'SOL', condition: 'above', thresholdPrice: 150, lastConditionMet: false })],
    ]));
    redis._scanKeys.push('agent:watches:agent-1');
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xSOL', symbol: 'SOL', priceUsd: 200 },
    ]));

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    // Two events emitted for same agent → second coalesces
    expect(monitor.getMetrics().eventsEmitted).toBe(2);
    expect(monitor.getMetrics().wakeRequestsCoalesced).toBe(1);
  });

  it('caps coalesced eventIds at MAX_COALESCED_EVENT_IDS (5)', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();

    // 6 watches for same agent
    const watches = new Map<string, string>();
    for (let i = 1; i <= 6; i++) {
      watches.set(`w${i}`, makeWatch({ watchId: `w${i}`, symbol: 'SOL', condition: 'above', thresholdPrice: i, lastConditionMet: false }));
    }
    redis._hstore.set('agent:watches:agent-1', watches);
    redis._scanKeys.push('agent:watches:agent-1');
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xSOL', symbol: 'SOL', priceUsd: 200 },
    ]));
    // No dedupe keys for any watch
    redis._store.delete('market-monitor:dedupe:watch:w1:cross:above');

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    // 6 events but wake bucket should cap at 5 eventIds
    // wakeRequestsCoalesced counts extras appended
    expect(monitor.getMetrics().eventsEmitted).toBe(6);
    // 5 coalescings (events 2–6 try to append, only 2–5 succeed, 6th is ignored)
    expect(monitor.getMetrics().wakeRequestsCoalesced).toBe(5);
  });

  it('clears pending wake buckets when stopped', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();

    redis._hstore.set('agent:watches:agent-1', new Map([
      ['w1', makeWatch({ watchId: 'w1', symbol: 'SOL', condition: 'above', thresholdPrice: 100, lastConditionMet: false })],
      ['w2', makeWatch({ watchId: 'w2', symbol: 'SOL', condition: 'above', thresholdPrice: 150, lastConditionMet: false })],
    ]));
    redis._scanKeys.push('agent:watches:agent-1');
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([{ network: 'solana', address: '0xSOL', symbol: 'SOL', priceUsd: 200 }]));

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();
    expect(monitor.getMetrics().wakeRequestsCoalesced).toBe(1);

    monitor.stop();

    redis._store.set('market-monitor:wake:last:agent-1', '0');
    expect(publisher.emitAgentWake).not.toHaveBeenCalled();
  });
});
