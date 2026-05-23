import { describe, it, expect } from 'vitest';
import { flatPosition, applyFill } from './position-tracker.js';
import type { FillEvent } from './order-state.js';
import type { OrderId, FillId, TradingInstanceId } from '@herobids/domain';
import { quantity, price, Decimal } from '@herobids/domain';

function makeFill(overrides: Partial<FillEvent> = {}): FillEvent {
  return {
    id: 'fill-1' as FillId,
    orderId: 'ord-1' as OrderId,
    tradingInstanceId: 'ti-1' as TradingInstanceId,
    venue: 'hyperliquid',
    symbol: 'BTC/USD:USD',
    side: 'buy',
    quantity: quantity('1'),
    price: price('30000'),
    filledAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('Position Tracker', () => {
  describe('flatPosition', () => {
    it('creates a flat position with zero size', () => {
      const pos = flatPosition('hyperliquid', 'BTC/USD:USD');
      expect(pos.side).toBe('flat');
      expect(pos.size.isZero()).toBe(true);
      expect(pos.entryPrice.isZero()).toBe(true);
      expect(pos.realizedPnl.isZero()).toBe(true);
    });
  });

  describe('applyFill', () => {
    it('opens a long position from flat', () => {
      const pos = flatPosition('hyperliquid', 'BTC/USD:USD');
      const result = applyFill(pos, makeFill({ side: 'buy', quantity: quantity('2'), price: price('30000') }));
      expect(result.side).toBe('long');
      expect(result.size.eq(new Decimal(2))).toBe(true);
      expect(result.entryPrice.eq(new Decimal(30000))).toBe(true);
    });

    it('opens a short position from flat', () => {
      const pos = flatPosition('hyperliquid', 'BTC/USD:USD');
      const result = applyFill(pos, makeFill({ side: 'sell', quantity: quantity('3'), price: price('29000') }));
      expect(result.side).toBe('short');
      expect(result.size.eq(new Decimal(3))).toBe(true);
      expect(result.entryPrice.eq(new Decimal(29000))).toBe(true);
    });

    it('increases a long position with weighted average entry', () => {
      const pos = applyFill(flatPosition('hyperliquid', 'BTC/USD:USD'), makeFill({ side: 'buy', quantity: quantity('2'), price: price('30000') }));
      const result = applyFill(pos, makeFill({ side: 'buy', quantity: quantity('2'), price: price('32000') }));
      expect(result.side).toBe('long');
      expect(result.size.eq(new Decimal(4))).toBe(true);
      // (30000*2 + 32000*2) / 4 = 31000
      expect(result.entryPrice.eq(new Decimal(31000))).toBe(true);
    });

    it('partially closes a long position with realized PnL', () => {
      const pos = applyFill(flatPosition('hyperliquid', 'BTC/USD:USD'), makeFill({ side: 'buy', quantity: quantity('4'), price: price('30000') }));
      const result = applyFill(pos, makeFill({ side: 'sell', quantity: quantity('2'), price: price('31000') }));
      expect(result.side).toBe('long');
      expect(result.size.eq(new Decimal(2))).toBe(true);
      // PnL: (31000-30000) * 2 = 2000
      expect(result.realizedPnl.eq(new Decimal(2000))).toBe(true);
      expect(result.entryPrice.eq(new Decimal(30000))).toBe(true);
    });

    it('fully closes a long position', () => {
      const pos = applyFill(flatPosition('hyperliquid', 'BTC/USD:USD'), makeFill({ side: 'buy', quantity: quantity('3'), price: price('30000') }));
      const result = applyFill(pos, makeFill({ side: 'sell', quantity: quantity('3'), price: price('29000') }));
      expect(result.side).toBe('flat');
      expect(result.size.isZero()).toBe(true);
      // PnL: (29000-30000) * 3 = -3000
      expect(result.realizedPnl.eq(new Decimal(-3000))).toBe(true);
    });

    it('reverses from long to short', () => {
      const pos = applyFill(flatPosition('hyperliquid', 'BTC/USD:USD'), makeFill({ side: 'buy', quantity: quantity('2'), price: price('30000') }));
      const result = applyFill(pos, makeFill({ side: 'sell', quantity: quantity('5'), price: price('31000') }));
      expect(result.side).toBe('short');
      expect(result.size.eq(new Decimal(3))).toBe(true);
      expect(result.entryPrice.eq(new Decimal(31000))).toBe(true);
      // PnL from closing long: (31000-30000)*2 = 2000
      expect(result.realizedPnl.eq(new Decimal(2000))).toBe(true);
    });

    it('partially closes a short with positive PnL', () => {
      const pos = applyFill(flatPosition('hyperliquid', 'BTC/USD:USD'), makeFill({ side: 'sell', quantity: quantity('4'), price: price('30000') }));
      const result = applyFill(pos, makeFill({ side: 'buy', quantity: quantity('2'), price: price('28000') }));
      expect(result.side).toBe('short');
      expect(result.size.eq(new Decimal(2))).toBe(true);
      // Short PnL: (30000-28000)*2 = 4000
      expect(result.realizedPnl.eq(new Decimal(4000))).toBe(true);
    });
  });
});
