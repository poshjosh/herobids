import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentIntakeResolver } from './agent-intake-resolver.js';

describe('AgentIntakeResolver', () => {
  function makeDeps(overrides: Record<string, unknown> = {}) {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([
        {
          sourceVenueAccountId: 'va-1',
          provider: 'hyperliquid',
          venueAccountVenue: 'hyperliquid',
          venueAccountId: 'va-1',
          connectionStatus: 'active',
        },
      ]),
    };

    const positionRepo = {
      getOpenByActor: vi.fn().mockResolvedValue([]),
      getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined),
    };

    const agentRepo = {
      getAgent: vi.fn().mockResolvedValue({ id: 'agent-1', capital: '250', dailyLossLimit: '75' }),
    };

    const decisionRepo = {
      insertDecision: vi.fn().mockResolvedValue(undefined),
    };

    const planRepo = {
      insertPlan: vi.fn().mockResolvedValue(undefined),
      markExecuting: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };

    const fillRepo = {
      insertFill: vi.fn().mockResolvedValue(undefined),
    };

    const orderRepo = {
      upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
    };

    const balanceSnapshotRepo = {
      getLatestByVenueAccount: vi.fn().mockResolvedValue(null),
    };

    const backtestingRepo = {
      insertDecisionContext: vi.fn().mockResolvedValue(undefined),
    };

    const journal = {
      append: vi.fn(),
    };

    const markSource = {
      fetchMark: vi.fn().mockResolvedValue({
        ok: true,
        data: { price: '50000', source: 'oracle', instrument: 'BTC/USD:USD', timestamp: '2026-06-12T14:00:00Z' },
      }),
    };

    const idGen = {
      orderId: () => 'order-1',
      fillId: () => 'fill-1',
      planId: () => 'plan-1',
    };

    return {
      deps: {
        db: db as any,
        agentRepo: agentRepo as any,
        positionRepo: positionRepo as any,
        decisionRepo: decisionRepo as any,
        planRepo: planRepo as any,
        fillRepo: fillRepo as any,
        orderRepo: orderRepo as any,
        balanceSnapshotRepo: balanceSnapshotRepo as any,
        backtestingRepo: backtestingRepo as any,
        journal: journal as any,
        markSource: markSource as any,
        idGen: idGen as any,
        ...overrides,
      },
      mocks: { db, agentRepo, positionRepo, markSource, journal },
    };
  }

  describe('getIntakeDeps', () => {
    it('resolves intake deps from active trading grant', async () => {
      const { deps } = makeDeps();
      const resolver = new AgentIntakeResolver(deps);

      const result = await resolver.getIntakeDeps('agent-1', 'BTC/USD:USD');

      expect(result).toBeDefined();
      expect(result!.actorType).toBe('agent');
      expect(result!.actorId).toBe('agent-1');
      expect(result!.venue).toBe('hyperliquid');
      expect(result!.symbol).toBe('BTC/USD:USD');
      expect(result!.venueAccountId).toBe('va-1');
    });

    it('returns undefined when no active grant exists', async () => {
      const { deps, mocks } = makeDeps();
      mocks.db.limit.mockResolvedValue([]);
      const resolver = new AgentIntakeResolver(deps);

      const result = await resolver.getIntakeDeps('agent-1', 'BTC/USD:USD');

      expect(result).toBeUndefined();
    });

    it('returns undefined when binding has no venue account reference', async () => {
      const { deps, mocks } = makeDeps();
      mocks.db.limit.mockResolvedValue([
        { sourceVenueAccountId: null, provider: 'hyperliquid', venueAccountVenue: null, venueAccountId: null },
      ]);
      const resolver = new AgentIntakeResolver(deps);

      const result = await resolver.getIntakeDeps('agent-1', 'BTC/USD:USD');

      expect(result).toBeUndefined();
    });

    it('includes aggregate openPositionCount for multi-instrument risk checks', async () => {
      const { deps, mocks } = makeDeps();
      mocks.positionRepo.getOpenByActorAndVenueAccount.mockResolvedValue([
        { venue: 'hyperliquid', symbol: 'BTC/USD:USD', side: 'long', size: '1', entryPrice: '50000', realizedPnl: '0' },
        { venue: 'hyperliquid', symbol: 'ETH/USD:USD', side: 'short', size: '2', entryPrice: '2500', realizedPnl: '0' },
        { venue: 'hyperliquid', symbol: 'SOL/USD:USD', side: 'flat', size: '0', entryPrice: '0', realizedPnl: '0' },
      ]);
      const resolver = new AgentIntakeResolver(deps);

      const result = await resolver.getIntakeDeps('agent-1', 'BTC/USD:USD');

      expect(result?.openPositionCount).toBe(2);
    });

    it('derives fallback risk limits from the agent profile instead of permissive hardcoded values', async () => {
      const { deps } = makeDeps();
      const resolver = new AgentIntakeResolver(deps);

      const result = await resolver.getIntakeDeps('agent-1', 'BTC/USD:USD');

      expect(result?.riskLimits.maxPositionSize.toString()).toBe('250');
      expect(result?.riskLimits.maxOpenPositions).toBe(10);
      expect(result?.riskLimits.maxDrawdown.toString()).toBe('75');
      expect(result?.riskLimits.maxOrderNotional?.toString()).toBe('250');
    });
  });

  describe('getDecisionContext', () => {
    it('builds context from mark source and flat position', async () => {
      const { deps } = makeDeps();
      const resolver = new AgentIntakeResolver(deps);

      const context = await resolver.getDecisionContext('agent-1', 'BTC/USD:USD');

      expect(context).toBeDefined();
      expect(context!.snapshot.symbol).toBe('BTC/USD:USD');
      expect(context!.snapshot.price).toBe('50000');
      expect(context!.position).toBeNull();
      expect(context!.referenceMark.source).toBe('oracle');
    });

    it('includes existing position in context', async () => {
      const { deps, mocks } = makeDeps();
      mocks.positionRepo.getOpenByActorAndVenueAccount.mockResolvedValue([
        { venue: 'hyperliquid', symbol: 'BTC/USD:USD', side: 'long', size: '0.5', entryPrice: '48000', realizedPnl: '100' },
      ]);
      const resolver = new AgentIntakeResolver(deps);

      const context = await resolver.getDecisionContext('agent-1', 'BTC/USD:USD');

      expect(context!.position).toEqual({
        side: 'long',
        size: '0.5',
        entryPrice: '48000',
        realizedPnl: '100',
      });
    });

    it('returns undefined when mark fetch fails', async () => {
      const { deps, mocks } = makeDeps();
      mocks.markSource.fetchMark.mockResolvedValue({
        ok: false,
        error: { code: 'mark.unavailable' },
      });
      const resolver = new AgentIntakeResolver(deps);

      const context = await resolver.getDecisionContext('agent-1', 'BTC/USD:USD');

      expect(context).toBeUndefined();
    });
  });

  describe('getPosition', () => {
    it('returns flat position when no open position exists', async () => {
      const { deps } = makeDeps();
      const resolver = new AgentIntakeResolver(deps);

      const pos = await resolver.getPosition('agent-1', 'BTC/USD:USD');

      expect(pos.side).toBe('flat');
      expect(pos.symbol).toBe('BTC/USD:USD');
    });

    it('returns existing position when found', async () => {
      const { deps, mocks } = makeDeps();
      mocks.positionRepo.getOpenByActorAndVenueAccount.mockResolvedValue([
        { venue: 'hyperliquid', symbol: 'BTC/USD:USD', side: 'long', size: '1.5', entryPrice: '45000', realizedPnl: '200' },
      ]);
      const resolver = new AgentIntakeResolver(deps);

      const pos = await resolver.getPosition('agent-1', 'BTC/USD:USD');

      expect(pos.side).toBe('long');
      expect(pos.size.toString()).toBe('1.5');
      expect(pos.entryPrice.toString()).toBe('45000');
    });

    it('filters positions by instrument', async () => {
      const { deps, mocks } = makeDeps();
      mocks.positionRepo.getOpenByActorAndVenueAccount.mockResolvedValue([
        { venue: 'hyperliquid', symbol: 'ETH/USD:USD', side: 'long', size: '10', entryPrice: '3000', realizedPnl: '50' },
      ]);
      const resolver = new AgentIntakeResolver(deps);

      const pos = await resolver.getPosition('agent-1', 'BTC/USD:USD');

      expect(pos.side).toBe('flat');
      expect(pos.symbol).toBe('BTC/USD:USD');
    });
  });

  describe('resolveBinding', () => {
    it('returns venue and venueAccountId from active trading grant', async () => {
      const { deps } = makeDeps();
      const resolver = new AgentIntakeResolver(deps);

      const binding = await resolver.resolveBinding('agent-1');

      expect(binding).toBeDefined();
      expect(binding!.venue).toBe('hyperliquid');
      expect(binding!.venueAccountId).toBe('va-1');
    });

    it('returns undefined when no active trading grant exists', async () => {
      const { deps, mocks } = makeDeps();
      mocks.db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([]),
                  }),
                }),
              }),
            }),
          }),
        }),
      });
      const resolver = new AgentIntakeResolver(deps);

      const binding = await resolver.resolveBinding('agent-no-grant');

      expect(binding).toBeUndefined();
    });

    it('falls back to provider when venueAccountVenue is null', async () => {
      const { deps, mocks } = makeDeps();
      mocks.db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([
                      {
                        sourceVenueAccountId: 'va-2',
                        provider: 'bybit',
                        venueAccountVenue: null,
                        venueAccountId: null,
                        connectionStatus: 'active',
                      },
                    ]),
                  }),
                }),
              }),
            }),
          }),
        }),
      });
      const resolver = new AgentIntakeResolver(deps);

      const binding = await resolver.resolveBinding('agent-2');

      expect(binding).toBeDefined();
      expect(binding!.venue).toBe('bybit');
      expect(binding!.venueAccountId).toBe('va-2');
    });

    it('returns undefined when both venueAccountId and sourceVenueAccountId are null', async () => {
      const { deps, mocks } = makeDeps();
      mocks.db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([
                      {
                        sourceVenueAccountId: null,
                        provider: 'hyperliquid',
                        venueAccountVenue: null,
                        venueAccountId: null,
                        connectionStatus: 'active',
                      },
                    ]),
                  }),
                }),
              }),
            }),
          }),
        }),
      });
      const resolver = new AgentIntakeResolver(deps);

      const binding = await resolver.resolveBinding('agent-broken');

      expect(binding).toBeUndefined();
    });
  });
});
