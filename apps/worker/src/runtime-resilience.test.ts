import { describe, expect, it } from 'vitest';
import { applyToolExclusions, FailureBackoffController, ToolCircuitBreaker, toolResultIndicatesFailure } from './runtime-resilience.js';

describe('FailureBackoffController', () => {
  it('backs off after repeated failures and stops after the threshold', () => {
    const controller = new FailureBackoffController({ baseIntervalMs: 60_000 });
    expect(controller.recordFailure()).toMatchObject({ consecutiveFailures: 1, nextIntervalMs: 60_000, shouldShutdown: false });
    expect(controller.recordFailure()).toMatchObject({ consecutiveFailures: 2, nextIntervalMs: 60_000, shouldShutdown: false });
    expect(controller.recordFailure()).toMatchObject({ consecutiveFailures: 3, nextIntervalMs: 120_000, shouldShutdown: false });
    expect(controller.recordFailure()).toMatchObject({ consecutiveFailures: 4, nextIntervalMs: 120_000, shouldShutdown: false });
    expect(controller.recordFailure()).toMatchObject({ consecutiveFailures: 5, nextIntervalMs: 120_000, shouldShutdown: true });
  });

  it('resets after a successful tick', () => {
    const controller = new FailureBackoffController({ baseIntervalMs: 60_000 });
    controller.recordFailure();
    controller.recordFailure();
    controller.recordFailure();

    expect(controller.recordSuccess()).toEqual({ recovered: true, nextIntervalMs: 60_000 });
    expect(controller.recordFailure()).toMatchObject({ consecutiveFailures: 1, nextIntervalMs: 60_000, shouldShutdown: false });
  });

  it('never triggers shutdown for advisory sources regardless of failure count', () => {
    const controller = new FailureBackoffController({ baseIntervalMs: 60_000 });
    for (let i = 0; i < 10; i++) {
      expect(controller.recordFailure('tick-gate')).toMatchObject({ shouldShutdown: false });
    }
    for (let i = 0; i < 10; i++) {
      expect(controller.recordFailure('market-data')).toMatchObject({ shouldShutdown: false });
    }
    for (let i = 0; i < 10; i++) {
      expect(controller.recordFailure('tool')).toMatchObject({ shouldShutdown: false });
    }
    for (let i = 0; i < 10; i++) {
      expect(controller.recordFailure('database')).toMatchObject({ shouldShutdown: false });
    }
  });

  it('triggers shutdown for redis after the per-source failure threshold', () => {
    const controller = new FailureBackoffController({ baseIntervalMs: 60_000 });
    for (let i = 0; i < 4; i++) {
      expect(controller.recordFailure('redis')).toMatchObject({ shouldShutdown: false });
    }
    expect(controller.recordFailure('redis')).toMatchObject({ shouldShutdown: true });
  });

  it('triggers shutdown for llm after the per-source failure threshold', () => {
    const controller = new FailureBackoffController({ baseIntervalMs: 60_000 });
    for (let i = 0; i < 4; i++) {
      expect(controller.recordFailure('llm')).toMatchObject({ shouldShutdown: false });
    }
    expect(controller.recordFailure('llm')).toMatchObject({ shouldShutdown: true });
  });

  it('tick-gate failures do not count toward the redis shutdown threshold', () => {
    const controller = new FailureBackoffController({ baseIntervalMs: 60_000 });
    // Saturate with tick-gate failures (advisory — never shutdown)
    for (let i = 0; i < 10; i++) controller.recordFailure('tick-gate');
    // Redis failures are tracked in their own per-source counter
    for (let i = 0; i < 4; i++) {
      expect(controller.recordFailure('redis')).toMatchObject({ shouldShutdown: false });
    }
    expect(controller.recordFailure('redis')).toMatchObject({ shouldShutdown: true });
  });

  it('recordSuccess resets per-source counters so thresholds restart', () => {
    const controller = new FailureBackoffController({ baseIntervalMs: 60_000 });
    for (let i = 0; i < 5; i++) controller.recordFailure('redis');
    controller.recordSuccess();
    for (let i = 0; i < 4; i++) {
      expect(controller.recordFailure('redis')).toMatchObject({ shouldShutdown: false });
    }
    expect(controller.recordFailure('redis')).toMatchObject({ shouldShutdown: true });
  });
});

describe('ToolCircuitBreaker', () => {
  it('opens after repeated failures and reopens after cooldown ticks', () => {
    const breaker = new ToolCircuitBreaker();
    breaker.recordFailure('discover_tokens', 1);
    breaker.recordFailure('discover_tokens', 2);
    const opened = breaker.recordFailure('discover_tokens', 3);

    expect(opened.opened).toBe(true);
    expect(breaker.getBlockedTools(3).has('discover_tokens')).toBe(true);
    expect(breaker.getBlockedTools(3).has('discover_tokens')).toBe(true);
    expect(breaker.getBlockedTools(4).has('discover_tokens')).toBe(false);
  });
});

describe('toolResultIndicatesFailure', () => {
  it('treats fault:false tool results as non-failures for breaker accounting', () => {
    expect(toolResultIndicatesFailure(JSON.stringify({ ok: false, error: 'redirect blocked', retryable: false, fault: false }))).toBe(false);
    expect(toolResultIndicatesFailure(JSON.stringify({ ok: false, error: 'invalid parameters', retryable: false, fault: false }))).toBe(false);
  });

  it('treats ordinary tool failures as breaker failures', () => {
    expect(toolResultIndicatesFailure(JSON.stringify({ ok: false, error: 'timeout', retryable: true }))).toBe(true);
  });

  it('ignores malformed tool results', () => {
    expect(toolResultIndicatesFailure('not-json')).toBe(false);
  });
});

describe('applyToolExclusions', () => {
  it('removes degraded and circuit-open tools from the visible set', () => {
    expect(applyToolExclusions(['list_positions', 'search_tokens', 'submit_decision'], {
      degraded: new Set(['list_positions']),
      circuit: new Set(['search_tokens']),
    })).toEqual(['submit_decision']);
  });
});

// ── SessionCircuitBreaker ──────────────────────────────────────────────

const defaultBreakerOptions = () => ({
  enabled: true,
  strategyError: { maxInWindow: 10, windowMs: 60_000 },
  drift: { maxInWindow: 5, windowMs: 300_000 },
  streamDisconnect: { maxInWindow: 5, windowMs: 300_000 },
  cooldownMs: 300_000,
  maxTrips: 3,
  probeIntervalMs: 60_000,
});

import { SessionCircuitBreaker } from './runtime-resilience.js';

describe('SessionCircuitBreaker', () => {
  // 1
  it('starts in CLOSED state', () => {
    const breaker = new SessionCircuitBreaker(defaultBreakerOptions());
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.tripCount).toBe(0);
  });

  // 2
  it('stays CLOSED when under threshold', () => {
    const breaker = new SessionCircuitBreaker(defaultBreakerOptions());
    for (let i = 0; i < 5; i++) {
      const result = breaker.record('strategy_error');
      expect(result.state).toBe('CLOSED');
      expect(result.isOpen).toBe(false);
    }
    for (let i = 0; i < 2; i++) {
      const result = breaker.record('drift_detected');
      expect(result.state).toBe('CLOSED');
    }
    for (let i = 0; i < 2; i++) {
      const result = breaker.record('stream_disconnect');
      expect(result.state).toBe('CLOSED');
    }
  });

  // 3
  it('transitions to OPEN when strategy_error threshold exceeded', () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      strategyError: { maxInWindow: 3, windowMs: 60_000 },
    });
    // Under threshold
    for (let i = 0; i < 3; i++) {
      expect(breaker.record('strategy_error').state).toBe('CLOSED');
    }
    // Exceeds threshold
    const result = breaker.record('strategy_error');
    expect(result.state).toBe('OPEN');
    expect(result.isOpen).toBe(true);
    expect(result.shouldTerminate).toBe(false);
    expect(breaker.tripCount).toBe(1);
  });

  // 4
  it('transitions to OPEN on single strategy_fatal regardless of other counters', () => {
    const breaker = new SessionCircuitBreaker(defaultBreakerOptions());
    const result = breaker.record('strategy_fatal');
    expect(result.state).toBe('OPEN');
    expect(result.isOpen).toBe(true);
    expect(breaker.tripCount).toBe(1);
  });

  // 5
  it('transitions to OPEN when drift threshold exceeded', () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      drift: { maxInWindow: 2, windowMs: 60_000 },
    });
    for (let i = 0; i < 2; i++) {
      expect(breaker.record('drift_detected').state).toBe('CLOSED');
    }
    const result = breaker.record('drift_detected');
    expect(result.state).toBe('OPEN');
    expect(breaker.tripCount).toBe(1);
  });

  // 6
  it('transitions to OPEN when streamDisconnect threshold exceeded', () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      streamDisconnect: { maxInWindow: 2, windowMs: 60_000 },
    });
    for (let i = 0; i < 2; i++) {
      expect(breaker.record('stream_disconnect').state).toBe('CLOSED');
    }
    const result = breaker.record('stream_disconnect');
    expect(result.state).toBe('OPEN');
    expect(breaker.tripCount).toBe(1);
  });

  // 7
  it('transitions OPEN → HALF_OPEN after cooldownMs', async () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      cooldownMs: 20,
    });
    // Trip the breaker
    breaker.record('strategy_fatal');
    expect(breaker.state).toBe('OPEN');

    // Wait for cooldown to expire
    await new Promise((r) => setTimeout(r, 30));

    // Next record() call triggers the OPEN→HALF_OPEN transition
    const result = breaker.record('drift_detected');
    expect(result.state).toBe('HALF_OPEN');
    expect(result.isOpen).toBe(false);
  });

  // 8
  it('transitions HALF_OPEN → CLOSED on probe success', async () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      cooldownMs: 10,
    });
    breaker.record('strategy_fatal');
    expect(breaker.state).toBe('OPEN');

    await new Promise((r) => setTimeout(r, 20));

    // Transition to HALF_OPEN on next call
    breaker.record('drift_detected');
    expect(breaker.state).toBe('HALF_OPEN');

    // Probe succeeds
    const newState = breaker.onProbeSuccess();
    expect(newState).toBe('CLOSED');
    expect(breaker.state).toBe('CLOSED');
  });

  // 9
  it('transitions HALF_OPEN → OPEN on probe failure (new error during probe)', async () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      cooldownMs: 10,
    });
    breaker.record('strategy_fatal');
    expect(breaker.state).toBe('OPEN');
    expect(breaker.tripCount).toBe(1);

    await new Promise((r) => setTimeout(r, 20));

    // Enter HALF_OPEN
    breaker.record('drift_detected');
    expect(breaker.state).toBe('HALF_OPEN');

    // An error during probe fails it
    const result = breaker.record('strategy_error');
    expect(result.state).toBe('OPEN');
    expect(breaker.tripCount).toBe(2);
  });

  // 10
  it('transitions to TERMINATED after maxTrips trips', async () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      strategyError: { maxInWindow: 1, windowMs: 60_000 },
      cooldownMs: 10,
      maxTrips: 2,
    });

    // Trip 1
    breaker.record('strategy_error');
    const r1 = breaker.record('strategy_error');
    expect(r1.state).toBe('OPEN');

    await new Promise((r) => setTimeout(r, 20));

    // Enter HALF_OPEN, then fail probe → trip 2 → TERMINATED
    breaker.record('drift_detected'); // triggers OPEN→HALF_OPEN
    expect(breaker.state).toBe('HALF_OPEN');

    const r2 = breaker.record('strategy_error');
    expect(r2.state).toBe('TERMINATED');
    expect(r2.shouldTerminate).toBe(true);
    expect(breaker.tripCount).toBe(2);
  });

  // 11
  it('reset() clears all counters and returns to CLOSED', () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      strategyError: { maxInWindow: 1, windowMs: 60_000 },
    });
    // Trip the breaker
    breaker.record('strategy_error');
    breaker.record('strategy_error');
    expect(breaker.state).toBe('OPEN');
    expect(breaker.tripCount).toBe(1);

    breaker.reset();
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.tripCount).toBe(0);
    expect(breaker.isOpen()).toBe(false);

    // Should be able to start fresh
    expect(breaker.record('strategy_error').state).toBe('CLOSED');
  });

  // 12
  it('reset() on fill.recorded event resets all counters', () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      strategyError: { maxInWindow: 1, windowMs: 60_000 },
    });
    breaker.record('strategy_error');
    breaker.record('strategy_error');
    expect(breaker.state).toBe('OPEN');

    const result = breaker.record('fill.recorded');
    expect(result.state).toBe('CLOSED');
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.tripCount).toBe(0);
  });

  // 13
  it('decision accepted resets drift counter', () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      drift: { maxInWindow: 2, windowMs: 60_000 },
    });
    // Accumulate drift events
    breaker.record('drift_detected');
    breaker.record('drift_detected');
    // Not yet over threshold because maxInWindow=2 means >2 to breach
    // Actually max is 2, so exceeding means 3+. Drift counter is at 2.
    expect(breaker.state).toBe('CLOSED');

    // Decision accepted resets drift
    const result = breaker.record('decision.accepted');
    expect(result.state).toBe('CLOSED');

    // After reset, we should be able to record 2 more without tripping
    breaker.record('drift_detected');
    breaker.record('drift_detected');
    expect(breaker.state).toBe('CLOSED');
  });

  // 14
  it('reconciliation.match decrements drift counter', () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      drift: { maxInWindow: 2, windowMs: 60_000 },
    });
    breaker.record('drift_detected');
    breaker.record('drift_detected');
    // Drift count is 2, threshold is 3+ (maxInWindow=2, exceed >2)

    // reconciliation.match decrements by 1
    breaker.record('reconciliation.match');
    // Now drift count is 1, so one more shouldn't trip
    breaker.record('drift_detected');
    expect(breaker.state).toBe('CLOSED');
  });

  // 15
  it('isOpen() returns true when state is OPEN', () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      strategyError: { maxInWindow: 1, windowMs: 60_000 },
    });
    breaker.record('strategy_error');
    breaker.record('strategy_error');
    expect(breaker.isOpen()).toBe(true);
  });

  // 16
  it('isOpen() returns false when state is CLOSED', () => {
    const breaker = new SessionCircuitBreaker(defaultBreakerOptions());
    expect(breaker.isOpen()).toBe(false);
    breaker.record('strategy_error');
    expect(breaker.isOpen()).toBe(false);
  });

  // 17
  it('does nothing when enabled=false', () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      enabled: false,
      strategyError: { maxInWindow: 1, windowMs: 60_000 },
    });
    // Record many errors — should never trip
    for (let i = 0; i < 100; i++) {
      const result = breaker.record('strategy_error');
      expect(result.state).toBe('CLOSED');
      expect(result.isOpen).toBe(false);
      expect(result.shouldTerminate).toBe(false);
    }
    breaker.record('strategy_fatal');
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.isOpen()).toBe(false);
  });

  // 18
  it('sliding window expires old events', async () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      strategyError: { maxInWindow: 2, windowMs: 30 },
    });
    // Record 2 events (under threshold of >2)
    breaker.record('strategy_error');
    breaker.record('strategy_error');
    expect(breaker.state).toBe('CLOSED');

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 50));

    // Old events expired — should still be CLOSED after one more
    const result = breaker.record('strategy_error');
    expect(result.state).toBe('CLOSED');
  });

  // 19
  it('cooldownStatus returns correct remaining time', () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      cooldownMs: 5000,
      strategyError: { maxInWindow: 1, windowMs: 60_000 },
    });
    // Not in cooldown
    expect(breaker.getCooldownStatus()).toEqual({ inCooldown: false, remainingMs: 0 });

    // Trip the breaker
    breaker.record('strategy_error');
    breaker.record('strategy_error');
    expect(breaker.state).toBe('OPEN');

    const status = breaker.getCooldownStatus();
    expect(status.inCooldown).toBe(true);
    expect(status.remainingMs).toBeGreaterThan(0);
    expect(status.remainingMs).toBeLessThanOrEqual(5000);
  });

  // Additional edge-case tests

  it('probeIntervalMs getter returns the configured value', () => {
    const breaker = new SessionCircuitBreaker(defaultBreakerOptions());
    expect(breaker.probeIntervalMs).toBe(60_000);
  });

  it('TERMINATED state stays TERMINATED even on recovery events', () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      strategyError: { maxInWindow: 1, windowMs: 60_000 },
      cooldownMs: 10,
      maxTrips: 1,
    });
    // Trip to TERMINATED immediately
    breaker.record('strategy_error');
    const r = breaker.record('strategy_error');
    expect(r.state).toBe('TERMINATED');
    expect(r.shouldTerminate).toBe(true);

    // fill.recorded must NOT reset from TERMINATED — session shutdown is irreversible.
    breaker.record('fill.recorded');
    expect(breaker.state).toBe('TERMINATED');
  });

  it('non-error events in HALF_OPEN do not cause probe failure', async () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      cooldownMs: 10,
    });
    breaker.record('strategy_fatal');
    await new Promise((r) => setTimeout(r, 20));
    breaker.record('drift_detected'); // OPEN → HALF_OPEN
    expect(breaker.state).toBe('HALF_OPEN');

    // A non-error event (e.g. fill.recorded) should not fail the probe
    const result = breaker.record('fill.recorded');
    // fill.recorded resets everything anyway
    expect(result.state).toBe('CLOSED');
  });

  it('strategy_fatal from HALF_OPEN probe causes trip back to OPEN', async () => {
    const breaker = new SessionCircuitBreaker({
      ...defaultBreakerOptions(),
      cooldownMs: 10,
    });
    breaker.record('strategy_fatal');
    expect(breaker.tripCount).toBe(1);

    await new Promise((r) => setTimeout(r, 20));
    breaker.record('drift_detected'); // OPEN → HALF_OPEN
    expect(breaker.state).toBe('HALF_OPEN');

    // Another fatal during probe → back to OPEN
    const result = breaker.record('strategy_fatal');
    expect(result.state).toBe('OPEN');
    expect(breaker.tripCount).toBe(2);
  });

  it('onProbeSuccess is a no-op when not in HALF_OPEN', () => {
    const breaker = new SessionCircuitBreaker(defaultBreakerOptions());
    expect(breaker.onProbeSuccess()).toBe('CLOSED');

    breaker.record('strategy_fatal');
    expect(breaker.state).toBe('OPEN');
    expect(breaker.onProbeSuccess()).toBe('OPEN'); // no change
  });
});