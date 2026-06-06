import { describe, it, expect } from 'vitest';
import { planDecision } from './planner.js';
import type { Decision } from '@herobids/domain';
import type { DecisionId, InstrumentId, BotId } from '@herobids/domain';
import { quantity, price, Decimal } from '@herobids/domain';

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'dec-1' as DecisionId,
    botId: 'ti-1' as BotId,
    instrumentId: 'ins-1' as InstrumentId,
    intent: 'go_long',
    targetSize: quantity('10'),
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const baseDeps = { venue: 'hyperliquid', symbol: 'BTC/USD:USD', currentPosition: null };

describe('planDecision', () => {
  it('go_long from flat → open_long with buy order', () => {
    const plan = planDecision(makeDecision({ intent: 'go_long', targetSize: quantity('5') }), baseDeps);
    expect(plan.action).toBe('open_long');
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].side).toBe('buy');
    expect(plan.orders[0].quantity.eq(new Decimal(5))).toBe(true);
    expect(plan.orders[0].type).toBe('market');
  });

  it('go_long with limitPrice → limit order', () => {
    const plan = planDecision(
      makeDecision({ intent: 'go_long', targetSize: quantity('5'), limitPrice: price('30000') }),
      baseDeps,
    );
    expect(plan.orders[0].type).toBe('limit');
    expect(plan.orders[0].price!.eq(new Decimal(30000))).toBe(true);
  });

  it('go_short from flat → open_short with sell order', () => {
    const plan = planDecision(makeDecision({ intent: 'go_short', targetSize: quantity('3') }), baseDeps);
    expect(plan.action).toBe('open_short');
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].side).toBe('sell');
    expect(plan.orders[0].quantity.eq(new Decimal(3))).toBe(true);
  });

  it('go_flat from long → close with sell order', () => {
    const plan = planDecision(
      makeDecision({ intent: 'go_flat', targetSize: quantity('0') }),
      {
        ...baseDeps,
        currentPosition: { symbol: 'BTC/USD:USD', side: 'long', size: quantity('5'), entryPrice: price('30000') },
      },
    );
    expect(plan.action).toBe('close');
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].side).toBe('sell');
    expect(plan.orders[0].quantity.eq(new Decimal(5))).toBe(true);
  });

  it('go_flat from flat → no orders', () => {
    const plan = planDecision(makeDecision({ intent: 'go_flat', targetSize: quantity('0') }), baseDeps);
    expect(plan.action).toBe('close');
    expect(plan.orders).toHaveLength(0);
  });

  it('go_long from short → reverse (close short + open long)', () => {
    const plan = planDecision(
      makeDecision({ intent: 'go_long', targetSize: quantity('2') }),
      {
        ...baseDeps,
        currentPosition: { symbol: 'BTC/USD:USD', side: 'short', size: quantity('3'), entryPrice: price('30000') },
      },
    );
    expect(plan.action).toBe('reverse');
    expect(plan.orders).toHaveLength(2);
    // First order: close short (buy 3)
    expect(plan.orders[0].side).toBe('buy');
    expect(plan.orders[0].quantity.eq(new Decimal(3))).toBe(true);
    // Second order: open long (buy 2)
    expect(plan.orders[1].side).toBe('buy');
    expect(plan.orders[1].quantity.eq(new Decimal(2))).toBe(true);
  });

  it('increase from existing long → buy deficit', () => {
    const plan = planDecision(
      makeDecision({ intent: 'increase', targetSize: quantity('8') }),
      {
        ...baseDeps,
        currentPosition: { symbol: 'BTC/USD:USD', side: 'long', size: quantity('5'), entryPrice: price('30000') },
      },
    );
    expect(plan.action).toBe('increase');
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].side).toBe('buy');
    expect(plan.orders[0].quantity.eq(new Decimal(3))).toBe(true);
  });

  it('decrease from existing long → sell excess', () => {
    const plan = planDecision(
      makeDecision({ intent: 'decrease', targetSize: quantity('2') }),
      {
        ...baseDeps,
        currentPosition: { symbol: 'BTC/USD:USD', side: 'long', size: quantity('5'), entryPrice: price('30000') },
      },
    );
    expect(plan.action).toBe('reduce');
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].side).toBe('sell');
    expect(plan.orders[0].quantity.eq(new Decimal(3))).toBe(true);
  });

  // --- swapParams ---

  it('emits swapParams on buy order when venueType=swap and swapAssets configured', () => {
    const plan = planDecision(
      makeDecision({ intent: 'go_long', targetSize: quantity('5') }),
      { ...baseDeps, venueType: 'swap', swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC' } },
    );
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].type).toBe('swap');
    expect(plan.orders[0].swapParams).toEqual({
      inputAsset: 'USDC',
      outputAsset: 'SOL',
      amount: plan.orders[0].quantity,
    });
  });

  it('emits swapParams on sell order when venueType=swap and swapAssets configured', () => {
    const plan = planDecision(
      makeDecision({ intent: 'go_flat', targetSize: quantity('0') }),
      {
        ...baseDeps,
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC' },
        currentPosition: { symbol: 'SOL/USDC', side: 'long', size: quantity('3'), entryPrice: price('150') },
      },
    );
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].side).toBe('sell');
    expect(plan.orders[0].swapParams).toEqual({
      inputAsset: 'SOL',
      outputAsset: 'USDC',
      amount: plan.orders[0].quantity,
    });
  });

  it('does not open a short from flat when venueType=swap', () => {
    const plan = planDecision(
      makeDecision({ intent: 'go_short', targetSize: quantity('3') }),
      { ...baseDeps, venueType: 'swap', swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC' } },
    );
    expect(plan.action).toBe('close');
    expect(plan.orders).toHaveLength(0);
  });

  it('closes an existing long without reversing into short when venueType=swap', () => {
    const plan = planDecision(
      makeDecision({ intent: 'go_short', targetSize: quantity('2') }),
      {
        ...baseDeps,
        symbol: 'SOL/USDC',
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC' },
        currentPosition: { symbol: 'SOL/USDC', side: 'long', size: quantity('3'), entryPrice: price('150') },
      },
    );
    expect(plan.action).toBe('close');
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].side).toBe('sell');
    expect(plan.orders[0].quantity.eq(new Decimal(3))).toBe(true);
    expect(plan.orders[0].type).toBe('swap');
  });

  it('emits swapParams on each order for a reverse (close + open)', () => {
    const plan = planDecision(
      makeDecision({ intent: 'go_long', targetSize: quantity('2') }),
      {
        ...baseDeps,
        venueType: 'swap',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC' },
        currentPosition: { symbol: 'SOL/USDC', side: 'short', size: quantity('3'), entryPrice: price('150') },
      },
    );
    expect(plan.orders).toHaveLength(2);
    // Both orders are buys for a reverse from short → long
    for (const order of plan.orders) {
      expect(order.swapParams).toBeDefined();
      expect(order.swapParams!.inputAsset).toBe('USDC');
      expect(order.swapParams!.outputAsset).toBe('SOL');
    }
  });

  it('does not emit swapParams when venueType=swap but swapAssets not configured', () => {
    const plan = planDecision(
      makeDecision({ intent: 'go_long', targetSize: quantity('5') }),
      { ...baseDeps, venueType: 'swap' },
    );
    expect(plan.orders[0].swapParams).toBeUndefined();
  });

  it('does not emit swapParams when venueType=orderbook even if swapAssets provided', () => {
    const plan = planDecision(
      makeDecision({ intent: 'go_long', targetSize: quantity('5') }),
      { ...baseDeps, venueType: 'orderbook', swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC' } },
    );
    expect(plan.orders[0].swapParams).toBeUndefined();
  });
});
