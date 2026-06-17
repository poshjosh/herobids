import { describe, it, expect, vi } from 'vitest';
import { TradingActor } from './trading-actor.js';
import type { TradingActorDeps } from './trading-actor.js';
import { price, quantity, ok, err } from '@herobids/domain';
import type { OrderId, FillId, BotId } from '@herobids/domain';
import { FULL_CAPABILITIES } from '@herobids/tests/fixtures/venue-capabilities.js';

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
      getCapabilities: () => FULL_CAPABILITIES,
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
      getCapabilities: () => FULL_CAPABILITIES,
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
      getCapabilities: () => FULL_CAPABILITIES,
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
      getCapabilities: () => FULL_CAPABILITIES,
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

    // bug-011 regression: paper mode TradingActor must start without error when
    // venuePort is absent but reconciliationConfig is present.
    //
    // Before the fix, apps/worker/src/index.ts passed venuePort unconditionally
    // (even for paper mode). startReconciler() would then call
    // venuePort.fetchPositions() on the HyperliquidAdapter, which required a
    // wallet address that does not exist in paper mode — causing an immediate crash.
    //
    // Fix: index.ts now sets venuePort = undefined for paper mode, so
    // startReconciler()'s early-return guard fires:
    //   if ((!venuePort && !swapVenue) || !reconciliationConfig) return;
    it('starts without error in paper mode when reconciliationConfig is set but venuePort is absent (bug-011 regression)', async () => {
      const deps = makeBaseDeps({
        executionMode: 'paper',
        // reconciliationConfig is set — mirrors a real bot config that enables
        // reconciliation. Without the fix this would cause a crash because
        // startReconciler() would call fetchPositions() on a missing wallet.
        reconciliationConfig: { intervalMs: 30_000, driftAlertOnly: false },
        // venuePort intentionally absent — matches the bug-011 fix in index.ts
      });

      const actor = new TradingActor('bug-011', {}, deps);
      await expect(actor.start()).resolves.toBeUndefined();
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
            botId: 'inst-6' as BotId,
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
      expect(persistedOrder.botId).toBe('inst-6');
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
            botId: 'inst-agent' as BotId,
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
            botId: 'inst-context' as BotId,
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
            botId: 'inst-swap-shadow' as BotId,
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
            botId: 'inst-paper-fallback' as BotId,
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
        botId: 'inst-swap-feed' as BotId,
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
        botId: 'inst-no-feed' as BotId,
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

    it('halts auto_go_flat when crash recovery is ambiguous', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const orderRepo = {
        ...stubRepo(),
        getOpenByInstance: vi.fn().mockResolvedValue([
          {
            id: 'o-ambiguous',
            symbol: 'BTC/USD:USD',
            venueRefId: null,
            venueAccountId: 'va-1',
            actorType: 'bot',
            actorId: 'inst-crash-ambiguous',
            venue: 'hyperliquid',
            side: 'buy',
            type: 'market',
            quantity: quantity('1'),
            filledQuantity: quantity('0'),
          },
        ]),
      };

      const venuePort = {
      getCapabilities: () => FULL_CAPABILITIES,
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn(), onStateChange: vi.fn() })),
        cancelOrder: vi.fn().mockResolvedValue(ok(undefined)),
      } as any;

      const deps = makeBaseDeps({
        executionMode: 'live',
        crashPolicy: 'auto_go_flat',
        journal: { append: journalAppend } as any,
        orderRepo: orderRepo as any,
        venuePort,
      });

      const actor = new TradingActor('inst-crash-ambiguous', {}, deps, 100_000);
      await actor.start();
      await actor.crash();

      const crashCall = journalAppend.mock.calls.find((c) => c[0]?.type === 'instance.crashed');
      expect(crashCall).toBeDefined();
      expect(crashCall?.[0]?.payload).toMatchObject({
        crashRecoveryAmbiguous: true,
        attemptedEmergencyGoFlat: false,
      });
    });

    it('halts auto_go_flat for swap crashes when on-chain confirmation is ambiguous', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const orderRepo = {
        ...stubRepo(),
        getOpenByInstance: vi.fn().mockResolvedValue([
          {
            id: 'o-swap-ambiguous',
            symbol: 'SOL/USDC',
            venueRefId: null,
            venueAccountId: 'va-1',
            actorType: 'bot',
            actorId: 'inst-crash-swap-ambiguous',
            venue: 'jupiter',
            side: 'buy',
            type: 'swap',
            quantity: quantity('1'),
            filledQuantity: quantity('0'),
          },
        ]),
      };

      const swapVenue = {
        fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])),
      } as any;

      const deps = makeBaseDeps({
        executionMode: 'live',
        venue: 'jupiter',
        symbol: 'SOL/USDC',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        swapVenue,
        crashPolicy: 'auto_go_flat',
        journal: { append: journalAppend } as any,
        orderRepo: orderRepo as any,
      });

      const actor = new TradingActor('inst-crash-swap-ambiguous', {}, deps, 100_000);
      await actor.start();
      await actor.crash();

      expect(swapVenue.fetchRecentTransactions).toHaveBeenCalled();

      const ambiguousFailure = journalAppend.mock.calls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === 'execution.failure'
          && ((c[0] as { payload: Record<string, unknown> }).payload.reason === 'live_swap_crash_recovery_ambiguous'),
      );
      expect(ambiguousFailure).toBeDefined();

      const crashCall = journalAppend.mock.calls.find((c: unknown[]) => (c[0] as { type: string }).type === 'instance.crashed');
      expect(crashCall).toBeDefined();
      expect((crashCall![0] as { payload: Record<string, unknown> }).payload).toMatchObject({
        crashRecoveryAmbiguous: true,
        attemptedEmergencyGoFlat: false,
        openSwapOrders: 1,
        unresolvedSwapOrders: 1,
      });
    });

    it('cancels open orders before attempting auto_go_flat', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const orderRepo = {
        ...stubRepo(),
        getOpenByInstance: vi.fn().mockResolvedValue([
          {
            id: 'o-cancel',
            symbol: 'BTC/USD:USD',
            venueRefId: 'venue-order-1',
            clientOrderId: 'client-1',
            venueAccountId: 'va-1',
            actorType: 'bot',
            actorId: 'inst-crash-cancel',
            executionPlanId: 'plan-1',
            venue: 'hyperliquid',
            side: 'buy',
            type: 'limit',
            quantity: quantity('1'),
            price: price('50000'),
            filledQuantity: quantity('0'),
          },
        ]),
      };

      const venuePort = {
      getCapabilities: () => FULL_CAPABILITIES,
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn(), onStateChange: vi.fn() })),
        cancelOrder: vi.fn().mockResolvedValue(ok(undefined)),
      } as any;

      const deps = makeBaseDeps({
        executionMode: 'live',
        crashPolicy: 'auto_go_flat',
        journal: { append: journalAppend } as any,
        orderRepo: orderRepo as any,
        venuePort,
      });

      const actor = new TradingActor('inst-crash-cancel', {}, deps, 100_000);
      await actor.start();
      await actor.crash();

      expect(venuePort.cancelOrder).toHaveBeenCalledWith({
        orderId: 'venue-order-1',
        symbol: 'BTC/USD:USD',
      });
      const crashCall = journalAppend.mock.calls.find((c) => c[0]?.type === 'instance.crashed');
      expect(crashCall?.[0]?.payload).toMatchObject({
        crashRecoveryAmbiguous: false,
        cancelledOpenOrders: 1,
        attemptedEmergencyGoFlat: true,
      });
    });
  });

  describe('live mode', () => {
    it('captures startup pending-live snapshot in live mode', async () => {
      const venuePort = {
      getCapabilities: () => FULL_CAPABILITIES,
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn(), onStateChange: vi.fn() })),
      } as any;

      const planRepo = {
        insertPlan: vi.fn().mockResolvedValue(undefined),
        markExecuting: vi.fn().mockResolvedValue(undefined),
        markCompleted: vi.fn().mockResolvedValue(undefined),
        markFailed: vi.fn().mockResolvedValue(undefined),
        getByExecutionPlanId: vi.fn().mockResolvedValue([]),
        getIncomplete: vi.fn().mockResolvedValue([{ id: 'plan-startup-snapshot', status: 'executing' }]),
      };

      const orderRepo = {
        getOpenByInstance: vi.fn().mockResolvedValue([]),
        getByExecutionPlanId: vi.fn().mockResolvedValue([
          { id: 'ord-startup-1', status: 'pending', submissionState: 'submit_attempting', venueRefId: null, clientOrderId: 'client-startup-1', symbol: 'BTC/USD:USD' },
        ]),
        upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
      };

      const deps = makeBaseDeps({
        venuePort,
        reconciliationConfig: { intervalMs: 30000, driftAlertOnly: false },
        executionMode: 'live',
        planRepo: planRepo as any,
        orderRepo: orderRepo as any,
        strategy: { evaluate: vi.fn().mockResolvedValue(ok(null)) } as any,
      });

      const actor = new TradingActor('inst-live-startup-snapshot', {}, deps, 100_000);
      await actor.start();

      const snapshot = (actor as any).startupPendingLiveSnapshot;
      expect(snapshot).toBeDefined();
      expect(snapshot.plans).toHaveLength(1);
      expect(snapshot.plans[0]).toMatchObject({
        planId: 'plan-startup-snapshot',
        planStatus: 'executing',
        orderCount: 1,
      });
      expect(snapshot.plans[0].nonTerminalOrders).toEqual([
        expect.objectContaining({ orderId: 'ord-startup-1', status: 'pending', submissionState: 'submit_attempting' }),
      ]);

      await actor.stop();
    });

    it('clears startup pending-live snapshot in non-live mode', async () => {
      const deps = makeBaseDeps({ executionMode: 'paper' });
      const actor = new TradingActor('inst-paper-startup-snapshot', {}, deps, 100_000);

      (actor as any).startupPendingLiveSnapshot = {
        capturedAt: new Date().toISOString(),
        plans: [{ planId: 'stale', planStatus: 'executing', orderCount: 1, nonTerminalOrders: [] }],
      };

      await actor.start();

      expect((actor as any).startupPendingLiveSnapshot).toBeUndefined();

      await actor.stop();
    });

    it('selects LiveExecutor and starts successfully with reconciliation + stream', async () => {
      const venuePort = {
      getCapabilities: () => FULL_CAPABILITIES,
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
      getCapabilities: () => FULL_CAPABILITIES,
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
        botId: 'inst-live-overlap' as BotId,
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

    it('keeps plan executing when direct clientOrderId lookup finds an open venue order', async () => {
      const venuePort = {
      getCapabilities: () => FULL_CAPABILITIES,
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        fetchOrderByClientOrderId: vi.fn().mockResolvedValue(ok({
          venueRefId: 'venue-open-lookup',
          clientOrderId: 'client-lookup-1',
          symbol: 'BTC/USD:USD',
          side: 'buy',
          type: 'limit',
          status: 'open',
          quantity: quantity('1'),
          filledQuantity: quantity('0'),
          price: price('50000'),
          avgFillPrice: undefined,
          createdAt: new Date().toISOString(),
        })),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn(), onStateChange: vi.fn() })),
      } as any;

      const planRepo = {
        insertPlan: vi.fn().mockResolvedValue(undefined),
        markExecuting: vi.fn().mockResolvedValue(undefined),
        markCompleted: vi.fn().mockResolvedValue(undefined),
        markFailed: vi.fn().mockResolvedValue(undefined),
        getByExecutionPlanId: vi.fn().mockResolvedValue([]),
        getIncomplete: vi.fn().mockResolvedValue([{ id: 'plan-client-lookup', status: 'executing' }]),
      };

      const orderRepo = {
        getOpenByInstance: vi.fn().mockResolvedValue([]),
        getByExecutionPlanId: vi.fn().mockResolvedValue([
          { id: 'order-lookup', venueRefId: null, clientOrderId: 'client-lookup-1', symbol: 'BTC/USD:USD', status: 'pending' },
        ]),
        upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
      };

      const deps = makeBaseDeps({
        venuePort,
        reconciliationConfig: { intervalMs: 30000, driftAlertOnly: false },
        executionMode: 'live',
        planRepo: planRepo as any,
        orderRepo: orderRepo as any,
        strategy: { evaluate: vi.fn().mockResolvedValue(ok(null)) } as any,
      });

      const actor = new TradingActor('inst-live-client-lookup', {}, deps, 100_000);
      await actor.start();

      expect(venuePort.fetchOrderByClientOrderId).toHaveBeenCalledWith('client-lookup-1', 'BTC/USD:USD');
      expect(planRepo.markFailed).not.toHaveBeenCalledWith('plan-client-lookup');
      expect(planRepo.markCompleted).not.toHaveBeenCalledWith('plan-client-lookup');

      await actor.stop();
    });

    it('cancels stale live limit orders via timeout policy', async () => {
      const cancelOrder = vi.fn().mockResolvedValue(ok({ cancelled: true }));
      const venuePort = {
      getCapabilities: () => FULL_CAPABILITIES,
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn(), onStateChange: vi.fn() })),
        cancelOrder,
      } as any;

      const staleSubmittedAt = new Date(Date.now() - 10 * 60 * 1000);
      const orderRepo = {
        getOpenByInstance: vi.fn().mockResolvedValue([
          {
            id: 'ord-stale-limit',
            venueAccountId: 'va-1',
            actorType: 'bot',
            actorId: 'inst-live-timeout-limit',
            executionPlanId: 'plan-stale-limit',
            venueRefId: 'venue-limit-1',
            clientOrderId: 'client-limit-1',
            venue: 'hyperliquid',
            symbol: 'BTC/USD:USD',
            side: 'buy',
            type: 'limit',
            quantity: '1',
            price: '49000',
            referencePrice: null,
            status: 'open',
            submissionState: 'venue_acknowledged',
            submitAttemptedAt: staleSubmittedAt,
            acknowledgedAt: staleSubmittedAt,
            filledQuantity: '0',
            avgFillPrice: null,
          },
        ]),
        getByExecutionPlanId: vi.fn().mockResolvedValue([{ id: 'ord-stale-limit', status: 'open' }]),
        upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
      };

      const planRepo = {
        insertPlan: vi.fn().mockResolvedValue(undefined),
        markExecuting: vi.fn().mockResolvedValue(undefined),
        markCompleted: vi.fn().mockResolvedValue(undefined),
        markFailed: vi.fn().mockResolvedValue(undefined),
        getByExecutionPlanId: vi.fn().mockResolvedValue([]),
        getIncomplete: vi.fn().mockResolvedValue([{ id: 'plan-unresolved', status: 'executing' }]),
      };

      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const deps = makeBaseDeps({
        venuePort,
        orderRepo: orderRepo as any,
        planRepo: planRepo as any,
        journal: { append: journalAppend } as any,
        executionMode: 'live',
        liveOrderTimeoutPolicy: { limitOrderTimeoutMs: 60_000, marketOrderTimeoutMs: 30_000 },
        reconciliationConfig: { intervalMs: 30000, driftAlertOnly: false },
        strategy: { evaluate: vi.fn().mockResolvedValue(ok(null)) } as any,
      });

      const actor = new TradingActor('inst-live-timeout-limit', {}, deps, 100_000);
      await actor.start();
      await (actor as any).tick();

      expect(cancelOrder).toHaveBeenCalledWith({ orderId: 'venue-limit-1', symbol: 'BTC/USD:USD' });
      expect(orderRepo.upsertByVenueRefId).toHaveBeenCalledWith(expect.objectContaining({
        venueRefId: 'venue-limit-1',
        status: 'cancelled',
        submissionState: 'terminal',
      }));

      const cancelledEvent = journalAppend.mock.calls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'order.cancelled',
      );
      expect(cancelledEvent).toBeTruthy();
      expect((cancelledEvent![0] as { payload: Record<string, unknown> }).payload.reason).toBe('live_limit_timeout');

      await actor.stop();
    });

    it('escalates stale live market orders as recovery-required', async () => {
      const cancelOrder = vi.fn();
      const venuePort = {
      getCapabilities: () => FULL_CAPABILITIES,
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn(), onStateChange: vi.fn() })),
        cancelOrder,
      } as any;

      const staleSubmittedAt = new Date(Date.now() - 5 * 60 * 1000);
      const orderRepo = {
        getOpenByInstance: vi.fn().mockResolvedValue([
          {
            id: 'ord-stale-market',
            venueAccountId: 'va-1',
            actorType: 'bot',
            actorId: 'inst-live-timeout-market',
            executionPlanId: 'plan-stale-market',
            venueRefId: 'venue-market-1',
            clientOrderId: 'client-market-1',
            venue: 'hyperliquid',
            symbol: 'BTC/USD:USD',
            side: 'buy',
            type: 'market',
            quantity: '1',
            price: null,
            referencePrice: null,
            status: 'pending',
            submissionState: 'submit_attempting',
            submitAttemptedAt: staleSubmittedAt,
            acknowledgedAt: null,
            filledQuantity: '0',
            avgFillPrice: null,
          },
        ]),
        getByExecutionPlanId: vi.fn().mockResolvedValue([{ id: 'ord-stale-market', status: 'pending' }]),
        upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
      };

      const planRepo = {
        insertPlan: vi.fn().mockResolvedValue(undefined),
        markExecuting: vi.fn().mockResolvedValue(undefined),
        markCompleted: vi.fn().mockResolvedValue(undefined),
        markFailed: vi.fn().mockResolvedValue(undefined),
        getByExecutionPlanId: vi.fn().mockResolvedValue([]),
        getIncomplete: vi.fn().mockResolvedValue([{ id: 'plan-unresolved', status: 'executing' }]),
      };

      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const deps = makeBaseDeps({
        venuePort,
        orderRepo: orderRepo as any,
        planRepo: planRepo as any,
        journal: { append: journalAppend } as any,
        executionMode: 'live',
        liveOrderTimeoutPolicy: { limitOrderTimeoutMs: 60_000, marketOrderTimeoutMs: 30_000 },
        reconciliationConfig: { intervalMs: 30000, driftAlertOnly: false },
        strategy: { evaluate: vi.fn().mockResolvedValue(ok(null)) } as any,
      });

      const actor = new TradingActor('inst-live-timeout-market', {}, deps, 100_000);
      await actor.start();
      await (actor as any).tick();

      expect(cancelOrder).not.toHaveBeenCalled();
      expect(orderRepo.upsertByVenueRefId).not.toHaveBeenCalled();

      const failureEvent = journalAppend.mock.calls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'execution.failure'
          && ((call[0] as { payload: Record<string, unknown> }).payload.reason === 'live_order_timeout_recovery_required'),
      );
      expect(failureEvent).toBeTruthy();

      await actor.stop();
    });

    it('halts swap intake when live confirmation timeout requires manual recovery', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const staleSubmittedAt = new Date(Date.now() - 5 * 60 * 1000);
      const orderRepo = {
        ...stubRepo(),
        getOpenByInstance: vi.fn().mockResolvedValue([
          {
            id: 'ord-stale-swap',
            venueAccountId: 'va-1',
            actorType: 'bot',
            actorId: 'inst-live-timeout-swap',
            executionPlanId: 'plan-stale-swap',
            venueRefId: null,
            clientOrderId: 'client-swap-1',
            venue: 'jupiter',
            symbol: 'SOL/USDC',
            side: 'buy',
            type: 'swap',
            quantity: '1',
            price: null,
            referencePrice: '100',
            status: 'pending',
            submissionState: 'submit_attempting',
            submitAttemptedAt: staleSubmittedAt,
            acknowledgedAt: null,
            filledQuantity: '0',
            avgFillPrice: null,
            createdAt: staleSubmittedAt,
          },
        ]),
      };

      const swapVenue = {
        fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])),
      } as any;

      const deps = makeBaseDeps({
        executionMode: 'live',
        venue: 'jupiter',
        symbol: 'SOL/USDC',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        swapVenue,
        orderRepo: orderRepo as any,
        journal: { append: journalAppend } as any,
        liveOrderTimeoutPolicy: { limitOrderTimeoutMs: 60_000, marketOrderTimeoutMs: 30_000 },
      });

      const actor = new TradingActor('inst-live-timeout-swap', {}, deps, 100_000);
      await (actor as any).enforceLiveOrderTimeouts();

      const timeoutFailure = journalAppend.mock.calls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'execution.failure'
          && ((call[0] as { payload: Record<string, unknown> }).payload.reason === 'live_swap_confirmation_timeout_recovery_required'),
      );
      expect(timeoutFailure).toBeTruthy();

      const intake = actor.getIntakeDeps();
      expect(intake).toMatchObject({
        rejected: true,
        code: 'swap_recovery_ambiguous',
      });
    });

    it('falls back to recent transactions when the swap confirmation poller errors', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const recoveredAt = new Date('2026-06-15T10:00:00.000Z');
      const orderRepo = {
        ...stubRepo(),
        getOpenByInstance: vi.fn().mockResolvedValue([
          {
            id: 'ord-poller-error-fallback',
            venueAccountId: 'va-1',
            actorType: 'bot',
            actorId: 'inst-swap-fallback',
            executionPlanId: 'plan-swap-fallback',
            venueRefId: 'tx-fallback-match',
            clientOrderId: 'client-swap-fallback',
            venue: 'jupiter',
            symbol: 'SOL/USDC',
            side: 'buy',
            type: 'swap',
            quantity: '1',
            price: null,
            referencePrice: '100',
            status: 'pending',
            submissionState: 'venue_acknowledged',
            submitAttemptedAt: recoveredAt,
            acknowledgedAt: recoveredAt,
            filledQuantity: '0',
            avgFillPrice: null,
            createdAt: recoveredAt,
          },
        ]),
        upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
      };
      const fillRepo = {
        ...stubRepo(),
        insertFill: vi.fn().mockResolvedValue('fill-id'),
      };
      const swapVenue = {
        fetchRecentTransactions: vi.fn().mockResolvedValue(ok([{ executionRef: 'tx-fallback-match' }])),
      } as any;
      const swapConfirmationPoller = {
        checkConfirmation: vi.fn().mockResolvedValue(err({ code: 'RPC_ERROR', message: 'temporary failure' })),
      };

      const deps = makeBaseDeps({
        executionMode: 'live',
        venue: 'jupiter',
        symbol: 'SOL/USDC',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        swapVenue,
        swapConfirmationPoller: swapConfirmationPoller as any,
        orderRepo: orderRepo as any,
        fillRepo: fillRepo as any,
        journal: { append: journalAppend } as any,
        liveOrderTimeoutPolicy: { limitOrderTimeoutMs: 60_000, marketOrderTimeoutMs: 30_000 },
      });

      const actor = new TradingActor('inst-swap-fallback', {}, deps, 100_000);
      await (actor as any).enforceLiveOrderTimeouts();

      expect(swapConfirmationPoller.checkConfirmation).toHaveBeenCalledWith('tx-fallback-match');
      expect(swapVenue.fetchRecentTransactions).toHaveBeenCalledTimes(1);
      expect(orderRepo.upsertByVenueRefId).toHaveBeenCalledWith(expect.objectContaining({
        venueRefId: 'tx-fallback-match',
        status: 'filled',
        submissionState: 'terminal',
      }));
      expect(fillRepo.insertFill).toHaveBeenCalledWith(expect.objectContaining({
        orderId: 'ord-poller-error-fallback',
        filledAt: recoveredAt,
      }));

      const timeoutFailure = journalAppend.mock.calls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'execution.failure'
          && ((call[0] as { payload: Record<string, unknown> }).payload.reason === 'live_swap_confirmation_timeout_recovery_required'),
      );
      expect(timeoutFailure).toBeFalsy();
    });

    it('marks incomplete swap plans failed when the confirmation poller reports a reverted tx', async () => {
      const planRepo = {
        ...stubRepo(),
        getIncomplete: vi.fn().mockResolvedValue([{ id: 'plan-swap-failed', status: 'executing' }]),
        markFailed: vi.fn().mockResolvedValue(undefined),
      };
      const orderRepo = {
        ...stubRepo(),
        getByExecutionPlanId: vi.fn().mockResolvedValue([
          { id: 'ord-swap-failed', venueRefId: 'tx-failed', status: 'pending', symbol: 'SOL/USDC' },
        ]),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      };
      const swapVenue = {
        fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])),
      } as any;
      const swapConfirmationPoller = {
        checkConfirmation: vi.fn().mockResolvedValue(ok({ confirmed: false, failed: true })),
      };

      const deps = makeBaseDeps({
        executionMode: 'live',
        venue: 'jupiter',
        symbol: 'SOL/USDC',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        swapVenue,
        swapConfirmationPoller: swapConfirmationPoller as any,
        planRepo: planRepo as any,
        orderRepo: orderRepo as any,
      });

      const actor = new TradingActor('inst-swap-failed', {}, deps, 100_000);
      await actor.start();

      expect(swapConfirmationPoller.checkConfirmation).toHaveBeenCalledWith('tx-failed');
      expect(orderRepo.updateStatus).toHaveBeenCalledWith('ord-swap-failed', 'rejected');
      expect(planRepo.markFailed).toHaveBeenCalledWith('plan-swap-failed');

      await actor.stop();
    });

    it('private stream disconnect pauses live actor', async () => {
      let stateChangeHandler: ((state: string) => void) | undefined;
      const venuePort = {
      getCapabilities: () => FULL_CAPABILITIES,
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
      getCapabilities: () => FULL_CAPABILITIES,
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
      getCapabilities: () => FULL_CAPABILITIES,
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
            botId: 'inst-cred-used' as BotId,
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
      getCapabilities: () => FULL_CAPABILITIES,
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
            botId: 'inst-nocred' as BotId,
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

  // --- ExecutionActor interface: getDecisionContext and getPosition ---

  describe('ExecutionActor: getDecisionContext', () => {
    it('returns undefined before start', () => {
      const deps = makeBaseDeps();
      const actor = new TradingActor('exec-actor-1', {}, deps);
      // Not started — no snapshot available
      expect(actor.getDecisionContext()).toBeUndefined();
    });

    it('returns a populated context after start (tick fires immediately on start)', async () => {
      const deps = makeBaseDeps({
        strategy: { evaluate: vi.fn().mockResolvedValue(ok(null)) } as any,
      });
      // Large interval — no periodic tick will fire; only the initial tick on start
      const actor = new TradingActor('exec-actor-2', {}, deps, 60_000);
      await actor.start();
      // flush microtasks so the initial void tick() completes
      await Promise.resolve();

      const ctx = actor.getDecisionContext();
      expect(ctx).toBeDefined();
      expect(ctx!.snapshot.symbol).toBe('BTC/USD:USD');
      expect(ctx!.snapshot.price).toBe('50000');
      expect(ctx!.position).toBeNull(); // flat position → null
      expect(ctx!.strategyParams).toEqual({});
      // No mark source configured → falls back to snapshot price
      expect(ctx!.referenceMark.source).toBe('snapshot');

      await actor.stop();
    });
  });

  describe('ExecutionActor: getPosition', () => {
    it('returns flat position before start', () => {
      const deps = makeBaseDeps();
      const actor = new TradingActor('pos-actor-1', {}, deps);
      const pos = actor.getPosition();
      expect(pos.side).toBe('flat');
      expect(pos.venue).toBe('hyperliquid');
      expect(pos.symbol).toBe('BTC/USD:USD');
    });

    it('returns the same PositionState as currentPosition', () => {
      const deps = makeBaseDeps();
      const actor = new TradingActor('pos-actor-2', {}, deps);
      expect(actor.getPosition()).toBe(actor.currentPosition);
    });
  });

  describe('getIntakeDeps circuit breaker guard', () => {
    it('returns circuit_breaker_open rejection when breaker is tripped', async () => {
      const deps = makeBaseDeps({
        executionMode: 'paper',
        maxConsecutiveVenueErrors: 2,
      });
      const actor = new TradingActor('cb-actor', {}, deps);
      await actor.start();

      // Trip the circuit breaker by recording consecutive errors
      actor.recordExecutionOutcome!(false);
      actor.recordExecutionOutcome!(false);

      const result = actor.getIntakeDeps();
      expect(result).toBeDefined();
      expect(result).toHaveProperty('rejected', true);
      expect(result).toHaveProperty('code', 'circuit_breaker_open');
      expect(result).toHaveProperty('retryable', false);

      await actor.stop();
    });

    it('returns normal intake deps when breaker is not tripped', async () => {
      const deps = makeBaseDeps({
        executionMode: 'paper',
        maxConsecutiveVenueErrors: 3,
      });
      const actor = new TradingActor('cb-actor-ok', {}, deps);
      await actor.start();

      const result = actor.getIntakeDeps();
      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('rejected');
      expect(result).toHaveProperty('actorType', 'bot');

      await actor.stop();
    });
  });

  describe('swap execution quality alerts', () => {
    it('emits live slippage alert for orderbook fills when threshold is exceeded', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const orderRepo = {
        ...stubRepo(),
        getByVenueRefId: vi.fn().mockResolvedValue({
          id: 'ord-orderbook-alert',
          referencePrice: '100',
        }),
      };

      const actor = new TradingActor('orderbook-slippage-alert', {}, makeBaseDeps({
        executionMode: 'live',
        venue: 'hyperliquid',
        venueType: 'orderbook',
        venuePort: {} as any,
        orderRepo: orderRepo as any,
        journal: { append: journalAppend } as any,
        slippageAlertBps: 20,
      }));

      await (actor as any).maybeEmitLiveSlippageAlert({
        orderId: 'orderbook-ref-1',
        venueRefId: 'orderbook-ref-1',
        symbol: 'BTC/USD:USD',
        side: 'buy',
        quantity: '1',
        price: '105',
        fee: '0',
        feeCurrency: 'USD',
        filledAt: new Date().toISOString(),
      });

      const slippageEvent = journalAppend.mock.calls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'live.slippage_alert',
      );
      expect(slippageEvent).toBeDefined();
      expect((slippageEvent![0] as { payload: Record<string, unknown> }).payload).toMatchObject({
        orderId: 'ord-orderbook-alert',
        venue: 'hyperliquid',
        symbol: 'BTC/USD:USD',
        side: 'buy',
        referencePrice: '100',
        avgFillPrice: '105',
        slippageBps: 500,
        thresholdBps: 20,
      });
      expect((slippageEvent![0] as { payload: Record<string, unknown> }).payload).not.toHaveProperty('executionType');
    });

    it('does not emit live slippage alert for orderbook fills below threshold', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const orderRepo = {
        ...stubRepo(),
        getByVenueRefId: vi.fn().mockResolvedValue({
          id: 'ord-orderbook-no-alert',
          referencePrice: '100',
        }),
      };

      const actor = new TradingActor('orderbook-slippage-no-alert', {}, makeBaseDeps({
        executionMode: 'live',
        venue: 'hyperliquid',
        venueType: 'orderbook',
        venuePort: {} as any,
        orderRepo: orderRepo as any,
        journal: { append: journalAppend } as any,
        slippageAlertBps: 20,
      }));

      await (actor as any).maybeEmitLiveSlippageAlert({
        orderId: 'orderbook-ref-2',
        venueRefId: 'orderbook-ref-2',
        symbol: 'BTC/USD:USD',
        side: 'buy',
        quantity: '1',
        price: '100.1',
        fee: '0',
        feeCurrency: 'USD',
        filledAt: new Date().toISOString(),
      });

      const slippageEvent = journalAppend.mock.calls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'live.slippage_alert',
      );
      expect(slippageEvent).toBeUndefined();
    });

    it('emits live slippage alert for swap fills when threshold is exceeded', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const orderRepo = {
        ...stubRepo(),
        getByVenueRefId: vi.fn().mockResolvedValue({
          id: 'ord-swap-alert',
          referencePrice: '100',
        }),
      };

      const actor = new TradingActor('swap-slippage-alert', {}, makeBaseDeps({
        executionMode: 'live',
        venue: 'jupiter',
        symbol: 'SOL/USDC',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        swapVenue: { fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])) } as any,
        orderRepo: orderRepo as any,
        journal: { append: journalAppend } as any,
        slippageAlertBps: 20,
      }));

      await (actor as any).maybeEmitLiveSwapExecutionQualityAlert({
        venueRefId: 'swap-tx-1',
        symbol: 'SOL/USDC',
        side: 'buy',
        price: '105',
      });

      const slippageEvent = journalAppend.mock.calls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'live.slippage_alert',
      );
      expect(slippageEvent).toBeDefined();
      expect((slippageEvent![0] as { payload: Record<string, unknown> }).payload).toMatchObject({
        orderId: 'ord-swap-alert',
        executionType: 'swap',
      });
    });
  });

  describe('clientOrderId persistence path (pre-venueRefId)', () => {
    it('persists order via upsertByClientOrderId when venueRefId is absent', async () => {
      const upsertByClientOrderId = vi.fn().mockResolvedValue(undefined);
      const upsertByVenueRefId = vi.fn().mockResolvedValue(undefined);
      const orderRepo = {
        getOpenByInstance: vi.fn().mockResolvedValue([]),
        getByExecutionPlanId: vi.fn().mockResolvedValue([]),
        upsertByVenueRefId,
        upsertByClientOrderId,
      };

      // A live executor that emits prepared → submit_attempting → acknowledged
      const submitOrder = vi.fn().mockResolvedValue(ok({
        orderId: 'o-live-1',
        venueRefId: 'venue-ref-1',
        status: 'open',
        timestamp: new Date().toISOString(),
      }));
      const venuePort = {
      getCapabilities: () => FULL_CAPABILITIES,
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn(), onStateChange: vi.fn() })),
        submitOrder,
        cancelOrder: vi.fn(),
      } as any;

      const deps = makeBaseDeps({
        venuePort,
        orderRepo: orderRepo as any,
        executionMode: 'live',
        reconciliationConfig: { intervalMs: 30000, driftAlertOnly: false },
        strategy: {
          evaluate: vi.fn().mockResolvedValueOnce(ok({
            id: 'd-coid',
            botId: 'inst-coid' as BotId,
            instrumentId: 'BTC/USD:USD',
            intent: 'go_long',
            targetSize: quantity('1'),
            timestamp: new Date().toISOString(),
          })).mockResolvedValue(ok(null)),
        } as any,
      });

      const actor = new TradingActor('inst-coid', {}, deps, 100_000);
      await actor.start();
      await new Promise((r) => setTimeout(r, 150));

      // The first two state changes (prepared, submit_attempting) should use clientOrderId path
      expect(upsertByClientOrderId).toHaveBeenCalled();
      const firstCall = upsertByClientOrderId.mock.calls[0]![0];
      expect(firstCall.clientOrderId).toBeDefined();
      expect(firstCall.venueRefId).toBeUndefined();
      expect(firstCall.submissionState).toBe('prepared');

      // After venue acknowledgement, venueRefId path is used
      expect(upsertByVenueRefId).toHaveBeenCalled();
      const ackCall = upsertByVenueRefId.mock.calls[0]![0];
      expect(ackCall.venueRefId).toBe('venue-ref-1');
      expect(ackCall.submissionState).toBe('venue_acknowledged');

      await actor.stop();
    });

    it('uses clientOrderId path for submit_attempting state before venue response', async () => {
      const upsertByClientOrderId = vi.fn().mockResolvedValue(undefined);
      const upsertByVenueRefId = vi.fn().mockResolvedValue(undefined);
      const orderRepo = {
        getOpenByInstance: vi.fn().mockResolvedValue([]),
        getByExecutionPlanId: vi.fn().mockResolvedValue([]),
        upsertByVenueRefId,
        upsertByClientOrderId,
      };

      // Slow venue that rejects after a delay — we get prepared + submit_attempting before rejection
      const submitOrder = vi.fn().mockResolvedValue(err({ code: 'VENUE_REJECT', message: 'insufficient margin' }));
      const venuePort = {
      getCapabilities: () => FULL_CAPABILITIES,
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), timestamp: new Date().toISOString() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn(), onStateChange: vi.fn() })),
        submitOrder,
        cancelOrder: vi.fn(),
      } as any;

      const deps = makeBaseDeps({
        venuePort,
        orderRepo: orderRepo as any,
        executionMode: 'live',
        reconciliationConfig: { intervalMs: 30000, driftAlertOnly: false },
        strategy: {
          evaluate: vi.fn().mockResolvedValueOnce(ok({
            id: 'd-reject',
            botId: 'inst-reject' as BotId,
            instrumentId: 'BTC/USD:USD',
            intent: 'go_long',
            targetSize: quantity('1'),
            timestamp: new Date().toISOString(),
          })).mockResolvedValue(ok(null)),
        } as any,
      });

      const actor = new TradingActor('inst-reject', {}, deps, 100_000);
      await actor.start();
      await new Promise((r) => setTimeout(r, 150));

      // All three state changes should go through clientOrderId since venue rejected (no venueRefId ever)
      expect(upsertByClientOrderId.mock.calls.length).toBeGreaterThanOrEqual(2);
      const states = upsertByClientOrderId.mock.calls.map((c: unknown[]) => (c[0] as Record<string, unknown>).submissionState);
      expect(states).toContain('prepared');
      expect(states).toContain('submit_attempting');

      // The rejected state also has no venueRefId — goes through clientOrderId path
      const rejectedCall = upsertByClientOrderId.mock.calls.find(
        (c: unknown[]) => (c[0] as Record<string, unknown>).submissionState === 'terminal',
      );
      expect(rejectedCall).toBeDefined();

      await actor.stop();
    });
  });
});

