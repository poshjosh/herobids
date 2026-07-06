import { describe, it, expect } from 'vitest';
import { price, quantity, Decimal } from '@herobids/domain';
import { flatPosition, applyFill } from './position-tracker.js';
import { checkStopLoss, checkPerTradeLevels } from './stop-loss-monitor.js';
import type { PerTradeLevelCheck } from './stop-loss-monitor.js';
import type { FillEvent } from './order-state.js';
import type { OrderId, FillId, BotId } from '@herobids/domain';

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

describe('Stop-loss monitor', () => {
  it('does not trigger when within threshold', () => {
    const pos = applyFill(flatPosition('hyperliquid', 'BTC/USD:USD'), makeFill({ side: 'buy', quantity: quantity('1'), price: price('100') }));
    // Mark is 95 → loss = 5, equity = 1000, threshold = 10% = 100 → NOT triggered
    const result = checkStopLoss(
      { maxUnrealizedLossPct: 10 },
      [{ instrument: 'BTC/USD:USD', position: pos, markPrice: price('95'), equity: price('1000') }],
    );
    expect(result.triggered).toBe(false);
  });

  it('triggers when unrealized loss exceeds threshold', () => {
    const pos = applyFill(flatPosition('hyperliquid', 'BTC/USD:USD'), makeFill({ side: 'buy', quantity: quantity('10'), price: price('100') }));
    // Mark is 85 → loss = (100-85)*10 = 150, equity = 1000, threshold = 10% = 100 → TRIGGERED
    const result = checkStopLoss(
      { maxUnrealizedLossPct: 10 },
      [{ instrument: 'BTC/USD:USD', position: pos, markPrice: price('85'), equity: price('1000') }],
    );
    expect(result.triggered).toBe(true);
    expect(result.instrument).toBe('BTC/USD:USD');
    expect(result.unrealizedLoss!.eq(new Decimal(150))).toBe(true);
    expect(result.threshold!.eq(new Decimal(100))).toBe(true);
  });

  it('disabled when maxUnrealizedLossPct = 0', () => {
    const pos = applyFill(flatPosition('hyperliquid', 'BTC/USD:USD'), makeFill({ side: 'buy', quantity: quantity('10'), price: price('100') }));
    const result = checkStopLoss(
      { maxUnrealizedLossPct: 0 },
      [{ instrument: 'BTC/USD:USD', position: pos, markPrice: price('1'), equity: price('1000') }],
    );
    expect(result.triggered).toBe(false);
  });

  it('does not trigger for profitable positions', () => {
    const pos = applyFill(flatPosition('hyperliquid', 'BTC/USD:USD'), makeFill({ side: 'buy', quantity: quantity('1'), price: price('100') }));
    const result = checkStopLoss(
      { maxUnrealizedLossPct: 5 },
      [{ instrument: 'BTC/USD:USD', position: pos, markPrice: price('120'), equity: price('1000') }],
    );
    expect(result.triggered).toBe(false);
  });

  it('triggers on short position loss', () => {
    const pos = applyFill(flatPosition('hyperliquid', 'ETH/USD:USD'), makeFill({ side: 'sell', quantity: quantity('5'), price: price('2000') }));
    // Mark is 2100 → loss = (2100-2000)*5 = 500, equity = 5000, threshold = 5% = 250 → TRIGGERED
    const result = checkStopLoss(
      { maxUnrealizedLossPct: 5 },
      [{ instrument: 'ETH/USD:USD', position: pos, markPrice: price('2100'), equity: price('5000') }],
    );
    expect(result.triggered).toBe(true);
    expect(result.instrument).toBe('ETH/USD:USD');
  });

  it('skips flat positions', () => {
    const flat = flatPosition('hyperliquid', 'BTC/USD:USD');
    const result = checkStopLoss(
      { maxUnrealizedLossPct: 1 },
      [{ instrument: 'BTC/USD:USD', position: flat, markPrice: price('50000'), equity: price('1000') }],
    );
    expect(result.triggered).toBe(false);
  });
});

// ── Per-trade stop-loss / take-profit ──

function mkCheck(overrides: Partial<PerTradeLevelCheck> = {}): PerTradeLevelCheck {
  return {
    instrument: 'BTC/USD:USD',
    side: 'long',
    markPrice: price('100'),
    stopLoss: price('95'),
    takeProfit: price('110'),
    ...overrides,
  };
}

describe('checkPerTradeLevels', () => {
  describe('long stop-loss', () => {
    it('triggers when mark ≤ stopLoss', () => {
      const result = checkPerTradeLevels([
        mkCheck({ markPrice: price('95'), stopLoss: price('95') }),
      ]);
      expect(result.triggered).toBe(true);
      expect(result.instrument).toBe('BTC/USD:USD');
      expect(result.reason).toBe('stop_loss');
      expect(result.level!.eq(price('95'))).toBe(true);
    });

    it('triggers when mark < stopLoss', () => {
      const result = checkPerTradeLevels([
        mkCheck({ markPrice: price('94'), stopLoss: price('95') }),
      ]);
      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('stop_loss');
    });

    it('does NOT trigger when mark > stopLoss', () => {
      const result = checkPerTradeLevels([
        mkCheck({ markPrice: price('96'), stopLoss: price('95') }),
      ]);
      expect(result.triggered).toBe(false);
    });
  });

  describe('short stop-loss', () => {
    it('triggers when mark ≥ stopLoss', () => {
      const result = checkPerTradeLevels([
        mkCheck({ side: 'short', markPrice: price('105'), stopLoss: price('105') }),
      ]);
      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('stop_loss');
    });

    it('triggers when mark > stopLoss', () => {
      const result = checkPerTradeLevels([
        mkCheck({ side: 'short', markPrice: price('106'), stopLoss: price('105') }),
      ]);
      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('stop_loss');
    });

    it('does NOT trigger when mark < stopLoss', () => {
      const result = checkPerTradeLevels([
        mkCheck({ side: 'short', markPrice: price('104'), stopLoss: price('105'), takeProfit: undefined }),
      ]);
      expect(result.triggered).toBe(false);
    });
  });

  describe('long take-profit', () => {
    it('triggers when mark ≥ takeProfit', () => {
      const result = checkPerTradeLevels([
        mkCheck({ markPrice: price('110'), takeProfit: price('110') }),
      ]);
      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('take_profit');
      expect(result.level!.eq(price('110'))).toBe(true);
    });

    it('triggers when mark > takeProfit', () => {
      const result = checkPerTradeLevels([
        mkCheck({ markPrice: price('111'), takeProfit: price('110') }),
      ]);
      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('take_profit');
    });

    it('does NOT trigger when mark < takeProfit', () => {
      const result = checkPerTradeLevels([
        mkCheck({ markPrice: price('109'), takeProfit: price('110') }),
      ]);
      expect(result.triggered).toBe(false);
    });
  });

  describe('short take-profit', () => {
    it('triggers when mark ≤ takeProfit', () => {
      const result = checkPerTradeLevels([
        mkCheck({ side: 'short', markPrice: price('90'), takeProfit: price('90') }),
      ]);
      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('take_profit');
    });

    it('triggers when mark < takeProfit', () => {
      const result = checkPerTradeLevels([
        mkCheck({ side: 'short', markPrice: price('89'), takeProfit: price('90') }),
      ]);
      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('take_profit');
    });

    it('does NOT trigger when mark > takeProfit', () => {
      const result = checkPerTradeLevels([
        mkCheck({ side: 'short', markPrice: price('91'), takeProfit: price('90') }),
      ]);
      expect(result.triggered).toBe(false);
    });
  });

  describe('multiple instruments', () => {
    it('returns first triggered result', () => {
      const result = checkPerTradeLevels([
        mkCheck({ instrument: 'ETH/USD:USD', markPrice: price('101'), stopLoss: price('100'), takeProfit: undefined }), // not triggered (long, mark > stop)
        mkCheck({ instrument: 'BTC/USD:USD', markPrice: price('90'), stopLoss: price('95'), takeProfit: undefined }),   // TRIGGERED
        mkCheck({ instrument: 'SOL/USD:USD', markPrice: price('10'), stopLoss: price('5'), takeProfit: undefined }),    // would trigger but shouldn't be reached
      ]);
      expect(result.triggered).toBe(true);
      expect(result.instrument).toBe('BTC/USD:USD');
      expect(result.reason).toBe('stop_loss');
    });

    it('returns false when none triggered', () => {
      const result = checkPerTradeLevels([
        mkCheck({ instrument: 'ETH/USD:USD', markPrice: price('100'), stopLoss: price('90') }),
        mkCheck({ instrument: 'BTC/USD:USD', markPrice: price('100'), stopLoss: price('95') }),
      ]);
      expect(result.triggered).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('does not trigger when neither stopLoss nor takeProfit is set', () => {
      const result = checkPerTradeLevels([
        { instrument: 'BTC/USD:USD', side: 'long', markPrice: price('100') },
      ]);
      expect(result.triggered).toBe(false);
    });

    it('triggers stop-loss at exact equality (long)', () => {
      const result = checkPerTradeLevels([
        mkCheck({ markPrice: price('95'), stopLoss: price('95') }),
      ]);
      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('stop_loss');
    });

    it('triggers take-profit at exact equality (long)', () => {
      const result = checkPerTradeLevels([
        mkCheck({ markPrice: price('110'), takeProfit: price('110') }),
      ]);
      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('take_profit');
    });

    it('triggers take-profit at exact equality (short)', () => {
      const result = checkPerTradeLevels([
        mkCheck({ side: 'short', markPrice: price('90'), takeProfit: price('90') }),
      ]);
      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('take_profit');
    });

    it('triggers stop-loss at exact equality (short)', () => {
      const result = checkPerTradeLevels([
        mkCheck({ side: 'short', markPrice: price('105'), stopLoss: price('105') }),
      ]);
      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('stop_loss');
    });
  });
});
