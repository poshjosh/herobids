import { describe, expect, it } from 'vitest';
import { applyToolExclusions, FailureBackoffController, ToolCircuitBreaker } from './runtime-resilience.js';

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
});

describe('ToolCircuitBreaker', () => {
  it('opens after repeated failures and reopens after cooldown ticks', () => {
    const breaker = new ToolCircuitBreaker();
    breaker.recordFailure('discover_tokens', 1);
    breaker.recordFailure('discover_tokens', 2);
    const opened = breaker.recordFailure('discover_tokens', 3);

    expect(opened.opened).toBe(true);
    expect(breaker.getBlockedTools(3).has('discover_tokens')).toBe(true);
    expect(breaker.getBlockedTools(7).has('discover_tokens')).toBe(true);
    expect(breaker.getBlockedTools(8).has('discover_tokens')).toBe(false);
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