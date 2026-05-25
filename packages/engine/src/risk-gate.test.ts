import { describe, it, expect } from 'vitest';
import { checkRisk } from './risk-gate.js';
import type { RiskLimits, RiskSnapshot } from './risk-gate.js';
import type { ExecutionPlan } from './planner.js';
import { flatPosition } from './position-tracker.js';
import { quantity, price, Decimal } from '@herobids/domain';

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    id: 'plan-1',
    decisionId: 'dec-1',
    tradingInstanceId: 'ti-1',
    venue: 'hyperliquid',
    symbol: 'BTC/USD:USD',
    action: 'open_long',
    orders: [{ side: 'buy', type: 'market', quantity: quantity('2') }],
    status: 'pending',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const baseLimits: RiskLimits = {
  maxPositionSize: quantity('10'),
  maxOpenPositions: 5,
  maxDrawdown: price('5000'),
};

const baseSnapshot: RiskSnapshot = {
  currentPosition: null,
  openPositionCount: 0,
  currentDrawdown: price('0'),
};

describe('Risk Gate', () => {
  it('passes when all limits respected', () => {
    const result = checkRisk(makePlan(), baseLimits, baseSnapshot);
    expect(result.ok).toBe(true);
  });

  it('rejects when max drawdown exceeded', () => {
    const result = checkRisk(makePlan(), baseLimits, {
      ...baseSnapshot,
      currentDrawdown: price('5000'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.max_drawdown_exceeded');
    }
  });

  it('rejects when max open positions exceeded on new open', () => {
    const result = checkRisk(
      makePlan({ action: 'open_long' }),
      baseLimits,
      { ...baseSnapshot, openPositionCount: 5 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.max_open_positions_exceeded');
    }
  });

  it('allows reduce even when max open positions reached', () => {
    const result = checkRisk(
      makePlan({ action: 'reduce', orders: [{ side: 'sell', type: 'market', quantity: quantity('1') }] }),
      baseLimits,
      {
        ...baseSnapshot,
        openPositionCount: 5,
        currentPosition: { venue: 'hyperliquid', symbol: 'BTC/USD:USD', side: 'long', size: quantity('3'), entryPrice: price('30000'), realizedPnl: price('0') },
      },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects when resulting position size exceeds limit', () => {
    const result = checkRisk(
      makePlan({ orders: [{ side: 'buy', type: 'market', quantity: quantity('8') }] }),
      baseLimits,
      {
        ...baseSnapshot,
        currentPosition: { venue: 'hyperliquid', symbol: 'BTC/USD:USD', side: 'long', size: quantity('5'), entryPrice: price('30000'), realizedPnl: price('0') },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.max_position_size_exceeded');
    }
  });

  it('allows position size within limit', () => {
    const result = checkRisk(
      makePlan({ orders: [{ side: 'buy', type: 'market', quantity: quantity('5') }] }),
      baseLimits,
      {
        ...baseSnapshot,
        currentPosition: { venue: 'hyperliquid', symbol: 'BTC/USD:USD', side: 'long', size: quantity('5'), entryPrice: price('30000'), realizedPnl: price('0') },
      },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects when order notional exceeds limit', () => {
    const result = checkRisk(
      makePlan({ orders: [{ side: 'buy', type: 'limit', quantity: quantity('2'), price: price('50000') }] }),
      { ...baseLimits, maxOrderNotional: price('80000') },
      baseSnapshot,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.max_order_notional_exceeded');
    }
  });

  it('rejects notional check when no price and no referenceMark on market order (fail closed)', () => {
    const result = checkRisk(
      makePlan({ orders: [{ side: 'buy', type: 'market', quantity: quantity('2') }] }),
      { ...baseLimits, maxOrderNotional: price('80000') },
      baseSnapshot,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.no_mark_for_notional');
    }
  });

  it('passes notional check on market order when referenceMark provided', () => {
    const result = checkRisk(
      makePlan({ orders: [{ side: 'buy', type: 'market', quantity: quantity('2') }] }),
      { ...baseLimits, maxOrderNotional: price('80000') },
      { ...baseSnapshot, referenceMark: price('30000') },
    );
    expect(result.ok).toBe(true);
  });

  // --- dailyMaxLossPct ---

  it('rejects when daily loss exceeds dailyMaxLossPct of equity', () => {
    const result = checkRisk(makePlan(), {
      ...baseLimits,
      dailyMaxLossPct: 10,
    }, {
      ...baseSnapshot,
      equity: price('10000'),
      dailyLoss: price('1000'), // exactly 10%
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.daily_max_loss_exceeded');
    }
  });

  it('passes when daily loss is below dailyMaxLossPct', () => {
    const result = checkRisk(makePlan(), {
      ...baseLimits,
      dailyMaxLossPct: 10,
    }, {
      ...baseSnapshot,
      equity: price('10000'),
      dailyLoss: price('999'),
    });
    expect(result.ok).toBe(true);
  });

  // --- stopLossCooldownMs ---

  it('rejects entry when stop-loss cooldown has not elapsed', () => {
    const now = 1700000000000;
    const result = checkRisk(makePlan(), {
      ...baseLimits,
      stopLossCooldownMs: 1800000, // 30 min
    }, {
      ...baseSnapshot,
      lastStopLossExitMs: now - 600000, // 10 min ago
      nowMs: now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.stop_loss_cooldown');
    }
  });

  it('passes when stop-loss cooldown has fully elapsed', () => {
    const now = 1700000000000;
    const result = checkRisk(makePlan(), {
      ...baseLimits,
      stopLossCooldownMs: 1800000,
    }, {
      ...baseSnapshot,
      lastStopLossExitMs: now - 1800001, // just over 30 min ago
      nowMs: now,
    });
    expect(result.ok).toBe(true);
  });

  // --- maxPositionSizePct ---

  it('rejects when resulting position notional exceeds maxPositionSizePct of equity', () => {
    const result = checkRisk(
      makePlan({ orders: [{ side: 'buy', type: 'limit', quantity: quantity('5'), price: price('50000') }] }),
      { ...baseLimits, maxPositionSizePct: 33 },
      { ...baseSnapshot, equity: price('500000') },
    );
    // 5 * 50000 = 250000 notional, 33% of 500000 = 165000 → should reject
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.max_position_size_pct_exceeded');
    }
  });

  it('passes when resulting position notional is within maxPositionSizePct', () => {
    const result = checkRisk(
      makePlan({ orders: [{ side: 'buy', type: 'limit', quantity: quantity('1'), price: price('50000') }] }),
      { ...baseLimits, maxPositionSizePct: 33 },
      { ...baseSnapshot, equity: price('500000') },
    );
    // 1 * 50000 = 50000 notional, 33% of 500000 = 165000 → should pass
    expect(result.ok).toBe(true);
  });

  // --- referenceMark edge cases ---

  it('referenceMark overrides order.price for maxOrderNotional check', () => {
    // order.price = 50000 (would pass: 2*50000=100000 < 120000)
    // referenceMark = 70000 (should reject: 2*70000=140000 > 120000)
    const result = checkRisk(
      makePlan({ orders: [{ side: 'buy', type: 'limit', quantity: quantity('2'), price: price('50000') }] }),
      { ...baseLimits, maxOrderNotional: price('120000') },
      { ...baseSnapshot, referenceMark: price('70000') },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.max_order_notional_exceeded');
    }
  });

  it('referenceMark overrides order.price for maxPositionSizePct check', () => {
    // order.price = 10000 → notional 1*10000=10000 (would pass at 33% of 500000 = 165000)
    // referenceMark = 200000 → notional 1*200000=200000 > 165000 → reject
    const result = checkRisk(
      makePlan({ orders: [{ side: 'buy', type: 'limit', quantity: quantity('1'), price: price('10000') }] }),
      { ...baseLimits, maxPositionSizePct: 33 },
      { ...baseSnapshot, equity: price('500000'), referenceMark: price('200000') },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.max_position_size_pct_exceeded');
    }
  });

  it('fails closed for maxPositionSizePct when no mark and no order price', () => {
    const result = checkRisk(
      makePlan({ orders: [{ side: 'buy', type: 'market', quantity: quantity('1') }] }),
      { ...baseLimits, maxPositionSizePct: 33 },
      { ...baseSnapshot, equity: price('500000') },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.no_mark_for_notional');
    }
  });

  it('uses referenceMark for maxPositionSizePct on market order (no order.price)', () => {
    const result = checkRisk(
      makePlan({ orders: [{ side: 'buy', type: 'market', quantity: quantity('1') }] }),
      { ...baseLimits, maxPositionSizePct: 33 },
      { ...baseSnapshot, equity: price('500000'), referenceMark: price('50000') },
    );
    // 1 * 50000 = 50000 < 165000 → pass
    expect(result.ok).toBe(true);
  });

  it('falls back to order.price when referenceMark absent but order has price', () => {
    const result = checkRisk(
      makePlan({ orders: [{ side: 'buy', type: 'limit', quantity: quantity('2'), price: price('50000') }] }),
      { ...baseLimits, maxOrderNotional: price('120000') },
      baseSnapshot, // no referenceMark
    );
    // 2 * 50000 = 100000 < 120000 → pass
    expect(result.ok).toBe(true);
  });

  it('uses order.price when it exceeds referenceMark for maxOrderNotional (worst-case)', () => {
    // referenceMark = 40000 (would pass: 2*40000=80000 < 120000)
    // order.price = 65000 → max(40000, 65000)=65000 → 2*65000=130000 > 120000 → reject
    const result = checkRisk(
      makePlan({ orders: [{ side: 'buy', type: 'limit', quantity: quantity('2'), price: price('65000') }] }),
      { ...baseLimits, maxOrderNotional: price('120000') },
      { ...baseSnapshot, referenceMark: price('40000') },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('risk.max_order_notional_exceeded');
    }
  });
});
