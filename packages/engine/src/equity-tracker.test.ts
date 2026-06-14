import { describe, it, expect } from 'vitest';
import { price, Decimal } from '@herobids/domain';
import { EquityTracker } from './equity-tracker.js';

describe('EquityTracker', () => {
  it('equity starts at capital when no unrealized P&L', () => {
    const tracker = new EquityTracker(price('10000'));
    expect(tracker.currentEquity(price('0')).eq(new Decimal(10000))).toBe(true);
  });

  it('after profitable fill, equity rises and peak updates', () => {
    const tracker = new EquityTracker(price('10000'));
    tracker.recordFill(price('500'));
    const equity = tracker.currentEquity(price('0'));
    expect(equity.eq(new Decimal(10500))).toBe(true);
    expect(tracker.peakEquity.eq(new Decimal(10500))).toBe(true);
  });

  it('after losing fill, drawdown increases', () => {
    const tracker = new EquityTracker(price('10000'));
    // First establish peak
    tracker.currentEquity(price('0'));
    // Lose money
    tracker.recordFill(price('-1000'));
    const drawdown = tracker.currentDrawdown(price('0'));
    expect(drawdown.eq(new Decimal(1000))).toBe(true);
  });

  it('drawdown is never negative', () => {
    const tracker = new EquityTracker(price('10000'));
    // Profit → new peak
    tracker.recordFill(price('2000'));
    tracker.currentEquity(price('0'));
    // More profit → still no drawdown
    tracker.recordFill(price('500'));
    const drawdown = tracker.currentDrawdown(price('0'));
    expect(drawdown.gte(0)).toBe(true);
    expect(drawdown.isZero()).toBe(true);
  });

  it('peak only moves up', () => {
    const tracker = new EquityTracker(price('10000'));
    tracker.currentEquity(price('0')); // peak = 10000
    tracker.recordFill(price('1000'));
    tracker.currentEquity(price('0')); // peak = 11000
    tracker.recordFill(price('-500'));
    tracker.currentEquity(price('0')); // equity = 10500, peak stays 11000
    expect(tracker.peakEquity.eq(new Decimal(11000))).toBe(true);
  });

  it('unrealized P&L affects equity and drawdown', () => {
    const tracker = new EquityTracker(price('10000'));
    tracker.currentEquity(price('0')); // peak = 10000
    // Position is losing 2000 unrealized
    const drawdown = tracker.currentDrawdown(price('-2000'));
    expect(drawdown.eq(new Decimal(2000))).toBe(true);
  });

  it('unrealized profit pushes peak higher', () => {
    const tracker = new EquityTracker(price('10000'));
    tracker.currentEquity(price('3000')); // equity=13000, peak=13000
    expect(tracker.peakEquity.eq(new Decimal(13000))).toBe(true);
    // unrealized drops
    const drawdown = tracker.currentDrawdown(price('1000'));
    // equity = 11000, peak = 13000, drawdown = 2000
    expect(drawdown.eq(new Decimal(2000))).toBe(true);
  });

  it('accepts initial realized P&L for rehydration', () => {
    const tracker = new EquityTracker(price('10000'), price('500'));
    const equity = tracker.currentEquity(price('0'));
    expect(equity.eq(new Decimal(10500))).toBe(true);
    expect(tracker.peakEquity.eq(new Decimal(10500))).toBe(true);
  });
});
