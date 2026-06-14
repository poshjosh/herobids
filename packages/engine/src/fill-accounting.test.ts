import { describe, expect, it } from 'vitest';
import { Decimal, price, quantity } from '@herobids/domain';
import type { FillEvent } from './order-state.js';
import type { FillId, OrderId } from '@herobids/domain';
import { applyFill, flatPosition } from './position-tracker.js';
import { DailyLossTracker } from './daily-loss-tracker.js';
import { applyFillAccounting } from './fill-accounting.js';

function makeFill(overrides: Partial<FillEvent> = {}): FillEvent {
  return {
    id: 'fill-1' as FillId,
    orderId: 'ord-1' as OrderId,
    venue: 'hyperliquid',
    symbol: 'BTC/USD:USD',
    side: 'sell',
    quantity: quantity('1'),
    price: price('90'),
    fee: quantity('1'),
    filledAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('applyFillAccounting', () => {
  it('records daily loss using the fill timestamp by default', () => {
    const tracker = new DailyLossTracker();
    const opened = applyFill(
      flatPosition('hyperliquid', 'BTC/USD:USD'),
      makeFill({ side: 'buy', price: price('100'), fee: quantity('0') }),
    );

    applyFillAccounting(opened, makeFill(), {
      dailyLossTracker: tracker,
    });

    expect(tracker.rollingLoss(Date.parse('2026-01-01T23:00:00.000Z')).eq(new Decimal(11))).toBe(true);
    expect(tracker.rollingLoss(Date.parse('2026-01-02T01:00:01.000Z')).isZero()).toBe(true);
  });
});