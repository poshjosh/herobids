import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { ReviewScheduler, type ReviewSchedulerConfig, type ReviewSchedulerDeps } from './review-scheduler.js';

/**
 * Lifecycle-focused unit tests for ReviewScheduler.
 *
 * These tests deliberately avoid exercising the DB-heavy `isReviewDue()` /
 * `runPreCheck()` / `persistCheckOutcomes()` paths inside `runReviewCheck()` —
 * that logic is covered elsewhere. The goal here is to guard the class's
 * `start()`/`stop()` scheduling contract in isolation, since RC2
 * (docs/bug-reports/2026/07/21/001-staging-agents-not-trading-actor-start-never-called.md)
 * showed that a ReviewScheduler which is never `start()`-ed produces no
 * observable error anywhere — only silence. `runReviewCheck` is stubbed via
 * spyOn so these tests exercise the real `start()`/`stop()`/timer contract.
 */

function buildConfig(overrides: Partial<ReviewSchedulerConfig> = {}): ReviewSchedulerConfig {
  return {
    reviewIntervalMs: 1000,
    minReviewIntervalMs: 1000,
    scannerCandidateLimit: 10,
    cacheFreshnessMs: 60_000,
    adviceExpiryMs: 60_000,
    preCheck: {
      signalRatioThreshold: 2.0,
      scanMetricsLookbackMs: 86_400_000,
      minSignalsForActive: 3,
      identityCooldownMs: 86_400_000,
      candidateMaxAgeMs: 86_400_000,
      policyVersion: '1.0.0',
      enablePeerComparison: true,
    },
    ...overrides,
  };
}

function buildDeps(overrides: Partial<ReviewSchedulerDeps> = {}): ReviewSchedulerDeps {
  return {
    db: {} as unknown as Database,
    redis: {},
    agentId: 'agent-1',
    eventPublisher: { emitAgentWake: vi.fn() } as unknown as ReviewSchedulerDeps['eventPublisher'],
    resolveActivePreset: vi.fn().mockResolvedValue(ok({
      presetKey: 'momentum',
      behaviorVersion: 'v1',
      styleTier: 'standard',
      enabledIndicators: [],
    })),
    checkBillingEligibility: vi.fn().mockResolvedValue(ok(true)),
    ...overrides,
  };
}

const sampleOutcome = {
  checkId: 'c1',
  checkedAt: new Date().toISOString(),
  nextEligibleAt: new Date().toISOString(),
  advisedCount: 0,
  outcomeCounts: {},
  hasAdvice: false,
};

/**
 * Stubs `runReviewCheck` while preserving the real method's side effect of
 * advancing `lastCheckAt` — otherwise `scheduleNext()`'s elapsed-time math
 * sees `lastCheckAt` frozen at 0 and reschedules with a zero delay forever.
 */
function stubRunReviewCheck(
  scheduler: ReviewScheduler,
  result: ReturnType<typeof ok<typeof sampleOutcome>> | { ok: false; error: { code: string; message: string } },
) {
  return vi.spyOn(scheduler, 'runReviewCheck').mockImplementation(async () => {
    (scheduler as unknown as { lastCheckAt: number }).lastCheckAt = Date.now();
    return result;
  });
}

describe('ReviewScheduler lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not run a review check before start() is called', () => {
    const scheduler = new ReviewScheduler(buildDeps(), buildConfig());
    const runSpy = stubRunReviewCheck(scheduler, ok(sampleOutcome));

    vi.advanceTimersByTime(10_000);

    expect(runSpy).not.toHaveBeenCalled();
  });

  it('runs a review check immediately after start() when no prior check is recorded', async () => {
    const scheduler = new ReviewScheduler(buildDeps(), buildConfig({ reviewIntervalMs: 1000 }));
    const runSpy = stubRunReviewCheck(scheduler, ok(sampleOutcome));

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('reschedules and runs again one reviewIntervalMs after the first check completes (never lets the loop die)', async () => {
    const scheduler = new ReviewScheduler(buildDeps(), buildConfig({ reviewIntervalMs: 1000 }));
    const runSpy = stubRunReviewCheck(scheduler, ok(sampleOutcome));

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0); // first, immediate check
    await vi.advanceTimersByTimeAsync(1000); // second, interval-spaced check

    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it('reschedules even when the review check resolves with an error Result', async () => {
    const scheduler = new ReviewScheduler(buildDeps(), buildConfig({ reviewIntervalMs: 1000 }));
    const runSpy = stubRunReviewCheck(scheduler, {
      ok: false,
      error: { code: 'review.check_failed', message: 'boom' },
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it('calling start() twice does not schedule duplicate timers', async () => {
    const scheduler = new ReviewScheduler(buildDeps(), buildConfig({ reviewIntervalMs: 1000 }));
    const runSpy = stubRunReviewCheck(scheduler, ok(sampleOutcome));

    scheduler.start();
    scheduler.start(); // idempotent — must not schedule a second parallel timer chain

    await vi.advanceTimersByTimeAsync(0);

    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels the pending timer so no further checks run', async () => {
    const scheduler = new ReviewScheduler(buildDeps(), buildConfig({ reviewIntervalMs: 1000 }));
    const runSpy = stubRunReviewCheck(scheduler, ok(sampleOutcome));

    scheduler.start();
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSpy).not.toHaveBeenCalled();
  });
});
