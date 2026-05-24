import { describe, it, expect, vi } from 'vitest';
import { TradingActor } from './trading-actor.js';
import type { TradingActorDeps } from './trading-actor.js';
import { price, quantity, ok, err } from '@herobids/domain';
import type { OrderId, FillId, TradingInstanceId } from '@herobids/domain';

/**
 * Minimal stubs for TradingActor lifecycle tests.
 * These test the startup contract (reconciliation blocking, stream readiness)
 * and order persistence with executionPlanId linkage.
 */

function makeIdGen() {
  let c = 0;
  return {
    orderId: () => `o-${++c}` as OrderId,
    fillId: () => `f-${++c}` as FillId,
    planId: () => `p-${++c}`,
    decisionId: () => `d-${++c}`,
  };
}

function stubRepo() {
  return {
    insertFill: vi.fn().mockResolvedValue('fill-id'),
    getRecentByInstance: vi.fn().mockResolvedValue([]),
    getOpenByInstance: vi.fn().mockResolvedValue([]),
    getLatestByVenueAccount: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    insertPlan: vi.fn().mockResolvedValue(undefined),
    markExecuting: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    getIncomplete: vi.fn().mockResolvedValue([]),
    getByExecutionPlanId: vi.fn().mockResolvedValue([]),
    upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(undefined),
    getLastReconciledAt: vi.fn().mockResolvedValue(null),
  };
}

function makeBaseDeps(overrides?: Partial<TradingActorDeps>): TradingActorDeps {
  const repo = stubRepo();
  return {
    strategy: {
      evaluate: vi.fn().mockResolvedValue(ok(null)), // no opinion = hold
    } as any,
    journal: { append: vi.fn().mockResolvedValue(undefined) } as any,
    fillRepo: repo as any,
    positionRepo: repo as any,
    planRepo: repo as any,
    orderRepo: repo as any,
    balanceSnapshotRepo: repo as any,
    reconciliationRepo: repo as any,
    riskLimits: {
      maxPositionSize: quantity('100'),
      maxOpenPositions: 5,
      maxDrawdown: price('10000'),
    },
    idGen: makeIdGen(),
    fetchPrice: vi.fn().mockResolvedValue({ symbol: 'BTC/USD', price: price('50000'), timestamp: new Date().toISOString() }),
    venue: 'hyperliquid',
    symbol: 'BTC/USD:USD',
    venueAccountId: 'va-1',
    ...overrides,
  };
}

describe('TradingActor lifecycle', () => {
  describe('startup reconciliation blocking', () => {
    it('throws if reconciliation first pass returns null (venue fetch failed)', async () => {
      // A venuePort that fails all fetches — causing reconciler.runPass() to return null
      const venuePort = {
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(err({ code: 'NETWORK_ERROR', message: 'timeout' })),
        fetchBalances: vi.fn().mockResolvedValue(err({ code: 'NETWORK_ERROR', message: 'timeout' })),
        fetchRecentFills: vi.fn().mockResolvedValue(err({ code: 'NETWORK_ERROR', message: 'timeout' })),
        fetchOpenOrders: vi.fn().mockResolvedValue(err({ code: 'NETWORK_ERROR', message: 'timeout' })),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn(), onStateChange: vi.fn() })),
      } as any;

      const deps = makeBaseDeps({
        venuePort,
        reconciliationConfig: { intervalMs: 30000, driftAlertOnly: false },
        executionMode: 'shadow',
      });

      const actor = new TradingActor('inst-1', {}, deps);
      await expect(actor.start()).rejects.toThrow('venue state could not be confirmed');
    });

    it('throws if reconciliation detects drift and driftAlertOnly is false', async () => {
      // A venuePort that returns positions different from local state
      const venuePort = {
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([
          { symbol: 'BTC/USD:USD', side: 'long', size: quantity('5'), entryPrice: price('48000') },
        ])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [{ asset: 'USD', free: quantity('10000'), locked: quantity('0'), total: quantity('10000') }] })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn(), onStateChange: vi.fn() })),
      } as any;

      const deps = makeBaseDeps({
        venuePort,
        reconciliationConfig: { intervalMs: 30000, driftAlertOnly: false },
        executionMode: 'shadow',
      });

      const actor = new TradingActor('inst-2', {}, deps);
      // Local state is flat, venue has a position → drift
      await expect(actor.start()).rejects.toThrow('drift detected');
    });

    it('does NOT throw when driftAlertOnly is true', async () => {
      const venuePort = {
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([
          { symbol: 'BTC/USD:USD', side: 'long', size: quantity('5'), entryPrice: price('48000') },
        ])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [{ asset: 'USD', free: quantity('10000'), locked: quantity('0'), total: quantity('10000') }] })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn(), onStateChange: vi.fn() })),
      } as any;

      const deps = makeBaseDeps({
        venuePort,
        reconciliationConfig: { intervalMs: 30000, driftAlertOnly: true },
        executionMode: 'shadow',
      });

      const actor = new TradingActor('inst-3', {}, deps);
      // Should not throw — drift is only alerted, not blocking
      await actor.start();
      await actor.stop();
    });
  });

  describe('private stream startup blocking', () => {
    it('throws if private stream connection fails in shadow mode', async () => {
      const venuePort = {
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [] })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        subscribePrivate: vi.fn().mockResolvedValue(err({ code: 'CONNECTION_FAILED', message: 'WebSocket error' })),
      } as any;

      const deps = makeBaseDeps({
        venuePort,
        reconciliationConfig: { intervalMs: 30000, driftAlertOnly: false },
        executionMode: 'shadow',
      });

      const actor = new TradingActor('inst-4', {}, deps);
      await expect(actor.start()).rejects.toThrow('Private stream connection failed');
    });

    it('does NOT require private stream in paper mode', async () => {
      const deps = makeBaseDeps({ executionMode: 'paper' });
      const actor = new TradingActor('inst-5', {}, deps);
      // Paper mode doesn't need venue port or private stream
      await actor.start();
      await actor.stop();
    });
  });

  describe('order persistence with executionPlanId', () => {
    it('persists executed orders with executionPlanId after tick', async () => {
      const orderRepo = {
        getOpenByInstance: vi.fn().mockResolvedValue([]),
        getByExecutionPlanId: vi.fn().mockResolvedValue([]),
        upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
      };

      const deps = makeBaseDeps({
        executionMode: 'paper',
        orderRepo: orderRepo as any,
        strategy: {
          evaluate: vi.fn().mockResolvedValueOnce(ok({
            id: 'd-1',
            tradingInstanceId: 'inst-6' as TradingInstanceId,
            instrumentId: 'BTC/USD:USD',
            intent: 'go_long',
            targetSize: quantity('1'),
            timestamp: new Date().toISOString(),
          })).mockResolvedValue(ok(null)),
        } as any,
      });

      const actor = new TradingActor('inst-6', {}, deps, 60000); // long interval so only manual tick
      await actor.start();

      // Wait for the initial tick to complete
      await new Promise((r) => setTimeout(r, 100));

      // The order must have been persisted with executionPlanId
      expect(orderRepo.upsertByVenueRefId).toHaveBeenCalled();
      const persistedOrder = orderRepo.upsertByVenueRefId.mock.calls[0]![0];
      expect(persistedOrder.executionPlanId).toBeDefined();
      expect(persistedOrder.tradingInstanceId).toBe('inst-6');
      expect(persistedOrder.venue).toBe('hyperliquid');
      expect(persistedOrder.symbol).toBe('BTC/USD:USD');

      await actor.stop();
    });
  });

  describe('crash recovery', () => {
    it('calls onCrashed callback when crash() is invoked', async () => {
      const onCrashed = vi.fn().mockResolvedValue(undefined);
      const deps = makeBaseDeps({ executionMode: 'paper', onCrashed });
      const actor = new TradingActor('inst-7', {}, deps);
      await actor.start();

      await actor.crash();

      expect(onCrashed).toHaveBeenCalledWith('inst-7');
    });
  });
});
