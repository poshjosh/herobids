import { describe, it, expect, vi, beforeEach } from 'vitest';
import { quantity, price } from '@herobids/domain';
import type { Decision, DecisionId, InstrumentId, VenueAccountId } from '@herobids/domain';
import { flatPosition } from './position-tracker.js';
import type { PositionState } from './position-tracker.js';
import { executeDecision } from './instrument-executor.js';
import type { InstrumentExecutorDeps } from './instrument-executor.js';
import { InMemoryJournal } from './journal-memory.js';
import type { OrderId, FillId } from '@herobids/domain';
import { DailyLossTracker } from './daily-loss-tracker.js';
import { EquityTracker } from './equity-tracker.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeIdGen() {
  let counter = 0;
  return {
    orderId: () => `order-${++counter}` as unknown as OrderId,
    fillId: () => `fill-${++counter}` as unknown as FillId,
    planId: () => `plan-${++counter}`,
    decisionId: () => `decision-${++counter}`,
  };
}

function makeDeps(overrides: Partial<InstrumentExecutorDeps> = {}): InstrumentExecutorDeps {
  const fillRepo = {
    insertFill: vi.fn().mockResolvedValue(undefined),
  };
  const orderRepo = {
    upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
    upsertByClientOrderId: vi.fn().mockResolvedValue(undefined),
  };
  const positionRepo = {
    upsert: vi.fn().mockResolvedValue(undefined),
  };

  return {
    venue: 'test-venue',
    symbol: 'BTC/USD:USD',
    venueAccountId: 'va-1',
    executionMode: 'paper',
    venueType: 'orderbook',
    riskLimits: {
      maxPositionSize: quantity('100'),
      maxOpenPositions: 5,
      maxDrawdown: price('10000'),
    },
    idGen: makeIdGen(),
    fillRepo,
    orderRepo,
    positionRepo,
    journal: new InMemoryJournal(),
    snapshotPrice: '50000',
    ...overrides,
  };
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'decision-1' as DecisionId,
    venueAccountId: 'va-1' as VenueAccountId,
    instrumentId: 'BTC/USD:USD' as InstrumentId,
    intent: 'go_long',
    targetSize: quantity('1'),
    timestamp: new Date().toISOString(),
    actorType: 'agent',
    actorId: 'agent-1',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('executeDecision', () => {
  it('paper mode produces fills for a go_long decision', async () => {
    const deps = makeDeps();
    const position = flatPosition('test-venue', 'BTC/USD:USD');
    const decision = makeDecision();

    const result = await executeDecision(decision, position, deps);

    expect(result.executed).toBe(true);
    expect(result.riskRejected).toBe(false);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.side).toBe('buy');
    expect(result.error).toBeUndefined();
  });

  it('returns newPosition reflecting the go_long fill', async () => {
    const deps = makeDeps();
    const position = flatPosition('test-venue', 'BTC/USD:USD');
    const decision = makeDecision({ targetSize: quantity('2') });

    const result = await executeDecision(decision, position, deps);

    expect(result.executed).toBe(true);
    expect(result.newPosition.side).toBe('long');
    expect(result.newPosition.size.toString()).toBe('2');
  });

  it('risk gate rejects when position size exceeds maxPositionSize', async () => {
    const deps = makeDeps({
      riskLimits: {
        maxPositionSize: quantity('0.1'),  // very small limit
        maxOpenPositions: 5,
        maxDrawdown: price('10000'),
      },
    });
    const position = flatPosition('test-venue', 'BTC/USD:USD');
    const decision = makeDecision({ targetSize: quantity('1') });

    const result = await executeDecision(decision, position, deps);

    expect(result.executed).toBe(false);
    expect(result.riskRejected).toBe(true);
    expect(result.fills).toHaveLength(0);
    expect(result.newPosition.side).toBe('flat');
  });

  it('risk gate rejects when daily loss limit is exceeded', async () => {
    const dailyLossTracker = new DailyLossTracker();
    // Record a large realized loss so the daily limit is already exceeded
    const now = Date.now();
    dailyLossTracker.recordFill(price('-900'), now);

    const equityTracker = new EquityTracker(price('1000'), price('0'));

    const deps = makeDeps({
      riskLimits: {
        maxPositionSize: quantity('100'),
        maxOpenPositions: 5,
        maxDrawdown: price('10000'),
        dailyMaxLossPct: 50,  // 50% of equity = $500; we've already lost $900
      },
      equityTracker,
      dailyLossTracker,
    });

    const position = flatPosition('test-venue', 'BTC/USD:USD');
    const decision = makeDecision();

    const result = await executeDecision(decision, position, deps);

    expect(result.executed).toBe(false);
    expect(result.riskRejected).toBe(true);
  });

  it('paper executor produces fill price close to snapshot price', async () => {
    const deps = makeDeps({ snapshotPrice: '60000' });
    const position = flatPosition('test-venue', 'BTC/USD:USD');
    const decision = makeDecision();

    const result = await executeDecision(decision, position, deps);

    expect(result.executed).toBe(true);
    const fillPrice = parseFloat(result.fills[0]!.price.toString());
    // Paper executor fills at snapshot price (no slippage by default)
    expect(fillPrice).toBe(60000);
  });

  it('fill persistence called with correct data', async () => {
    const deps = makeDeps();
    const position = flatPosition('test-venue', 'BTC/USD:USD');
    const decision = makeDecision({ targetSize: quantity('1') });

    await executeDecision(decision, position, deps);

    expect(deps.fillRepo.insertFill).toHaveBeenCalledOnce();
    const fillArg = (deps.fillRepo.insertFill as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(fillArg).toMatchObject({
      venue: 'test-venue',
      symbol: 'BTC/USD:USD',
      side: 'buy',
      quantity: '1',
    });
    expect(fillArg.filledAt).toBeInstanceOf(Date);
  });

  it('position repo called after execution to persist updated position', async () => {
    const deps = makeDeps();
    const position = flatPosition('test-venue', 'BTC/USD:USD');
    const decision = makeDecision({ targetSize: quantity('1') });

    await executeDecision(decision, position, deps);

    expect(deps.positionRepo.upsert).toHaveBeenCalledOnce();
    const posArg = (deps.positionRepo.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(posArg).toMatchObject({
      venue: 'test-venue',
      symbol: 'BTC/USD:USD',
      side: 'long',
    });
  });

  it('returns error without throwing when live mode has no venuePort', async () => {
    const deps = makeDeps({ executionMode: 'live', venueType: 'orderbook', venuePort: undefined });
    const position = flatPosition('test-venue', 'BTC/USD:USD');
    const decision = makeDecision();

    const result = await executeDecision(decision, position, deps);

    expect(result.executed).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.riskRejected).toBe(false);
  });

  it('flat go_flat decision on flat position produces no fills', async () => {
    const deps = makeDeps();
    const position = flatPosition('test-venue', 'BTC/USD:USD');
    const decision = makeDecision({ intent: 'go_flat', targetSize: quantity('0') });

    const result = await executeDecision(decision, position, deps);

    // go_flat from flat position → planner produces 0 orders → no execution
    expect(result.executed).toBe(false);
    expect(result.fills).toHaveLength(0);
    expect(result.riskRejected).toBe(false);
  });

  it('go_flat on open long position produces a sell fill', async () => {
    const deps = makeDeps();
    // Start with an open long position
    const position: PositionState = {
      venue: 'test-venue',
      symbol: 'BTC/USD:USD',
      side: 'long',
      size: quantity('1'),
      entryPrice: price('45000'),
      realizedPnl: price('0'),
    };
    const decision = makeDecision({ intent: 'go_flat', targetSize: quantity('0') });

    const result = await executeDecision(decision, position, deps);

    expect(result.executed).toBe(true);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.side).toBe('sell');
    expect(result.newPosition.side).toBe('flat');
  });

  it('shadow mode behaves identically to paper — produces fills and position updates', async () => {
    const deps = makeDeps({ executionMode: 'shadow' });
    const position = flatPosition('test-venue', 'BTC/USD:USD');
    const decision = makeDecision({ targetSize: quantity('2') });

    const result = await executeDecision(decision, position, deps);

    expect(result.executed).toBe(true);
    expect(result.riskRejected).toBe(false);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.side).toBe('buy');
    expect(result.newPosition.side).toBe('long');
    expect(result.newPosition.size.toString()).toBe('2');
    expect(deps.fillRepo.insertFill).toHaveBeenCalledOnce();
    expect(deps.positionRepo.upsert).toHaveBeenCalledOnce();
  });

  it('maxOpenPositions limit: rejects when openPositionCount >= maxOpenPositions', async () => {
    const deps = makeDeps({
      riskLimits: {
        maxPositionSize: quantity('100'),
        maxOpenPositions: 2,
        maxDrawdown: price('10000'),
      },
      // 2 open positions already, at the limit
      openPositionCount: 2,
    });
    const position = flatPosition('test-venue', 'BTC/USD:USD');
    const decision = makeDecision({ intent: 'go_long', targetSize: quantity('1') });

    const result = await executeDecision(decision, position, deps);

    expect(result.riskRejected).toBe(true);
    expect(result.executed).toBe(false);
    expect(result.fills).toHaveLength(0);
  });
});
