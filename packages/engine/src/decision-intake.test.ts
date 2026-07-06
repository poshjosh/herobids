import { describe, it, expect, vi } from 'vitest';
import { quantity, price } from '@herobids/domain';
import type { Decision, DecisionId, InstrumentId, BotId } from '@herobids/domain';
import { flatPosition } from './position-tracker.js';
import { PaperExecutor } from './paper-executor.js';
import { computeDecisionContextHash, DecisionContextHashMismatchError } from './decision-context-hash.js';
import { submitDecisionForExecution } from './decision-intake.js';
import type { Clock, TradingCyclePersistence, DecisionContext } from './decision-intake.js';
import type { Executor } from './executor.js';
import type { OrderId, FillId } from '@herobids/domain';

function makeIdGen() {
  let counter = 0;
  return {
    orderId: () => `o-${++counter}` as OrderId,
    fillId: () => `f-${++counter}` as FillId,
    planId: () => `p-${++counter}`,
    decisionId: () => `d-${++counter}`,
  };
}

const clock: Clock = { now: () => '2026-06-03T00:00:00.000Z' };

function makePersistence() {
  const calls: Record<string, unknown[][]> = {
    persistDecision: [],
    persistDecisionContext: [],
    persistPlan: [],
    markPlanExecuting: [],
    markPlanCompleted: [],
    markPlanFailed: [],
    persistFill: [],
    persistPosition: [],
    persistOrder: [],
  };

  const persistence: TradingCyclePersistence & { calls: Record<string, unknown[][]> } = {
    calls,
    persistDecision: vi.fn(async (...args) => { calls.persistDecision.push(args); }),
    persistDecisionContext: vi.fn(async (...args) => { calls.persistDecisionContext.push(args); }),
    persistPlan: vi.fn(async (...args) => { calls.persistPlan.push(args); }),
    markPlanExecuting: vi.fn(async (...args) => { calls.markPlanExecuting.push(args); }),
    markPlanCompleted: vi.fn(async (...args) => { calls.markPlanCompleted.push(args); }),
    markPlanFailed: vi.fn(async (...args) => { calls.markPlanFailed.push(args); }),
    persistFill: vi.fn(async (...args) => { calls.persistFill.push(args); }),
    persistPosition: vi.fn(async (...args) => { calls.persistPosition.push(args); }),
    persistOrder: vi.fn(async (...args) => { calls.persistOrder.push(args); }),
  };

  return persistence;
}

function makeContext(): DecisionContext {
  return {
    snapshot: {
      symbol: 'BTC/USD:USD',
      price: '60000',
      timestamp: '2026-06-03T00:00:00.000Z',
      data: { source: 'unit-test' },
    },
    position: null,
    referenceMark: {
      price: '60000',
      source: 'oracle',
    },
    strategyParams: { lookbackPeriod: 5 },
  };
}

function makeDecision(contextHash?: string): Decision {
  return {
    id: 'decision-1' as DecisionId,
    botId: 'inst-1' as BotId,
    instrumentId: 'BTC/USD:USD' as InstrumentId,
    intent: 'go_long',
    targetSize: quantity('1'),
    timestamp: '2026-06-03T00:00:00.000Z',
    contextHash,
  };
}

describe('submitDecisionForExecution', () => {
  it('stamps and persists the canonical hash when the decision omits one', async () => {
    const context = makeContext();
    const expectedHash = computeDecisionContextHash(context);
    const persistence = makePersistence();
    const result = await submitDecisionForExecution(
      makeDecision(),
      context,
      flatPosition('hyperliquid', 'BTC/USD:USD'),
      {
        botId: 'inst-1',
        venue: 'hyperliquid',
        symbol: 'BTC/USD:USD',
        venueAccountId: 'venue-account-1',
        executor: new PaperExecutor(makeIdGen()),
        journal: { append: vi.fn().mockResolvedValue(undefined) },
        riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
        persistence,
        idGen: makeIdGen(),
        clock,
      },
    );

    expect(result.decision.contextHash).toBe(expectedHash);
    expect(persistence.calls.persistDecision).toHaveLength(1);
    expect((persistence.calls.persistDecision[0]![0] as Decision).contextHash).toBe(expectedHash);
    expect(persistence.calls.persistDecisionContext).toHaveLength(1);
    expect((persistence.calls.persistDecisionContext[0]![0] as { contextHash: string }).contextHash).toBe(expectedHash);
    expect(persistence.calls.persistPosition).toHaveLength(1);
    expect((persistence.calls.persistPosition[0]![0] as { markSource?: string }).markSource).toBe('oracle');
  });

  it('accepts a matching supplied hash and persists the same canonical hash', async () => {
    const context = makeContext();
    const expectedHash = computeDecisionContextHash(context);
    const persistence = makePersistence();

    const result = await submitDecisionForExecution(
      makeDecision(expectedHash),
      context,
      flatPosition('hyperliquid', 'BTC/USD:USD'),
      {
        botId: 'inst-1',
        venue: 'hyperliquid',
        symbol: 'BTC/USD:USD',
        venueAccountId: 'venue-account-1',
        executor: new PaperExecutor(makeIdGen()),
        journal: { append: vi.fn().mockResolvedValue(undefined) },
        riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
        persistence,
        idGen: makeIdGen(),
        clock,
      },
    );

    expect(result.decision.contextHash).toBe(expectedHash);
    expect((persistence.calls.persistDecision[0]![0] as Decision).contextHash).toBe(expectedHash);
    expect((persistence.calls.persistDecisionContext[0]![0] as { contextHash: string }).contextHash).toBe(expectedHash);
  });

  it('rejects a mismatched supplied hash before persistence', async () => {
    const context = makeContext();
    const persistence = makePersistence();

    await expect(
      submitDecisionForExecution(
        makeDecision('deadbeefdeadbeef'),
        context,
        flatPosition('hyperliquid', 'BTC/USD:USD'),
        {
          botId: 'inst-1',
          venue: 'hyperliquid',
          symbol: 'BTC/USD:USD',
          venueAccountId: 'venue-account-1',
          executor: new PaperExecutor(makeIdGen()),
          journal: { append: vi.fn().mockResolvedValue(undefined) },
          riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
          persistence,
          idGen: makeIdGen(),
          clock,
        },
      ),
    ).rejects.toMatchObject({ code: 'decision.context_hash_mismatch' });

    expect(persistence.calls.persistDecision).toHaveLength(0);
    expect(persistence.calls.persistDecisionContext).toHaveLength(0);
    expect(persistence.calls.persistPosition).toHaveLength(0);
  });

  it('produces the same hash for equivalent contexts with different key order', () => {
    const firstContext: DecisionContext = {
      snapshot: {
        symbol: 'BTC/USD:USD',
        price: '60000',
        timestamp: '2026-06-03T00:00:00.000Z',
        data: { alpha: 1, beta: 2 },
      },
      position: null,
      referenceMark: {
        price: '60000',
        source: 'oracle',
      },
      strategyParams: { first: 'one', second: 'two' },
    };

    const secondContext: DecisionContext = {
      snapshot: {
        symbol: 'BTC/USD:USD',
        price: '60000',
        timestamp: '2026-06-03T00:00:00.000Z',
        data: { beta: 2, alpha: 1 },
      },
      position: null,
      referenceMark: {
        price: '60000',
        source: 'oracle',
      },
      strategyParams: { second: 'two', first: 'one' },
    };

    expect(computeDecisionContextHash(firstContext)).toBe(computeDecisionContextHash(secondContext));
  });

  it('rejects swap buy when token safety check fails', async () => {
    const context = makeContext();
    const persistence = makePersistence();

    const result = await submitDecisionForExecution(
      makeDecision(),
      context,
      flatPosition('jupiter', 'SOL/USDC'),
      {
        actorType: 'bot',
        actorId: 'bot-1',
        venue: 'jupiter',
        symbol: 'SOL/USDC',
        venueAccountId: 'venue-account-1',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC' },
        swapNetwork: 'solana',
        swapBaseTokenAddress: 'So11111111111111111111111111111111111111112',
        executor: new PaperExecutor(makeIdGen()),
        journal: { append: vi.fn().mockResolvedValue(undefined) },
        riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
        persistence,
        idGen: makeIdGen(),
        clock,
        swapTokenSafety: {
          checkSwapTarget: vi.fn().mockResolvedValue({
            ok: false,
            error: {
              code: 'token.safety_rejected',
              message: 'Liquidity too low',
              retryable: true,
              details: { liquidityUsd: 5000 },
              overrideTicket: { id: 'override-1', expiresAt: '2026-06-04T00:00:00Z', tokenAddress: 'So111...', network: 'solana', reasonCodes: ['token.low_liquidity'] },
            },
          }),
        },
      },
    );

    expect(result.preExecutionRejection).toBeDefined();
    expect(result.preExecutionRejection!.scope).toBe('swap_token_safety');
    expect(result.preExecutionRejection!.code).toBe('token.safety_rejected');
    expect(result.preExecutionRejection!.retryable).toBe(true);
    expect(result.executionFailed).toBe(false);
    expect(result.riskRejected).toBe(false);
    expect(persistence.calls.markPlanFailed).toHaveLength(1);
  });

  it('passes swap buy when token safety check approves', async () => {
    const context = makeContext();
    const persistence = makePersistence();

    const result = await submitDecisionForExecution(
      makeDecision(),
      context,
      flatPosition('jupiter', 'SOL/USDC'),
      {
        actorType: 'bot',
        actorId: 'bot-1',
        venue: 'jupiter',
        symbol: 'SOL/USDC',
        venueAccountId: 'venue-account-1',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC' },
        swapNetwork: 'solana',
        swapBaseTokenAddress: 'So11111111111111111111111111111111111111112',
        executor: new PaperExecutor(makeIdGen()),
        journal: { append: vi.fn().mockResolvedValue(undefined) },
        riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
        persistence,
        idGen: makeIdGen(),
        clock,
        swapTokenSafety: {
          checkSwapTarget: vi.fn().mockResolvedValue({
            ok: true,
            data: { tokenAddress: 'So11111111111111111111111111111111111111112', overridden: false, liquidityUsd: 5_000_000 },
          }),
        },
      },
    );

    expect(result.preExecutionRejection).toBeUndefined();
    expect(persistence.calls.markPlanFailed).toHaveLength(0);
  });

  it('does not run swap safety for orderbook venues', async () => {
    const context = makeContext();
    const persistence = makePersistence();
    const mockSafety = { checkSwapTarget: vi.fn() };

    await submitDecisionForExecution(
      makeDecision(),
      context,
      flatPosition('hyperliquid', 'BTC/USD:USD'),
      {
        actorType: 'bot',
        actorId: 'bot-1',
        venue: 'hyperliquid',
        symbol: 'BTC/USD:USD',
        venueAccountId: 'venue-account-1',
        venueType: 'orderbook',
        executor: new PaperExecutor(makeIdGen()),
        journal: { append: vi.fn().mockResolvedValue(undefined) },
        riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
        persistence,
        idGen: makeIdGen(),
        clock,
        swapTokenSafety: mockSafety,
      },
    );

    expect(mockSafety.checkSwapTarget).not.toHaveBeenCalled();
  });

  describe('computeEstimatedNotionalUsd (via checkSwapTarget call args)', () => {
    function makeSwapDeps(quoteAsset: string, quantity_: string, refPrice: string) {
      const checkSwapTarget = vi.fn().mockResolvedValue({
        ok: true,
        data: { tokenAddress: 'addr', overridden: false },
      });
      const deps = {
        actorType: 'bot',
        actorId: 'bot-1',
        venue: 'jupiter',
        symbol: 'SOL/QUOTE',
        venueAccountId: 'va-1',
        venueType: 'swap' as const,
        swapAssets: { baseAsset: 'SOL', quoteAsset },
        swapNetwork: 'solana',
        swapBaseTokenAddress: 'So11111111111111111111111111111111111111112',
        executor: new PaperExecutor(makeIdGen()),
        journal: { append: vi.fn().mockResolvedValue(undefined) },
        riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
        persistence: makePersistence(),
        idGen: makeIdGen(),
        clock,
        swapTokenSafety: { checkSwapTarget },
      };
      const context: DecisionContext = {
        ...makeContext(),
        referenceMark: { price: refPrice, source: 'oracle' },
      };
      const decision: Decision = {
        id: 'decision-1' as DecisionId,
        botId: 'inst-1' as BotId,
        instrumentId: 'SOL/QUOTE' as InstrumentId,
        intent: 'go_long',
        targetSize: quantity(quantity_),
        timestamp: '2026-06-03T00:00:00.000Z',
      };
      return { deps, context, decision, checkSwapTarget };
    }

    it('uses quantity directly as notional when quote is USDC (stablecoin)', async () => {
      const { deps, context, decision, checkSwapTarget } = makeSwapDeps('USDC', '100', '150');

      await submitDecisionForExecution(decision, context, flatPosition('jupiter', 'SOL/USDC'), deps);

      expect(checkSwapTarget).toHaveBeenCalledOnce();
      const callArgs = checkSwapTarget.mock.calls[0]![0];
      // quantity=100 USDC, price=$150 — notional should be $100 (not $15000)
      expect(callArgs.estimatedOrderNotionalUsd).toBe('100.00');
    });

    it('uses quantity directly as notional when quote is USDT', async () => {
      const { deps, context, decision, checkSwapTarget } = makeSwapDeps('USDT', '250', '200');

      await submitDecisionForExecution(decision, context, flatPosition('jupiter', 'SOL/USDT'), deps);

      const callArgs = checkSwapTarget.mock.calls[0]![0];
      expect(callArgs.estimatedOrderNotionalUsd).toBe('250.00');
    });

    it('uses quantity × refPrice when quote is non-stablecoin', async () => {
      // buying with wBTC as quote: quantity=2 wBTC, price=$50000 → notional=$100000
      const { deps, context, decision, checkSwapTarget } = makeSwapDeps('wBTC', '2', '50000');

      await submitDecisionForExecution(decision, context, flatPosition('jupiter', 'SOL/wBTC'), deps);

      const callArgs = checkSwapTarget.mock.calls[0]![0];
      expect(callArgs.estimatedOrderNotionalUsd).toBe('100000.00');
    });

    it('passes undefined notional when there is no buy order', async () => {
      // A sell-only decision: safety guard is skipped entirely since isBuyPath is false
      const checkSwapTarget = vi.fn().mockResolvedValue({
        ok: true,
        data: { tokenAddress: 'addr', overridden: false },
      });
      const persistence = makePersistence();

      const decision: Decision = {
        id: 'decision-1' as DecisionId,
        botId: 'inst-1' as BotId,
        instrumentId: 'SOL/USDC' as InstrumentId,
        intent: 'close',
        targetSize: quantity('0'),
        timestamp: '2026-06-03T00:00:00.000Z',
      };

      await submitDecisionForExecution(
        decision,
        makeContext(),
        flatPosition('jupiter', 'SOL/USDC'),
        {
          actorType: 'bot',
          actorId: 'bot-1',
          venue: 'jupiter',
          symbol: 'SOL/USDC',
          venueAccountId: 'va-1',
          venueType: 'swap',
          swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC' },
          swapNetwork: 'solana',
          swapBaseTokenAddress: 'So11111111111111111111111111111111111111112',
          executor: new PaperExecutor(makeIdGen()),
          journal: { append: vi.fn().mockResolvedValue(undefined) },
          riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
          persistence,
          idGen: makeIdGen(),
          clock,
          swapTokenSafety: { checkSwapTarget },
        },
      );

      // Safety check should not be called when there is no buy order
      expect(checkSwapTarget).not.toHaveBeenCalled();
    });

    it('uses quantity × refPrice when swapAssets is not provided', async () => {
      const checkSwapTarget = vi.fn().mockResolvedValue({
        ok: true,
        data: { tokenAddress: 'addr', overridden: false },
      });
      const context: DecisionContext = {
        ...makeContext(),
        referenceMark: { price: '100', source: 'oracle' },
      };
      const decision: Decision = {
        id: 'decision-1' as DecisionId,
        botId: 'inst-1' as BotId,
        instrumentId: 'SOL/USDC' as InstrumentId,
        intent: 'go_long',
        targetSize: quantity('3'),
        timestamp: '2026-06-03T00:00:00.000Z',
      };

      await submitDecisionForExecution(decision, context, flatPosition('jupiter', 'SOL/USDC'), {
        actorType: 'bot',
        actorId: 'bot-1',
        venue: 'jupiter',
        symbol: 'SOL/USDC',
        venueAccountId: 'va-1',
        venueType: 'swap',
        swapNetwork: 'solana',
        swapBaseTokenAddress: 'So11111111111111111111111111111111111111112',
        executor: new PaperExecutor(makeIdGen()),
        journal: { append: vi.fn().mockResolvedValue(undefined) },
        riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
        persistence: makePersistence(),
        idGen: makeIdGen(),
        clock,
        swapTokenSafety: { checkSwapTarget },
      });

      const callArgs = checkSwapTarget.mock.calls[0]![0];
      // No swapAssets → falls back to quantity * refPrice = 3 * 100 = 300
      expect(callArgs.estimatedOrderNotionalUsd).toBe('300.00');
    });
  });

  describe('openPositionCount override', () => {
    it('uses provided openPositionCount for risk check instead of deriving from position', async () => {
      const persistence = makePersistence();
      // Position is flat for this symbol, but agent has 5 open positions elsewhere
      const result = await submitDecisionForExecution(
        makeDecision(computeDecisionContextHash(makeContext())),
        makeContext(),
        flatPosition('hyperliquid', 'BTC/USD:USD'),
        {
          actorType: 'agent',
          actorId: 'agent-1',
          venue: 'hyperliquid',
          symbol: 'BTC/USD:USD',
          venueAccountId: 'venue-account-1',
          executor: new PaperExecutor(makeIdGen()),
          journal: { append: vi.fn().mockResolvedValue(undefined) },
          riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
          persistence,
          idGen: makeIdGen(),
          clock,
          openPositionCount: 5,
        },
      );

      // Should be risk-rejected because openPositionCount (5) >= maxOpenPositions (5)
      expect(result.riskRejected).toBe(true);
    });

    it('falls back to single-instrument derivation when openPositionCount is not provided', async () => {
      const persistence = makePersistence();
      const result = await submitDecisionForExecution(
        makeDecision(computeDecisionContextHash(makeContext())),
        makeContext(),
        flatPosition('hyperliquid', 'BTC/USD:USD'),
        {
          actorType: 'bot',
          actorId: 'bot-1',
          venue: 'hyperliquid',
          symbol: 'BTC/USD:USD',
          venueAccountId: 'venue-account-1',
          executor: new PaperExecutor(makeIdGen()),
          journal: { append: vi.fn().mockResolvedValue(undefined) },
          riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
          persistence,
          idGen: makeIdGen(),
          clock,
        },
      );

      // Position is flat → openPositionCount = 0, well under limit of 5
      expect(result.riskRejected).toBe(false);
    });
  });

  it('stamps exitReason from decision metadata.reason on close', async () => {
    const context = makeContext();
    const persistence = makePersistence();

    // Start from a non-flat (long) position so go_flat actually closes.
    const longPosition = {
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      side: 'long' as const,
      size: quantity('0.5'),
      entryPrice: price('59000'),
      realizedPnl: price('0'),
    };

    const decisionWithReason: Decision = {
      ...makeDecision(),
      intent: 'go_flat',
      targetSize: quantity('0'),
      metadata: { reason: 'signal_lost' },
    };

    await submitDecisionForExecution(
      decisionWithReason,
      context,
      longPosition,
      {
        actorType: 'bot',
        actorId: 'bot-1',
        venue: 'hyperliquid',
        symbol: 'BTC/USD:USD',
        venueAccountId: 'venue-account-1',
        executor: new PaperExecutor(makeIdGen()),
        journal: { append: vi.fn().mockResolvedValue(undefined) },
        riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
        persistence,
        idGen: makeIdGen(),
        clock,
      },
    );

    expect(persistence.calls.persistPosition).toHaveLength(1);
    const posArg = persistence.calls.persistPosition[0]![0] as { side: string; exitReason?: string };
    expect(posArg.side).toBe('flat');
    expect(posArg.exitReason).toBe('signal_lost');
  });

  it('omits exitReason from persistPosition when decision has no metadata.reason', async () => {
    const context = makeContext();
    const persistence = makePersistence();

    const longPosition = {
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      side: 'long' as const,
      size: quantity('0.5'),
      entryPrice: price('59000'),
      realizedPnl: price('0'),
    };

    // No metadata at all
    const decisionNoReason: Decision = {
      ...makeDecision(),
      intent: 'go_flat',
      targetSize: quantity('0'),
    };

    await submitDecisionForExecution(
      decisionNoReason,
      context,
      longPosition,
      {
        actorType: 'bot',
        actorId: 'bot-1',
        venue: 'hyperliquid',
        symbol: 'BTC/USD:USD',
        venueAccountId: 'venue-account-1',
        executor: new PaperExecutor(makeIdGen()),
        journal: { append: vi.fn().mockResolvedValue(undefined) },
        riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
        persistence,
        idGen: makeIdGen(),
        clock,
      },
    );

    expect(persistence.calls.persistPosition).toHaveLength(1);
    const posArg = persistence.calls.persistPosition[0]![0] as { side: string; exitReason?: string };
    expect(posArg.side).toBe('flat');
    expect(posArg.exitReason).toBeUndefined();
  });
});
