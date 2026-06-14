import { describe, it, expect } from 'vitest';
import { price, Decimal } from '@herobids/domain';
import { DailyLossTracker } from './daily-loss-tracker.js';

describe('DailyLossTracker', () => {
  it('empty tracker returns 0', () => {
    const tracker = new DailyLossTracker();
    expect(tracker.rollingLoss(Date.now()).isZero()).toBe(true);
  });

  it('single loss records correctly', () => {
    const tracker = new DailyLossTracker();
    const now = Date.now();
    tracker.recordFill(price('-500'), now);
    expect(tracker.rollingLoss(now).eq(new Decimal(500))).toBe(true);
  });

  it('multiple losses sum correctly', () => {
    const tracker = new DailyLossTracker();
    const now = Date.now();
    tracker.recordFill(price('-500'), now);
    tracker.recordFill(price('-300'), now);
    tracker.recordFill(price('-200'), now);
    expect(tracker.rollingLoss(now).eq(new Decimal(1000))).toBe(true);
  });

  it('losses older than 24h are excluded', () => {
    const tracker = new DailyLossTracker();
    const now = Date.now();
    const dayAgo = now - 86_400_000 - 1; // Just over 24h ago
    tracker.recordFill(price('-1000'), dayAgo);
    tracker.recordFill(price('-200'), now);
    expect(tracker.rollingLoss(now).eq(new Decimal(200))).toBe(true);
  });

  it('profits do not count as losses', () => {
    const tracker = new DailyLossTracker();
    const now = Date.now();
    tracker.recordFill(price('1000'), now);
    tracker.recordFill(price('500'), now);
    tracker.recordFill(price('-100'), now);
    expect(tracker.rollingLoss(now).eq(new Decimal(100))).toBe(true);
  });

  it('recent loss within 24h window is included', () => {
    const tracker = new DailyLossTracker();
    const now = Date.now();
    const halfDayAgo = now - 43_200_000; // 12h ago
    tracker.recordFill(price('-700'), halfDayAgo);
    tracker.recordFill(price('-300'), now);
    expect(tracker.rollingLoss(now).eq(new Decimal(1000))).toBe(true);
  });
});
