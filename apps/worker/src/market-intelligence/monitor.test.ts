import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMarketMonitor, type TriggeredWatch } from './monitor.js';

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
        if (sset.delete(key)) deleted++;
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
    purpose: overrides.purpose ?? 'alert',
    schemaVersion: overrides.schemaVersion ?? 2,
  };
  if (overrides.resolvedChain) base.resolvedChain = overrides.resolvedChain;
  if (overrides.resolvedSymbol) base.resolvedSymbol = overrides.resolvedSymbol;
  if (overrides.resolvedAddress) base.resolvedAddress = overrides.resolvedAddress;
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

// ---------------------------------------------------------------------------
// Boundary port helpers (B3-monitor)
//
// Watch evaluation authority lives in Traderton; the monitor sources triggered
// (edge-up) + reset (edge-down) watches from the `evaluateAgentWatches` port.
// These helpers build the port's return shape + a scripted fake port.
// ---------------------------------------------------------------------------

// Use the exported TriggeredWatch type so the fixtures track the real port
// contract (e.g. `purpose` is the WatchPurpose enum, not a loose string).
type TriggeredWatchLike = TriggeredWatch;

function makeTriggeredWatch(overrides: Partial<TriggeredWatchLike> = {}): TriggeredWatchLike {
  return {
    watchId: overrides.watchId ?? DEFAULT_WATCH_ID,
    symbol: overrides.symbol ?? 'SOL',
    chain: overrides.chain ?? 'solana',
    condition: overrides.condition ?? 'above',
    thresholdPrice: overrides.thresholdPrice ?? 200,
    currentPrice: overrides.currentPrice ?? 204,
    priceSource: overrides.priceSource ?? 'discovery_snapshot',
    stale: overrides.stale ?? false,
    ...(overrides.note !== undefined ? { note: overrides.note } : {}),
    ...(overrides.purpose !== undefined ? { purpose: overrides.purpose } : {}),
    ...(overrides.instrument !== undefined ? { instrument: overrides.instrument } : {}),
    ...(overrides.coverage !== undefined ? { coverage: overrides.coverage } : {}),
    ...(overrides.schemaVersion !== undefined ? { schemaVersion: overrides.schemaVersion } : {}),
    ...(overrides.resolvedSymbol !== undefined ? { resolvedSymbol: overrides.resolvedSymbol } : {}),
    ...(overrides.resolvedChain !== undefined ? { resolvedChain: overrides.resolvedChain } : {}),
  };
}

/**
 * Build a fake `evaluateAgentWatches` port. `byAgent` maps agentId → the
 * {triggered, reset} result returned for that agent; unmapped agents return
 * empty. The returned mock records calls for assertions.
 */
function makeWatchPort(byAgent: Record<string, { triggered?: TriggeredWatchLike[]; reset?: string[] }>) {
  return vi.fn(async (agentId: string) => {
    const entry = byAgent[agentId] ?? {};
    return { triggered: entry.triggered ?? [], reset: entry.reset ?? [] };
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

  /** Mark an agent active + subscribed so the boundary port is invoked for it. */
  function activateAgent(agentId: string) {
    redis.sadd('agent:sessions:active', agentId);
  }

  it('emits market.watch.triggered on triggered entry (above)', async () => {
    activateAgent('agent-1');
    const port = makeWatchPort({
      'agent-1': { triggered: [makeTriggeredWatch({ symbol: 'SOL', condition: 'above', thresholdPrice: 200, currentPrice: 204, stale: false })] },
    });

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher, evaluateAgentWatches: port });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [calledAgentId, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(calledAgentId).toBe('agent-1');
    expect(payload.monitorType).toBe('watch_threshold');
    expect(payload.symbol).toBe('SOL');
    expect(payload.condition).toBe('above');
    expect(payload.thresholdPrice).toBe(200);
    expect(payload.currentPrice).toBe(204);
    expect(payload.priceSource).toBe('discovery_snapshot');
    expect(payload.stale).toBe(false);
  });

  it('emits market.watch.triggered on triggered entry (below)', async () => {
    activateAgent('agent-1');
    const port = makeWatchPort({
      'agent-1': { triggered: [makeTriggeredWatch({ symbol: 'SOL', condition: 'below', thresholdPrice: 100, currentPrice: 95 })] },
    });

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher, evaluateAgentWatches: port });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(payload.condition).toBe('below');
    expect(payload.currentPrice).toBe(95);
  });

  it('maps effectiveSymbol/effectiveChain from resolved fields on the triggered entry', async () => {
    activateAgent('agent-1');
    const port = makeWatchPort({
      'agent-1': { triggered: [makeTriggeredWatch({ symbol: 'WSOL', chain: 'any', resolvedSymbol: 'SOL', resolvedChain: 'solana', currentPrice: 204 })] },
    });

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher, evaluateAgentWatches: port });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    // Payload carries the resolved identity, not the original "any"/"WSOL"
    expect(payload.symbol).toBe('SOL');
    expect(payload.chain).toBe('solana');
  });

  it('does NOT emit when the port returns no triggered entries', async () => {
    activateAgent('agent-1');
    const port = makeWatchPort({ 'agent-1': { triggered: [], reset: [] } });

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher, evaluateAgentWatches: port });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).not.toHaveBeenCalled();
  });

  it('no-ops when the evaluateAgentWatches port is not configured', async () => {
    activateAgent('agent-1');

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).not.toHaveBeenCalled();
  });

  it('suppresses second emission when dedupe key is already set', async () => {
    activateAgent('agent-1');
    const port = makeWatchPort({
      'agent-1': { triggered: [makeTriggeredWatch({ condition: 'above', thresholdPrice: 200, currentPrice: 204 })] },
    });

    // Pre-populate the platform dedupe key for this watch's cross:above.
    redis._store.set(`market-monitor:dedupe:watch:${DEFAULT_WATCH_ID}:cross:above`, '1');

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher, evaluateAgentWatches: port });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).not.toHaveBeenCalled();
    expect(monitor.getMetrics().eventsSuppressed).toBe(1);
  });

  it('dedupe suppresses a re-triggered watch on a second evaluate cycle', async () => {
    activateAgent('agent-1');
    const triggered = [makeTriggeredWatch({ condition: 'above', thresholdPrice: 200, currentPrice: 204 })];
    const port = makeWatchPort({ 'agent-1': { triggered } });

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher, evaluateAgentWatches: port });

    // Cycle 1: emits + records dedupe.
    await monitor.evaluate();
    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();

    // Cycle 2: same triggered entry — dedupe key set from cycle 1 suppresses it.
    await monitor.evaluate();
    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    expect(monitor.getMetrics().eventsSuppressed).toBe(1);
  });

  it('enqueues a wake request after a watch trigger', async () => {
    activateAgent('agent-1');
    const port = makeWatchPort({
      'agent-1': { triggered: [makeTriggeredWatch({ condition: 'above', thresholdPrice: 200, currentPrice: 204 })] },
    });

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher, evaluateAgentWatches: port });
    await monitor.evaluate();

    expect(monitor.getMetrics().eventsEmitted).toBe(1);
    // Wake bucket enqueued (coalesced) under the source-scoped key.
    expect(redis._store.has('market-monitor:wake:agent-1:watch_threshold')).toBe(true);
  });

  it('increments eventsEmitted counter on each trigger', async () => {
    activateAgent('agent-1');
    const port = makeWatchPort({
      'agent-1': { triggered: [makeTriggeredWatch({ condition: 'above', thresholdPrice: 200, currentPrice: 204 })] },
    });

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher, evaluateAgentWatches: port });
    await monitor.evaluate();

    expect(monitor.getMetrics().eventsEmitted).toBe(1);
  });

  it('maps priceSource + stale straight through from the triggered entry', async () => {
    activateAgent('agent-1');
    const port = makeWatchPort({
      'agent-1': { triggered: [makeTriggeredWatch({ condition: 'above', thresholdPrice: 200, currentPrice: 204, priceSource: 'regime_snapshot', stale: true })] },
    });

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher, evaluateAgentWatches: port });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(payload.priceSource).toBe('regime_snapshot');
    expect(payload.stale).toBe(true);
  });

  it('populates purpose, instrument, positionKey, and schemaVersion in payload when present on the triggered entry', async () => {
    activateAgent('agent-1');
    const port = makeWatchPort({
      'agent-1': { triggered: [makeTriggeredWatch({
        symbol: 'SOL',
        condition: 'above',
        thresholdPrice: 200,
        currentPrice: 204,
        purpose: 'stop_loss',
        instrument: { venue: 'hyperliquid', instrumentId: 'SOL-USD' },
        coverage: { positionKey: 'pos-sol-stop-1' },
        schemaVersion: 2,
      })] },
    });

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher, evaluateAgentWatches: port });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(payload.purpose).toBe('stop_loss');
    expect(payload.instrumentVenue).toBe('hyperliquid');
    expect(payload.instrumentId).toBe('SOL-USD');
    expect(payload.positionKey).toBe('pos-sol-stop-1');
    expect(payload.schemaVersion).toBe(2);
  });

  it('populates only partial new fields when the triggered entry has some but not all metadata', async () => {
    activateAgent('agent-1');
    const port = makeWatchPort({
      'agent-1': { triggered: [makeTriggeredWatch({
        symbol: 'ETH',
        chain: 'ethereum',
        condition: 'below',
        thresholdPrice: 3000,
        currentPrice: 2950,
        purpose: 'entry',
        instrument: { venue: 'hyperliquid', instrumentId: 'ETH-USD' },
        // no coverage/positionKey
      })] },
    });

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher, evaluateAgentWatches: port });
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [, payload] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(payload.purpose).toBe('entry');
    expect(payload.instrumentVenue).toBe('hyperliquid');
    expect(payload.instrumentId).toBe('ETH-USD');
    expect(payload.positionKey).toBeUndefined();
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

  it('clears the dedupe key on reset so a re-trigger fires again', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();
    redis.sadd('agent:sessions:active', 'agent-1');

    const triggered = [makeTriggeredWatch({ condition: 'above', thresholdPrice: 200, currentPrice: 204 })];
    // Cycle 1: triggered → emits + sets dedupe.
    // Cycle 2: reset[watchId] → clears both cross:above and cross:below dedupe keys.
    // Cycle 3: triggered again → emits again (not suppressed).
    const port = vi.fn(async (_agentId: string) => ({ triggered: [] as ReturnType<typeof makeTriggeredWatch>[], reset: [] as string[] }))
      .mockResolvedValueOnce({ triggered, reset: [] })
      .mockResolvedValueOnce({ triggered: [], reset: [DEFAULT_WATCH_ID] })
      .mockResolvedValueOnce({ triggered, reset: [] });

    const monitor = createMarketMonitor({ families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } }, { redis, publisher, evaluateAgentWatches: port });

    // Cycle 1 — first trigger emits.
    await monitor.evaluate();
    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();

    // Cycle 2 — reset clears BOTH cross keys.
    await monitor.evaluate();
    expect(redis.del).toHaveBeenCalledWith(`market-monitor:dedupe:watch:${DEFAULT_WATCH_ID}:cross:above`);
    expect(redis.del).toHaveBeenCalledWith(`market-monitor:dedupe:watch:${DEFAULT_WATCH_ID}:cross:below`);

    // Cycle 3 — re-trigger fires again because dedupe was cleared.
    await monitor.evaluate();
    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledTimes(2);
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
    // The outer evaluate() try/catch increments evaluationFailures. Make the
    // active-agent lookup (smembers, called by getSubscribedAgentIds inside
    // evaluateWatches) throw so the whole cycle fails.
    const redis = makeRedisMock({
      smembers: vi.fn().mockRejectedValue(new Error('Redis gone')),
    });
    const publisher = makePublisherMock();
    const port = makeWatchPort({});

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher, evaluateAgentWatches: port },
    );
    await monitor.evaluate();

    expect(monitor.getMetrics().evaluationFailures).toBe(1);
  });

  it('increments eventsSuppressed when dedupe suppresses a watch trigger', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();

    redis.sadd('agent:sessions:active', 'agent-1');
    const port = makeWatchPort({
      'agent-1': { triggered: [makeTriggeredWatch({ condition: 'above', thresholdPrice: 100, currentPrice: 204 })] },
    });
    redis._store.set(`market-monitor:dedupe:watch:${DEFAULT_WATCH_ID}:cross:above`, '1');

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher, evaluateAgentWatches: port },
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
    redis.sadd('agent:sessions:active', 'agent-1');

    // Two distinct triggered watches for the same agent → two wakes coalesce.
    const W1 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const W2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
    const port = makeWatchPort({
      'agent-1': { triggered: [
        makeTriggeredWatch({ watchId: W1, condition: 'above', thresholdPrice: 100, currentPrice: 200 }),
        makeTriggeredWatch({ watchId: W2, condition: 'above', thresholdPrice: 150, currentPrice: 200 }),
      ] },
    });

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher, evaluateAgentWatches: port },
    );
    await monitor.evaluate();

    // Two events emitted for same agent → second coalesces
    expect(monitor.getMetrics().eventsEmitted).toBe(2);
    expect(monitor.getMetrics().wakeRequestsCoalesced).toBe(1);
  });

  it('caps coalesced eventIds at MAX_COALESCED_EVENT_IDS (5)', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();
    redis.sadd('agent:sessions:active', 'agent-1');

    // 6 distinct triggered watches for the same agent.
    const triggered = [];
    for (let i = 1; i <= 6; i++) {
      const watchId = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
      triggered.push(makeTriggeredWatch({ watchId, condition: 'above', thresholdPrice: i, currentPrice: 200 }));
    }
    const port = makeWatchPort({ 'agent-1': { triggered } });

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher, evaluateAgentWatches: port },
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
    redis.sadd('agent:sessions:active', 'agent-1');

    const W1 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const W2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
    const port = makeWatchPort({
      'agent-1': { triggered: [
        makeTriggeredWatch({ watchId: W1, condition: 'above', thresholdPrice: 100, currentPrice: 200 }),
        makeTriggeredWatch({ watchId: W2, condition: 'above', thresholdPrice: 150, currentPrice: 200 }),
      ] },
    });

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher, evaluateAgentWatches: port },
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
    const port = makeWatchPort({ 'agent-1': { triggered: [makeTriggeredWatch({ condition: 'above', thresholdPrice: 200, currentPrice: 204 })] } });

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher, evaluateAgentWatches: port },
    );
    await monitor.evaluate();

    // Event IS emitted
    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    // Wake IS enqueued (key exists in Redis)
    expect(redis._store.has('market-monitor:wake:agent-1:watch_threshold')).toBe(true);
  });

  // --- watch threshold: context mode ---

  it('emits event but does NOT enqueue wake when watch_threshold mode is context', async () => {
    const port = makeWatchPort({ 'agent-1': { triggered: [makeTriggeredWatch({ condition: 'above', thresholdPrice: 200, currentPrice: 204 })] } });

    const monitor = createMarketMonitor(
      {
        families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false },
        wakePolicy: { watch_threshold: { mode: 'context' } },
      },
      { redis, publisher, evaluateAgentWatches: port },
    );
    await monitor.evaluate();

    // Event IS emitted
    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    // Wake is NOT enqueued
    expect(redis._store.has('market-monitor:wake:agent-1:watch_threshold')).toBe(false);
  });

  // --- watch threshold: wake mode (explicit) ---

  it('emits event and enqueues wake when watch_threshold mode is wake', async () => {
    const port = makeWatchPort({ 'agent-1': { triggered: [makeTriggeredWatch({ condition: 'above', thresholdPrice: 200, currentPrice: 204 })] } });

    const monitor = createMarketMonitor(
      {
        families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false },
        wakePolicy: { watch_threshold: { mode: 'wake' } },
      },
      { redis, publisher, evaluateAgentWatches: port },
    );
    await monitor.evaluate();

    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    expect(redis._store.has('market-monitor:wake:agent-1:watch_threshold')).toBe(true);
  });

  // --- watch threshold: batched mode ---

  it('emits event and enqueues wake when watch_threshold mode is batched', async () => {
    const port = makeWatchPort({ 'agent-1': { triggered: [makeTriggeredWatch({ condition: 'above', thresholdPrice: 200, currentPrice: 204 })] } });

    const monitor = createMarketMonitor(
      {
        families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false },
        wakePolicy: { watch_threshold: { mode: 'batched' } },
      },
      { redis, publisher, evaluateAgentWatches: port },
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

  it('skips agents not in agent:sessions:active — port not invoked, no emit', async () => {
    // agent-1 is NOT added to the active set. The boundary port would trigger
    // a watch if invoked, but it must never be called for an inactive agent.
    const port = makeWatchPort({ 'agent-1': { triggered: [makeTriggeredWatch({ condition: 'above', thresholdPrice: 200, currentPrice: 204 })] } });

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher, evaluateAgentWatches: port },
    );
    await monitor.evaluate();

    // Port never invoked for the inactive agent → no watch event emitted.
    expect(port).not.toHaveBeenCalled();
    expect(publisher.emitMarketWatchTriggered).not.toHaveBeenCalled();
  });

  it('emits watch event for active subscribed agent', async () => {
    addActiveAgent('agent-1');
    const port = makeWatchPort({ 'agent-1': { triggered: [makeTriggeredWatch({ condition: 'above', thresholdPrice: 200, currentPrice: 204 })] } });

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher, evaluateAgentWatches: port },
    );
    await monitor.evaluate();

    // Active agent receives the watch trigger
    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledOnce();
    const [agentId] = publisher.emitMarketWatchTriggered.mock.calls[0]!;
    expect(agentId).toBe('agent-1');
    // The boundary port was invoked for the subscribed agent.
    expect(port).toHaveBeenCalledWith('agent-1');
  });

  // -----------------------------------------------------------------------
  // C4.4 — evaluateWatches reads prefs once per agent per cycle
  // -----------------------------------------------------------------------

  it('reads wake prefs once per agent per evaluation cycle', async () => {
    addActiveAgent('agent-1');
    // Two triggered watches for the same agent in one cycle.
    const W1 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const W2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
    const port = makeWatchPort({
      'agent-1': { triggered: [
        makeTriggeredWatch({ watchId: W1, condition: 'above', thresholdPrice: 100, currentPrice: 200 }),
        makeTriggeredWatch({ watchId: W2, condition: 'above', thresholdPrice: 150, currentPrice: 200 }),
      ] },
    });

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher, evaluateAgentWatches: port },
    );
    await monitor.evaluate();

    // The boundary port is invoked once per agent per cycle — subscription
    // resolution (which reads prefs) is hoisted before the per-watch loop, so
    // two triggered watches for the same agent do not cause a second lookup.
    expect(port).toHaveBeenCalledTimes(1);
    expect(port).toHaveBeenCalledWith('agent-1');
    // Both triggered watches still emit.
    expect(publisher.emitMarketWatchTriggered).toHaveBeenCalledTimes(2);
  });

  // Edge: agent with prefs that exclude watch_threshold — the port is never invoked for it.
  it('does not invoke the port when watch_threshold not in subscribedSources', async () => {
    addActiveAgent('agent-1');
    setWakePrefs('agent-1', { subscribedSources: ['discovery_delta'] });
    const port = makeWatchPort({ 'agent-1': { triggered: [makeTriggeredWatch({ condition: 'above', thresholdPrice: 200, currentPrice: 204 })] } });

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher, evaluateAgentWatches: port },
    );
    await monitor.evaluate();

    // Agent only wants discovery_delta → not subscribed to watch_threshold →
    // port not invoked, no watch event emitted.
    expect(port).not.toHaveBeenCalled();
    expect(publisher.emitMarketWatchTriggered).not.toHaveBeenCalled();
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
    const port = makeWatchPort({ 'agent-1': { triggered: [makeTriggeredWatch({ condition: 'above', thresholdPrice: 200, currentPrice: 204 })] } });

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher, evaluateAgentWatches: port },
    );
    await monitor.evaluate();

    // Malformed prefs → treated as subscribed to all sources → port invoked, event fires.
    expect(port).toHaveBeenCalledWith('agent-1');
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

  // Helper: mark an agent active + scanner-gated and script a triggered watch
  // over the boundary port.
  function makeScannerGatedPort(
    redis: ReturnType<typeof makeRedisMock>,
    agentId: string,
    triggered: ReturnType<typeof makeTriggeredWatch>[],
  ) {
    redis.sadd('agent:sessions:active', agentId);
    redis._store.set(`${SCANNER_GATED_KEY}:${agentId}`, '1');
    return makeWatchPort({ [agentId]: { triggered } });
  }

  it('emits watch event but does NOT enqueue wake for scanner_gated agents (context-only)', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();

    const agentId = 'agent-gated-2';
    const port = makeScannerGatedPort(redis, agentId, [
      makeTriggeredWatch({ condition: 'above', thresholdPrice: 200, currentPrice: 204 }),
    ]);

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher, evaluateAgentWatches: port },
    );

    await monitor.evaluate();

    // Event should still be emitted (context-only, not wake)
    const triggerCalls = publisher.emitMarketWatchTriggered.mock.calls.filter(
      (call: unknown[]) => call[0] === agentId,
    );
    expect(triggerCalls.length).toBe(1);

    // No wake bucket should be enqueued for the scanner-gated agent (context-only).
    expect(redis._store.has(`market-monitor:wake:${agentId}:watch_threshold`)).toBe(false);
  });

  it('discovery_delta uses context-only delivery for scanner_gated agents (no wake)', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();

    redis._store.set('market-intel:discovery:latest', makeDiscoverySnapshot([
      { network: 'solana', address: '0xNEW', symbol: 'NEW', discoveryVectors: ['trending'] },
    ]));

    redis._sset.set('agent:sessions:active', new Set(['agent-gated-4']));
    redis._store.set(`${SCANNER_GATED_KEY}:agent-gated-4`, '1');

    const monitor = createMarketMonitor(
      { families: { watchThresholds: false, discoveryDeltas: true, regimeChanges: false } },
      { redis, publisher },
    );

    await monitor.evaluate();

    const wakeCallsForGated = publisher.emitAgentWake.mock.calls.filter(
      (call: unknown[]) => call[0]?.agentId === 'agent-gated-4',
    );
    expect(wakeCallsForGated.length).toBe(0);
  });

  it('scanner_gated detection fails open — agent without Redis flag treated as not gated', async () => {
    const redis = makeRedisMock();
    const publisher = makePublisherMock();

    const agentId = 'agent-normal';
    redis.sadd('agent:sessions:active', agentId);
    // Deliberately NOT setting scanner_gated key — key is absent.
    const port = makeWatchPort({ [agentId]: { triggered: [makeTriggeredWatch({ condition: 'above', thresholdPrice: 200, currentPrice: 204 })] } });

    const monitor = createMarketMonitor(
      { families: { watchThresholds: true, discoveryDeltas: false, regimeChanges: false } },
      { redis, publisher, evaluateAgentWatches: port },
    );

    // Should not throw; fail-open means agent is not blocked
    await expect(monitor.evaluate()).resolves.toBeUndefined();

    // Non-gated agent should get the event emitted AND a wake bucket enqueued
    // (not context-only), since scanner-gated detection failed open to "not gated".
    const triggerCalls = publisher.emitMarketWatchTriggered.mock.calls.filter(
      (call: unknown[]) => call[0] === agentId,
    );
    expect(triggerCalls.length).toBe(1);
    expect(monitor.getMetrics().eventsEmitted).toBe(1);
    expect(redis._store.has(`market-monitor:wake:${agentId}:watch_threshold`)).toBe(true);
  });
});
