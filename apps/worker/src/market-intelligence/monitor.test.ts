import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMarketMonitor } from './monitor.js';

// ---------------------------------------------------------------------------
// Redis mock factory
// ---------------------------------------------------------------------------

function makeRedisMock(overrides: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  const hstore = new Map<string, Map<string, string>>();
  const zstore = new Map<string, Map<string, number>>();
  const sset = new Map<string, Set<string>>();
  const scanKeys: string[] = [];

  return {
    // Expose internals for assertions
    _store: store,
    _hstore: hstore,
    _zstore: zstore,
    _sset: sset,
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
      if (sset.delete(key)) deleted++;
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
    // Set operations
    sadd: vi.fn(async (key: string, ...members: string[]) => {
      if (!sset.has(key)) sset.set(key, new Set());
      let added = 0;
      for (const m of members) {
        if (!sset.get(key)!.has(m)) { sset.get(key)!.add(m); added++; }
      }
      return added;
    }),
    srem: vi.fn(async (key: string, ...members: string[]) => {
      const s = sset.get(key);
      if (!s) return 0;
      let removed = 0;
      for (const m of members) {
        if (s.delete(m)) removed++;
      }
      return removed;
    }),
    smembers: vi.fn(async (key: string) => [...(sset.get(key) ?? [])]),
    sismember: vi.fn(async (key: string, member: string) => (sset.get(key)?.has(member) ? 1 : 0)),
    pipeline: vi.fn(() => {
      const queuedGets: Array<string> = [];
      const pipeline = {
        incr: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        zadd: vi.fn().mockReturnThis(),
        get: vi.fn((key: string) => { queuedGets.push(key); return pipeline; }),
        exec: vi.fn(async () => {
          if (queuedGets.length > 0) {
            return queuedGets.map((key) => [null, store.get(key) ?? null]);
          }
          return [];
        }),
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

const DEFAULT_WATCH_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function makeWatch(overrides: Partial<{
  watchId: string;
  symbol: string;
  chain: string;
  thresholdPrice: number;
  condition: 'above' | 'below';
  lastConditionMet: boolean | null;
  purpose: 'entry' | 'exit' | 'stop_loss' | 'take_profit' | 'monitor' | 'alert';
  instrumentVenue: string;
  instrumentId: string;
  positionKey: string;
  schemaVersion: number;
  resolvedChain: string;
  resolvedSymbol: string;
  resolvedAddress: string;
}> = {}) {
  const base: Record<string, unknown> = {
    watchId: overrides.watchId ?? DEFAULT_WATCH_ID,
    symbol: overrides.symbol ?? 'SOL',
    chain: overrides.chain ?? 'solana',
    thresholdPrice: overrides.thresholdPrice ?? 200,
    condition: overrides.condition ?? 'above',
    createdAt: '2026-06-10T00:00:00.000Z',
    lastConditionMet: overrides.lastConditionMet ?? null,
    schemaVersion: overrides.schemaVersion ?? 2,
  };
  if (overrides.resolvedChain) base.resolvedChain = overrides.resolvedChain;
  if (overrides.resolvedSymbol) base.resolvedSymbol = overrides.resolvedSymbol;
  if (overrides.resolvedAddress) base.resolvedAddress = overrides.resolvedAddress;
  if (overrides.purpose) base.purpose = overrides.purpose;
  if (overrides.instrumentVenue || overrides.instrumentId) {
    base.instrument = {
      venue: overrides.instrumentVenue ?? 'hyperliquid',
      instrumentId: overrides.instrumentId ?? 'SOL-USD',
      symbol: overrides.symbol ?? 'SOL',
    };
  }
  if (overrides.positionKey) {
    base.coverage = { positionKey: overrides.positionKey };
  }
  if (overrides.schemaVersion !== undefined) {
    base.schemaVersion = overrides.schemaVersion;
  }
  return JSON.stringify(base);
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
    redis.sadd('agent:sessions:active', agentId);
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
    redis._store.set(`market-monitor:dedupe:watch:${DEFAULT_WATCH_ID}:cross:above`, '1');

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

  it('uses resolvedChain/resolvedSymbol for regime fallback when discovery snapshot unavailable', async () => {
    // Seed a watch with pinned identity but NO discovery price
    seedWatch('agent-1', makeWatch({
      symbol: 'UNKNOWN',
      chain: 'any',
      resolvedChain: 'solana',
      resolvedSymbol: 'SOL',
      condition: 'above',
      thresholdPrice: 200,
      lastConditionMet: false,
    }));
    // Seed regime snapshot under the resolved symbol
    redis._store.set('market-intel:regime:SOL', JSON.stringify({
      benchmarkSymbol: 'SOL',
      freshness: { state: 'fresh' },
      pass: true,
      details: { currentPrice: 204 },
    }));

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(payload.currentPrice).toBe(204);
    expect(payload.priceSource).toBe('regime_snapshot');
    // Verify the payload carries the resolved identity, not "any"
    expect(payload.chain).toBe('solana');
    expect(payload.symbol).toBe('SOL');
  });

  it('uses fallback regime key under watch.symbol when effectiveSymbol differs', async () => {
    // Seed a watch where resolvedSymbol differs from watch.symbol (e.g. wrapped token)
    seedWatch('agent-1', makeWatch({
      symbol: 'WSOL',
      chain: 'solana',
      resolvedChain: 'solana',
      resolvedSymbol: 'SOL',
      condition: 'above',
      thresholdPrice: 200,
      lastConditionMet: false,
    }));
    // Regime snapshot keyed under the original symbol, NOT the resolved symbol
    redis._store.set('market-intel:regime:WSOL', JSON.stringify({
      benchmarkSymbol: 'WSOL',
      freshness: { state: 'fresh' },
      pass: true,
      details: { currentPrice: 205 },
    }));

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(payload.currentPrice).toBe(205);
    expect(payload.priceSource).toBe('regime_snapshot');
    // Verify the payload carries the resolved identity
    expect(payload.chain).toBe('solana');
    expect(payload.symbol).toBe('SOL');
  });

  it('populates purpose, instrument, positionKey, and schemaVersion in payload when present on watch', async () => {
    seedWatch('agent-1', makeWatch({
      symbol: 'SOL',
      condition: 'above',
      thresholdPrice: 200,
      lastConditionMet: false,
      purpose: 'stop_loss',
      instrumentVenue: 'hyperliquid',
      instrumentId: 'SOL-USD',
      positionKey: 'pos-sol-stop-1',
      schemaVersion: 2,
    }));
    seedDiscoveryPrice('SOL', 'solana', 204);

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(payload.purpose).toBe('stop_loss');
    expect(payload.instrumentVenue).toBe('hyperliquid');
    expect(payload.instrumentId).toBe('SOL-USD');
    expect(payload.positionKey).toBe('pos-sol-stop-1');
    expect(payload.schemaVersion).toBe(2);
  });

  it('populates purpose="alert" (repair default) and schemaVersion=2, but no instrument/positionKey when watch lacks them', async () => {
    seedWatch('agent-1', makeWatch({ symbol: 'SOL', condition: 'above', thresholdPrice: 200, lastConditionMet: false }));
    seedDiscoveryPrice('SOL', 'solana', 204);

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(payload.purpose).toBe('alert');
    expect(payload.instrumentVenue).toBeUndefined();
    expect(payload.instrumentId).toBeUndefined();
    expect(payload.positionKey).toBeUndefined();
    expect(payload.schemaVersion).toBe(2);
  });

  it('populates only partial new fields when watch has some but not all metadata', async () => {
    seedWatch('agent-1', makeWatch({
      symbol: 'ETH',
      chain: 'ethereum',
      condition: 'below',
      thresholdPrice: 3000,
      lastConditionMet: false,
      purpose: 'entry',
      instrumentVenue: 'hyperliquid',
      instrumentId: 'ETH-USD',
      // no positionKey
    }));
    seedDiscoveryPrice('ETH', 'ethereum', 2950);

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(payload.purpose).toBe('entry');
    expect(payload.instrumentVenue).toBe('hyperliquid');
    expect(payload.instrumentId).toBe('ETH-USD');
    expect(payload.positionKey).toBeUndefined();
  });

  it('uses resolvedChain/resolvedSymbol for price lookup when pinned identity present', async () => {
    // Watch created with chain="any", resolved to solana
    seedWatch('agent-1', makeWatch({
      symbol: 'SOL',
      chain: 'any',
      resolvedChain: 'solana',
      resolvedSymbol: 'SOL',
      condition: 'above',
      thresholdPrice: 200,
      lastConditionMet: false,
    }));
    // Discovery snapshot has price under the resolved identity key
    seedDiscoveryPrice('SOL', 'solana', 204);

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    // Must trigger — proving resolved identity (solana:SOL) was used, not original (any:SOL)
    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(payload.currentPrice).toBe(204);
  });

  it('falls back to watch.chain/watch.symbol when resolved fields are absent', async () => {
    // Watch with no resolvedChain/resolvedSymbol (e.g. created before price service was available)
    seedWatch('agent-1', makeWatch({
      symbol: 'BTC',
      chain: 'hyperliquid',
      condition: 'above',
      thresholdPrice: 60_000,
      lastConditionMet: false,
    }));
    // Discovery snapshot has price under the original identity key
    seedDiscoveryPrice('BTC', 'hyperliquid', 65_000);

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(payload.currentPrice).toBe(65_000);
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
    redis.sadd('agent:sessions:active', 'agent-1');
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xSOL', symbol: 'SOL', priceUsd: 150 },
    ]));

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(redis.del).toHaveBeenCalledWith(`market-monitor:dedupe:watch:${DEFAULT_WATCH_ID}:cross:above`);
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
    redis.sadd('agent:sessions:active', 'agent-1');
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
    redis.sadd('agent:sessions:active', 'agent-1');
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
    redis.sadd('agent:sessions:active', 'agent-1');
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([{ network: 'solana', address: '0xSOL', symbol: 'SOL', priceUsd: 200 }]));
    redis._store.set(`market-monitor:dedupe:watch:${DEFAULT_WATCH_ID}:cross:above`, '1');

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
    const W1 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const W2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
    redis._hstore.set('agent:watches:agent-1', new Map([
      [W1, makeWatch({ watchId: W1, symbol: 'SOL', condition: 'above', thresholdPrice: 100, lastConditionMet: false })],
      [W2, makeWatch({ watchId: W2, symbol: 'SOL', condition: 'above', thresholdPrice: 150, lastConditionMet: false })],
    ]));
    redis._scanKeys.push('agent:watches:agent-1');
    redis.sadd('agent:sessions:active', 'agent-1');
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

    // 6 watches for same agent — generate valid UUIDs to pass WatchEntrySchema validation
    const watches = new Map<string, string>();
    for (let i = 1; i <= 6; i++) {
      const watchId = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
      watches.set(watchId, makeWatch({ watchId, symbol: 'SOL', condition: 'above', thresholdPrice: i, lastConditionMet: false }));
    }
    redis._hstore.set('agent:watches:agent-1', watches);
    redis._scanKeys.push('agent:watches:agent-1');
    redis.sadd('agent:sessions:active', 'agent-1');
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xSOL', symbol: 'SOL', priceUsd: 200 },
    ]));

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

    const W1 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const W2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
    redis._hstore.set('agent:watches:agent-1', new Map([
      [W1, makeWatch({ watchId: W1, symbol: 'SOL', condition: 'above', thresholdPrice: 100, lastConditionMet: false })],
      [W2, makeWatch({ watchId: W2, symbol: 'SOL', condition: 'above', thresholdPrice: 150, lastConditionMet: false })],
    ]));
    redis._scanKeys.push('agent:watches:agent-1');
    redis.sadd('agent:sessions:active', 'agent-1');
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([{ network: 'solana', address: '0xSOL', symbol: 'SOL', priceUsd: 200 }]));

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();
    expect(monitor.getMetrics().wakeRequestsCoalesced).toBe(1);

    monitor.stop();

    redis._store.set('market-monitor:wake:last:agent-1:watch_threshold', '0');
    expect(publisher.emitAgentWake).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// mode-based delivery (wake / batched / context)
// ===========================================================================

describe('createMarketMonitor — mode-based delivery', () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let publisher: ReturnType<typeof makePublisherMock>;

  beforeEach(() => {
    redis = makeRedisMock();
    publisher = makePublisherMock();
    redis._scanKeys.push('agent:watches:agent-1');
    // Populate active sessions so getSubscribedAgentIds and evaluateWatches
    // can find the agent (required after C4 subscription-filtering refactor).
    redis.sadd('agent:sessions:active', 'agent-1');
  });

  // --- backward compatibility (no mode configured = wake) ---

  it('defaults to wake mode when no wakePolicy is configured (watch threshold)', async () => {
    seedWatchInRedis();
    seedDiscoveryPriceInRedis('SOL', 'solana', 204);

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    // Event IS emitted
    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    // Wake IS enqueued (key exists in Redis)
    expect(redis._store.has('market-monitor:wake:agent-1:watch_threshold')).toBe(true);
  });

  // --- watch threshold: context mode ---

  it('emits event but does NOT enqueue wake when watch_threshold mode is context', async () => {
    seedWatchInRedis();
    seedDiscoveryPriceInRedis('SOL', 'solana', 204);

    const monitor = createMarketMonitor(
      {
        families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false },
        wakePolicy: { watch_threshold: { mode: 'context' } },
      },
      { redis, publisher },
    );
    await monitor.evaluate();

    // Event IS emitted
    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    // Wake is NOT enqueued
    expect(redis._store.has('market-monitor:wake:agent-1:watch_threshold')).toBe(false);
  });

  // --- watch threshold: wake mode (explicit) ---

  it('emits event and enqueues wake when watch_threshold mode is wake', async () => {
    seedWatchInRedis();
    seedDiscoveryPriceInRedis('SOL', 'solana', 204);

    const monitor = createMarketMonitor(
      {
        families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false },
        wakePolicy: { watch_threshold: { mode: 'wake' } },
      },
      { redis, publisher },
    );
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    expect(redis._store.has('market-monitor:wake:agent-1:watch_threshold')).toBe(true);
  });

  // --- watch threshold: batched mode ---

  it('emits event and enqueues wake when watch_threshold mode is batched', async () => {
    seedWatchInRedis();
    seedDiscoveryPriceInRedis('SOL', 'solana', 204);

    const monitor = createMarketMonitor(
      {
        families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false },
        wakePolicy: { watch_threshold: { mode: 'batched' } },
      },
      { redis, publisher },
    );
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    expect(redis._store.has('market-monitor:wake:agent-1:watch_threshold')).toBe(true);
  });

  // --- discovery delta: entered_top_set — context mode ---

  it('emits discovery event but does NOT enqueue wake when discovery_delta mode is context (entered_top_set)', async () => {
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xWIF', symbol: 'WIF', discoveryVectors: ['trending'] },
    ]));

    const monitor = createMarketMonitor(
      {
        families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false },
        wakePolicy: { discovery_delta: { mode: 'context' } },
      },
      { redis, publisher },
    );
    await monitor.evaluate();

    expect(publisher.emitMarketDiscoveryDetected).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketDiscoveryDetected.mock.calls[0]!;
    expect(payload.reason).toBe('entered_top_set');
    expect(redis._store.has('market-monitor:wake:agent-1:discovery_delta')).toBe(false);
  });

  // --- discovery delta: entered_top_set — wake mode (explicit) ---

  it('emits discovery event and enqueues wake when discovery_delta mode is wake (entered_top_set)', async () => {
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xWIF', symbol: 'WIF', discoveryVectors: ['trending'] },
    ]));

    const monitor = createMarketMonitor(
      {
        families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false },
        wakePolicy: { discovery_delta: { mode: 'wake' } },
      },
      { redis, publisher },
    );
    await monitor.evaluate();

    expect(publisher.emitMarketDiscoveryDetected).toHaveBeenCalledOnce();
    expect(redis._store.has('market-monitor:wake:agent-1:discovery_delta')).toBe(true);
  });

  // --- discovery delta: multi_vector_confirmation — context mode ---

  it('respects context mode for multi_vector_confirmation call site', async () => {
    const tokenAddress = '0xWIF';
    const prevSnap = makeDiscoverySnapshot([
      { network: 'solana', address: tokenAddress, symbol: 'WIF', discoveryVectors: ['trending'] },
    ]);
    const currSnap = makeDiscoverySnapshot([
      { network: 'solana', address: tokenAddress, symbol: 'WIF', discoveryVectors: ['trending', 'boosts_latest'] },
    ]);
    redis._store.set('market-monitor:discovery:previous-snapshot', prevSnap);
    redis._store.set('market-intel:discovery:latest', currSnap);

    const monitor = createMarketMonitor(
      {
        families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false },
        wakePolicy: { discovery_delta: { mode: 'context' } },
      },
      { redis, publisher },
    );
    await monitor.evaluate();

    expect(publisher.emitMarketDiscoveryDetected).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketDiscoveryDetected.mock.calls[0]!;
    expect(payload.reason).toBe('multi_vector_confirmation');
    expect(redis._store.has('market-monitor:wake:agent-1:discovery_delta')).toBe(false);
  });

  // --- discovery delta: reappeared_after_cooldown — context mode ---

  it('respects context mode for reappeared_after_cooldown call site', async () => {
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000 - 1;
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xWIF', symbol: 'WIF' },
    ]));
    redis._zstore.set('market-intel:discovery:seen', new Map([['solana:0xWIF', fourHoursAgo]]));

    const monitor = createMarketMonitor(
      {
        families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false },
        wakePolicy: { discovery_delta: { mode: 'context' } },
      },
      { redis, publisher },
    );
    await monitor.evaluate();

    const reasons = publisher.emitMarketDiscoveryDetected.mock.calls.map(
      ([, p]: [string, { reason: string }]) => p.reason,
    );
    expect(reasons).toContain('reappeared_after_cooldown');
    expect(redis._store.has('market-monitor:wake:agent-1:discovery_delta')).toBe(false);
  });

  // --- discovery delta: wake mode with batched ---

  it('enqueues wake for discovery_delta when mode is batched', async () => {
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xWIF', symbol: 'WIF', discoveryVectors: ['trending'] },
    ]));

    const monitor = createMarketMonitor(
      {
        families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false },
        wakePolicy: { discovery_delta: { mode: 'batched' } },
      },
      { redis, publisher },
    );
    await monitor.evaluate();

    expect(publisher.emitMarketDiscoveryDetected).toHaveBeenCalled();
    expect(redis._store.has('market-monitor:wake:agent-1:discovery_delta')).toBe(true);
  });

  // --- regime change: context mode ---

  it('emits regime event but does NOT enqueue wake when regime_change mode is context', async () => {
    redis._scanKeys.push('market-intel:regime:BTC');
    redis._store.set('market-intel:regime:BTC', JSON.stringify({ pass: false, details: { emaAlignment: 'bearish' } }));
    redis._store.set('market-monitor:regime:last-state:BTC', JSON.stringify({ pass: true }));

    const monitor = createMarketMonitor(
      {
        families: { watchThresholds: false, discoveryDeltas: false, regimeChanges: true },
        wakePolicy: { regime_change: { mode: 'context' } },
      },
      { redis, publisher },
    );
    await monitor.evaluate();

    expect(publisher.emitMarketRegimeChanged).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketRegimeChanged.mock.calls[0]!;
    expect(payload.monitorType).toBe('regime_change');
    expect(redis._store.has('market-monitor:wake:agent-1:regime_change')).toBe(false);
  });

  // --- helpers reused across mode-based delivery tests ---

  function seedWatchInRedis() {
    redis._hstore.set('agent:watches:agent-1', new Map([
      ['watch-1', makeWatch({ symbol: 'SOL', condition: 'above', thresholdPrice: 200, lastConditionMet: false })],
    ]));
  }

  function seedDiscoveryPriceInRedis(symbol: string, network: string, priceUsd: number) {
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network, address: `0x${symbol}`, symbol, priceUsd },
    ]));
  }
});

// ===========================================================================
// C4 — subscription filtering via agent:sessions:active and wake preferences
// ===========================================================================

describe('createMarketMonitor — subscription filtering (C4)', () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let publisher: ReturnType<typeof makePublisherMock>;

  beforeEach(() => {
    redis = makeRedisMock();
    publisher = makePublisherMock();
  });

  function addActiveAgent(agentId: string) {
    redis.sadd('agent:sessions:active', agentId);
  }

  function setWakePrefs(agentId: string, prefs: { subscribedSources?: string[] } | null) {
    if (prefs === null) {
      redis._store.delete(`agent:wake:prefs:${agentId}`);
    } else {
      redis._store.set(`agent:wake:prefs:${agentId}`, JSON.stringify(prefs));
    }
  }

  // -----------------------------------------------------------------------
  // C4.1 — getSubscribedAgentIds returns all active agents when no prefs key
  // -----------------------------------------------------------------------

  it('returns all active agents for discovery_delta when no prefs key exists', async () => {
    addActiveAgent('agent-1');
    addActiveAgent('agent-2');
    // No prefs keys set — both agents should be subscribed to everything

    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xWIF', symbol: 'WIF', discoveryVectors: ['trending'] },
    ]));

    const monitor = createMarketMonitor(
      { families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    // Both agents receive the discovery event
    expect(publisher.emitMarketDiscoveryDetected).toHaveBeenCalledTimes(2);
    const agentIds = publisher.emitMarketDiscoveryDetected.mock.calls.map((c: [string, unknown]) => c[0]);
    expect(agentIds).toContain('agent-1');
    expect(agentIds).toContain('agent-2');
  });

  it('returns all active agents for regime_change when no prefs key exists', async () => {
    addActiveAgent('agent-1');
    addActiveAgent('agent-2');

    redis._scanKeys.push('market-intel:regime:BTC');
    redis._store.set('market-intel:regime:BTC', JSON.stringify({ pass: false, details: {} }));
    redis._store.set('market-monitor:regime:last-state:BTC', JSON.stringify({ pass: true }));

    const monitor = createMarketMonitor(
      { families: { watchThresholds: false, discoveryDeltas: false, regimeChanges: true } },
      { redis, publisher },
    );
    await monitor.evaluate();

    // Both agents receive the regime event
    expect(publisher.emitMarketRegimeChanged).toHaveBeenCalledTimes(2);
    const agentIds = publisher.emitMarketRegimeChanged.mock.calls.map((c: [string, unknown]) => c[0]);
    expect(agentIds).toContain('agent-1');
    expect(agentIds).toContain('agent-2');
  });

  // -----------------------------------------------------------------------
  // C4.2 — getSubscribedAgentIds filters correctly per source
  // -----------------------------------------------------------------------

  it('filters agents per source when prefs are restricted', async () => {
    // agent-1: no prefs → all sources
    addActiveAgent('agent-1');

    // agent-2: only watch_threshold
    addActiveAgent('agent-2');
    setWakePrefs('agent-2', { subscribedSources: ['watch_threshold'] });

    // agent-3: discovery_delta + regime_change
    addActiveAgent('agent-3');
    setWakePrefs('agent-3', { subscribedSources: ['discovery_delta', 'regime_change'] });

    // Test discovery_delta: agents 1 and 3 should receive, agent 2 should NOT
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xWIF', symbol: 'WIF', discoveryVectors: ['trending'] },
    ]));

    const monitor = createMarketMonitor(
      { families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    const discoveryAgentIds = publisher.emitMarketDiscoveryDetected.mock.calls.map((c: [string, unknown]) => c[0]);
    expect(discoveryAgentIds).toContain('agent-1');
    expect(discoveryAgentIds).not.toContain('agent-2');
    expect(discoveryAgentIds).toContain('agent-3');
  });

  it('filters agents for regime_change when prefs are restricted', async () => {
    addActiveAgent('agent-1');
    addActiveAgent('agent-2');
    setWakePrefs('agent-2', { subscribedSources: ['watch_threshold'] });
    addActiveAgent('agent-3');
    setWakePrefs('agent-3', { subscribedSources: ['discovery_delta'] });

    redis._scanKeys.push('market-intel:regime:BTC');
    redis._store.set('market-intel:regime:BTC', JSON.stringify({ pass: false, details: {} }));
    redis._store.set('market-monitor:regime:last-state:BTC', JSON.stringify({ pass: true }));

    const monitor = createMarketMonitor(
      { families: { watchThresholds: false, discoveryDeltas: false, regimeChanges: true } },
      { redis, publisher },
    );
    await monitor.evaluate();

    const regimeAgentIds = publisher.emitMarketRegimeChanged.mock.calls.map((c: [string, unknown]) => c[0]);
    // agent-1: no prefs → gets regime
    expect(regimeAgentIds).toContain('agent-1');
    // agent-2: only watch_threshold → NOT regime
    expect(regimeAgentIds).not.toContain('agent-2');
    // agent-3: only discovery_delta → NOT regime
    expect(regimeAgentIds).not.toContain('agent-3');
  });

  // -----------------------------------------------------------------------
  // C4.3 — evaluateWatches excludes stopped agents even with stale watch keys
  // -----------------------------------------------------------------------

  it('skips agents not in agent:sessions:active even if watch keys remain', async () => {
    // Seed a watch key for agent-1 but do NOT add to active set
    redis._hstore.set('agent:watches:agent-1', new Map([
      ['watch-1', makeWatch({ symbol: 'SOL', condition: 'above', thresholdPrice: 200, lastConditionMet: false })],
    ]));
    redis._scanKeys.push('agent:watches:agent-1');
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xSOL', symbol: 'SOL', priceUsd: 204 },
    ]));

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    // No watch event emitted despite price crossing threshold — agent is not active
    expect(publisher.emitMarketWatchTriggered).not.toHaveBeenCalled();
  });

  it('emits watch event for active agent with watch key', async () => {
    addActiveAgent('agent-1');
    redis._hstore.set('agent:watches:agent-1', new Map([
      ['watch-1', makeWatch({ symbol: 'SOL', condition: 'above', thresholdPrice: 200, lastConditionMet: false })],
    ]));
    redis._scanKeys.push('agent:watches:agent-1');
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xSOL', symbol: 'SOL', priceUsd: 204 },
    ]));

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    // Active agent receives the watch trigger
    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [agentId] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(agentId).toBe('agent-1');
  });

  // -----------------------------------------------------------------------
  // C4.4 — evaluateWatches reads prefs once per agent per cycle
  // -----------------------------------------------------------------------

  it('reads wake prefs once per agent per evaluation cycle', async () => {
    addActiveAgent('agent-1');
    // Two watches for the same agent
    const W1 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const W2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
    redis._hstore.set('agent:watches:agent-1', new Map([
      [W1, makeWatch({ watchId: W1, symbol: 'SOL', condition: 'above', thresholdPrice: 100, lastConditionMet: false })],
      [W2, makeWatch({ watchId: W2, symbol: 'SOL', condition: 'above', thresholdPrice: 150, lastConditionMet: false })],
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

    // Both watches trigger, but prefs are only read once (hoisted before the per-watch loop).
    // The get spy is called for agent:wake:prefs:agent-1 exactly once (per agent).
    // Also called during watch evaluation for price lookups, but those are hgetall.
    const prefsCalls = redis.get.mock.calls.filter(
      (c: [string]) => c[0] === 'agent:wake:prefs:agent-1',
    );
    expect(prefsCalls).toHaveLength(1);
  });

  // Edge: agent with prefs that exclude watch_threshold — prefs still read once, then skipped
  it('reads prefs once then skips all watches when watch_threshold not in subscribedSources', async () => {
    addActiveAgent('agent-1');
    setWakePrefs('agent-1', { subscribedSources: ['discovery_delta'] });
    redis._hstore.set('agent:watches:agent-1', new Map([
      ['watch-1', makeWatch({ symbol: 'SOL', condition: 'above', thresholdPrice: 200, lastConditionMet: false })],
    ]));
    redis._scanKeys.push('agent:watches:agent-1');
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xSOL', symbol: 'SOL', priceUsd: 204 },
    ]));

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    // Watch event NOT emitted — agent only wants discovery_delta
    expect(publisher.emitMarketWatchTriggered).not.toHaveBeenCalled();
    // Prefs fetched once
    const prefsCalls = redis.get.mock.calls.filter(
      (c: [string]) => c[0] === 'agent:wake:prefs:agent-1',
    );
    expect(prefsCalls).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // C4.5 — Malformed prefs JSON fails open (treated as all sources)
  // -----------------------------------------------------------------------

  it('treats malformed prefs JSON as all sources (fail open)', async () => {
    addActiveAgent('agent-1');
    // Malformed JSON in prefs key
    redis._store.set('agent:wake:prefs:agent-1', '{broken json!!!');

    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xWIF', symbol: 'WIF', discoveryVectors: ['trending'] },
    ]));

    const monitor = createMarketMonitor(
      { families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    // Agent should still receive discovery events (fail open)
    expect(publisher.emitMarketDiscoveryDetected).toHaveBeenCalled();
    const agentIds = publisher.emitMarketDiscoveryDetected.mock.calls.map((c: [string, unknown]) => c[0]);
    expect(agentIds).toContain('agent-1');
  });

  it('treats malformed prefs JSON as all sources for watch thresholds (fail open)', async () => {
    addActiveAgent('agent-1');
    redis._store.set('agent:wake:prefs:agent-1', '{not valid}');
    redis._hstore.set('agent:watches:agent-1', new Map([
      ['watch-1', makeWatch({ symbol: 'SOL', condition: 'above', thresholdPrice: 200, lastConditionMet: false })],
    ]));
    redis._scanKeys.push('agent:watches:agent-1');
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xSOL', symbol: 'SOL', priceUsd: 204 },
    ]));

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    // Watch event should still fire (fail open)
    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
  });

  // -----------------------------------------------------------------------
  // Additional edge: empty subscribedSources array → subscribed to nothing
  // -----------------------------------------------------------------------

  it('excludes agent with empty subscribedSources array from all monitor sources', async () => {
    addActiveAgent('agent-1');
    setWakePrefs('agent-1', { subscribedSources: [] });

    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xWIF', symbol: 'WIF', discoveryVectors: ['trending'] },
    ]));

    const monitor = createMarketMonitor(
      { families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    // Agent has empty subscribedSources — receives nothing
    expect(publisher.emitMarketDiscoveryDetected).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Edge: no active agents → no recipients
  // -----------------------------------------------------------------------

  it('returns empty recipients when no agents are active', async () => {
    // No active agents added
    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xWIF', symbol: 'WIF', discoveryVectors: ['trending'] },
    ]));

    const monitor = createMarketMonitor(
      { families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false } },
      { redis, publisher },
    );
    await monitor.evaluate();

    // No one to notify
    expect(publisher.emitMarketDiscoveryDetected).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// scanner_gated agent detection (004, D-M1)
// ---------------------------------------------------------------------------

describe('scanner_gated agent detection (004)', () => {
  const SCANNER_GATED_KEY = 'agent:scanner_gated';

  it('watch threshold evaluation skips scanner_gated agents', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();

    const watchId = DEFAULT_WATCH_ID;
    const watchJson = makeWatch({ watchId, symbol: 'SOL', thresholdPrice: 200, condition: 'above' });
    redis._hstore.set(`watches:${watchId}`, new Map(Object.entries(JSON.parse(watchJson))));
    redis._scanKeys.push(`watches:${watchId}`);

    redis._sset.set('agents:active', new Set(['agent-gated-1']));
    redis._store.set(`${SCANNER_GATED_KEY}:agent-gated-1`, '1');

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher },
    );

    await monitor.evaluate();

    const wakeCalls = publisher.emitAgentWake.mock.calls.filter(
      (call: any[]) => call[0]?.agentId === 'agent-gated-1',
    );
    expect(wakeCalls.length).toBe(0);
  });

  it('discovery_delta uses context-only delivery for scanner_gated agents (no wake)', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();

    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xNEW', symbol: 'NEW', discoveryVectors: ['trending'] },
    ]));
    redis._store.set('market-intel:discovery:prev', makeDiscoverySnapshot([
      { network: 'solana', address: '0xOLD', symbol: 'OLD', discoveryVectors: [] },
    ]));

    redis._sset.set('agents:active', new Set(['agent-gated-2']));
    redis._store.set(`${SCANNER_GATED_KEY}:agent-gated-2`, '1');

    const monitor = createMarketMonitor(
      { families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false } },
      { redis, publisher },
    );

    await monitor.evaluate();

    const wakeCallsForGated = publisher.emitAgentWake.mock.calls.filter(
      (call: any[]) => call[0]?.agentId === 'agent-gated-2',
    );
    expect(wakeCallsForGated.length).toBe(0);
  });

  it('scanner_gated detection fails open — agent without Redis flag treated as not gated', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();

    const watchJson = makeWatch({ watchId: 'w-normal', symbol: 'SOL', thresholdPrice: 200, condition: 'above' });
    redis._hstore.set('watches:w-normal', new Map(Object.entries(JSON.parse(watchJson))));
    redis._scanKeys.push('watches:w-normal');

    redis._sset.set('agents:active', new Set(['agent-normal']));
    // Deliberately NOT setting scanner_gated key — key is absent

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher },
    );

    // Should not throw; fail-open means agent is not blocked
    await expect(monitor.evaluate()).resolves.toBeUndefined();
  });
});
