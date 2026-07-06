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

  // --- oldestEntryMs ---

  it('oldestEntryMs returns undefined for an empty tracker', () => {
    const tracker = new DailyLossTracker();
    expect(tracker.oldestEntryMs(Date.now())).toBeUndefined();
  });

  it('oldestEntryMs returns the timestamp of the single active entry', () => {
    const tracker = new DailyLossTracker();
    const now = Date.now();
    const entryTs = now - 3_600_000; // 1h ago
    tracker.recordFill(price('-500'), entryTs);
    expect(tracker.oldestEntryMs(now)).toBe(entryTs);
  });

  it('oldestEntryMs returns the earliest timestamp among multiple entries', () => {
    const tracker = new DailyLossTracker();
    const now = Date.now();
    const twoHoursAgo = now - 7_200_000;
    const oneHourAgo = now - 3_600_000;
    tracker.recordFill(price('-200'), oneHourAgo);
    tracker.recordFill(price('-500'), twoHoursAgo);
    tracker.recordFill(price('-300'), now);
    expect(tracker.oldestEntryMs(now)).toBe(twoHoursAgo);
  });

  it('oldestEntryMs excludes entries older than 24h', () => {
    const tracker = new DailyLossTracker();
    const now = Date.now();
    const twoDaysAgo = now - 2 * 86_400_000;
    const oneHourAgo = now - 3_600_000;
    tracker.recordFill(price('-1000'), twoDaysAgo);
    tracker.recordFill(price('-200'), oneHourAgo);
    expect(tracker.oldestEntryMs(now)).toBe(oneHourAgo);
  });

  it('oldestEntryMs adding DAY_MS gives the earliest unblock time', () => {
    const tracker = new DailyLossTracker();
    const now = Date.now();
    const entryTs = now - 3_600_000; // 1h ago → expires in 23h
    tracker.recordFill(price('-500'), entryTs);
    const oldestMs = tracker.oldestEntryMs(now)!;
    const unblockTime = oldestMs + 86_400_000;
    expect(unblockTime).toBe(entryTs + 86_400_000);
    expect(unblockTime).toBeGreaterThan(now);
  });
});
