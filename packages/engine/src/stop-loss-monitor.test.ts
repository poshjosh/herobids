import { describe, it, expect } from 'vitest';
import { price, quantity, Decimal } from '@herobids/domain';
import { flatPosition, applyFill } from './position-tracker.js';
import { checkStopLoss } from './stop-loss-monitor.js';
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
