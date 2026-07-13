import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentIntakeResolver } from './agent-intake-resolver.js';

describe('AgentIntakeResolver', () => {
  function makeDeps(overrides: Record<string, unknown> = {}) {
    const limitMock = vi.fn().mockResolvedValue([
      {
        resolvedVenueAccountId: 'va-1',
        provider: 'hyperliquid',
        venueAccountVenue: 'hyperliquid',
        venueAccountId: 'va-1',
        connectionStatus: 'active',
      },
    ]);

    const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
    const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
    const leftJoinMock = vi.fn().mockReturnValue({ where: whereMock });
    const innerJoin2Mock = vi.fn().mockReturnValue({ leftJoin: leftJoinMock, where: whereMock });
    const innerJoin1Mock = vi.fn().mockReturnValue({ innerJoin: innerJoin2Mock, leftJoin: leftJoinMock, where: whereMock });
    const fromMock = vi.fn().mockReturnValue({ innerJoin: innerJoin1Mock });
    const selectMock = vi.fn().mockReturnValue({ from: fromMock });

    const db = {
      select: selectMock,
      from: fromMock,
      innerJoin: innerJoin1Mock,
      leftJoin: leftJoinMock,
      where: whereMock,
      orderBy: orderByMock,
      limit: limitMock,
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
        agentRiskDefaults: {
          maxOpenPositions: 10,
          maxPositionSizePct: 100,
          maxPositionSize: 1000000000,
          stopLossMaxUnrealizedLossPct: 10,
          dailyMaxLossPct: 20,
          stopLossCooldownMs: 300000,
          maxOrderNotionalMultiplier: 1,
          maxDrawdown: 1_000_000_000,
          botConfigInvalidHaltThreshold: 1,
          botExecutionErrorHaltThreshold: 5,
          botLlmProviderErrorHaltThreshold: 1,
        },
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
        { resolvedVenueAccountId: null, provider: 'hyperliquid', venueAccountVenue: null, venueAccountId: null },
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

    it('applies agent-profile limits for drawdown and operator defaults for risk settings', async () => {
      const { deps } = makeDeps();
      const resolver = new AgentIntakeResolver(deps);

      const result = await resolver.getIntakeDeps('agent-1', 'BTC/USD:USD');

      expect(result?.riskLimits.maxPositionSize.toString()).toBe('1000000000');
      expect(result?.riskLimits.maxOpenPositions).toBe(10);
      // maxDrawdown is now always derived from operator defaults for agent flows.
      expect(result?.riskLimits.maxDrawdown.toString()).toBe('1000000000');
      expect(result?.riskLimits.maxOrderNotional?.toString()).toBe('250');
      expect(result?.riskLimits.maxPositionSizePct).toBe(100);
      expect(result?.riskLimits.stopLossMaxUnrealizedLossPct).toBe(10);
      expect(result?.riskLimits.stopLossCooldownMs).toBe(300000);
      expect(result?.equity?.toString()).toBe('250');
    });

    it('prefers explicit agent risk overrides when present', async () => {
      const { deps, mocks } = makeDeps();
      mocks.agentRepo.getAgent.mockResolvedValue({
        id: 'agent-1',
        capital: '250',
        dailyLossLimit: '75',
        maxOpenPositions: 3,
        maxPositionSizePct: '40',
        stopLossPct: '2.5',
        stopLossCooldownMs: 120000,
      });
      const resolver = new AgentIntakeResolver(deps);

      const result = await resolver.getIntakeDeps('agent-1', 'BTC/USD:USD');

      expect(result?.riskLimits.maxOpenPositions).toBe(3);
      expect(result?.riskLimits.maxPositionSizePct).toBe(40);
      expect(result?.riskLimits.stopLossMaxUnrealizedLossPct).toBe(2.5);
      expect(result?.riskLimits.stopLossCooldownMs).toBe(120000);
    });

    it('omits capital-based limits when agent has no capital configured', async () => {
      const { deps, mocks } = makeDeps();
      mocks.agentRepo.getAgent.mockResolvedValue({ id: 'agent-1', capital: null, dailyLossLimit: '75' });
      const resolver = new AgentIntakeResolver(deps);

      const result = await resolver.getIntakeDeps('agent-1', 'BTC/USD:USD');

      expect(result?.riskLimits.maxOrderNotional).toBeUndefined();
      expect(result?.riskLimits.maxPositionSizePct).toBeUndefined();
      expect(result?.equity).toBeUndefined();
    });

    it('returns undefined when agent row is missing (fail closed)', async () => {
      const { deps, mocks } = makeDeps();
      mocks.agentRepo.getAgent.mockResolvedValue(null);
      const resolver = new AgentIntakeResolver(deps);

      const result = await resolver.getIntakeDeps('agent-1', 'BTC/USD:USD');

      expect(result).toBeUndefined();
    });

    it('returns undefined when agent is in shadow mode (fail closed)', async () => {
      const { deps, mocks } = makeDeps();
      mocks.agentRepo.getAgent.mockResolvedValue({ id: 'agent-1', capital: '100', dailyLossLimit: '50', executionMode: 'shadow' });
      const resolver = new AgentIntakeResolver(deps);

      const result = await resolver.getIntakeDeps('agent-1', 'BTC/USD:USD');

      expect(result).toBeUndefined();
    });

    it('returns undefined when agent is in live mode (fail closed)', async () => {
      const { deps, mocks } = makeDeps();
      mocks.agentRepo.getAgent.mockResolvedValue({ id: 'agent-1', capital: '100', dailyLossLimit: '50', executionMode: 'live' });
      const resolver = new AgentIntakeResolver(deps);

      const result = await resolver.getIntakeDeps('agent-1', 'BTC/USD:USD');

      expect(result).toBeUndefined();
    });

    it('wires swap fields for paper-mode 1inch binding', async () => {
      const { deps, mocks } = makeDeps({
        swapTokenSafety: { checkSwapTarget: vi.fn() },
        oneInchConfig: { tokenSafetyNetwork: 'base', chainId: 8453 },
      });
      mocks.db.limit.mockResolvedValue([
        {
          resolvedVenueAccountId: 'va-1inch',
          provider: '1inch',
          venueAccountVenue: '1inch',
          venueAccountId: 'va-1inch',
          connectionStatus: 'active',
          bindingProfile: null,
        },
      ]);
      const resolver = new AgentIntakeResolver(deps);

      const result = await resolver.getIntakeDeps('agent-1', 'ETH/USDC');

      expect(result).toBeDefined();
      expect(result!.venueType).toBe('swap');
      expect(result!.swapNetwork).toBe('base');
      expect(result!.swapBaseTokenAddress).toBe('ETH');
      expect(result!.swapTokenSafety).toBe(deps.swapTokenSafety);
      expect(result!.venue).toBe('1inch');
    });

    it('rejects with instrument_unknown when cache is ready and symbol is not recognized', async () => {
      const { deps } = makeDeps({
        instrumentCache: {
          isReady: () => true,
          hasSymbol: (venue: string, symbol: string) => {
            if (venue === 'hyperliquid' && symbol === 'DOGE') return false;
            return true;
          },
        },
      });
      const resolver = new AgentIntakeResolver(deps);

      const result = await resolver.getIntakeDeps('agent-1', 'DOGE');

      expect(result).toBeDefined();
      expect(result).toHaveProperty('rejected', true);
      expect(result).toHaveProperty('code', 'instrument_unknown');
      expect(result).toHaveProperty('retryable', false);
    });

    it('accepts base ticker format for perp venues (find_instrument → submit_decision contract)', async () => {
      // After the find_instrument fix (Option A), perp instruments return
      // instrumentId = base ticker (e.g. "ZEC"), not a DB UUID.
      // This test validates that the intake resolver accepts that format.
      const { deps } = makeDeps({
        instrumentCache: {
          isReady: () => true,
          hasSymbol: (venue: string, symbol: string) => {
            // Simulate VenueInstrumentCache normalisation:
            // Hyperliquid strips -PERP and /QUOTE:QUOTE suffixes → base ticker
            if (venue === 'hyperliquid' && ['BTC', 'ETH', 'ZEC'].includes(symbol)) return true;
            return false;
          },
        },
      });
      const resolver = new AgentIntakeResolver(deps);

      // Base ticker (what find_instrument now returns for perps) should be accepted
      const perpResult = await resolver.getIntakeDeps('agent-1', 'ZEC');
      expect(perpResult).toBeDefined();
      expect(perpResult).toHaveProperty('actorType', 'agent');
      expect(perpResult).not.toHaveProperty('rejected');

      // A base ticker not in the cache should still be rejected
      const unknownResult = await resolver.getIntakeDeps('agent-1', 'DOGE');
      expect(unknownResult).toBeDefined();
      expect(unknownResult).toHaveProperty('rejected', true);
      expect(unknownResult).toHaveProperty('code', 'instrument_unknown');
    });

    it('rejects DB UUID format — confirms the old bug path is closed', async () => {
      // Before the fix, find_instrument returned DB UUIDs as instrumentId.
      // This test proves that UUIDs are now rejected (they should never
      // reach the intake resolver after the fix, but if they do, they fail).
      const { deps } = makeDeps({
        instrumentCache: {
          isReady: () => true,
          hasSymbol: () => false, // UUID will never match a venue symbol
        },
      });
      const resolver = new AgentIntakeResolver(deps);

      const result = await resolver.getIntakeDeps('agent-1', '63982074-a987-44a7-b943-6de1bb54ff6f');

      expect(result).toBeDefined();
      expect(result).toHaveProperty('rejected', true);
      expect(result).toHaveProperty('code', 'instrument_unknown');
    });

    it('allows known symbols through when cache is ready', async () => {
      const { deps } = makeDeps({
        instrumentCache: {
          isReady: () => true,
          hasSymbol: () => true,
        },
      });
      const resolver = new AgentIntakeResolver(deps);

      const result = await resolver.getIntakeDeps('agent-1', 'BTC/USD:USD');

      expect(result).toBeDefined();
      expect(result).toHaveProperty('actorType', 'agent');
      expect(result).not.toHaveProperty('rejected');
    });

    it('skips validation when instrumentCache is not provided (backward compat)', async () => {
      const { deps } = makeDeps(); // no instrumentCache override
      const resolver = new AgentIntakeResolver(deps);

      const result = await resolver.getIntakeDeps('agent-1', 'DOGE');

      // Should NOT reject — cache is absent, so validation is skipped
      expect(result).toBeDefined();
      expect(result).toHaveProperty('actorType', 'agent');
      expect(result).not.toHaveProperty('rejected');
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
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]),
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
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([
                    {
                      resolvedVenueAccountId: 'va-2',
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
      });
      const resolver = new AgentIntakeResolver(deps);

      const binding = await resolver.resolveBinding('agent-2');

      expect(binding).toBeDefined();
      expect(binding!.venue).toBe('bybit');
      expect(binding!.venueAccountId).toBe('va-2');
    });

    it('returns undefined when both venueAccountId and resolvedVenueAccountId are null', async () => {
      const { deps, mocks } = makeDeps();
      mocks.db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([
                    {
                      resolvedVenueAccountId: null,
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
      });
      const resolver = new AgentIntakeResolver(deps);

      const binding = await resolver.resolveBinding('agent-broken');

      expect(binding).toBeUndefined();
    });
  });
});
