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
});