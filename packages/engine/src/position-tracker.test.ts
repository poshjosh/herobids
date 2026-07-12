import { describe, it, expect } from 'vitest';
import { flatPosition, applyFill, unrealizedPnl, totalUnrealizedPnl } from './position-tracker.js';
import type { FillEvent } from './order-state.js';
import type { OrderId, FillId, BotId } from '@herobids/domain';
import { quantity, price, Decimal } from '@herobids/domain';

function makeFill(overrides: Partial<FillEvent> = {}): FillEvent {
  return {
    id: 'fill-1' as FillId,
    orderId: 'ord-1' as OrderId,
    botId: 'ti-1' as BotId,
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

    it('accepts optional instrumentId', () => {
      const pos = flatPosition('hyperliquid', 'BTC/USD:USD', 'BTC-USD');
      expect(pos.instrumentId).toBe('BTC-USD');
    });

    it('is backward-compatible without instrumentId', () => {
      const pos = flatPosition('hyperliquid', 'BTC/USD:USD');
      expect(pos.instrumentId).toBeUndefined();
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

    it('preserves instrumentId through applyFill operations', () => {
      // Open with instrumentId
      const pos = flatPosition('hyperliquid', 'BTC/USD:USD', 'BTC-USD');
      const opened = applyFill(pos, makeFill({ side: 'buy', quantity: quantity('2'), price: price('30000') }));
      expect(opened.instrumentId).toBe('BTC-USD');

      // Increase
      const increased = applyFill(opened, makeFill({ side: 'buy', quantity: quantity('1'), price: price('31000') }));
      expect(increased.instrumentId).toBe('BTC-USD');

      // Partial close
      const reduced = applyFill(increased, makeFill({ side: 'sell', quantity: quantity('1'), price: price('32000') }));
      expect(reduced.instrumentId).toBe('BTC-USD');

      // Full close
      const closed = applyFill(reduced, makeFill({ side: 'sell', quantity: quantity('2'), price: price('33000') }));
      expect(closed.instrumentId).toBe('BTC-USD');
    });

    it('preserves instrumentId through reversal', () => {
      const pos = flatPosition('hyperliquid', 'BTC/USD:USD', 'BTC-USD');
      const opened = applyFill(pos, makeFill({ side: 'buy', quantity: quantity('2'), price: price('30000') }));
      // Reverse from long to short
      const reversed = applyFill(opened, makeFill({ side: 'sell', quantity: quantity('5'), price: price('31000') }));
      expect(reversed.side).toBe('short');
      expect(reversed.instrumentId).toBe('BTC-USD');
    });
  });

  describe('unrealizedPnl', () => {
    it('returns 0 for flat position', () => {
      const pos = flatPosition('hyperliquid', 'BTC/USD:USD');
      expect(unrealizedPnl(pos, price('60000')).isZero()).toBe(true);
    });

    it('computes profit for long when mark > entry', () => {
      const pos = applyFill(flatPosition('hyperliquid', 'BTC/USD:USD'), makeFill({ side: 'buy', quantity: quantity('2'), price: price('30000') }));
      // (32000 - 30000) * 2 = 4000
      expect(unrealizedPnl(pos, price('32000')).eq(new Decimal(4000))).toBe(true);
    });

    it('computes loss for long when mark < entry', () => {
      const pos = applyFill(flatPosition('hyperliquid', 'BTC/USD:USD'), makeFill({ side: 'buy', quantity: quantity('2'), price: price('30000') }));
      // (28000 - 30000) * 2 = -4000
      expect(unrealizedPnl(pos, price('28000')).eq(new Decimal(-4000))).toBe(true);
    });

    it('computes profit for short when mark < entry', () => {
      const pos = applyFill(flatPosition('hyperliquid', 'BTC/USD:USD'), makeFill({ side: 'sell', quantity: quantity('3'), price: price('30000') }));
      // (30000 - 28000) * 3 = 6000
      expect(unrealizedPnl(pos, price('28000')).eq(new Decimal(6000))).toBe(true);
    });

    it('computes loss for short when mark > entry', () => {
      const pos = applyFill(flatPosition('hyperliquid', 'BTC/USD:USD'), makeFill({ side: 'sell', quantity: quantity('3'), price: price('30000') }));
      // (30000 - 32000) * 3 = -6000
      expect(unrealizedPnl(pos, price('32000')).eq(new Decimal(-6000))).toBe(true);
    });
  });

  describe('totalUnrealizedPnl', () => {
    it('sums across multiple positions', () => {
      const long = applyFill(flatPosition('hyperliquid', 'BTC/USD:USD'), makeFill({ side: 'buy', quantity: quantity('1'), price: price('30000') }));
      const short = applyFill(flatPosition('hyperliquid', 'ETH/USD:USD'), makeFill({ side: 'sell', quantity: quantity('10'), price: price('2000') }));
      const flat = flatPosition('hyperliquid', 'SOL/USD:USD');
      // long: (31000-30000)*1 = 1000, short: (2000-1900)*10 = 1000
      // Using markPrice 31000 for simplicity (applies to all — in practice each would have its own mark)
      // long unrealized: (31000-30000)*1=1000
      // short unrealized: (2000-31000)*10 = big loss. Let's use a uniform mark for test
      const total = totalUnrealizedPnl([long, short, flat], price('31000'));
      // long: +1000, short: (2000 - 31000) * 10 = -290000
      expect(total.eq(new Decimal(-289000))).toBe(true);
    });

    it('returns 0 when all positions are flat', () => {
      const flat1 = flatPosition('hyperliquid', 'BTC/USD:USD');
      const flat2 = flatPosition('hyperliquid', 'ETH/USD:USD');
      expect(totalUnrealizedPnl([flat1, flat2], price('50000')).isZero()).toBe(true);
    });
  });
});
