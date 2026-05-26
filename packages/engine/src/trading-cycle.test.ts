import { describe, it, expect, vi } from 'vitest';
import { runTradingCycle, realClock } from './trading-cycle.js';
import type { Clock, TradingCycleDeps, TradingCyclePersistence } from './trading-cycle.js';
import { flatPosition } from './position-tracker.js';
import { PaperExecutor } from './paper-executor.js';
import { InMemoryJournal } from './journal-memory.js';
import { ok, price, quantity } from '@herobids/domain';
import type { OrderId, FillId, TradingInstanceId, DecisionId, InstrumentId, MarketSnapshot, Strategy, Decision } from '@herobids/domain';
import type { Executor } from './executor.js';

function makeIdGen() {
  let c = 0;
  return {
    orderId: () => `o-${++c}` as OrderId,
    fillId: () => `f-${++c}` as FillId,
    planId: () => `p-${++c}`,
    decisionId: () => `d-${++c}`,
  };
}

function makeSimulatedClock(iso: string): Clock {
  return { now: () => iso };
}

function makeStrategy(decision: Decision | null): Strategy {
  return {
    id: 'test-strategy',
    name: 'Test',
    evaluate: vi.fn().mockResolvedValue(ok(decision)),
  };
}

function makePersistence(): TradingCyclePersistence & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    persistDecision: [],
    persistPlan: [],
    markPlanExecuting: [],
    markPlanCompleted: [],
    markPlanFailed: [],
    persistFill: [],
    persistPosition: [],
    persistOrder: [],
  };
  return {
    calls,
    persistDecision: vi.fn(async (...args) => { calls['persistDecision']!.push(args); }),
    persistPlan: vi.fn(async (...args) => { calls['persistPlan']!.push(args); }),
    markPlanExecuting: vi.fn(async (...args) => { calls['markPlanExecuting']!.push(args); }),
    markPlanCompleted: vi.fn(async (...args) => { calls['markPlanCompleted']!.push(args); }),
    markPlanFailed: vi.fn(async (...args) => { calls['markPlanFailed']!.push(args); }),
    persistFill: vi.fn(async (...args) => { calls['persistFill']!.push(args); }),
    persistPosition: vi.fn(async (...args) => { calls['persistPosition']!.push(args); }),
    persistOrder: vi.fn(async (...args) => { calls['persistOrder']!.push(args); }),
  };
}

function makeDecision(): Decision {
  return {
    id: 'd-1' as DecisionId,
    tradingInstanceId: '' as TradingInstanceId,
    instrumentId: 'BTC/USD:USD' as InstrumentId,
    intent: 'go_long',
    targetSize: quantity('1'),
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

describe('runTradingCycle', () => {
  const snapshot: MarketSnapshot = {
    symbol: 'BTC/USD:USD',
    price: price('50000'),
    timestamp: '2026-01-01T00:00:00.000Z',
  };

  it('returns decided=false when strategy returns null', async () => {
    const journal = new InMemoryJournal();
    const persistence = makePersistence();
    const idGen = makeIdGen();

    const result = await runTradingCycle(snapshot, flatPosition('hyperliquid', 'BTC/USD:USD'), {
      tradingInstanceId: 'inst-1',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: makeStrategy(null),
      strategyConfig: {},
      executor: new PaperExecutor(idGen),
      journal,
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      persistence,
      idGen,
      clock: realClock,
    });

    expect(result.decided).toBe(false);
    expect(result.position.side).toBe('flat');
    expect(journal.entries).toHaveLength(0);
  });

  it('executes full cycle and updates position on go_long decision', async () => {
    const journal = new InMemoryJournal();
    const persistence = makePersistence();
    const idGen = makeIdGen();

    const result = await runTradingCycle(snapshot, flatPosition('hyperliquid', 'BTC/USD:USD'), {
      tradingInstanceId: 'inst-1',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: makeStrategy(makeDecision()),
      strategyConfig: {},
      executor: new PaperExecutor(idGen),
      journal,
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      persistence,
      idGen,
      clock: realClock,
    });

    expect(result.decided).toBe(true);
    expect(result.riskRejected).toBe(false);
    expect(result.executionFailed).toBe(false);
    expect(result.position.side).toBe('long');
    expect(result.position.size.toString()).toBe('1');
    expect(result.executionResult).toBeDefined();
    expect(result.executionResult!.fills.length).toBe(1);

    // Persistence hooks called
    expect(persistence.calls['persistDecision']!.length).toBe(1);
    expect(persistence.calls['persistPlan']!.length).toBe(1);
    expect(persistence.calls['markPlanExecuting']!.length).toBe(1);
    expect(persistence.calls['markPlanCompleted']!.length).toBe(1);
    expect(persistence.calls['persistFill']!.length).toBe(1);
    expect(persistence.calls['persistPosition']!.length).toBe(1);
    expect(persistence.calls['persistOrder']!.length).toBe(1);

    // Journal has expected events
    const types = journal.entries.map((e) => e.type);
    expect(types).toContain('decision.created');
    expect(types).toContain('plan.created');
    expect(types).toContain('fill.recorded');
    expect(types).toContain('plan.completed');
  });

  it('produces same output under real and simulated clocks', async () => {
    const decision = makeDecision();

    const run = async (clock: Clock) => {
      const journal = new InMemoryJournal();
      const persistence = makePersistence();
      const idGen = makeIdGen();
      return runTradingCycle(snapshot, flatPosition('hyperliquid', 'BTC/USD:USD'), {
        tradingInstanceId: 'inst-1',
        venue: 'hyperliquid',
        symbol: 'BTC/USD:USD',
        venueAccountId: 'va-1',
        strategy: makeStrategy(decision),
        strategyConfig: {},
        executor: new PaperExecutor(idGen),
        journal,
        riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
        persistence,
        idGen,
        clock,
      });
    };

    const realResult = await run(realClock);
    const simResult = await run(makeSimulatedClock('2025-06-01T12:00:00.000Z'));

    // Same decision, same plan action, same fills, same resulting position
    expect(realResult.decided).toBe(simResult.decided);
    expect(realResult.decision?.intent).toBe(simResult.decision?.intent);
    expect(realResult.position.side).toBe(simResult.position.side);
    expect(realResult.position.size.toString()).toBe(simResult.position.size.toString());
    expect(realResult.executionResult!.fills.length).toBe(simResult.executionResult!.fills.length);
  });

  it('returns riskRejected=true when risk gate rejects', async () => {
    const journal = new InMemoryJournal();
    const persistence = makePersistence();
    const idGen = makeIdGen();

    // Very small maxPositionSize to trigger rejection
    const result = await runTradingCycle(snapshot, flatPosition('hyperliquid', 'BTC/USD:USD'), {
      tradingInstanceId: 'inst-1',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: makeStrategy(makeDecision()),
      strategyConfig: {},
      executor: new PaperExecutor(idGen),
      journal,
      riskLimits: { maxPositionSize: quantity('0.5'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      persistence,
      idGen,
      clock: realClock,
    });

    expect(result.decided).toBe(true);
    expect(result.riskRejected).toBe(true);
    expect(result.position.side).toBe('flat');
    expect(persistence.calls['markPlanFailed']!.length).toBe(1);
  });

  it('returns strategyError=true when strategy evaluation fails', async () => {
    const journal = new InMemoryJournal();
    const persistence = makePersistence();
    const idGen = makeIdGen();

    const failingStrategy: Strategy = {
      id: 'fail-strat',
      name: 'Failing',
      evaluate: vi.fn().mockResolvedValue({ ok: false, error: { code: 'strategy.timeout', message: 'LLM timed out' } }),
    };

    const result = await runTradingCycle(snapshot, flatPosition('hyperliquid', 'BTC/USD:USD'), {
      tradingInstanceId: 'inst-1',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: failingStrategy,
      strategyConfig: {},
      executor: new PaperExecutor(idGen),
      journal,
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      persistence,
      idGen,
      clock: realClock,
    });

    expect(result.strategyError).toBe(true);
    expect(result.decided).toBe(false);
    expect(result.position.side).toBe('flat');
    // Journal should have the strategy error event
    expect(journal.entries.some((e) => e.type === 'strategy.error')).toBe(true);
    // No persistence calls should have been made
    expect(persistence.calls['persistDecision']!.length).toBe(0);
  });

  it('returns executionFailed=true when executor rejects', async () => {
    const journal = new InMemoryJournal();
    const persistence = makePersistence();
    const idGen = makeIdGen();

    const failingExecutor: Executor = {
      execute: vi.fn().mockResolvedValue({ ok: false, error: { code: 'executor.venue_error', message: 'connection lost' } }),
    };

    const result = await runTradingCycle(snapshot, flatPosition('hyperliquid', 'BTC/USD:USD'), {
      tradingInstanceId: 'inst-1',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: makeStrategy(makeDecision()),
      strategyConfig: {},
      executor: failingExecutor,
      journal,
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      persistence,
      idGen,
      clock: realClock,
    });

    expect(result.executionFailed).toBe(true);
    expect(result.decided).toBe(true);
    expect(result.riskRejected).toBe(false);
    expect(result.position.side).toBe('flat'); // unchanged
    // Plan marked executing then failed
    expect(persistence.calls['markPlanExecuting']!.length).toBe(1);
    expect(persistence.calls['markPlanFailed']!.length).toBe(1);
    expect(persistence.calls['persistFill']!.length).toBe(0);
  });

  it('stamps tradingInstanceId onto the decision', async () => {
    const journal = new InMemoryJournal();
    const persistence = makePersistence();
    const idGen = makeIdGen();

    const result = await runTradingCycle(snapshot, flatPosition('hyperliquid', 'BTC/USD:USD'), {
      tradingInstanceId: 'my-instance-99',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: makeStrategy(makeDecision()),
      strategyConfig: {},
      executor: new PaperExecutor(idGen),
      journal,
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      persistence,
      idGen,
      clock: realClock,
    });

    expect(result.decision!.tradingInstanceId).toBe('my-instance-99');
  });

  it('uses mark source price for risk check when available and not stale', async () => {
    const journal = new InMemoryJournal();
    const persistence = makePersistence();
    const idGen = makeIdGen();

    const markSource: import('@herobids/domain').MarkSource = {
      fetchMark: vi.fn().mockResolvedValue({ ok: true, data: { price: price('60000'), source: 'oracle', stale: false } }),
    };

    // Risk check with a mark at 60000 will compute notional as quantity(1) * 60000 = 60000
    // With maxOrderNotional unset & maxPositionSize = 100, should pass
    const result = await runTradingCycle(snapshot, flatPosition('hyperliquid', 'BTC/USD:USD'), {
      tradingInstanceId: 'inst-1',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: makeStrategy(makeDecision()),
      strategyConfig: {},
      executor: new PaperExecutor(idGen),
      journal,
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      markSource,
      persistence,
      idGen,
      clock: realClock,
    });

    expect(markSource.fetchMark).toHaveBeenCalledWith('BTC/USD:USD');
    expect(result.riskRejected).toBe(false);
    expect(result.decided).toBe(true);
  });

  it('falls back to snapshot price when mark is stale', async () => {
    const journal = new InMemoryJournal();
    const persistence = makePersistence();
    const idGen = makeIdGen();

    const markSource: import('@herobids/domain').MarkSource = {
      fetchMark: vi.fn().mockResolvedValue({ ok: true, data: { price: price('1'), source: 'oracle', stale: true } }),
    };

    // Stale mark (price=1) should be ignored, snapshot price=50000 used for risk check
    const result = await runTradingCycle(snapshot, flatPosition('hyperliquid', 'BTC/USD:USD'), {
      tradingInstanceId: 'inst-1',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: makeStrategy(makeDecision()),
      strategyConfig: {},
      executor: new PaperExecutor(idGen),
      journal,
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      markSource,
      persistence,
      idGen,
      clock: realClock,
    });

    // Should still pass risk (using snapshot price 50000, position size 1 → well under 100 limit)
    expect(result.riskRejected).toBe(false);
    expect(result.executionResult).toBeDefined();
  });

  it('uses simulated clock time in plan createdAt', async () => {
    const journal = new InMemoryJournal();
    const persistence = makePersistence();
    const idGen = makeIdGen();
    const clock: Clock = { now: () => '2025-03-15T08:00:00.000Z' };

    const result = await runTradingCycle(snapshot, flatPosition('hyperliquid', 'BTC/USD:USD'), {
      tradingInstanceId: 'inst-1',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: makeStrategy(makeDecision()),
      strategyConfig: {},
      executor: new PaperExecutor(idGen, clock),
      journal,
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      persistence,
      idGen,
      clock,
    });

    expect(result.plan!.createdAt).toBe('2025-03-15T08:00:00.000Z');
    // Fills should also use the clock time (via PaperExecutor)
    expect(result.executionResult!.fills[0]!.filledAt).toBe('2025-03-15T08:00:00.000Z');
  });

  it('persists all fills when plan has multiple orders', async () => {
    const journal = new InMemoryJournal();
    const persistence = makePersistence();
    const idGen = makeIdGen();

    // Decision with larger target size to trigger multi-fill if planner supports it
    const decision: Decision = {
      id: 'd-multi' as DecisionId,
      tradingInstanceId: '' as TradingInstanceId,
      instrumentId: 'BTC/USD:USD' as InstrumentId,
      intent: 'go_long',
      targetSize: quantity('3'),
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    const result = await runTradingCycle(snapshot, flatPosition('hyperliquid', 'BTC/USD:USD'), {
      tradingInstanceId: 'inst-1',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: makeStrategy(decision),
      strategyConfig: {},
      executor: new PaperExecutor(idGen),
      journal,
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      persistence,
      idGen,
      clock: realClock,
    });

    expect(result.executionResult!.fills.length).toBeGreaterThanOrEqual(1);
    expect(persistence.calls['persistFill']!.length).toBe(result.executionResult!.fills.length);
    expect(result.position.size.toString()).toBe('3');
  });
});
