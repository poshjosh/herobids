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
    getRecentByVenueAccount: vi.fn().mockResolvedValue([]),
    getOpenByInstance: vi.fn().mockResolvedValue([]),
    getLatestByVenueAccount: vi.fn().mockResolvedValue(null),
    insertSnapshot: vi.fn().mockResolvedValue('snap-id'),
    upsert: vi.fn().mockResolvedValue(undefined),
    insertPlan: vi.fn().mockResolvedValue(undefined),
    markExecuting: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    getIncomplete: vi.fn().mockResolvedValue([]),
    getByExecutionPlanId: vi.fn().mockResolvedValue([]),
    upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
    insertDecision: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(undefined),
    getLastReconciledAt: vi.fn().mockResolvedValue(null),
    getLastReconciledAtForInstance: vi.fn().mockResolvedValue(null),
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
    decisionRepo: repo as any,
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
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [{ asset: 'USD', free: quantity('10000'), locked: quantity('0'), total: quantity('10000') }], timestamp: new Date().toISOString() })),
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
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [{ asset: 'USD', free: quantity('10000'), locked: quantity('0'), total: quantity('10000') }], timestamp: new Date().toISOString() })),
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
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
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

  // --- BUG-004 regression: swap venue shadow execution path ---

  describe('swap venue shadow executor selection', () => {
    it('creates ShadowExecutor when swapVenue is provided without venuePort', async () => {
      const swapVenue = {
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])),
        quote: vi.fn().mockResolvedValue(ok({
          quoteData: {},
          inputAsset: 'USDC',
          outputAsset: 'SOL',
          inputAmount: quantity('150'),
          expectedOutputAmount: quantity('1'),
          minimumOutputAmount: quantity('0.99'),
          priceImpact: 0.01,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        })),
        executeSwap: vi.fn(),
        fetchBalance: vi.fn(),
      } as any;

      const deps = makeBaseDeps({
        executionMode: 'shadow',
        swapVenue,
        venueType: 'swap',
        // No venuePort — this is the bug scenario
        strategy: {
          evaluate: vi.fn().mockResolvedValueOnce(ok({
            id: 'd-1',
            tradingInstanceId: 'inst-swap-shadow' as TradingInstanceId,
            instrumentId: 'SOL/USDC',
            intent: 'go_long',
            targetSize: quantity('1'),
            timestamp: new Date().toISOString(),
          })).mockResolvedValue(ok(null)),
        } as any,
        symbol: 'SOL/USDC',
      });

      const actor = new TradingActor('inst-swap-shadow', {}, deps, 60000);
      await actor.start();

      // Wait for the initial tick
      await new Promise((r) => setTimeout(r, 100));

      // The order should have been created by ShadowExecutor (prefix "shadow-")
      // NOT by PaperExecutor (prefix "paper-")
      const orderCalls = deps.orderRepo.upsertByVenueRefId.mock.calls;
      expect(orderCalls.length).toBeGreaterThan(0);
      const order = orderCalls[0]![0];
      expect(order.venueRefId).toMatch(/^shadow-/);

      await actor.stop();
    });

    it('falls back to PaperExecutor when neither venuePort nor swapVenue provided in shadow mode', async () => {
      const deps = makeBaseDeps({
        executionMode: 'shadow',
        // No venuePort, no swapVenue
        strategy: {
          evaluate: vi.fn().mockResolvedValueOnce(ok({
            id: 'd-2',
            tradingInstanceId: 'inst-paper-fallback' as TradingInstanceId,
            instrumentId: 'BTC/USD:USD',
            intent: 'go_long',
            targetSize: quantity('1'),
            timestamp: new Date().toISOString(),
          })).mockResolvedValue(ok(null)),
        } as any,
      });

      const actor = new TradingActor('inst-paper-fallback', {}, deps, 60000);
      await actor.start();

      await new Promise((r) => setTimeout(r, 100));

      const orderCalls = deps.orderRepo.upsertByVenueRefId.mock.calls;
      expect(orderCalls.length).toBeGreaterThan(0);
      const order = orderCalls[0]![0];
      expect(order.venueRefId).toMatch(/^paper-/);

      await actor.stop();
    });
  });

  // --- BUG-008 regression: swap venue fetchPrice null blocks strategy ---

  describe('swap venue fetchPrice fallback to market data feed', () => {
    it('evaluates strategy using market data feed when fetchPrice returns null (swap venue)', async () => {
      const swapVenue = {
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])),
        quote: vi.fn().mockResolvedValue(ok({
          quoteData: {},
          inputAsset: 'USDC',
          outputAsset: 'SOL',
          inputAmount: quantity('150'),
          expectedOutputAmount: quantity('1'),
          minimumOutputAmount: quantity('0.99'),
          priceImpact: 0.01,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        })),
        executeSwap: vi.fn(),
        fetchBalance: vi.fn(),
      } as any;

      // Mock stream pool that immediately sends a ticker to the feed
      let capturedHandlers: any;
      const streamPool = {
        subscribe: vi.fn(async (_venue: string, _symbols: string[], handlers: any) => {
          capturedHandlers = handlers;
          // Immediately emit a ticker so feed has data
          setTimeout(() => {
            handlers.onTicker?.({ symbol: 'SOL/USDC', last: '150', bid: '149.5', ask: '150.5', timestamp: new Date().toISOString() });
          }, 5);
          return { unsubscribe: vi.fn().mockResolvedValue(undefined) };
        }),
      };

      const strategyEvaluate = vi.fn().mockResolvedValueOnce(ok({
        id: 'd-1',
        tradingInstanceId: 'inst-swap-feed' as TradingInstanceId,
        instrumentId: 'SOL/USDC',
        intent: 'go_long',
        targetSize: quantity('1'),
        timestamp: new Date().toISOString(),
      })).mockResolvedValue(ok(null));

      const deps = makeBaseDeps({
        executionMode: 'shadow',
        swapVenue,
        venueType: 'swap',
        symbol: 'SOL/USDC',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC' },
        shadowPollIntervalMs: 50,
        // fetchPrice returns null — simulating no orderbook adapter for swap venues
        fetchPrice: vi.fn().mockResolvedValue(null),
        strategy: { evaluate: strategyEvaluate } as any,
        streamPool,
      });

      const actor = new TradingActor('inst-swap-feed', {}, deps, 50); // short interval for second tick
      await actor.start();

      // Wait for the stream pool ticker to arrive + second tick to fire
      await new Promise((r) => setTimeout(r, 200));

      // Strategy should have been called — the tick() method derived a snapshot from the feed
      expect(strategyEvaluate).toHaveBeenCalled();
      // An order should have been produced (confirming strategy evaluation proceeded)
      const orderCalls = deps.orderRepo.upsertByVenueRefId.mock.calls;
      expect(orderCalls.length).toBeGreaterThan(0);

      await actor.stop();
    });

    it('still returns early when fetchPrice is null and no market data feed exists (paper mode)', async () => {
      const strategyEvaluate = vi.fn().mockResolvedValue(ok({
        id: 'd-1',
        tradingInstanceId: 'inst-no-feed' as TradingInstanceId,
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: quantity('1'),
        timestamp: new Date().toISOString(),
      }));

      const deps = makeBaseDeps({
        executionMode: 'paper',
        // fetchPrice returns null and no market data feed in paper mode
        fetchPrice: vi.fn().mockResolvedValue(null),
        strategy: { evaluate: strategyEvaluate } as any,
      });

      const actor = new TradingActor('inst-no-feed', {}, deps, 60000);
      await actor.start();

      await new Promise((r) => setTimeout(r, 100));

      // Strategy should NOT have been called — no snapshot available
      expect(strategyEvaluate).not.toHaveBeenCalled();

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
