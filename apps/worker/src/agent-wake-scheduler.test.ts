import { describe, expect, it } from 'vitest';
import { getWakeRescheduleDelay, resolveNextTickDelay } from './agent-wake-scheduler.js';

describe('agent wake scheduler decisions', () => {
  it('reschedules an idle runtime earlier when the normal delay exceeds the wake minimum', () => {
    const delayMs = getWakeRescheduleDelay({
      running: true,
      tickInFlight: false,
      nextTickDueAt: 60_000,
      now: 0,
      effectiveTickIntervalMs: 45_000,
      wakeMinIntervalMs: 15_000,
    });

    expect(delayMs).toBe(15_000);
  });

  it('does not reschedule when the runtime is not idle', () => {
    expect(getWakeRescheduleDelay({
      running: false,
      tickInFlight: false,
      nextTickDueAt: 60_000,
      now: 0,
      effectiveTickIntervalMs: 45_000,
      wakeMinIntervalMs: 15_000,
    })).toBeNull();

    expect(getWakeRescheduleDelay({
      running: true,
      tickInFlight: true,
      nextTickDueAt: 60_000,
      now: 0,
      effectiveTickIntervalMs: 45_000,
      wakeMinIntervalMs: 15_000,
    })).toBeNull();
  });

  it('does not pull the tick earlier when it is already due sooner than the wake minimum', () => {
    const delayMs = getWakeRescheduleDelay({
      running: true,
      tickInFlight: false,
      nextTickDueAt: 10_000,
      now: 0,
      effectiveTickIntervalMs: 45_000,
      wakeMinIntervalMs: 15_000,
    });

    expect(delayMs).toBeNull();
  });

  it('applies the wake cooldown and clears wakePending once the next tick is scheduled', () => {
    const decision = resolveNextTickDelay({
      requestedDelayMs: 45_000,
      wakePending: true,
      tickInFlight: false,
      now: 100_000,
      lastWakeTickAt: 80_000,
      wakeMinIntervalMs: 15_000,
    });

    expect(decision.actualDelayMs).toBe(15_000);
    expect(decision.nextTickDueAt).toBe(115_000);
    expect(decision.wakePending).toBe(false);
    expect(decision.lastWakeTickAt).toBe(100_000);
    expect(decision.wakeTriggered).toBe(true);
  });

  it('schedules remaining cooldown when the wake cooldown has not elapsed', () => {
    const decision = resolveNextTickDelay({
      requestedDelayMs: 45_000,
      wakePending: true,
      tickInFlight: false,
      now: 100_000,
      lastWakeTickAt: 95_000,
      wakeMinIntervalMs: 15_000,
    });

    // Remaining cooldown = 15_000 - (100_000 - 95_000) = 10_000
    expect(decision.actualDelayMs).toBe(10_000);
    expect(decision.nextTickDueAt).toBe(110_000);
    expect(decision.wakePending).toBe(false);
    expect(decision.lastWakeTickAt).toBe(95_000);
    expect(decision.wakeTriggered).toBe(true);
  });

  it('preserves wakePending while a tick is already in flight', () => {
    const decision = resolveNextTickDelay({
      requestedDelayMs: 45_000,
      wakePending: true,
      tickInFlight: true,
      now: 100_000,
      lastWakeTickAt: 80_000,
      wakeMinIntervalMs: 15_000,
    });

    expect(decision.actualDelayMs).toBe(45_000);
    expect(decision.wakePending).toBe(true);
    expect(decision.lastWakeTickAt).toBe(80_000);
    expect(decision.wakeTriggered).toBe(false);
  });

  it('consumes wakePending when requested delay is shorter than remaining cooldown', () => {
    // remaining cooldown = 15_000 - (100_000 - 99_000) = 14_000 > requestedDelayMs of 10_000
    // The normal tick fires sooner and will process market state — no extra tick needed.
    const decision = resolveNextTickDelay({
      requestedDelayMs: 10_000,
      wakePending: true,
      tickInFlight: false,
      now: 100_000,
      lastWakeTickAt: 99_000,
      wakeMinIntervalMs: 15_000,
    });

    expect(decision.actualDelayMs).toBe(10_000);
    expect(decision.wakePending).toBe(false);
    expect(decision.wakeTriggered).toBe(false);
  });
});