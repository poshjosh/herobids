import { describe, it, expect } from 'vitest';
import { advanceRepeatingReminder } from './reminder-schedule.js';

const INTERVAL = 15 * 60_000; // 15 minutes

describe('advanceRepeatingReminder', () => {
  it('reports zero missed and advances one interval when fired on time', () => {
    const triggerAtMs = 1_000_000;
    const result = advanceRepeatingReminder({
      triggerAtMs,
      repeatEveryMs: INTERVAL,
      nowMs: triggerAtMs,
    });

    expect(result.missedOccurrences).toBe(0);
    expect(result.nextTriggerAtMs).toBe(triggerAtMs + INTERVAL);
  });

  it('reports three missed and keeps the next slot on the original grid when three intervals late', () => {
    const triggerAtMs = 1_000_000;
    // Just past the third slot after the due one, but before the fourth.
    const nowMs = triggerAtMs + 3 * INTERVAL + 1;
    const result = advanceRepeatingReminder({
      triggerAtMs,
      repeatEveryMs: INTERVAL,
      nowMs,
    });

    expect(result.missedOccurrences).toBe(3);
    // Next slot is the fourth after the due one — still aligned to the grid.
    expect(result.nextTriggerAtMs).toBe(triggerAtMs + 4 * INTERVAL);
    expect((result.nextTriggerAtMs - triggerAtMs) % INTERVAL).toBe(0);
  });

  it('counts a later slot landed on exactly as missed and places next strictly after now', () => {
    const triggerAtMs = 1_000_000;
    // now lands exactly on the second slot after the due one.
    const nowMs = triggerAtMs + 2 * INTERVAL;
    const result = advanceRepeatingReminder({
      triggerAtMs,
      repeatEveryMs: INTERVAL,
      nowMs,
    });

    expect(result.missedOccurrences).toBe(2);
    expect(result.nextTriggerAtMs).toBe(triggerAtMs + 3 * INTERVAL);
    expect(result.nextTriggerAtMs).toBeGreaterThan(nowMs);
  });

  it('clamps to zero missed and advances one interval when fired before the due slot', () => {
    const triggerAtMs = 1_000_000;
    // Precondition violation: now is before the due slot.
    const nowMs = triggerAtMs - 5 * INTERVAL;
    const result = advanceRepeatingReminder({
      triggerAtMs,
      repeatEveryMs: INTERVAL,
      nowMs,
    });

    expect(result.missedOccurrences).toBe(0);
    expect(result.nextTriggerAtMs).toBe(triggerAtMs + INTERVAL);
  });
});
