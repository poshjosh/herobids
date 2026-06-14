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