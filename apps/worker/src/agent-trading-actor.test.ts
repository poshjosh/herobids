import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentTradingActor } from './agent-trading-actor.js';
import type { AgentTradingActorDeps } from './agent-trading-actor.js';
import { price, quantity, ok } from '@herobids/domain';
import { PaperExecutor, ShadowExecutor, LiveExecutor, LastFillMarkSource, MarkSelector } from '@herobids/engine';
import type { OrderId, FillId } from '@herobids/domain';
import { FULL_CAPABILITIES } from '@herobids/tests/fixtures/venue-capabilities.js';

function makeIdGen() {
  let c = 0;
  return {
    orderId: () => `o-${++c}` as OrderId,
    fillId: () => `f-${++c}` as FillId,
    planId: () => `p-${++c}`,
    decisionId: () => `d-${++c}`,
  };
}

function makeRepo() {
  return {
    insertFill: vi.fn().mockResolvedValue(undefined),
    getOpenByActor: vi.fn().mockResolvedValue([]),
    getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([]),
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
    getLastReconciledAtForInstance: vi.fn().mockResolvedValue(null),
    getRecentByVenueAccount: vi.fn().mockResolvedValue([]),
    getLatestByVenueAccount: vi.fn().mockResolvedValue(null),
    insertSnapshot: vi.fn().mockResolvedValue('snap-id'),
    insert: vi.fn().mockResolvedValue(undefined),
  };
}

function makeVenueAdapterFactory(overrides?: {
  orderbookAdapter?: object;
  swapAdapter?: object;
}) {
  return {
    buildOrderbookAdapter: vi.fn().mockResolvedValue(
      overrides?.orderbookAdapter ?? {
        venuePort: {
          fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49990'), ask: price('50010'), timestamp: new Date().toISOString() })),
          subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() })),
          fetchPositions: vi.fn(),
          fetchBalances: vi.fn(),
          fetchRecentFills: vi.fn(),
          fetchOpenOrders: vi.fn(),
        },
        credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: false },
        credentialId: 'cred-1',
      },
    ),
    buildSwapAdapter: vi.fn().mockResolvedValue(
      overrides?.swapAdapter ?? {
        swapVenue: {
          fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
          quote: vi.fn(),
        },
        walletAddress: 'wallet-xyz',
      },
    ),
  };
}

function makeMarkSource(priceStr = '50000') {
  return {
    fetchMark: vi.fn().mockResolvedValue(ok({
      price: price(priceStr),
      source: 'oracle',
      instrument: 'BTC/USD:USD',
      timestamp: new Date().toISOString(),
      stale: false,
    })),
  };
}

function makeBaseDeps(overrides?: Partial<AgentTradingActorDeps>): AgentTradingActorDeps {
  const repo = makeRepo();
  return {
    agentId: 'agent-test-1',
    executionMode: 'paper',
    venueAccountId: 'va-1',
    venue: 'hyperliquid',
    venueType: 'orderbook',
    riskLimits: {
      maxPositionSize: quantity('100'),
      maxOpenPositions: 5,
      maxDrawdown: price('10000'),
    },
    venueAdapterFactory: makeVenueAdapterFactory() as any,
    markSource: makeMarkSource() as any,
    journal: { append: vi.fn().mockResolvedValue(undefined) } as any,
    idGen: makeIdGen(),
    positionRepo: repo as any,
    fillRepo: repo as any,
    planRepo: repo as any,
    orderRepo: repo as any,
    decisionRepo: repo as any,
    balanceSnapshotRepo: repo as any,
    backtestingRepo: repo as any,
    reconciliationRepo: repo as any,
    ...overrides,
  };
}

describe('AgentTradingActor', () => {
  describe('lifecycle', () => {
    it('is not running before start', () => {
      const actor = new AgentTradingActor(makeBaseDeps());
      expect(actor.isRunning).toBe(false);
    });

    it('is running after start', async () => {
      const actor = new AgentTradingActor(makeBaseDeps());
      await actor.start();
      expect(actor.isRunning).toBe(true);
      await actor.stop();
    });

    it('is not running after stop', async () => {
      const actor = new AgentTradingActor(makeBaseDeps());
      await actor.start();
      await actor.stop();
      expect(actor.isRunning).toBe(false);
    });

    it('idempotent start — second start is a no-op', async () => {
      const factory = makeVenueAdapterFactory();
      const actor = new AgentTradingActor(makeBaseDeps({ executionMode: 'shadow', venueAdapterFactory: factory as any }));
      await actor.start();
      await actor.start();
      // factory called only once (second start() returns early because isRunning is true)
      expect(factory.buildOrderbookAdapter).toHaveBeenCalledTimes(1);
      expect(actor.isRunning).toBe(true);
      await actor.stop();
    });

    it('idempotent stop — second stop is a no-op', async () => {
      const actor = new AgentTradingActor(makeBaseDeps());
      await actor.start();
      await actor.stop();
      // Should not throw
      await expect(actor.stop()).resolves.toBeUndefined();
    });

    it('cleans up failed startup when private stream connection fails', async () => {
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'shadow',
        venueAdapterFactory: makeVenueAdapterFactory({
          orderbookAdapter: {
            venuePort: {
              fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49990'), ask: price('50010'), timestamp: new Date().toISOString() })),
              subscribePrivate: vi.fn().mockResolvedValue({ ok: false, error: { message: 'stream down' } }),
              fetchPositions: vi.fn(),
              fetchBalances: vi.fn(),
              fetchRecentFills: vi.fn(),
              fetchOpenOrders: vi.fn(),
            },
            credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: false },
            credentialId: 'cred-1',
          },
        }) as any,
      }));

      await expect(actor.start()).rejects.toThrow('Private stream connection failed');
      expect(actor.isRunning).toBe(false);
    });

    it('stops the actor when a private stream mutation fails', async () => {
      let privateHandlers: Record<string, ((event: any) => void) | undefined> = {};
      const fillRepo = {
        ...makeRepo(),
        insertFill: vi.fn().mockRejectedValue(new Error('write failed')),
      };
      const onCrashed = vi.fn().mockResolvedValue(undefined);
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'shadow',
        onCrashed,
        fillRepo: fillRepo as any,
        venueAdapterFactory: makeVenueAdapterFactory({
          orderbookAdapter: {
            venuePort: {
              fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49990'), ask: price('50010'), timestamp: new Date().toISOString() })),
              subscribePrivate: vi.fn().mockImplementation(async (handlers) => {
                privateHandlers = handlers;
                return ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() });
              }),
              fetchPositions: vi.fn(),
              fetchBalances: vi.fn(),
              fetchRecentFills: vi.fn(),
              fetchOpenOrders: vi.fn(),
            },
            credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: false },
            credentialId: 'cred-1',
          },
        }) as any,
      }));

      await actor.start();
      privateHandlers.onFill?.({
        orderId: 'order-1',
        venueRefId: 'venue-fill-1',
        symbol: 'BTC/USD:USD',
        side: 'buy',
        quantity: '1',
        price: '48000',
        fee: '0',
        feeCurrency: 'USD',
        filledAt: new Date().toISOString(),
      });

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(actor.isRunning).toBe(false);
      expect(onCrashed).toHaveBeenCalledWith(expect.any(Error));
    });

    it('halts auto_go_flat when crash recovery is ambiguous', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const orderRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            id: 'o-ambiguous',
            symbol: 'BTC/USD:USD',
            venueRefId: null,
            venueAccountId: 'va-1',
            actorType: 'agent',
            actorId: 'agent-test-1',
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
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49990'), ask: price('50010'), timestamp: new Date().toISOString() })),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        cancelOrder: vi.fn().mockResolvedValue(ok(undefined)),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        crashPolicy: 'auto_go_flat',
        journal: { append: journalAppend } as any,
        orderRepo: orderRepo as any,
        venueAdapterFactory: makeVenueAdapterFactory({
          orderbookAdapter: {
            venuePort,
            credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: false },
            credentialId: 'cred-1',
          },
        }) as any,
      }));

      await actor.start();
      await (actor as any).crash(new Error('forced crash'));

      const crashCall = journalAppend.mock.calls.find((c) => c[0]?.type === 'instance.crashed');
      expect(crashCall).toBeDefined();
      expect(crashCall?.[0]?.payload).toMatchObject({
        crashRecoveryAmbiguous: true,
        attemptedEmergencyGoFlat: 0,
      });
    });

    it('halts swap auto_go_flat when crash recovery is ambiguous on-chain', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const orderRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            id: 'o-swap-ambiguous',
            symbol: 'SOL/USDC',
            venueRefId: null,
            venueAccountId: 'va-1',
            actorType: 'agent',
            actorId: 'agent-test-1',
            venue: 'jupiter',
            side: 'buy',
            type: 'swap',
            quantity: quantity('1'),
            filledQuantity: quantity('0'),
          },
        ]),
      };

      const swapVenue = {
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        quote: vi.fn(),
        fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        crashPolicy: 'auto_go_flat',
        venue: 'jupiter',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        journal: { append: journalAppend } as any,
        orderRepo: orderRepo as any,
        venueAdapterFactory: makeVenueAdapterFactory({
          swapAdapter: {
            swapVenue,
            walletAddress: 'wallet-xyz',
            signerPresent: true,
          },
        }) as any,
      }));

      await actor.start();
      await (actor as any).crash(new Error('forced crash'));

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
        attemptedEmergencyGoFlat: 0,
        openSwapOrders: 1,
        unresolvedSwapOrders: 1,
      });
    });

    it('cancels open orders before crash-policy go_flat path', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const orderRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            id: 'o-cancel',
            symbol: 'BTC/USD:USD',
            venueRefId: 'venue-order-1',
            clientOrderId: 'client-1',
            venueAccountId: 'va-1',
            actorType: 'agent',
            actorId: 'agent-test-1',
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
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49990'), ask: price('50010'), timestamp: new Date().toISOString() })),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        cancelOrder: vi.fn().mockResolvedValue(ok(undefined)),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        crashPolicy: 'auto_go_flat',
        journal: { append: journalAppend } as any,
        orderRepo: orderRepo as any,
        venueAdapterFactory: makeVenueAdapterFactory({
          orderbookAdapter: {
            venuePort,
            credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: false },
            credentialId: 'cred-1',
          },
        }) as any,
      }));

      await actor.start();
      await (actor as any).crash(new Error('forced crash'));

      expect(venuePort.cancelOrder).toHaveBeenCalledWith({
        orderId: 'venue-order-1',
        symbol: 'BTC/USD:USD',
      });

      const crashCall = journalAppend.mock.calls.find((c) => c[0]?.type === 'instance.crashed');
      expect(crashCall).toBeDefined();
      expect(crashCall?.[0]?.payload).toMatchObject({
        crashRecoveryAmbiguous: false,
        cancelledOpenOrders: 1,
      });
    });

    it('captures startup pending-live snapshot in live mode', async () => {
      const planRepo = {
        ...makeRepo(),
        getIncomplete: vi.fn().mockResolvedValue([{ id: 'plan-startup-snapshot', status: 'executing' }]),
      };
      const orderRepo = {
        ...makeRepo(),
        getByExecutionPlanId: vi.fn().mockResolvedValue([
          {
            id: 'ord-startup-1',
            status: 'pending',
            submissionState: 'submit_attempting',
            venueRefId: null,
            clientOrderId: 'client-startup-1',
            symbol: 'BTC/USD:USD',
          },
        ]),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        planRepo: planRepo as any,
        orderRepo: orderRepo as any,
        venueAdapterFactory: makeVenueAdapterFactory({
          orderbookAdapter: {
            venuePort: {
              fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49990'), ask: price('50010'), timestamp: new Date().toISOString() })),
              subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() })),
              fetchPositions: vi.fn().mockResolvedValue(ok([])),
              fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
              fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
              fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
            },
            credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: false },
            credentialId: 'cred-1',
          },
        }) as any,
      }));

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
      const actor = new AgentTradingActor(makeBaseDeps({ executionMode: 'paper' }));
      (actor as any).startupPendingLiveSnapshot = {
        capturedAt: new Date().toISOString(),
        plans: [{ planId: 'stale', planStatus: 'executing', orderCount: 1, nonTerminalOrders: [] }],
      };

      await actor.start();

      expect((actor as any).startupPendingLiveSnapshot).toBeUndefined();

      await actor.stop();
    });

    it('builds a reconnect snapshot from a tracked instrument', async () => {
      const positionRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            venue: 'hyperliquid',
            symbol: 'BTC/USD:USD',
            side: 'long',
            size: '0.75',
            entryPrice: '49000',
            realizedPnl: '250',
          },
        ]),
      };
      const actor = new AgentTradingActor(makeBaseDeps({ positionRepo: positionRepo as any }));

      await actor.start();
      const snapshot = await actor.buildReconnectSnapshot();

      expect(snapshot).toBeDefined();
      expect(snapshot!.symbol).toBe('BTC/USD:USD');
      expect(snapshot!.executionMode).toBe('paper');
      expect(snapshot!.position).toEqual({
        side: 'long',
        size: '0.75',
        entryPrice: '49000',
        realizedPnl: '250',
      });
      // pnl = (50000 - 49000) * 0.75 * 1 = 750
      expect(snapshot!.pnl).toBe('750.00');

      await actor.stop();
    });

    it('builds reconnect snapshots covering ALL tracked instruments, not just one', async () => {
      const positionRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            venue: 'hyperliquid',
            symbol: 'BTC/USD:USD',
            side: 'long',
            size: '0.75',
            entryPrice: '49000',
            realizedPnl: '250',
          },
          {
            venue: 'hyperliquid',
            symbol: 'ETH/USD:USD',
            side: 'short',
            size: '5.0',
            entryPrice: '3200',
            realizedPnl: '-40',
          },
        ]),
      };
      const actor = new AgentTradingActor(makeBaseDeps({ positionRepo: positionRepo as any }));

      await actor.start();

      // The actor tracks two instruments with open positions.
      // Reconnect recovery MUST return snapshot data for both instruments
      // so the agent runtime does not lose awareness of one position.
      const snapshots = await actor.buildReconnectSnapshots();

      expect(snapshots).toHaveLength(2);
      const symbols = snapshots.map((s) => s.symbol).sort();
      expect(symbols).toEqual(['BTC/USD:USD', 'ETH/USD:USD']);

      const btcSnapshot = snapshots.find((s) => s.symbol === 'BTC/USD:USD');
      expect(btcSnapshot!.position).toEqual({
        side: 'long',
        size: '0.75',
        entryPrice: '49000',
        realizedPnl: '250',
      });

      const ethSnapshot = snapshots.find((s) => s.symbol === 'ETH/USD:USD');
      expect(ethSnapshot!.position).toEqual({
        side: 'short',
        size: '5',
        entryPrice: '3200',
        realizedPnl: '-40',
      });

      await actor.stop();
    });

    it('returns no reconnect snapshot when no instrument is tracked yet', async () => {
      const actor = new AgentTradingActor(makeBaseDeps());

      await actor.start();
      await expect(actor.buildReconnectSnapshot()).resolves.toBeUndefined();
      await actor.stop();
    });

    it('still emits a reconnect snapshot for an instrument when mark fetch fails', async () => {
      const positionRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            venue: 'hyperliquid',
            symbol: 'BTC/USD:USD',
            side: 'long',
            size: '1.0',
            entryPrice: '48000',
            realizedPnl: '100',
          },
          {
            venue: 'hyperliquid',
            symbol: 'ETH/USD:USD',
            side: 'short',
            size: '5',
            entryPrice: '3100',
            realizedPnl: '0',
          },
        ]),
      };

      let callCount = 0;
      const markSource = {
        fetchMark: vi.fn().mockImplementation((symbol: string) => {
          callCount++;
          if (symbol === 'ETH/USD:USD') {
            return Promise.resolve({ ok: false, error: { code: 'mark.unavailable' } });
          }
          return Promise.resolve(ok({
            price: price('50000'),
            source: 'oracle',
            instrument: symbol,
            timestamp: '2026-06-14T00:00:00Z',
            stale: false,
          }));
        }),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        positionRepo: positionRepo as any,
        markSource: markSource as any,
      }));

      await actor.start();
      const snapshots = await actor.buildReconnectSnapshots();

      // Both instruments must be present — mark failure must NOT drop the position
      expect(snapshots).toHaveLength(2);
      const ethSnapshot = snapshots.find((s) => s.symbol === 'ETH/USD:USD');
      expect(ethSnapshot).toBeDefined();
      expect(ethSnapshot!.position).toEqual({
        side: 'short',
        size: '5',
        entryPrice: '3100',
        realizedPnl: '0',
      });
      // Price is degraded (0 = unavailable)
      expect(ethSnapshot!.price).toBe('0');
      expect(ethSnapshot!.referenceMark.source).toBe('unavailable');
      // pnl is undefined when mark fetch fails
      expect(ethSnapshot!.pnl).toBeUndefined();

      // BTC/USD:USD should have a real price
      const btcSnapshot = snapshots.find((s) => s.symbol === 'BTC/USD:USD');
      expect(btcSnapshot!.price).toBe('50000');
      // pnl = (50000 - 48000) * 1.0 * 1 = 2000
      expect(btcSnapshot!.pnl).toBe('2000.00');

      await actor.stop();
    });

    it('returns empty array when last reconciliation was drift_detected with no position changes', async () => {
      const positionRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            venue: 'hyperliquid',
            symbol: 'BTC/USD:USD',
            side: 'long',
            size: '1.0',
            entryPrice: '50000',
            realizedPnl: '0',
          },
        ]),
      };
      const actor = new AgentTradingActor(makeBaseDeps({ positionRepo: positionRepo as any }));

      await actor.start();

      // Simulate reconciler detecting drift with no position changes
      (actor as any).lastReconciliationStatus = 'drift_detected';
      (actor as any).lastReconciliationHadPositionChange = false;

      const snapshots = await actor.buildReconnectSnapshots();
      expect(snapshots).toEqual([]);

      await actor.stop();
    });

    it('returns normal snapshots when last reconciliation had actual position diffs', async () => {
      const positionRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            venue: 'hyperliquid',
            symbol: 'BTC/USD:USD',
            side: 'long',
            size: '1.0',
            entryPrice: '50000',
            realizedPnl: '0',
          },
        ]),
      };
      const actor = new AgentTradingActor(makeBaseDeps({ positionRepo: positionRepo as any }));

      await actor.start();

      // Simulate reconciler detecting drift WITH position changes
      (actor as any).lastReconciliationStatus = 'drift_detected';
      (actor as any).lastReconciliationHadPositionChange = true;

      const snapshots = await actor.buildReconnectSnapshots();
      expect(snapshots.length).toBeGreaterThan(0);

      await actor.stop();
    });
  });

  describe('executor selection', () => {
    it('creates PaperExecutor in paper mode', async () => {
      const factory = makeVenueAdapterFactory();
      const actor = new AgentTradingActor(makeBaseDeps({ venueAdapterFactory: factory as any }));
      await actor.start();

      // Paper mode skips venue adapter resolution entirely
      expect(factory.buildOrderbookAdapter).not.toHaveBeenCalled();

      // But the executor selected is PaperExecutor since mode is 'paper'
      const deps = actor.getIntakeDeps('BTC/USD:USD');
      expect(deps).toBeDefined();
      expect(deps!.executor).toBeInstanceOf(PaperExecutor);

      await actor.stop();
    });

    it('calls buildOrderbookAdapter for shadow orderbook mode', async () => {
      const factory = makeVenueAdapterFactory();
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'shadow',
        venueAdapterFactory: factory as any,
      }));
      await actor.start();

      expect(factory.buildOrderbookAdapter).toHaveBeenCalledWith({
        venueAccountId: 'va-1',
        venue: 'hyperliquid',
        actorType: 'agent',
        actorId: 'agent-test-1',
        executionMode: 'shadow',
      });

      const deps = actor.getIntakeDeps('BTC/USD:USD');
      expect(deps!.executor).toBeInstanceOf(ShadowExecutor);

      await actor.stop();
    });

    it('creates ShadowExecutor for swap venue in shadow mode', async () => {
      const factory = makeVenueAdapterFactory();
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'shadow',
        venueType: 'swap',
        venue: 'jupiter',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        venueAdapterFactory: factory as any,
      }));
      await actor.start();

      expect(factory.buildSwapAdapter).toHaveBeenCalledWith({
        venueAccountId: 'va-1',
        venue: 'jupiter',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        actorType: 'agent',
        actorId: 'agent-test-1',
      });

      const deps = actor.getIntakeDeps('SOL/USDC');
      expect(deps!.executor).toBeInstanceOf(ShadowExecutor);

      await actor.stop();
    });

    it('derives swap decision metadata from the requested instrument when startup has no canonical symbol', async () => {
      const actor = new AgentTradingActor(makeBaseDeps({
        venue: 'jupiter',
        venueType: 'swap',
      }));

      await actor.start();

      const deps = actor.getIntakeDeps('solana:BONK/USDC');

      expect(deps?.swapAssets).toEqual({ baseAsset: 'BONK', quoteAsset: 'USDC' });
      expect(deps?.swapBaseTokenAddress).toBe('BONK');

      await actor.stop();
    });

    it('creates LiveExecutor for live orderbook mode', async () => {
      const factory = makeVenueAdapterFactory();
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        venueAdapterFactory: factory as any,
      }));
      await actor.start();

      const deps = actor.getIntakeDeps('BTC/USD:USD');
      expect(deps!.executor).toBeInstanceOf(LiveExecutor);

      await actor.stop();
    });

    it('throws when live mode has no orderbook adapter result', async () => {
      const factory = {
        buildOrderbookAdapter: vi.fn().mockResolvedValue({
          venuePort: null, // simulate missing port
          credentials: { apiKey: '', secret: '', walletAddress: '', testnet: false },
          credentialId: undefined,
        }),
        buildSwapAdapter: vi.fn(),
      };
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        venueAdapterFactory: factory as any,
      }));
      await expect(actor.start()).rejects.toThrow('Live execution mode requires a venue port');
    });

    it('cancels stale live limit orders via timeout policy', async () => {
      const cancelOrder = vi.fn().mockResolvedValue(ok({ cancelled: true }));
      const orderRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            id: 'agent-stale-limit',
            venueAccountId: 'va-1',
            actorType: 'agent',
            actorId: 'agent-test-1',
            executionPlanId: 'plan-stale-limit',
            venueRefId: 'venue-agent-limit-1',
            clientOrderId: 'client-agent-limit-1',
            venue: 'hyperliquid',
            symbol: 'BTC/USD:USD',
            side: 'buy',
            type: 'limit',
            quantity: '1',
            price: '49000',
            referencePrice: null,
            status: 'open',
            submissionState: 'venue_acknowledged',
            submitAttemptedAt: new Date(Date.now() - 10 * 60 * 1000),
            acknowledgedAt: new Date(Date.now() - 10 * 60 * 1000),
            filledQuantity: '0',
            avgFillPrice: null,
          },
        ]),
        upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        orderRepo: orderRepo as any,
        liveOrderTimeoutPolicy: {
          limitOrderTimeoutMs: 60_000,
          marketOrderTimeoutMs: 30_000,
          checkIntervalMs: 60_000,
        },
        venueAdapterFactory: makeVenueAdapterFactory({
          orderbookAdapter: {
            venuePort: {
              fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49990'), ask: price('50010'), timestamp: new Date().toISOString() })),
              subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() })),
              fetchPositions: vi.fn().mockResolvedValue(ok([])),
              fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
              fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
              fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
              cancelOrder,
            },
            credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: false },
            credentialId: 'cred-1',
          },
        }) as any,
      }));

      await actor.start();
      await (actor as any).enforceLiveOrderTimeouts();

      expect(cancelOrder).toHaveBeenCalledWith({ orderId: 'venue-agent-limit-1', symbol: 'BTC/USD:USD' });
      expect(orderRepo.upsertByVenueRefId).toHaveBeenCalledWith(expect.objectContaining({
        venueRefId: 'venue-agent-limit-1',
        status: 'cancelled',
        submissionState: 'terminal',
      }));

      await actor.stop();
    });

    it('marks stale live market orders as recovery-required', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const orderRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            id: 'agent-stale-market',
            venueAccountId: 'va-1',
            actorType: 'agent',
            actorId: 'agent-test-1',
            executionPlanId: 'plan-stale-market',
            venueRefId: 'venue-agent-market-1',
            clientOrderId: 'client-agent-market-1',
            venue: 'hyperliquid',
            symbol: 'BTC/USD:USD',
            side: 'buy',
            type: 'market',
            quantity: '1',
            price: null,
            referencePrice: null,
            status: 'pending',
            submissionState: 'submit_attempting',
            submitAttemptedAt: new Date(Date.now() - 5 * 60 * 1000),
            acknowledgedAt: null,
            filledQuantity: '0',
            avgFillPrice: null,
          },
        ]),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        orderRepo: orderRepo as any,
        journal: { append: journalAppend } as any,
        liveOrderTimeoutPolicy: {
          limitOrderTimeoutMs: 60_000,
          marketOrderTimeoutMs: 30_000,
          checkIntervalMs: 60_000,
        },
        venueAdapterFactory: makeVenueAdapterFactory({
          orderbookAdapter: {
            venuePort: {
              fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49990'), ask: price('50010'), timestamp: new Date().toISOString() })),
              subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() })),
              fetchPositions: vi.fn().mockResolvedValue(ok([])),
              fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
              fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
              fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
              cancelOrder: vi.fn(),
            },
            credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: false },
            credentialId: 'cred-1',
          },
        }) as any,
      }));

      await actor.start();
      await (actor as any).enforceLiveOrderTimeouts();

      const recoveryEvent = journalAppend.mock.calls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'execution.failure'
          && ((call[0] as { payload: Record<string, unknown> }).payload.reason === 'live_order_timeout_recovery_required'),
      );
      expect(recoveryEvent).toBeTruthy();

      await actor.stop();
    });

    it('starts with swap adapter even without pre-configured swapAssets (agents resolve tokens dynamically)', async () => {
      const factory = makeVenueAdapterFactory();
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'shadow',
        venueType: 'swap',
        venue: 'jupiter',
        swapAssets: undefined,
        venueAdapterFactory: factory as any,
      }));

      // Agents can start without pre-configured swapAssets — the swap adapter is
      // still built so that token pairs can be resolved dynamically at decision time
      // from the instrument ID. Decimals are fetched on-demand by the adapter.
      await expect(actor.start()).resolves.toBeUndefined();
      expect(factory.buildSwapAdapter).toHaveBeenCalledWith(expect.objectContaining({
        swapAssets: undefined,
        venue: 'jupiter',
      }));
    });
  });

  describe('getIntakeDeps', () => {
    it('returns undefined when actor not running', () => {
      const actor = new AgentTradingActor(makeBaseDeps());
      expect(actor.getIntakeDeps('BTC/USD:USD')).toBeUndefined();
    });

    it('returns undefined when instrumentId is omitted', async () => {
      const actor = new AgentTradingActor(makeBaseDeps());
      await actor.start();
      expect(actor.getIntakeDeps()).toBeUndefined();
      await actor.stop();
    });

    it('returns correct actorType and actorId', async () => {
      const actor = new AgentTradingActor(makeBaseDeps());
      await actor.start();

      const deps = actor.getIntakeDeps('BTC/USD:USD');
      expect(deps!.actorType).toBe('agent');
      expect(deps!.actorId).toBe('agent-test-1');
      expect(deps!.venue).toBe('hyperliquid');
      expect(deps!.venueAccountId).toBe('va-1');
      expect(deps!.symbol).toBe('BTC/USD:USD');

      await actor.stop();
    });

    it('propagates riskLimits into intake deps', async () => {
      const riskLimits = {
        maxPositionSize: quantity('500'),
        maxOpenPositions: 3,
        maxDrawdown: price('2500'),
      };
      const actor = new AgentTradingActor(makeBaseDeps({ riskLimits }));
      await actor.start();

      const deps = actor.getIntakeDeps('BTC/USD:USD');
      expect(deps!.riskLimits.maxPositionSize.toString()).toBe('500');
      expect(deps!.riskLimits.maxOpenPositions).toBe(3);
      expect(deps!.riskLimits.maxDrawdown.toString()).toBe('2500');

      await actor.stop();
    });

    it('propagates venueType and swapAssets into intake deps', async () => {
      const swapAssets = { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 };
      const actor = new AgentTradingActor(makeBaseDeps({
        venueType: 'swap',
        swapAssets,
      }));
      await actor.start();

      const deps = actor.getIntakeDeps('SOL/USDC');
      expect(deps!.venueType).toBe('swap');
      expect(deps!.swapAssets).toEqual(swapAssets);

      await actor.stop();
    });

    it('rejects bare token instrument on swap venue when no pre-configured swapAssets', async () => {
      const actor = new AgentTradingActor(makeBaseDeps({
        venueType: 'swap',
        venue: '1inch',
        swapAssets: undefined,
      }));
      await actor.start();

      const result = actor.getIntakeDeps('WETH');
      expect(result).not.toBeUndefined();
      expect(result).toHaveProperty('rejected', true);
      expect((result as { code: string; message: string }).code).toBe('swap.instrument_format');
      expect((result as { message: string }).message).toContain('BASE/QUOTE');
      expect((result as { message: string }).message).toContain('WETH');

      await actor.stop();
    });

    it('accepts BASE/QUOTE instrument on swap venue without pre-configured swapAssets', async () => {
      const actor = new AgentTradingActor(makeBaseDeps({
        venueType: 'swap',
        venue: '1inch',
        swapAssets: undefined,
      }));
      await actor.start();

      const deps = actor.getIntakeDeps('WETH/USDC');
      expect(deps).not.toBeUndefined();
      expect(deps).not.toHaveProperty('rejected');
      expect(deps!.swapAssets).toEqual({ baseAsset: 'WETH', quoteAsset: 'USDC' });

      await actor.stop();
    });

    it('persistence planId delegates to idGen.planId', async () => {
      const idGen = makeIdGen();
      const actor = new AgentTradingActor(makeBaseDeps({ idGen }));
      await actor.start();

      const deps = actor.getIntakeDeps('BTC/USD:USD');
      const planId1 = deps!.idGen.planId();
      const planId2 = deps!.idGen.planId();
      expect(planId1).not.toBe(planId2); // unique IDs
      expect(typeof planId1).toBe('string');

      await actor.stop();
    });

    it('rejects with instrument_unknown when cache is ready and symbol is not recognized', async () => {
      const actor = new AgentTradingActor(makeBaseDeps({
        instrumentCache: {
          isReady: () => true,
          hasSymbol: (venue: string, symbol: string) => {
            if (venue === 'hyperliquid' && symbol === 'DOGE') return false;
            return true;
          },
        } as any,
      }));
      await actor.start();

      const result = actor.getIntakeDeps('DOGE');
      expect(result).toBeDefined();
      expect(result).toHaveProperty('rejected', true);
      expect(result).toHaveProperty('code', 'instrument_unknown');
      expect(result).toHaveProperty('retryable', false);

      await actor.stop();
    });

    it('allows known symbols when cache is ready', async () => {
      const actor = new AgentTradingActor(makeBaseDeps({
        instrumentCache: {
          isReady: () => true,
          hasSymbol: () => true,
        } as any,
      }));
      await actor.start();

      const result = actor.getIntakeDeps('BTC/USD:USD');
      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('rejected');
      expect(result).toHaveProperty('actorType', 'agent');

      await actor.stop();
    });

    it('skips validation when instrumentCache is absent (backward compat)', async () => {
      const actor = new AgentTradingActor(makeBaseDeps());
      await actor.start();

      const result = actor.getIntakeDeps('DOGE');
      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('rejected');
      expect(result).toHaveProperty('actorType', 'agent');

      await actor.stop();
    });
  });

  describe('getDecisionContext', () => {
    it('returns undefined when instrumentId is omitted', async () => {
      const actor = new AgentTradingActor(makeBaseDeps());
      await actor.start();
      const ctx = await actor.getDecisionContext();
      expect(ctx).toBeUndefined();
      await actor.stop();
    });

    it('returns undefined when mark source fails', async () => {
      const markSource = {
        fetchMark: vi.fn().mockResolvedValue({ ok: false, error: { code: 'MARK_UNAVAILABLE', message: 'no data' } }),
      };
      const actor = new AgentTradingActor(makeBaseDeps({ markSource: markSource as any }));
      await actor.start();

      const ctx = await actor.getDecisionContext('BTC/USD:USD');
      expect(ctx).toBeUndefined();

      await actor.stop();
    });

    it('returns context with flat position when no position exists', async () => {
      const actor = new AgentTradingActor(makeBaseDeps());
      await actor.start();

      const ctx = await actor.getDecisionContext('BTC/USD:USD');
      expect(ctx).toBeDefined();
      expect(ctx!.snapshot.symbol).toBe('BTC/USD:USD');
      expect(ctx!.snapshot.price).toBe('50000');
      expect(ctx!.position).toBeNull();
      expect(ctx!.referenceMark.source).toBe('oracle');

      await actor.stop();
    });

    it('returns context with position when instrument has open position (from rehydration)', async () => {
      const positionRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            venue: 'hyperliquid',
            symbol: 'BTC/USD:USD',
            side: 'long',
            size: '2',
            entryPrice: '48000',
            realizedPnl: '500',
          },
        ]),
      };
      const actor = new AgentTradingActor(makeBaseDeps({ positionRepo: positionRepo as any }));
      await actor.start();

      const ctx = await actor.getDecisionContext('BTC/USD:USD');
      expect(ctx!.position).not.toBeNull();
      expect(ctx!.position!.side).toBe('long');
      expect(ctx!.position!.size).toBe('2');
      expect(ctx!.position!.entryPrice).toBe('48000');

      await actor.stop();
    });

    it('returns null position for different instrument not in positions map', async () => {
      const actor = new AgentTradingActor(makeBaseDeps());
      await actor.start();

      const ctx = await actor.getDecisionContext('ETH/USD:USD');
      expect(ctx!.position).toBeNull();

      await actor.stop();
    });

    it('uses last fill price as reference mark when MarkSelector has a recent fill', async () => {
      const fillLookup = {
        getLatestFillByInstrument: vi.fn().mockResolvedValue({
          price: '0.00000484',
          filledAt: new Date().toISOString(),
        }),
      };
      const oracleMark = {
        fetchMark: vi.fn().mockResolvedValue(ok({
          price: price('0.00002099'),
          source: 'oracle' as const,
          instrument: 'BONK',
          timestamp: new Date().toISOString(),
          stale: false,
        })),
      };
      const markSource = new MarkSelector(
        { stalenessThresholdMs: 5 * 60 * 1000 },
        new LastFillMarkSource(fillLookup),
        oracleMark as any,
      );
      const actor = new AgentTradingActor(makeBaseDeps({ markSource }));
      await actor.start();

      const ctx = await actor.getDecisionContext('BONK');
      expect(ctx).toBeDefined();
      expect(ctx!.referenceMark.price).toBe('0.00000484');
      expect(ctx!.referenceMark.source).toBe('last_fill');
      expect(oracleMark.fetchMark).not.toHaveBeenCalled();

      await actor.stop();
    });

    it('falls back to oracle price as reference mark when no fill exists', async () => {
      const fillLookup = {
        getLatestFillByInstrument: vi.fn().mockResolvedValue(null),
      };
      const oracleMark = {
        fetchMark: vi.fn().mockResolvedValue(ok({
          price: price('0.00002099'),
          source: 'oracle' as const,
          instrument: 'BONK',
          timestamp: new Date().toISOString(),
          stale: false,
        })),
      };
      const markSource = new MarkSelector(
        { stalenessThresholdMs: 5 * 60 * 1000 },
        new LastFillMarkSource(fillLookup),
        oracleMark as any,
      );
      const actor = new AgentTradingActor(makeBaseDeps({ markSource }));
      await actor.start();

      const ctx = await actor.getDecisionContext('BONK');
      expect(ctx).toBeDefined();
      expect(ctx!.referenceMark.price).toBe('0.00002099');
      expect(ctx!.referenceMark.source).toBe('oracle');

      await actor.stop();
    });
  });

  describe('getPosition', () => {
    it('returns undefined when instrumentId is omitted', async () => {
      const actor = new AgentTradingActor(makeBaseDeps());
      await actor.start();
      expect(actor.getPosition()).toBeUndefined();
      await actor.stop();
    });

    it('returns flat position for unknown instrument', async () => {
      const actor = new AgentTradingActor(makeBaseDeps());
      await actor.start();

      const pos = actor.getPosition('BTC/USD:USD');
      expect(pos).toBeDefined();
      expect(pos!.side).toBe('flat');
      expect(pos!.venue).toBe('hyperliquid');
      expect(pos!.symbol).toBe('BTC/USD:USD');

      await actor.stop();
    });

    it('returns rehydrated position for known instrument', async () => {
      const positionRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            venue: 'hyperliquid',
            symbol: 'ETH/USD:USD',
            side: 'short',
            size: '5',
            entryPrice: '3200',
            realizedPnl: '-100',
          },
        ]),
      };
      const actor = new AgentTradingActor(makeBaseDeps({ positionRepo: positionRepo as any }));
      await actor.start();

      const pos = actor.getPosition('ETH/USD:USD');
      expect(pos!.side).toBe('short');
      expect(pos!.size.toString()).toBe('5');
      expect(pos!.entryPrice.toString()).toBe('3200');

      await actor.stop();
    });

    it('ignores flat positions from rehydration', async () => {
      const positionRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            venue: 'hyperliquid',
            symbol: 'BTC/USD:USD',
            side: 'flat',
            size: '0',
            entryPrice: '0',
            realizedPnl: '0',
          },
        ]),
      };
      const actor = new AgentTradingActor(makeBaseDeps({ positionRepo: positionRepo as any }));
      await actor.start();

      // flat rows from DB are skipped — position returns flatPosition default
      const pos = actor.getPosition('BTC/USD:USD');
      expect(pos!.side).toBe('flat');

      await actor.stop();
    });

    it('tracks multiple instruments independently', async () => {
      const positionRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          { venue: 'hyperliquid', symbol: 'BTC/USD:USD', side: 'long', size: '1', entryPrice: '60000', realizedPnl: '0' },
          { venue: 'hyperliquid', symbol: 'ETH/USD:USD', side: 'short', size: '3', entryPrice: '3000', realizedPnl: '100' },
        ]),
      };
      const actor = new AgentTradingActor(makeBaseDeps({ positionRepo: positionRepo as any }));
      await actor.start();

      expect(actor.getPosition('BTC/USD:USD')!.side).toBe('long');
      expect(actor.getPosition('ETH/USD:USD')!.side).toBe('short');
      expect(actor.getPosition('SOL/USD:USD')!.side).toBe('flat');

      await actor.stop();
    });

    it('updates in-memory and persisted position from private stream fills', async () => {
      let privateHandlers: Record<string, ((event: any) => void) | undefined> = {};
      const positionRepo = {
        ...makeRepo(),
        upsert: vi.fn().mockResolvedValue(undefined),
      };
      const fillRepo = {
        ...makeRepo(),
        insertFill: vi.fn().mockResolvedValue(undefined),
      };
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'shadow',
        positionRepo: positionRepo as any,
        fillRepo: fillRepo as any,
        venueAdapterFactory: makeVenueAdapterFactory({
          orderbookAdapter: {
            venuePort: {
              fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49990'), ask: price('50010'), timestamp: new Date().toISOString() })),
              subscribePrivate: vi.fn().mockImplementation(async (handlers) => {
                privateHandlers = handlers;
                return ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() });
              }),
              fetchPositions: vi.fn(),
              fetchBalances: vi.fn(),
              fetchRecentFills: vi.fn(),
              fetchOpenOrders: vi.fn(),
            },
            credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: false },
            credentialId: 'cred-1',
          },
        }) as any,
      }));

      await actor.start();
      privateHandlers.onFill?.({
        orderId: 'order-1',
        venueRefId: 'venue-fill-1',
        symbol: 'BTC/USD:USD',
        side: 'buy',
        quantity: '2',
        price: '48000',
        fee: '1',
        feeCurrency: 'USD',
        filledAt: new Date().toISOString(),
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(actor.getPosition('BTC/USD:USD')!.side).toBe('long');
      expect(actor.getPosition('BTC/USD:USD')!.size.toString()).toBe('2');
      expect(fillRepo.insertFill).toHaveBeenCalled();
      expect(positionRepo.upsert).toHaveBeenCalled();

      await actor.stop();
    });

    it('updates in-memory and persisted position from private stream position updates', async () => {
      let privateHandlers: Record<string, ((event: any) => void) | undefined> = {};
      const positionRepo = {
        ...makeRepo(),
        upsert: vi.fn().mockResolvedValue(undefined),
      };
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'shadow',
        positionRepo: positionRepo as any,
        venueAdapterFactory: makeVenueAdapterFactory({
          orderbookAdapter: {
            venuePort: {
              fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49990'), ask: price('50010'), timestamp: new Date().toISOString() })),
              subscribePrivate: vi.fn().mockImplementation(async (handlers) => {
                privateHandlers = handlers;
                return ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() });
              }),
              fetchPositions: vi.fn(),
              fetchBalances: vi.fn(),
              fetchRecentFills: vi.fn(),
              fetchOpenOrders: vi.fn(),
            },
            credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: false },
            credentialId: 'cred-1',
          },
        }) as any,
      }));

      await actor.start();
      privateHandlers.onPositionUpdate?.({
        symbol: 'ETH/USD:USD',
        side: 'short',
        size: '3',
        entryPrice: '3200',
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(actor.getPosition('ETH/USD:USD')!.side).toBe('short');
      expect(actor.getPosition('ETH/USD:USD')!.size.toString()).toBe('3');
      expect(positionRepo.upsert).toHaveBeenCalled();

      await actor.stop();
    });

    it('uses resolved testnet flag when creating a stream pool handle', async () => {
      const createStreamPoolHandle = vi.fn().mockReturnValue(undefined);
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'shadow',
        createStreamPoolHandle,
        venueAdapterFactory: makeVenueAdapterFactory({
          orderbookAdapter: {
            venuePort: {
              fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49990'), ask: price('50010'), timestamp: new Date().toISOString() })),
              subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() })),
              fetchPositions: vi.fn(),
              fetchBalances: vi.fn(),
              fetchRecentFills: vi.fn(),
              fetchOpenOrders: vi.fn(),
            },
            credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: true },
            credentialId: 'cred-1',
          },
        }) as any,
      }));

      await actor.start();

      expect(createStreamPoolHandle).toHaveBeenCalledWith(true);

      await actor.stop();
    });
  });

  describe('paper mode restart — feed bootstrapping', () => {
    it('bootstraps a market data feed for a rehydrated open position on restart', async () => {
      const positionRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            venue: 'hyperliquid',
            symbol: 'BTC/USD:USD',
            side: 'long',
            size: '1.0',
            entryPrice: '90000',
            realizedPnl: '0',
            openedAt: new Date('2026-01-02T00:00:00Z'),
            stopLoss: '90000',
          },
        ]),
      };

      const actor = new AgentTradingActor(
        makeBaseDeps({ executionMode: 'paper', positionRepo: positionRepo as any }),
      );

      await actor.start();

      // Feed must have been bootstrapped for the rehydrated BTC position
      const feeds = (actor as any).instrumentFeeds as Map<string, unknown>;
      expect(feeds.has('BTC/USD:USD')).toBe(true);

      await actor.stop();
    });

    it('does not bootstrap feeds when there are no rehydrated open positions', async () => {
      const actor = new AgentTradingActor(makeBaseDeps({ executionMode: 'paper' }));

      await actor.start();

      const feeds = (actor as any).instrumentFeeds as Map<string, unknown>;
      expect(feeds.size).toBe(0);

      await actor.stop();
    });
  });

  describe('position rehydration', () => {
    it('rehydration failure is non-fatal — actor starts with empty positions', async () => {
      const positionRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockRejectedValue(new Error('DB connection error')),
      };
      const actor = new AgentTradingActor(makeBaseDeps({ positionRepo: positionRepo as any }));

      // Should not throw
      await expect(actor.start()).resolves.toBeUndefined();
      expect(actor.isRunning).toBe(true);

      const pos = actor.getPosition('BTC/USD:USD');
      expect(pos!.side).toBe('flat');

      await actor.stop();
    });
  });

  describe('exit-level lifecycle boundary', () => {
    it('does not rehydrate exit levels when position row has no stopLoss or takeProfit', async () => {
      // Position row without exit levels — must not populate exitLevels map
      const positionRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            venue: 'hyperliquid',
            symbol: 'BTC/USD:USD',
            side: 'long',
            size: '1.0',
            entryPrice: '90000',
            realizedPnl: '0',
            openedAt: new Date('2026-01-02T00:00:00Z'),
            stopLoss: null,
            takeProfit: null,
          },
        ]),
      };

      const actor = new AgentTradingActor(
        makeBaseDeps({ executionMode: 'paper', positionRepo: positionRepo as any }),
      );

      await actor.start();

      // No exit levels must have been set
      const exitLevels = (actor as any).exitLevels as Map<string, unknown>;
      expect(exitLevels.has('BTC/USD:USD')).toBe(false);

      await actor.stop();
    });

    it('rehydrates exit levels from position row stopLoss and takeProfit columns', async () => {
      const positionRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            venue: 'hyperliquid',
            symbol: 'BTC/USD:USD',
            side: 'long',
            size: '1.0',
            entryPrice: '90000',
            realizedPnl: '0',
            openedAt: new Date('2026-01-02T00:00:00Z'),
            stopLoss: '88000',
            takeProfit: '95000',
          },
        ]),
      };

      const actor = new AgentTradingActor(
        makeBaseDeps({ executionMode: 'paper', positionRepo: positionRepo as any }),
      );

      await actor.start();

      const exitLevels = (actor as any).exitLevels as Map<string, { stopLoss?: { toFixed(): string }; takeProfit?: { toFixed(): string } }>;
      expect(exitLevels.has('BTC/USD:USD')).toBe(true);
      expect(exitLevels.get('BTC/USD:USD')?.stopLoss?.toFixed()).toBe('88000');
      expect(exitLevels.get('BTC/USD:USD')?.takeProfit?.toFixed()).toBe('95000');

      await actor.stop();
    });

    it('persistPosition is called with stopLoss and takeProfit when decision carries exit levels', async () => {
      const positionRepo = {
        ...makeRepo(),
        upsert: vi.fn().mockResolvedValue(undefined),
      };

      const actor = new AgentTradingActor(
        makeBaseDeps({ executionMode: 'paper', positionRepo: positionRepo as any }),
      );

      await actor.start();

      const persistence = (actor as any).buildPersistence('BTC/USD:USD');

      // Simulate persistDecision carrying stopLoss + takeProfit
      await persistence.persistDecision({
        id: 'd-1',
        venueAccountId: 'va-1',
        instrumentId: 'BTC/USD:USD',
        intent: 'open_long',
        targetSize: quantity('1'),
        actorType: 'agent',
        actorId: 'agent-test-1',
        stopLoss: price('88000'),
        takeProfit: price('95000'),
      });

      // Simulate persistPosition for the resulting open position
      await persistence.persistPosition({
        venueAccountId: 'va-1',
        actorType: 'agent',
        actorId: 'agent-test-1',
        venue: 'hyperliquid',
        symbol: 'BTC/USD:USD',
        side: 'long',
        size: '1',
        entryPrice: '90000',
        realizedPnl: '0',
      });

      expect(positionRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ stopLoss: '88000', takeProfit: '95000' }),
      );

      await actor.stop();
    });

    it('persistPosition does NOT pass stopLoss when decision carries only takeProfit', async () => {
      const positionRepo = {
        ...makeRepo(),
        upsert: vi.fn().mockResolvedValue(undefined),
      };

      const actor = new AgentTradingActor(
        makeBaseDeps({ executionMode: 'paper', positionRepo: positionRepo as any }),
      );

      await actor.start();

      const persistence = (actor as any).buildPersistence('BTC/USD:USD');

      // Decision carries only takeProfit — no stopLoss
      await persistence.persistDecision({
        id: 'd-tp-only',
        venueAccountId: 'va-1',
        instrumentId: 'BTC/USD:USD',
        intent: 'open_long',
        targetSize: quantity('1'),
        actorType: 'agent',
        actorId: 'agent-test-1',
        takeProfit: price('95000'),
      });

      await persistence.persistPosition({
        venueAccountId: 'va-1',
        actorType: 'agent',
        actorId: 'agent-test-1',
        venue: 'hyperliquid',
        symbol: 'BTC/USD:USD',
        side: 'long',
        size: '1',
        entryPrice: '90000',
        realizedPnl: '0',
      });

      const callArg = positionRepo.upsert.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg).toEqual(expect.objectContaining({ takeProfit: '95000' }));
      expect('stopLoss' in callArg).toBe(false);

      await actor.stop();
    });

    it('persistPosition does NOT pass any exit fields when decision has no levels', async () => {
      const positionRepo = {
        ...makeRepo(),
        upsert: vi.fn().mockResolvedValue(undefined),
      };

      const actor = new AgentTradingActor(
        makeBaseDeps({ executionMode: 'paper', positionRepo: positionRepo as any }),
      );

      await actor.start();

      const persistence = (actor as any).buildPersistence('BTC/USD:USD');

      // Decision with no exit levels
      await persistence.persistDecision({
        id: 'd-no-levels',
        venueAccountId: 'va-1',
        instrumentId: 'BTC/USD:USD',
        intent: 'open_long',
        targetSize: quantity('1'),
        actorType: 'agent',
        actorId: 'agent-test-1',
      });

      await persistence.persistPosition({
        venueAccountId: 'va-1',
        actorType: 'agent',
        actorId: 'agent-test-1',
        venue: 'hyperliquid',
        symbol: 'BTC/USD:USD',
        side: 'long',
        size: '1',
        entryPrice: '90000',
        realizedPnl: '0',
      });

      const callArg = positionRepo.upsert.mock.calls[0]?.[0] as Record<string, unknown>;
      expect('stopLoss' in callArg).toBe(false);
      expect('takeProfit' in callArg).toBe(false);

      await actor.stop();
    });
  });

  describe('credential audit event', () => {
    it('emits credential-used event when credentialId is returned by factory', async () => {
      const journal = { append: vi.fn().mockResolvedValue(undefined) };
      const factory = makeVenueAdapterFactory({
        orderbookAdapter: {
          venuePort: {
            fetchTicker: vi.fn(),
            subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() })),
            fetchPositions: vi.fn(),
            fetchBalances: vi.fn(),
            fetchRecentFills: vi.fn(),
            fetchOpenOrders: vi.fn(),
          },
          credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: false },
          credentialId: 'cred-audit-1',
        },
      });

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        journal: journal as any,
        venueAdapterFactory: factory as any,
      }));
      await actor.start();

      // Wait for the async credential-used emit
      await new Promise((r) => setTimeout(r, 10));

      expect(journal.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'credential.used' }),
      );

      await actor.stop();
    });

    it('does not emit credential-used event in paper mode', async () => {
      const journal = { append: vi.fn().mockResolvedValue(undefined) };
      // In paper mode, factory returns no credentialId (no DB credential required)
      const factory = makeVenueAdapterFactory({
        orderbookAdapter: {
          venuePort: {
            fetchTicker: vi.fn(),
            subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() })),
            fetchPositions: vi.fn(),
            fetchBalances: vi.fn(),
            fetchRecentFills: vi.fn(),
            fetchOpenOrders: vi.fn(),
          },
          credentials: { apiKey: '', secret: '', walletAddress: '', testnet: false },
          credentialId: undefined,
        },
      });
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'paper',
        journal: journal as any,
        venueAdapterFactory: factory as any,
      }));
      await actor.start();

      await new Promise((r) => setTimeout(r, 10));

      // Paper mode factory returns no credentialId, so no credential-used event
      const credUsedCalls = (journal.append as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([entry]: [{ type: string }]) => entry.type === 'credential.used',
      );
      expect(credUsedCalls).toHaveLength(0);

      await actor.stop();
    });
  });

  describe('balance reconciliation seeding', () => {
    it('seeds initial balance snapshot on shadow startup when none exists', async () => {
      let seededBalance: object | null = null;
      const balanceSnapshotRepo = {
        getLatestByVenueAccount: vi.fn().mockImplementation(async () => seededBalance),
        insertSnapshot: vi.fn().mockImplementation(async (snap: { balances: Array<{ total: string }> }) => {
          seededBalance = { balances: snap.balances };
          return 'snap-1';
        }),
      };
      const reconciliationRepo = {
        ...makeRepo(),
        insert: vi.fn().mockResolvedValue(undefined),
        getLastReconciledAtForInstance: vi.fn().mockResolvedValue(null),
      };
      const venueBalances = [
        { asset: 'USDC', free: price('10000'), locked: price('0'), total: price('10000') },
      ];
      const venuePort = {
        getCapabilities: () => FULL_CAPABILITIES,
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49990'), ask: price('50010'), timestamp: new Date().toISOString() })),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: venueBalances, timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
      };
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'shadow',
        balanceSnapshotRepo: balanceSnapshotRepo as any,
        reconciliationRepo: reconciliationRepo as any,
        reconciliationConfig: { intervalMs: 60000, driftThresholdPct: 5, autoCorrect: false },
        venueAdapterFactory: makeVenueAdapterFactory({
          orderbookAdapter: {
            venuePort,
            credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: false },
            credentialId: 'cred-1',
          },
        }) as any,
      }));

      // Should NOT throw — seeding prevents false drift
      await actor.start();

      // Seeding should have been called
      expect(balanceSnapshotRepo.insertSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        venueAccountId: 'va-1',
        venue: 'hyperliquid',
      }));

      await actor.stop();
    });

    it('skips balance seeding when a snapshot already exists', async () => {
      const balanceSnapshotRepo = {
        getLatestByVenueAccount: vi.fn().mockResolvedValue({ balances: [{ asset: 'USDC', total: '5000' }] }),
        insertSnapshot: vi.fn().mockResolvedValue('snap-1'),
      };
      const reconciliationRepo = {
        ...makeRepo(),
        insert: vi.fn().mockResolvedValue(undefined),
        getLastReconciledAtForInstance: vi.fn().mockResolvedValue(null),
      };
      const venuePort = {
        getCapabilities: () => FULL_CAPABILITIES,
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49990'), ask: price('50010'), timestamp: new Date().toISOString() })),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [{ asset: 'USDC', free: price('5000'), locked: price('0'), total: price('5000') }], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
      };
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'shadow',
        balanceSnapshotRepo: balanceSnapshotRepo as any,
        reconciliationRepo: reconciliationRepo as any,
        reconciliationConfig: { intervalMs: 60000, driftThresholdPct: 5, autoCorrect: false },
        venueAdapterFactory: makeVenueAdapterFactory({
          orderbookAdapter: {
            venuePort,
            credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: false },
            credentialId: 'cred-1',
          },
        }) as any,
      }));

      await actor.start();

      // With existing snapshot: no seeding occurs. Reconciler is skipped entirely in
      // shadow mode, so persistResult never runs and insertSnapshot is never called.
      expect(balanceSnapshotRepo.insertSnapshot).toHaveBeenCalledTimes(0);

      await actor.stop();
    });
  });

  describe('incomplete plan recovery', () => {
    it('marks incomplete plans as failed in paper mode', async () => {
      const planRepo = {
        ...makeRepo(),
        getIncomplete: vi.fn().mockResolvedValue([
          { id: 'plan-1', status: 'executing' },
          { id: 'plan-2', status: 'pending' },
        ]),
        markFailed: vi.fn().mockResolvedValue(undefined),
        markCompleted: vi.fn().mockResolvedValue(undefined),
      };
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'paper',
        planRepo: planRepo as any,
      }));

      await actor.start();

      expect(planRepo.getIncomplete).toHaveBeenCalledWith('agent', 'agent-test-1');
      expect(planRepo.markFailed).toHaveBeenCalledTimes(2);
      expect(planRepo.markFailed).toHaveBeenCalledWith('plan-1');
      expect(planRepo.markFailed).toHaveBeenCalledWith('plan-2');

      await actor.stop();
    });

    it('reconciles incomplete plans against venue in shadow mode', async () => {
      const planRepo = {
        ...makeRepo(),
        getIncomplete: vi.fn().mockResolvedValue([
          { id: 'plan-filled', status: 'executing' },
          { id: 'plan-no-orders', status: 'executing' },
        ]),
        markFailed: vi.fn().mockResolvedValue(undefined),
        markCompleted: vi.fn().mockResolvedValue(undefined),
      };
      const orderRepo = {
        ...makeRepo(),
        getByExecutionPlanId: vi.fn().mockImplementation(async (planId: string) => {
          if (planId === 'plan-filled') return [{ venueRefId: 'venue-order-1' }];
          return [];
        }),
      };
      const venuePort = {
        getCapabilities: () => FULL_CAPABILITIES,
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49990'), ask: price('50010'), timestamp: new Date().toISOString() })),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([{ venueRefId: 'fill-1', orderId: 'venue-order-1', symbol: 'BTC/USD:USD', side: 'buy', quantity: '1', price: '50000', filledAt: new Date().toISOString() }])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
      };
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'shadow',
        planRepo: planRepo as any,
        orderRepo: orderRepo as any,
        venueAdapterFactory: makeVenueAdapterFactory({
          orderbookAdapter: {
            venuePort,
            credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: false },
            credentialId: 'cred-1',
          },
        }) as any,
      }));

      await actor.start();

      // plan-filled: has orders and matching fills on venue → marked completed
      expect(planRepo.markCompleted).toHaveBeenCalledWith('plan-filled');
      // plan-no-orders: no orders submitted → marked failed
      expect(planRepo.markFailed).toHaveBeenCalledWith('plan-no-orders');

      await actor.stop();
    });

    it('marks all plans failed when venue state is unreachable in shadow mode', async () => {
      const planRepo = {
        ...makeRepo(),
        getIncomplete: vi.fn().mockResolvedValue([
          { id: 'plan-1', status: 'executing' },
        ]),
        markFailed: vi.fn().mockResolvedValue(undefined),
        markCompleted: vi.fn().mockResolvedValue(undefined),
      };
      const venuePort = {
        getCapabilities: () => FULL_CAPABILITIES,
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49990'), ask: price('50010'), timestamp: new Date().toISOString() })),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue({ ok: false, error: { message: 'timeout' } }),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
      };
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'shadow',
        planRepo: planRepo as any,
        venueAdapterFactory: makeVenueAdapterFactory({
          orderbookAdapter: {
            venuePort,
            credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: false },
            credentialId: 'cred-1',
          },
        }) as any,
      }));

      await actor.start();

      expect(planRepo.markFailed).toHaveBeenCalledWith('plan-1');

      await actor.stop();
    });

    it('keeps plan executing when direct clientOrderId lookup finds an open venue order', async () => {
      const planRepo = {
        ...makeRepo(),
        getIncomplete: vi.fn().mockResolvedValue([
          { id: 'plan-client-lookup', status: 'executing' },
        ]),
        markFailed: vi.fn().mockResolvedValue(undefined),
        markCompleted: vi.fn().mockResolvedValue(undefined),
      };
      const orderRepo = {
        ...makeRepo(),
        getByExecutionPlanId: vi.fn().mockResolvedValue([
          { venueRefId: null, clientOrderId: 'client-lookup-1', symbol: 'BTC/USD:USD' },
        ]),
      };
      const venuePort = {
        getCapabilities: () => FULL_CAPABILITIES,
        fetchTicker: vi.fn().mockResolvedValue(ok({ last: price('50000'), bid: price('49990'), ask: price('50010'), timestamp: new Date().toISOString() })),
        subscribePrivate: vi.fn().mockResolvedValue(ok({ unsubscribe: vi.fn().mockResolvedValue(undefined), onStateChange: vi.fn() })),
        fetchPositions: vi.fn().mockResolvedValue(ok([])),
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        fetchRecentFills: vi.fn().mockResolvedValue(ok([])),
        fetchOpenOrders: vi.fn().mockResolvedValue(ok([])),
        fetchOrderByClientOrderId: vi.fn().mockResolvedValue(ok({
          venueRefId: 'venue-open-1',
          clientOrderId: 'client-lookup-1',
          symbol: 'BTC/USD:USD',
          side: 'buy',
          type: 'limit',
          status: 'open',
          quantity: '1',
          filledQuantity: '0',
          price: '50000',
          avgFillPrice: undefined,
          createdAt: new Date().toISOString(),
        })),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'shadow',
        planRepo: planRepo as any,
        orderRepo: orderRepo as any,
        venueAdapterFactory: makeVenueAdapterFactory({
          orderbookAdapter: {
            venuePort,
            credentials: { apiKey: 'k', secret: 's', walletAddress: '', testnet: false },
            credentialId: 'cred-1',
          },
        }) as any,
      }));

      await actor.start();

      expect(venuePort.fetchOrderByClientOrderId).toHaveBeenCalledWith('client-lookup-1', 'BTC/USD:USD');
      expect(planRepo.markFailed).not.toHaveBeenCalledWith('plan-client-lookup');
      expect(planRepo.markCompleted).not.toHaveBeenCalledWith('plan-client-lookup');

      await actor.stop();
    });

    it('halts live swap intake when incomplete swap plan cannot be confirmed on-chain', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const planRepo = {
        ...makeRepo(),
        getIncomplete: vi.fn().mockResolvedValue([
          { id: 'plan-swap-ambiguous', status: 'executing' },
        ]),
        markFailed: vi.fn().mockResolvedValue(undefined),
        markCompleted: vi.fn().mockResolvedValue(undefined),
      };
      const orderRepo = {
        ...makeRepo(),
        getByExecutionPlanId: vi.fn().mockResolvedValue([
          { id: 'ord-swap-1', venueRefId: null, status: 'pending', symbol: 'SOL/USDC' },
        ]),
      };
      const swapVenue = {
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        quote: vi.fn(),
        fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        venue: 'jupiter',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        journal: { append: journalAppend } as any,
        planRepo: planRepo as any,
        orderRepo: orderRepo as any,
        venueAdapterFactory: makeVenueAdapterFactory({
          swapAdapter: {
            swapVenue,
            walletAddress: 'wallet-xyz',
            signerPresent: true,
          },
        }) as any,
      }));

      await actor.start();

      expect(planRepo.markFailed).not.toHaveBeenCalledWith('plan-swap-ambiguous');
      expect(planRepo.markCompleted).not.toHaveBeenCalledWith('plan-swap-ambiguous');

      const recoveryFailure = journalAppend.mock.calls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === 'execution.failure'
          && ((c[0] as { payload: Record<string, unknown> }).payload.reason === 'live_swap_recovery_ambiguous'),
      );
      expect(recoveryFailure).toBeDefined();

      const intake = actor.getIntakeDeps('SOL/USDC');
      expect(intake).toMatchObject({
        rejected: true,
        code: 'swap_recovery_ambiguous',
      });

      await actor.stop();
    });
  });

  describe('swap timeout recovery and quality alerts', () => {
    it('halts swap intake when live confirmation timeout requires manual recovery', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const staleSubmittedAt = new Date(Date.now() - 5 * 60 * 1000);
      const orderRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            id: 'ord-stale-swap',
            venueAccountId: 'va-1',
            actorType: 'agent',
            actorId: 'agent-test-1',
            executionPlanId: 'plan-stale-swap',
            venueRefId: null,
            clientOrderId: 'agent:swap:1',
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
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        quote: vi.fn(),
        fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        venue: 'jupiter',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        journal: { append: journalAppend } as any,
        orderRepo: orderRepo as any,
        liveOrderTimeoutPolicy: { limitOrderTimeoutMs: 60_000, marketOrderTimeoutMs: 30_000 },
        venueAdapterFactory: makeVenueAdapterFactory({
          swapAdapter: {
            swapVenue,
            walletAddress: 'wallet-xyz',
            signerPresent: true,
          },
        }) as any,
      }));

      await actor.start();
      await (actor as any).enforceLiveOrderTimeouts();

      const timeoutFailure = journalAppend.mock.calls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'execution.failure'
          && ((call[0] as { payload: Record<string, unknown> }).payload.reason === 'live_swap_confirmation_timeout_recovery_required'),
      );
      expect(timeoutFailure).toBeDefined();

      const intake = actor.getIntakeDeps('SOL/USDC');
      expect(intake).toMatchObject({
        rejected: true,
        code: 'swap_recovery_ambiguous',
      });

      await actor.stop();
    });

    it('emits live swap slippage alert when threshold is exceeded', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const orderRepo = {
        ...makeRepo(),
        getByVenueRefId: vi.fn().mockResolvedValue({
          id: 'ord-swap-alert',
          referencePrice: '100',
        }),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        venue: 'jupiter',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
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

    it('emits live orderbook slippage alert when threshold is exceeded', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const orderRepo = {
        ...makeRepo(),
        getByVenueRefId: vi.fn().mockResolvedValue({
          id: 'ord-orderbook-alert',
          referencePrice: '100',
        }),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        venue: 'hyperliquid',
        venueType: 'orderbook',
        orderRepo: orderRepo as any,
        journal: { append: journalAppend } as any,
        slippageAlertBps: 20,
      }));

      await (actor as any).maybeEmitLiveSlippageAlert({
        orderId: 'orderbook-ref-1',
        venueRefId: 'orderbook-ref-1',
        symbol: 'BTC/USD:USD',
        side: 'buy',
        price: '105',
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

    it('does not emit live orderbook slippage alert below threshold', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const orderRepo = {
        ...makeRepo(),
        getByVenueRefId: vi.fn().mockResolvedValue({
          id: 'ord-orderbook-no-alert',
          referencePrice: '100',
        }),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        venue: 'hyperliquid',
        venueType: 'orderbook',
        orderRepo: orderRepo as any,
        journal: { append: journalAppend } as any,
        slippageAlertBps: 20,
      }));

      await (actor as any).maybeEmitLiveSlippageAlert({
        orderId: 'orderbook-ref-2',
        venueRefId: 'orderbook-ref-2',
        symbol: 'BTC/USD:USD',
        side: 'buy',
        price: '100.1',
      });

      const slippageEvent = journalAppend.mock.calls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'live.slippage_alert',
      );
      expect(slippageEvent).toBeUndefined();
    });
  });

  describe('openPositionCount enforcement', () => {
    it('provides aggregate open position count in intake deps', async () => {
      const positionRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          { venue: 'hyperliquid', symbol: 'BTC/USD:USD', side: 'long', size: '1', entryPrice: '50000', realizedPnl: '0' },
          { venue: 'hyperliquid', symbol: 'ETH/USD:USD', side: 'short', size: '10', entryPrice: '3000', realizedPnl: '0' },
        ]),
      };
      const actor = new AgentTradingActor(makeBaseDeps({ positionRepo: positionRepo as any }));
      await actor.start();

      const deps = actor.getIntakeDeps('SOL/USD:USD');
      expect(deps).toBeDefined();
      // Agent holds 2 open positions — intake deps should reflect this
      expect(deps!.openPositionCount).toBe(2);

      await actor.stop();
    });
  });

  describe('circuit breaker typed rejection', () => {
    it('returns circuit_breaker_open rejection when breaker is tripped', async () => {
      const actor = new AgentTradingActor(makeBaseDeps({
        maxConsecutiveVenueErrors: 2,
      }));
      await actor.start();

      // Trip the circuit breaker
      actor.recordExecutionOutcome(false);
      actor.recordExecutionOutcome(false);

      const result = actor.getIntakeDeps('BTC/USD:USD');
      expect(result).toBeDefined();
      expect(result).toHaveProperty('rejected', true);
      expect(result).toHaveProperty('code', 'circuit_breaker_open');
      expect(result).toHaveProperty('retryable', false);

      await actor.stop();
    });

    it('returns normal intake deps when breaker is not tripped', async () => {
      const actor = new AgentTradingActor(makeBaseDeps({
        maxConsecutiveVenueErrors: 5,
      }));
      await actor.start();

      actor.recordExecutionOutcome(false); // 1 error, threshold is 5

      const result = actor.getIntakeDeps('BTC/USD:USD');
      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('rejected');
      expect(result).toHaveProperty('actorType', 'agent');

      await actor.stop();
    });
  });

  describe('stop-loss typed rejection', () => {
    it('returns stop_loss_active when isStopLossTriggered returns true', async () => {
      const positionRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          { venue: 'hyperliquid', symbol: 'BTC/USD:USD', side: 'long', size: '1', entryPrice: '50000', realizedPnl: '0' },
        ]),
      };
      const actor = new AgentTradingActor(makeBaseDeps({
        positionRepo: positionRepo as any,
        riskLimits: {
          maxPositionSize: quantity('100'),
          maxOpenPositions: 5,
          maxDrawdown: price('10000'),
          stopLossMaxUnrealizedLossPct: 1,
        },
        capital: '10000',
      }));
      await actor.start();

      // Spy on isStopLossTriggered to force it to return true
      vi.spyOn(actor as any, 'isStopLossTriggered').mockReturnValue(true);

      const result = actor.getIntakeDeps('BTC/USD:USD');
      expect(result).toBeDefined();
      expect(result).toHaveProperty('rejected', true);
      expect(result).toHaveProperty('code', 'stop_loss_active');
      expect(result).toHaveProperty('retryable', false);

      await actor.stop();
    });
  });

  describe('stop-loss go_flat position cleanup', () => {
    it('removes flat position from map after stop-loss, reducing openPositionCount', async () => {
      const positionRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          { venue: 'hyperliquid', symbol: 'BTC/USD:USD', side: 'long', size: '1', entryPrice: '50000', realizedPnl: '0' },
          { venue: 'hyperliquid', symbol: 'ETH/USD:USD', side: 'short', size: '10', entryPrice: '3000', realizedPnl: '0' },
        ]),
      };
      const actor = new AgentTradingActor(makeBaseDeps({
        positionRepo: positionRepo as any,
      }));
      await actor.start();

      // Verify initial count is 2
      const depsBefore = actor.getIntakeDeps('SOL/USD:USD');
      expect(depsBefore).toHaveProperty('openPositionCount', 2);

      // Simulate a stop-loss flattening BTC/USD:USD by directly manipulating positions
      // (the actual executeAgentStopLoss is private; we test the contract via the map)
      (actor as any).positions.delete('BTC/USD:USD');

      const depsAfter = actor.getIntakeDeps('SOL/USD:USD');
      expect(depsAfter).toHaveProperty('openPositionCount', 1);

      await actor.stop();
    });
  });

  describe('swap confirmation poller recovery', () => {
    it('confirms pending swap via confirmation poller on runtime timeout check', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const staleSubmittedAt = new Date(Date.now() - 5 * 60 * 1000);
      const confirmedAt = new Date(staleSubmittedAt.getTime() + 15_000).toISOString();
      const orderRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            id: 'ord-poller-confirm',
            venueAccountId: 'va-1',
            actorType: 'agent',
            actorId: 'agent-test-1',
            executionPlanId: 'plan-poller-confirm',
            venueRefId: 'tx-hash-confirmed',
            clientOrderId: 'agent:swap:1',
            venue: 'jupiter',
            symbol: 'SOL/USDC',
            side: 'buy',
            type: 'swap',
            quantity: '10',
            price: null,
            referencePrice: '150',
            status: 'pending',
            submissionState: 'venue_acknowledged',
            submitAttemptedAt: staleSubmittedAt,
            acknowledgedAt: null,
            filledQuantity: '0',
            avgFillPrice: null,
            createdAt: staleSubmittedAt,
          },
        ]),
        upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
        getByVenueRefId: vi.fn().mockResolvedValue({ id: 'ord-poller-confirm', referencePrice: '150' }),
      };
      const fillRepo = {
        ...makeRepo(),
        insertFill: vi.fn().mockResolvedValue(undefined),
      };
      const confirmationPoller = {
        checkConfirmation: vi.fn().mockResolvedValue(ok({ confirmed: true, blockNumber: 100, timestamp: confirmedAt })),
      };
      const swapVenue = {
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        quote: vi.fn(),
        fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        venue: 'jupiter',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        journal: { append: journalAppend } as any,
        orderRepo: orderRepo as any,
        fillRepo: fillRepo as any,
        liveOrderTimeoutPolicy: { limitOrderTimeoutMs: 60_000, marketOrderTimeoutMs: 30_000 },
        swapConfirmationPoller: confirmationPoller as any,
        venueAdapterFactory: makeVenueAdapterFactory({
          swapAdapter: {
            swapVenue,
            walletAddress: 'wallet-xyz',
            signerPresent: true,
            confirmationPoller,
          },
        }) as any,
      }));

      await actor.start();
      await (actor as any).enforceLiveOrderTimeouts();

      // Poller was called with the tx hash
      expect(confirmationPoller.checkConfirmation).toHaveBeenCalledWith('tx-hash-confirmed');
      // Order was finalized as filled
      expect(orderRepo.upsertByVenueRefId).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'filled', submissionState: 'terminal' }),
      );
      // Timestamp precedence: submitAttemptedAt is preferred over poller's confirmedAt
      expect(fillRepo.insertFill).toHaveBeenCalledWith(expect.objectContaining({
        orderId: 'ord-poller-confirm',
        filledAt: staleSubmittedAt,
      }));
      // Should NOT halt recovery
      const intake = actor.getIntakeDeps('SOL/USDC');
      expect(intake).not.toMatchObject({ rejected: true, code: 'swap_recovery_ambiguous' });

      await actor.stop();
    });

    it('halts when confirmation poller says not confirmed and timeout exceeded', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const staleSubmittedAt = new Date(Date.now() - 5 * 60 * 1000);
      const orderRepo = {
        ...makeRepo(),
        getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([
          {
            id: 'ord-poller-unconfirmed',
            venueAccountId: 'va-1',
            actorType: 'agent',
            actorId: 'agent-test-1',
            executionPlanId: 'plan-poller-unconfirmed',
            venueRefId: 'tx-hash-pending',
            clientOrderId: 'agent:swap:2',
            venue: 'jupiter',
            symbol: 'SOL/USDC',
            side: 'buy',
            type: 'swap',
            quantity: '10',
            price: null,
            referencePrice: '150',
            status: 'pending',
            submissionState: 'venue_acknowledged',
            submitAttemptedAt: staleSubmittedAt,
            acknowledgedAt: null,
            filledQuantity: '0',
            avgFillPrice: null,
            createdAt: staleSubmittedAt,
          },
        ]),
        upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
      };
      const confirmationPoller = {
        checkConfirmation: vi.fn().mockResolvedValue(ok({ confirmed: false })),
      };
      const swapVenue = {
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        quote: vi.fn(),
        fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        venue: 'jupiter',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        journal: { append: journalAppend } as any,
        orderRepo: orderRepo as any,
        liveOrderTimeoutPolicy: { limitOrderTimeoutMs: 60_000, marketOrderTimeoutMs: 30_000 },
        swapConfirmationPoller: confirmationPoller as any,
        venueAdapterFactory: makeVenueAdapterFactory({
          swapAdapter: {
            swapVenue,
            walletAddress: 'wallet-xyz',
            signerPresent: true,
            confirmationPoller,
          },
        }) as any,
      }));

      await actor.start();
      await (actor as any).enforceLiveOrderTimeouts();

      // Should halt — poller says not confirmed and timeout exceeded
      const intake = actor.getIntakeDeps('SOL/USDC');
      expect(intake).toMatchObject({ rejected: true, code: 'swap_recovery_ambiguous' });

      await actor.stop();
    });

    it('uses confirmation poller on startup to confirm incomplete swap plan', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const planRepo = {
        ...makeRepo(),
        getIncomplete: vi.fn().mockResolvedValue([
          { id: 'plan-startup-poller', status: 'executing', plannedOrders: [], createdAt: new Date() },
        ]),
        markCompleted: vi.fn().mockResolvedValue(undefined),
        markFailed: vi.fn().mockResolvedValue(undefined),
      };
      const orderRepo = {
        ...makeRepo(),
        getByExecutionPlanId: vi.fn().mockResolvedValue([
          { id: 'ord-startup-1', venueRefId: 'tx-hash-startup-confirmed', status: 'pending', symbol: 'SOL/USDC' },
        ]),
      };
      const confirmationPoller = {
        checkConfirmation: vi.fn().mockResolvedValue(ok({ confirmed: true, blockNumber: 200 })),
      };
      const swapVenue = {
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        quote: vi.fn(),
        fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        venue: 'jupiter',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        journal: { append: journalAppend } as any,
        planRepo: planRepo as any,
        orderRepo: orderRepo as any,
        swapConfirmationPoller: confirmationPoller as any,
        venueAdapterFactory: makeVenueAdapterFactory({
          swapAdapter: {
            swapVenue,
            walletAddress: 'wallet-xyz',
            signerPresent: true,
            confirmationPoller,
          },
        }) as any,
      }));

      await actor.start();

      // Poller was called with the tx hash during startup recovery
      expect(confirmationPoller.checkConfirmation).toHaveBeenCalledWith('tx-hash-startup-confirmed');
      // Plan was marked completed
      expect(planRepo.markCompleted).toHaveBeenCalledWith('plan-startup-poller');
      // Should NOT halt
      const intake = actor.getIntakeDeps('SOL/USDC');
      expect(intake).not.toMatchObject({ rejected: true, code: 'swap_recovery_ambiguous' });

      await actor.stop();
    });

    it('halts when startup confirmation poller returns not confirmed for incomplete swap plan', async () => {
      const journalAppend = vi.fn().mockResolvedValue(undefined);
      const planRepo = {
        ...makeRepo(),
        getIncomplete: vi.fn().mockResolvedValue([
          { id: 'plan-startup-not-confirmed', status: 'executing', plannedOrders: [], createdAt: new Date() },
        ]),
        markCompleted: vi.fn().mockResolvedValue(undefined),
        markFailed: vi.fn().mockResolvedValue(undefined),
      };
      const orderRepo = {
        ...makeRepo(),
        getByExecutionPlanId: vi.fn().mockResolvedValue([
          { id: 'ord-startup-2', venueRefId: 'tx-hash-not-found', status: 'pending', symbol: 'SOL/USDC' },
        ]),
      };
      const confirmationPoller = {
        checkConfirmation: vi.fn().mockResolvedValue(ok({ confirmed: false })),
      };
      const swapVenue = {
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        quote: vi.fn(),
        fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        venue: 'jupiter',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        journal: { append: journalAppend } as any,
        planRepo: planRepo as any,
        orderRepo: orderRepo as any,
        swapConfirmationPoller: confirmationPoller as any,
        venueAdapterFactory: makeVenueAdapterFactory({
          swapAdapter: {
            swapVenue,
            walletAddress: 'wallet-xyz',
            signerPresent: true,
            confirmationPoller,
          },
        }) as any,
      }));

      await actor.start();

      // Plan was NOT marked completed
      expect(planRepo.markCompleted).not.toHaveBeenCalledWith('plan-startup-not-confirmed');
      // Should halt
      const intake = actor.getIntakeDeps('SOL/USDC');
      expect(intake).toMatchObject({ rejected: true, code: 'swap_recovery_ambiguous' });

      await actor.stop();
    });

    it('marks incomplete swap plans failed and rejects pending orders when the confirmation poller reports a reverted tx', async () => {
      const planRepo = {
        ...makeRepo(),
        getIncomplete: vi.fn().mockResolvedValue([
          { id: 'plan-startup-failed', status: 'executing', plannedOrders: [], createdAt: new Date() },
        ]),
        markCompleted: vi.fn().mockResolvedValue(undefined),
        markFailed: vi.fn().mockResolvedValue(undefined),
      };
      const orderRepo = {
        ...makeRepo(),
        getByExecutionPlanId: vi.fn().mockResolvedValue([
          { id: 'ord-startup-failed', venueRefId: 'tx-hash-failed', status: 'pending', symbol: 'SOL/USDC' },
        ]),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      };
      const confirmationPoller = {
        checkConfirmation: vi.fn().mockResolvedValue(ok({ confirmed: false, failed: true })),
      };
      const swapVenue = {
        fetchBalances: vi.fn().mockResolvedValue(ok({ balances: [], timestamp: new Date().toISOString() })),
        quote: vi.fn(),
        fetchRecentTransactions: vi.fn().mockResolvedValue(ok([])),
      };

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'live',
        venue: 'jupiter',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
        planRepo: planRepo as any,
        orderRepo: orderRepo as any,
        swapConfirmationPoller: confirmationPoller as any,
        venueAdapterFactory: makeVenueAdapterFactory({
          swapAdapter: {
            swapVenue,
            walletAddress: 'wallet-xyz',
            signerPresent: true,
            confirmationPoller,
          },
        }) as any,
      }));

      await actor.start();

      expect(confirmationPoller.checkConfirmation).toHaveBeenCalledWith('tx-hash-failed');
      expect(orderRepo.updateStatus).toHaveBeenCalledWith('ord-startup-failed', 'rejected');
      expect(planRepo.markFailed).toHaveBeenCalledWith('plan-startup-failed');

      await actor.stop();
    });
  });

  describe('technical scan enrichment', () => {
    it('forwards technical scan results before emitting a scanner wake', async () => {
      const callOrder: string[] = [];
      const onTechnicalScanComplete = vi.fn().mockImplementation(async () => {
        callOrder.push('scan');
      });
      const emitAgentWake = vi.fn().mockImplementation(async () => {
        callOrder.push('wake');
      });

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'paper',
        technicalConfig: {
          filters: { venue: 'hyperliquid', venueType: 'orderbook' },
          indicators: {
            rsi: { enabled: true, period: 14, healthyMin: 40, healthyMax: 70, overbought: 80, weakBelow: 30 },
            macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
            volume: { enabled: true, strongRatio: 1.5, weakRatio: 0.5, recentBars: 4, avgBars: 20 },
            choch: { enabled: false, swingLookback: 5, minSwingPct: 0.01, minSwings: 4, confirmBars: 2, rejectOnBearish: false },
            supportResistance: { enabled: false, lookback: 50, breakoutThreshold: 0.005 },
            confidence: {
              rsiWeight: 0.15,
              macdCrossoverWeight: 0.20,
              macdIncreasingWeight: 0.10,
              volumeWeight: 0.15,
              breakoutWeight: 0.15,
              chochBullishWeight: 0.15,
              chochBearishPenalty: 0.10,
              priceActionWeight: 0.10,
              minConfidence: 0.45,
              minReasons: 2,
            },
          },
          candles: { interval: '15m', limit: 100 },
          signalBias: 'trend-following',
          scanIntervalMs: 60_000,
          scanBatchSize: 5,
        },
        discoverCandidates: vi.fn().mockResolvedValue([]),
        fetchCandles: vi.fn().mockResolvedValue(
          Array.from({ length: 100 }, (_, index) => ({
            timestamp: new Date(Date.now() - (100 - index) * 60_000).toISOString(),
            open: 100 + index * 5,
            high: 105 + index * 5,
            low: 99 + index * 5,
            close: 104 + index * 5,
            volume: 2000 + index * 50,
          })),
        ),
        onTechnicalScanComplete,
        emitAgentWake,
        isHybridMode: true,
      }));

      await actor.start();
      (actor as any).positions.set('BTC', {
        venue: 'hyperliquid',
        symbol: 'BTC',
        side: 'long',
        size: { toString: () => '1' },
        entryPrice: { toString: () => '100' },
        realizedPnl: { toString: () => '0' },
      });
      await (actor as any).runTechnicalScan();

      expect(onTechnicalScanComplete).toHaveBeenCalledOnce();
      expect(emitAgentWake).toHaveBeenCalledOnce();
      expect(callOrder).toEqual(['scan', 'wake']);

      await actor.stop();
    });

    it('does not emit a scanner wake when forwarding technical scan results fails', async () => {
      const onTechnicalScanComplete = vi.fn().mockRejectedValue(new Error('forward failed'));
      const emitAgentWake = vi.fn().mockResolvedValue(undefined);

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'paper',
        technicalConfig: {
          filters: { venue: 'hyperliquid', venueType: 'orderbook' },
          indicators: {
            rsi: { enabled: true, period: 14, healthyMin: 40, healthyMax: 70, overbought: 80, weakBelow: 30 },
            macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
            volume: { enabled: true, strongRatio: 1.5, weakRatio: 0.5, recentBars: 4, avgBars: 20 },
            choch: { enabled: false, swingLookback: 5, minSwingPct: 0.01, minSwings: 4, confirmBars: 2, rejectOnBearish: false },
            supportResistance: { enabled: false, lookback: 50, breakoutThreshold: 0.005 },
            confidence: {
              rsiWeight: 0.15,
              macdCrossoverWeight: 0.20,
              macdIncreasingWeight: 0.10,
              volumeWeight: 0.15,
              breakoutWeight: 0.15,
              chochBullishWeight: 0.15,
              chochBearishPenalty: 0.10,
              priceActionWeight: 0.10,
              minConfidence: 0.45,
              minReasons: 2,
            },
          },
          candles: { interval: '15m', limit: 100 },
          signalBias: 'trend-following',
          scanIntervalMs: 60_000,
          scanBatchSize: 5,
        },
        discoverCandidates: vi.fn().mockResolvedValue([]),
        fetchCandles: vi.fn().mockResolvedValue(
          Array.from({ length: 100 }, (_, index) => ({
            timestamp: new Date(Date.now() - (100 - index) * 60_000).toISOString(),
            open: 100 + index * 5,
            high: 105 + index * 5,
            low: 99 + index * 5,
            close: 104 + index * 5,
            volume: 2000 + index * 50,
          })),
        ),
        onTechnicalScanComplete,
        emitAgentWake,
        isHybridMode: true,
      }));

      await actor.start();
      (actor as any).positions.set('BTC', {
        venue: 'hyperliquid',
        symbol: 'BTC',
        side: 'long',
        size: { toString: () => '1' },
        entryPrice: { toString: () => '100' },
        realizedPnl: { toString: () => '0' },
      });

      await (actor as any).runTechnicalScan();

      expect(onTechnicalScanComplete).toHaveBeenCalledOnce();
      expect(emitAgentWake).not.toHaveBeenCalled();

      await actor.stop();
    });

    it('calls onTechnicalScanComplete with scan results after a successful scan', async () => {
      const onTechnicalScanComplete = vi.fn().mockResolvedValue(undefined);

      const discoverCandidates = vi.fn().mockResolvedValue([
        { symbol: 'ETH-PERP', instrumentId: 'ETH-PERP', volume24hUsd: 1_000_000 },
      ]);

      const fetchCandles = vi.fn().mockResolvedValue(
        Array.from({ length: 50 }, (_, i) => ({
          time: Date.now() - i * 60_000,
          open: 1800,
          high: 1850,
          low: 1780,
          close: 1820,
          volume: 500,
        })),
      );

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'paper',
        technicalConfig: {
          scanIntervalMs: 60_000,
          scanBatchSize: 5,
          filters: {},
          candles: { interval: '1h', limit: 50 },
          indicators: {},
          signalBias: 'trend-following',
        },
        discoverCandidates,
        fetchCandles,
        onTechnicalScanComplete,
      }));

      await actor.start();

      // Run the scan directly
      await (actor as any).runTechnicalScan();

      expect(onTechnicalScanComplete).toHaveBeenCalledOnce();
      const [calledAgentId, calledScan] = onTechnicalScanComplete.mock.calls[0]!;
      expect(calledAgentId).toBe('agent-test-1');
      expect(typeof calledScan.timestamp).toBe('string');
      expect(calledScan.scanIntervalMs).toBe(60_000);
      expect(Array.isArray(calledScan.signals)).toBe(true);
      expect(calledScan.summary).toBeDefined();

      // getLastTechnicalScan reflects the stored result
      expect(actor.getLastTechnicalScan()).toBeDefined();
      expect(actor.getLastTechnicalScan()?.summary).toEqual(calledScan.summary);

      await actor.stop();
    });

    it('does not call onTechnicalScanComplete when technicalConfig is absent', async () => {
      const onTechnicalScanComplete = vi.fn();

      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'paper',
        onTechnicalScanComplete,
      }));

      await actor.start();

      expect(onTechnicalScanComplete).not.toHaveBeenCalled();
      expect(actor.getLastTechnicalScan()).toBeUndefined();

      await actor.stop();
    });
  });
});
