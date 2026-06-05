import { describe, it, expect, vi } from 'vitest';
import { TradingActor } from './trading-actor.js';
import type { TradingActorDeps } from './trading-actor.js';
import { price, quantity, ok, err } from '@herobids/domain';
import type { OrderId, FillId, BotId } from '@herobids/domain';

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
    insertDecisionContext: vi.fn().mockResolvedValue('ctx-id'),
    insert: vi.fn().mockResolvedValue(undefined),
    getLastReconciledAt: vi.fn().mockResolvedValue(null),
    getLastReconciledAtForInstance: vi.fn().mockResolvedValue(null),
    getOpenByInstance: vi.fn().mockResolvedValue([]),
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
    backtestingRepo: repo as any,
    balanceSnapshotRepo: repo as any,
    reconciliationRepo: repo as any,
    riskLimits: {
      maxPositionSize: quantity('100'),
      maxOpenPositions: 5,
      maxDrawdown: price('10000'),
    },
    idGen: makeIdGen(),
    fetchPrice: vi.fn().mockResolvedValue({ symbol: 'BTC/USD:USD', price: price('50000'), timestamp: new Date().toISOString() }),
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
            tradingInstanceId: 'inst-6' as BotId,
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

    it('preserves actor attribution when persisting decisions', async () => {
      const decisionRepo = {
        insertDecision: vi.fn().mockResolvedValue(undefined),
      };

      const deps = makeBaseDeps({
        executionMode: 'paper',
        decisionRepo: decisionRepo as any,
        strategy: {
          evaluate: vi.fn().mockResolvedValueOnce(ok({
            id: 'd-agent',
            tradingInstanceId: 'inst-agent' as BotId,
            instrumentId: 'BTC/USD:USD',
            intent: 'go_long',
            targetSize: quantity('1'),
            timestamp: new Date().toISOString(),
            actorType: 'agent',
            actorId: 'agent-123',
          })).mockResolvedValue(ok(null)),
        } as any,
      });

      const actor = new TradingActor('inst-agent', {}, deps, 60_000);
      await actor.start();

      await new Promise((r) => setTimeout(r, 100));

      expect(decisionRepo.insertDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'd-agent',
          actorType: 'agent',
          actorId: 'agent-123',
        }),
      );

      await actor.stop();
    });

    it('persists a replayable decision context during the live cycle', async () => {
      const backtestingRepo = {
        insertDecisionContext: vi.fn().mockResolvedValue('ctx-1'),
      };

      const deps = makeBaseDeps({
        executionMode: 'paper',
        backtestingRepo: backtestingRepo as any,
        balanceSnapshotRepo: {
          getLatestByVenueAccount: vi.fn().mockResolvedValue({
            balances: [{ asset: 'USD', free: '1000', locked: '0', total: '1000' }],
          }),
        } as any,
        strategy: {
          evaluate: vi.fn().mockResolvedValueOnce(ok({
            id: 'd-context',
            tradingInstanceId: 'inst-context' as BotId,
            instrumentId: 'BTC/USD:USD',
            intent: 'go_long',
            targetSize: quantity('1'),
            timestamp: new Date().toISOString(),
          })).mockResolvedValue(ok(null)),
        } as any,
      });

      const actor = new TradingActor('inst-context', { lookbackPeriod: 5 }, deps, 60000);
      await actor.start();

      await new Promise((r) => setTimeout(r, 100));

      expect(backtestingRepo.insertDecisionContext).toHaveBeenCalledTimes(1);
      const persistedContext = backtestingRepo.insertDecisionContext.mock.calls[0]![0];
      expect(persistedContext.context.snapshot.symbol).toBe('BTC/USD:USD');
      expect(persistedContext.context.balanceSnapshot).toEqual({
        balances: [{ asset: 'USD', free: '1000', locked: '0', total: '1000' }],
      });
      expect(persistedContext.context.strategyParams).toEqual({ lookbackPeriod: 5 });
      expect(persistedContext.contextHash).toHaveLength(16);

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
            tradingInstanceId: 'inst-swap-shadow' as BotId,
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
            tradingInstanceId: 'inst-paper-fallback' as BotId,
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
        tradingInstanceId: 'inst-swap-feed' as BotId,
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
        tradingInstanceId: 'inst-no-feed' as BotId,
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

  describe('live mode', () => {
    it('selects LiveExecutor and starts successfully with reconciliation + stream', async () => {
      const venuePort = {
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn(), onStateChange: vi.fn() })),
        submitOrder: vi.fn().mockResolvedValue(ok({
          orderId: 'venue-oid-1',
          clientOrderId: 'test',
          status: 'open',
          venueRefId: 'vref-1',
          timestamp: new Date().toISOString(),
        })),
      } as any;

      const deps = makeBaseDeps({
        venuePort,
        reconciliationConfig: { intervalMs: 30000, driftAlertOnly: false },
        executionMode: 'live',
        strategy: {
          evaluate: vi.fn().mockResolvedValue(ok(null)),
        } as any,
      });

      const actor = new TradingActor('inst-live-1', {}, deps);
      await actor.start();
      await actor.stop();
    });

    it('throws when live mode is used without a venue port', () => {
      const deps = makeBaseDeps({ executionMode: 'live', venuePort: undefined });
      expect(() => new TradingActor('inst-live-no-port', {}, deps)).toThrow(
        'Live execution mode requires a venue port',
      );
    });

    it('skips tick when unresolved live plans exist', async () => {
      const venuePort = {
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn(), onStateChange: vi.fn() })),
        submitOrder: vi.fn(),
      } as any;

      const planRepo = {
        insertPlan: vi.fn().mockResolvedValue(undefined),
        markExecuting: vi.fn().mockResolvedValue(undefined),
        markCompleted: vi.fn().mockResolvedValue(undefined),
        markFailed: vi.fn().mockResolvedValue(undefined),
        getByExecutionPlanId: vi.fn().mockResolvedValue([]),
        getIncomplete: vi.fn().mockResolvedValue([{ id: 'plan-unresolved', status: 'executing' }]),
      };

      const orderRepo = {
        getOpenByInstance: vi.fn().mockResolvedValue([]),
        getByExecutionPlanId: vi.fn().mockResolvedValue([{ id: 'o-1', status: 'open' }]),
        upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
      };

      const strategyEvaluate = vi.fn().mockResolvedValue(ok({
        id: 'd-live',
        tradingInstanceId: 'inst-live-overlap' as BotId,
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: quantity('1'),
        timestamp: new Date().toISOString(),
      }));

      const deps = makeBaseDeps({
        venuePort,
        reconciliationConfig: { intervalMs: 30000, driftAlertOnly: false },
        executionMode: 'live',
        planRepo: planRepo as any,
        orderRepo: orderRepo as any,
        strategy: { evaluate: strategyEvaluate } as any,
      });

      const actor = new TradingActor('inst-live-overlap', {}, deps, 100_000);
      await actor.start();

      // Wait a bit for the tick to fire
      await new Promise((r) => setTimeout(r, 50));

      // Strategy should NOT have been called because unresolved plan blocks the tick
      expect(strategyEvaluate).not.toHaveBeenCalled();
      expect(venuePort.submitOrder).not.toHaveBeenCalled();

      await actor.stop();
    });

    it('private stream disconnect pauses live actor', async () => {
      let stateChangeHandler: ((state: string) => void) | undefined;
      const venuePort = {
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        subscribePrivate: vi.fn().mockResolvedValue(ok({
          unsubscribe: vi.fn(),
          onStateChange: (handler: (state: string) => void) => { stateChangeHandler = handler; },
        })),
      } as any;

      const strategyEvaluate = vi.fn().mockResolvedValue(ok(null));

      const deps = makeBaseDeps({
        venuePort,
        reconciliationConfig: { intervalMs: 30000, driftAlertOnly: false },
        executionMode: 'live',
        strategy: { evaluate: strategyEvaluate } as any,
      });

      const actor = new TradingActor('inst-live-disconnect', {}, deps, 100_000);
      await actor.start();

      // Wait for the initial fire-and-forget tick from start() to complete
      await new Promise((r) => setTimeout(r, 50));

      // Simulate disconnect
      stateChangeHandler!('disconnected');

      // Clear previous calls from the startup tick
      strategyEvaluate.mockClear();

      // Force a tick — should be a no-op because paused
      await (actor as any).tick();
      expect(strategyEvaluate).not.toHaveBeenCalled();

      // Simulate reconnect
      stateChangeHandler!('connected');
      await actor.stop();
    });

    it('private stream closed state crashes live actor', async () => {
      let stateChangeHandler: ((state: string) => void) | undefined;
      const onCrashed = vi.fn().mockResolvedValue(undefined);
      const venuePort = {
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        subscribePrivate: vi.fn().mockResolvedValue(ok({
          unsubscribe: vi.fn(),
          onStateChange: (handler: (state: string) => void) => { stateChangeHandler = handler; },
        })),
      } as any;

      const deps = makeBaseDeps({
        venuePort,
        reconciliationConfig: { intervalMs: 30000, driftAlertOnly: false },
        executionMode: 'live',
        onCrashed,
      });

      const actor = new TradingActor('inst-live-crash', {}, deps, 100_000);
      await actor.start();

      // Simulate stream closed (max reconnect exhausted)
      stateChangeHandler!('closed');

      // Give async crash a tick to complete
      await new Promise((r) => setTimeout(r, 50));
      expect(onCrashed).toHaveBeenCalledWith('inst-live-crash');
    });

    it('emits credential.used event on successful live order submission', async () => {
      const venuePort = {
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        subscribePrivate: vi.fn().mockResolvedValue(ok({
          unsubscribe: vi.fn(),
          onStateChange: vi.fn(),
        })),
        submitOrder: vi.fn().mockResolvedValue(ok({
          orderId: 'venue-oid-cred',
          clientOrderId: 'test',
          status: 'open',
          venueRefId: 'vref-cred',
          timestamp: new Date().toISOString(),
        })),
      } as any;

      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const deps = makeBaseDeps({
        venuePort,
        reconciliationConfig: { intervalMs: 30000, driftAlertOnly: false },
        executionMode: 'live',
        credentialId: 'cred-xyz',
        journal: { append: journalAppend } as any,
        strategy: {
          evaluate: vi.fn().mockResolvedValue(ok({
            id: 'd-cred',
            tradingInstanceId: 'inst-cred-used' as BotId,
            instrumentId: 'BTC/USD:USD',
            intent: 'go_long',
            targetSize: quantity('0.1'),
            timestamp: new Date().toISOString(),
          })),
        } as any,
      });

      const actor = new TradingActor('inst-cred-used', {}, deps, 100_000);
      await actor.start();

      // Wait for the initial tick to fire
      await new Promise((r) => setTimeout(r, 50));

      // Find the credential.used event among journal calls
      const credUsedCalls = journalAppend.mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === 'credential.used',
      );
      expect(credUsedCalls.length).toBeGreaterThan(0);
      const payload = (credUsedCalls[0]![0] as { payload: Record<string, unknown> }).payload;
      expect(payload.credentialId).toBe('cred-xyz');
      expect(payload.venue).toBe('hyperliquid');
      expect(payload.action).toBe('live_order_submit');
      expect(payload.ordersSubmitted).toBe(1);

      await actor.stop();
    });

    it('does not emit credential.used when credentialId is not set', async () => {
      const venuePort = {
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        subscribePrivate: vi.fn().mockResolvedValue(ok({
          unsubscribe: vi.fn(),
          onStateChange: vi.fn(),
        })),
        submitOrder: vi.fn().mockResolvedValue(ok({
          orderId: 'venue-oid-nocred',
          clientOrderId: 'test',
          status: 'open',
          venueRefId: 'vref-nocred',
          timestamp: new Date().toISOString(),
        })),
      } as any;

      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const deps = makeBaseDeps({
        venuePort,
        reconciliationConfig: { intervalMs: 30000, driftAlertOnly: false },
        executionMode: 'live',
        // No credentialId — env fallback scenario
        journal: { append: journalAppend } as any,
        strategy: {
          evaluate: vi.fn().mockResolvedValue(ok({
            id: 'd-nocred',
            tradingInstanceId: 'inst-nocred' as BotId,
            instrumentId: 'BTC/USD:USD',
            intent: 'go_long',
            targetSize: quantity('0.1'),
            timestamp: new Date().toISOString(),
          })),
        } as any,
      });

      const actor = new TradingActor('inst-nocred', {}, deps, 100_000);
      await actor.start();
      await new Promise((r) => setTimeout(r, 50));

      const credUsedCalls = journalAppend.mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === 'credential.used',
      );
      expect(credUsedCalls.length).toBe(0);

      await actor.stop();
    });
  });
});
