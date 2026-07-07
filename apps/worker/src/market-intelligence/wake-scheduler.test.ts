import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMarketMonitor } from './monitor.js';

// ---------------------------------------------------------------------------
// Redis mock factory (same pattern as monitor.test.ts)
// ---------------------------------------------------------------------------

function makeRedisMock() {
  const store = new Map<string, string>();
  const hstore = new Map<string, Map<string, string>>();
  const scanKeys: string[] = [];

  return {
    _store: store,
    _hstore: hstore,
    _scanKeys: scanKeys,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => { store.set(key, value); return 'OK'; }),
    hgetall: vi.fn(async (key: string) => {
      const h = hstore.get(key);
      if (!h || h.size === 0) return null;
      const result: Record<string, string> = {};
      for (const [field, value] of h) result[field] = value;
      return result;
    }),
    hset: vi.fn(async (key: string, field: string, value: string) => {
      if (!hstore.has(key)) hstore.set(key, new Map());
      hstore.get(key)!.set(field, value);
      return 1;
    }),
    del: vi.fn(async (...keys: string[]) => {
      let deleted = 0;
      for (const key of keys) {
        if (store.delete(key)) deleted++;
      }
      return deleted;
    }),
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    zadd: vi.fn(async () => 1),
    zscore: vi.fn(async () => null),
    scan: vi.fn(async (_cursor: string, _matchKeyword: string, pattern: string, _countKeyword?: string, _count?: number) => {
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
    pipeline: vi.fn(() => ({
      incr: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
  } as any;
}

function makePublisherMock() {
  return {
    emitMarketWatchTriggered: vi.fn().mockResolvedValue(undefined),
    emitMarketDiscoveryDetected: vi.fn().mockResolvedValue(undefined),
    emitMarketRegimeChanged: vi.fn().mockResolvedValue(undefined),
    emitAgentWake: vi.fn().mockResolvedValue(undefined),
  } as any;
}

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
    schemaVersion: 2,
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

// ===========================================================================
// Wake coalescing and flush behavior
// ===========================================================================

describe('wake scheduler — coalescing and cooldown', () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let publisher: ReturnType<typeof makePublisherMock>;

  beforeEach(() => {
    vi.useFakeTimers();
    redis = makeRedisMock();
    publisher = makePublisherMock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces multiple wake requests into a single emit after the window', async () => {
    // Set up a pending wake in Redis with scheduledAt in the past (ready to flush)
    const agentId = 'agent-001';
    const wakeKey = `market-monitor:wake:${agentId}`;
    redis._store.set(wakeKey, JSON.stringify({
      agentId,
      eventIds: ['ev-1', 'ev-2', 'ev-3'],
      scheduledAt: Date.now() - 100, // already past due
    }));
    redis._scanKeys.push(wakeKey);

    const monitor = createMarketMonitor(
      { enabled: true, wakeCoalescingWindowMs: 3000, wakeCooldownMs: 30000 },
      { redis, publisher },
    );

    // Flush pending wakes
    await monitor.flushWakes();

    // The single coalesced wake should emit one wake signal
    expect(publisher.emitAgentWake).toHaveBeenCalledTimes(1);
    expect(publisher.emitAgentWake).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        eventIds: ['ev-1', 'ev-2', 'ev-3'],
        reason: 'market monitor',
      }),
    );

    // Wake key should be deleted from Redis after flush
    expect(redis.del).toHaveBeenCalledWith(wakeKey);
  });

  it('suppresses wake when cooldown has not elapsed', async () => {
    const agentId = 'agent-002';
    const wakeKey = `market-monitor:wake:${agentId}`;
    const lastWakeKey = `market-monitor:wake:last:${agentId}`;

    // Pending wake ready to flush
    redis._store.set(wakeKey, JSON.stringify({
      agentId,
      eventIds: ['ev-1'],
      scheduledAt: Date.now() - 100,
    }));
    // Last wake emitted 5 seconds ago (within 30s cooldown)
    redis._store.set(lastWakeKey, String(Date.now() - 5_000));
    redis._scanKeys.push(wakeKey);

    const monitor = createMarketMonitor(
      { enabled: true, wakeCoalescingWindowMs: 3000, wakeCooldownMs: 30000 },
      { redis, publisher },
    );

    await monitor.flushWakes();

    // Wake should be suppressed due to cooldown
    expect(publisher.emitAgentWake).not.toHaveBeenCalled();
    const metrics = monitor.getMetrics();
    expect(metrics.wakeRequestsSuppressed).toBe(1);
  });

  it('counts a suppressed wake only once across repeated flush cycles', async () => {
    const agentId = 'agent-009';
    const wakeKey = `market-monitor:wake:${agentId}`;
    const lastWakeKey = `market-monitor:wake:last:${agentId}`;

    redis._store.set(wakeKey, JSON.stringify({
      agentId,
      eventIds: ['ev-1'],
      scheduledAt: Date.now() - 100,
    }));
    redis._store.set(lastWakeKey, String(Date.now() - 5_000));
    redis._scanKeys.push(wakeKey);

    const monitor = createMarketMonitor(
      { enabled: true, wakeCoalescingWindowMs: 3000, wakeCooldownMs: 30000 },
      { redis, publisher },
    );

    await monitor.flushWakes();
    await monitor.flushWakes();

    const metrics = monitor.getMetrics();
    expect(metrics.wakeRequestsSuppressed).toBe(1);
  });

  it('does not flush wakes whose scheduledAt is in the future', async () => {
    const agentId = 'agent-003';
    const wakeKey = `market-monitor:wake:${agentId}`;

    // Pending wake with scheduledAt in the future
    redis._store.set(wakeKey, JSON.stringify({
      agentId,
      eventIds: ['ev-1'],
      scheduledAt: Date.now() + 5_000, // 5 seconds from now
    }));
    redis._scanKeys.push(wakeKey);

    const monitor = createMarketMonitor(
      { enabled: true, wakeCoalescingWindowMs: 3000, wakeCooldownMs: 30000 },
      { redis, publisher },
    );

    await monitor.flushWakes();

    // Should not emit yet — scheduledAt is in the future
    expect(publisher.emitAgentWake).not.toHaveBeenCalled();
  });

  it('emits wake after cooldown has elapsed', async () => {
    const agentId = 'agent-004';
    const wakeKey = `market-monitor:wake:${agentId}`;
    const lastWakeKey = `market-monitor:wake:last:${agentId}`;

    // Pending wake ready to flush
    redis._store.set(wakeKey, JSON.stringify({
      agentId,
      eventIds: ['ev-1'],
      scheduledAt: Date.now() - 100,
    }));
    // Last wake emitted 35 seconds ago (beyond 30s cooldown)
    redis._store.set(lastWakeKey, String(Date.now() - 35_000));
    redis._scanKeys.push(wakeKey);

    const monitor = createMarketMonitor(
      { enabled: true, wakeCoalescingWindowMs: 3000, wakeCooldownMs: 30000 },
      { redis, publisher },
    );

    await monitor.flushWakes();

    expect(publisher.emitAgentWake).toHaveBeenCalledTimes(1);
    const metrics = monitor.getMetrics();
    expect(metrics.wakeRequestsEmitted).toBe(1);
  });

  it('does not emit concurrent wakes for the same agent', async () => {
    const agentId = 'agent-005';
    const wakeKey = `market-monitor:wake:${agentId}`;

    redis._store.set(wakeKey, JSON.stringify({
      agentId,
      eventIds: ['ev-1'],
      scheduledAt: Date.now() - 100,
    }));
    redis._scanKeys.push(wakeKey);

    const monitor = createMarketMonitor(
      { enabled: true, wakeCoalescingWindowMs: 3000, wakeCooldownMs: 30000 },
      { redis, publisher },
    );

    // First flush emits
    await monitor.flushWakes();
    expect(publisher.emitAgentWake).toHaveBeenCalledTimes(1);

    // Now the cooldown key is set — a new wake enqueued should be suppressed
    redis._store.set(wakeKey, JSON.stringify({
      agentId,
      eventIds: ['ev-2'],
      scheduledAt: Date.now() - 100,
    }));
    // scanKeys still has the key listed (simulating re-enqueue)

    await monitor.flushWakes();
    // Second wake should be suppressed by cooldown
    expect(publisher.emitAgentWake).toHaveBeenCalledTimes(1);
    const metrics = monitor.getMetrics();
    expect(metrics.wakeRequestsSuppressed).toBe(1);
  });

  it('caps coalesced event IDs at MAX_COALESCED_EVENT_IDS (5)', async () => {
    const agentId = 'agent-006';
    const wakeKey = `market-monitor:wake:${agentId}`;

    // Pre-populate with 5 events already
    redis._store.set(wakeKey, JSON.stringify({
      agentId,
      eventIds: ['ev-1', 'ev-2', 'ev-3', 'ev-4', 'ev-5'],
      scheduledAt: Date.now() - 100,
    }));
    redis._scanKeys.push(wakeKey);

    const monitor = createMarketMonitor(
      { enabled: true, wakeCoalescingWindowMs: 3000, wakeCooldownMs: 30000 },
      { redis, publisher },
    );

    await monitor.flushWakes();

    expect(publisher.emitAgentWake).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        eventIds: ['ev-1', 'ev-2', 'ev-3', 'ev-4', 'ev-5'],
      }),
    );
  });

  it('wake state survives between evaluate cycles (Redis-backed)', async () => {
    // This test verifies that wake state is in Redis, not in-memory
    const agentId = 'agent-007';
    const wakeKey = `market-monitor:wake:${agentId}`;

    // Simulate that a wake was triggered and wake was enqueued to Redis
    redis._store.set(wakeKey, JSON.stringify({
      agentId,
      eventIds: ['ev-triggered'],
      scheduledAt: Date.now() - 100,
    }));
    redis._scanKeys.push(wakeKey);

    // Create a NEW monitor instance (simulating failover to new leader)
    const monitor = createMarketMonitor(
      { enabled: true, wakeCoalescingWindowMs: 3000, wakeCooldownMs: 30000 },
      { redis, publisher },
    );

    await monitor.flushWakes();

    // The new monitor instance should flush the pending wake from Redis
    expect(publisher.emitAgentWake).toHaveBeenCalledTimes(1);
    expect(publisher.emitAgentWake).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ eventIds: ['ev-triggered'] }),
    );
  });

  it('retains the pending wake bucket when publish fails', async () => {
    const agentId = 'agent-008';
    const wakeKey = `market-monitor:wake:${agentId}`;

    redis._store.set(wakeKey, JSON.stringify({
      agentId,
      eventIds: ['ev-failed'],
      scheduledAt: Date.now() - 100,
    }));
    redis._scanKeys.push(wakeKey);
    publisher.emitAgentWake.mockRejectedValueOnce(new Error('publish failed'));

    const monitor = createMarketMonitor(
      { enabled: true, wakeCoalescingWindowMs: 3000, wakeCooldownMs: 30000 },
      { redis, publisher },
    );

    await expect(monitor.flushWakes()).rejects.toThrow('publish failed');
    expect(redis._store.get(wakeKey)).toBeTruthy();
    expect(redis.del).not.toHaveBeenCalledWith(wakeKey);
  });

  it('does not duplicate wake emission when flush is called concurrently', async () => {
    const agentId = 'agent-010';
    const wakeKey = `market-monitor:wake:${agentId}`;
    const deferred = createDeferred<void>();

    redis._store.set(wakeKey, JSON.stringify({
      agentId,
      eventIds: ['ev-1'],
      scheduledAt: Date.now() - 100,
    }));
    redis._scanKeys.push(wakeKey);
    publisher.emitAgentWake.mockReturnValueOnce(deferred.promise);

    const monitor = createMarketMonitor(
      { enabled: true, wakeCoalescingWindowMs: 3000, wakeCooldownMs: 30000 },
      { redis, publisher },
    );

    const firstFlush = monitor.flushWakes();
    await vi.waitFor(() => expect(publisher.emitAgentWake).toHaveBeenCalledTimes(1));
    const secondFlush = monitor.flushWakes();

    expect(publisher.emitAgentWake).toHaveBeenCalledTimes(1);

    deferred.resolve();
    await firstFlush;
    await secondFlush;
  });

  it('preserves bucket when enqueue happens at cap during in-flight publish', async () => {
    const agentId = 'agent-012';
    const wakeKey = `market-monitor:wake:${agentId}`;
    const deferred = createDeferred<void>();

    // Bucket already at MAX_COALESCED_EVENT_IDS (5) with generation 5
    redis._store.set(wakeKey, JSON.stringify({
      agentId,
      eventIds: ['ev-1', 'ev-2', 'ev-3', 'ev-4', 'ev-5'],
      scheduledAt: Date.now() - 100,
      generation: 5,
    }));
    redis._scanKeys.push(wakeKey);
    publisher.emitAgentWake.mockReturnValueOnce(deferred.promise);

    const monitor = createMarketMonitor(
      { enabled: true, wakeCoalescingWindowMs: 3000, wakeCooldownMs: 30000 },
      { redis, publisher },
    );

    // Start flush — publish blocks on deferred
    const firstFlush = monitor.flushWakes();
    await vi.waitFor(() => expect(publisher.emitAgentWake).toHaveBeenCalledTimes(1));

    // Simulate a new enqueue while publish is in flight: generation advances
    // but eventIds stays at cap length (same last element).
    redis._store.set(wakeKey, JSON.stringify({
      agentId,
      eventIds: ['ev-1', 'ev-2', 'ev-3', 'ev-4', 'ev-5'],
      scheduledAt: Date.now() + 3_000,
      generation: 6,
    }));

    // Unblock publish
    deferred.resolve();
    await firstFlush;

    // The bucket must survive because generation advanced
    const raw = redis._store.get(wakeKey);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).generation).toBe(6);

    // Advance past scheduledAt so the next flush can emit it
    await vi.advanceTimersByTimeAsync(30_000);
    await monitor.flushWakes();
    expect(publisher.emitAgentWake).toHaveBeenCalledTimes(2);
  });

  it('preserves a new wake enqueued while a flush is in flight', async () => {
    const agentId = 'agent-011';
    const wakeKey = `market-monitor:wake:${agentId}`;
    const deferred = createDeferred<void>();

    redis._store.set('market-intel:discovery:latest', JSON.stringify({
      snapshotId: 'snap-1',
      capturedAt: '2026-06-10T00:00:00.000Z',
      freshness: { state: 'fresh', ageMs: 0, maxAllowedAgeMs: 600_000 },
      sources: { discovery: { ok: true, freshness: 'fresh' } },
      tokens: [
        {
          network: 'solana',
          address: '0x1',
          symbol: 'SOL',
          name: 'Solana',
          priceUsd: 200,
          liquidityUsd: 1_000_000,
          volume24hUsd: 10_000_000,
          poolAddress: null,
          poolCreatedAt: null,
          discoveryVectors: ['trending'],
          rank: 1,
        },
      ],
    }));
    redis._hstore.set(`agent:watches:${agentId}`, new Map([
      ['watch-1', makeWatch({ symbol: 'SOL', chain: 'solana', thresholdPrice: 100, condition: 'above', lastConditionMet: false })],
    ]));
    redis._scanKeys.push(`agent:watches:${agentId}`);

    redis._store.set(wakeKey, JSON.stringify({
      agentId,
      eventIds: ['ev-existing'],
      scheduledAt: Date.now() - 100,
    }));
    redis._scanKeys.push(wakeKey);
    publisher.emitAgentWake.mockReturnValueOnce(deferred.promise);

    const monitor = createMarketMonitor(
      { enabled: true, wakeCoalescingWindowMs: 3000, wakeCooldownMs: 30000 },
      { redis, publisher },
    );

    const firstFlush = monitor.flushWakes();
    await vi.waitFor(() => expect(publisher.emitAgentWake).toHaveBeenCalledTimes(1));

    const evaluatePromise = monitor.evaluate();
    deferred.resolve();
    await firstFlush;
    await evaluatePromise;

    const pendingWakeRaw = redis._store.get(wakeKey);
    expect(pendingWakeRaw).toBeTruthy();
    expect(JSON.parse(pendingWakeRaw!).eventIds).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(30_000);
    await monitor.flushWakes();

    expect(publisher.emitAgentWake).toHaveBeenCalledTimes(2);
  });
});
