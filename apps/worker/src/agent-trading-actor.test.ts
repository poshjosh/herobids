import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentTradingActor } from './agent-trading-actor.js';
import type { AgentTradingActorDeps } from './agent-trading-actor.js';
import { price, quantity, ok } from '@herobids/domain';
import { PaperExecutor, ShadowExecutor, LiveExecutor } from '@herobids/engine';
import type { OrderId, FillId } from '@herobids/domain';

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

    it('throws for swap venues when swapAssets metadata is missing', async () => {
      const factory = makeVenueAdapterFactory();
      const actor = new AgentTradingActor(makeBaseDeps({
        executionMode: 'shadow',
        venueType: 'swap',
        venue: 'jupiter',
        swapAssets: undefined,
        venueAdapterFactory: factory as any,
      }));

      await expect(actor.start()).rejects.toThrow('requires explicit swapAssets metadata');
      expect(factory.buildSwapAdapter).not.toHaveBeenCalled();
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

      // With existing snapshot: no seeding occurs. Only 1 call from persistResult promotion.
      // If seeding had occurred, there would be 2 calls (seed + promotion).
      expect(balanceSnapshotRepo.insertSnapshot).toHaveBeenCalledTimes(1);

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
});
