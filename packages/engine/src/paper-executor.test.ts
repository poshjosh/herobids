import { describe, it, expect } from 'vitest';
import { PaperExecutor } from './paper-executor.js';
import type { ExecutionPlan } from './planner.js';
import type { OrderId, FillId, BotId } from '@herobids/domain';
import { price, quantity } from '@herobids/domain';
import type { Clock } from './trading-cycle.js';

function makeIdGen() {
  let orderCounter = 0;
  let fillCounter = 0;
  return {
    orderId: () => `order-${++orderCounter}` as OrderId,
    fillId: () => `fill-${++fillCounter}` as FillId,
  };
}

function makePlan(overrides?: Partial<ExecutionPlan>): ExecutionPlan {
  return {
    id: 'plan-1',
    decisionId: 'dec-1',
    tradingInstanceId: 'inst-1' as unknown as string,
    venue: 'hyperliquid',
    symbol: 'BTC/USD:USD',
    action: 'open_long',
    orders: [{ side: 'buy', type: 'market', quantity: quantity('1') }],
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PaperExecutor', () => {
  it('uses wall-clock time when no clock injected', async () => {
    const idGen = makeIdGen();
    const executor = new PaperExecutor(idGen);
    const plan = makePlan();
    const before = new Date().toISOString();

    const result = await executor.execute(plan, price('50000'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = new Date().toISOString();
    const fill = result.data.fills[0]!;
    // Fill timestamp should be between before and after
    expect(fill.filledAt >= before).toBe(true);
    expect(fill.filledAt <= after).toBe(true);
  });

  it('uses injected clock for fill timestamps', async () => {
    const fixedTime = '2025-06-15T10:30:00.000Z';
    const clock: Clock = { now: () => fixedTime };
    const idGen = makeIdGen();
    const executor = new PaperExecutor(idGen, clock);
    const plan = makePlan();

    const result = await executor.execute(plan, price('50000'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.fills[0]!.filledAt).toBe(fixedTime);
    expect(result.data.orders[0]!.createdAt).toBe(fixedTime);
    expect(result.data.orders[0]!.updatedAt).toBe(fixedTime);
    expect(result.data.plan.completedAt).toBe(fixedTime);
  });

  it('fills market orders at current price', async () => {
    const idGen = makeIdGen();
    const executor = new PaperExecutor(idGen);
    const plan = makePlan({
      orders: [{ side: 'buy', type: 'market', quantity: quantity('2') }],
    });

    const result = await executor.execute(plan, price('42000'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.fills[0]!.price.toString()).toBe('42000');
    expect(result.data.fills[0]!.quantity.toString()).toBe('2');
  });

  it('fills limit orders at limit price', async () => {
    const idGen = makeIdGen();
    const executor = new PaperExecutor(idGen);
    const plan = makePlan({
      orders: [{ side: 'sell', type: 'limit', quantity: quantity('0.5'), price: price('55000') }],
    });

    const result = await executor.execute(plan, price('50000'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.fills[0]!.price.toString()).toBe('55000');
    expect(result.data.fills[0]!.side).toBe('sell');
  });

  it('fills multiple orders in a single plan', async () => {
    const idGen = makeIdGen();
    const executor = new PaperExecutor(idGen);
    const plan = makePlan({
      orders: [
        { side: 'buy', type: 'market', quantity: quantity('1') },
        { side: 'buy', type: 'market', quantity: quantity('0.5') },
      ],
    });

    const result = await executor.execute(plan, price('30000'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.fills).toHaveLength(2);
    expect(result.data.orders).toHaveLength(2);
    expect(result.data.fills[0]!.quantity.toString()).toBe('1');
    expect(result.data.fills[1]!.quantity.toString()).toBe('0.5');
  });

  it('marks plan as completed', async () => {
    const idGen = makeIdGen();
    const executor = new PaperExecutor(idGen);
    const plan = makePlan();

    const result = await executor.execute(plan, price('50000'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.plan.status).toBe('completed');
    expect(result.data.plan.completedAt).toBeDefined();
  });

  it('assigns unique IDs to each order and fill', async () => {
    const idGen = makeIdGen();
    const executor = new PaperExecutor(idGen);
    const plan = makePlan({
      orders: [
        { side: 'buy', type: 'market', quantity: quantity('1') },
        { side: 'sell', type: 'market', quantity: quantity('1') },
      ],
    });

    const result = await executor.execute(plan, price('10000'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const orderIds = result.data.orders.map((o) => o.id);
    const fillIds = result.data.fills.map((f) => f.id);
    expect(new Set(orderIds).size).toBe(2);
    expect(new Set(fillIds).size).toBe(2);
  });

  it('propagates tradingInstanceId and executionPlanId to orders', async () => {
    const idGen = makeIdGen();
    const executor = new PaperExecutor(idGen);
    const plan = makePlan({ tradingInstanceId: 'my-inst-42' });

    const result = await executor.execute(plan, price('10000'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.orders[0]!.tradingInstanceId).toBe('my-inst-42');
    expect(result.data.orders[0]!.executionPlanId).toBe('plan-1');
  });
});
