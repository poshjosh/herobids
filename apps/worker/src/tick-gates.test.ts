import { describe, expect, it, vi } from 'vitest';
import type { RegimeResult } from '@herobids/market-data';
import { calculateAtrPercent, computeDecisionContextHash, computeWakeSignalDigest, computeWatchSummaryDigest, isWithinTradingHours, resolveAdaptiveIntervalMs, shouldSkipTick } from './tick-gates.js';
import type { RuntimeActiveWatchSummary } from './runtime-composition.js';

function makeRegimeResult(pass: boolean, reasons: string[]): RegimeResult {
  return {
    pass,
    reasons,
    details: {
      benchmarkSymbol: 'BTC',
      currentPrice: 100,
      emaFast: 101,
      emaSlow: 100,
      emaTrend: 99,
      emaAlignment: pass ? 'bullish' : 'bearish',
      adxValue: pass ? 30 : 10,
      choppy: !pass,
      vwap: 99,
      priceAboveVwap: pass,
      marketStructure: pass ? 'higherHighs' : 'mixed',
    },
  };
}

function makeWatchSummary(overrides: Partial<RuntimeActiveWatchSummary> = {}): RuntimeActiveWatchSummary {
  return {
    totalCount: 3,
    uniqueCount: 2,
    lines: [
      '[protective] BTC (ethereum) above $50000 status=not_met',
      'ETH (ethereum) below $3000 status=met x2',
    ],
    overflowCount: 0,
    ...overrides,
  };
}

describe('computeWatchSummaryDigest', () => {
  it('returns "__unknown__" for null summary', () => {
    expect(computeWatchSummaryDigest(null)).toBe('__unknown__');
  });

  it('produces a stable hex digest for a valid summary', () => {
    const summary = makeWatchSummary();
    const digest = computeWatchSummaryDigest(summary);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces identical digests for identical summaries', () => {
    const a = makeWatchSummary();
    const b = makeWatchSummary();
    expect(computeWatchSummaryDigest(a)).toBe(computeWatchSummaryDigest(b));
  });

  it('produces different digests when a watch line changes status', () => {
    const before = makeWatchSummary({
      lines: ['BTC (ethereum) above $50000 status=not_met'],
    });
    const after = makeWatchSummary({
      lines: ['BTC (ethereum) above $50000 status=met'],
    });
    expect(computeWatchSummaryDigest(before)).not.toBe(computeWatchSummaryDigest(after));
  });

  it('produces different digests when totalCount changes (watch added/removed)', () => {
    const before = makeWatchSummary({ totalCount: 2 });
    const after = makeWatchSummary({ totalCount: 3 });
    expect(computeWatchSummaryDigest(before)).not.toBe(computeWatchSummaryDigest(after));
  });

  it('produces different digests when uniqueCount changes', () => {
    const before = makeWatchSummary({ uniqueCount: 1 });
    const after = makeWatchSummary({ uniqueCount: 2 });
    expect(computeWatchSummaryDigest(before)).not.toBe(computeWatchSummaryDigest(after));
  });
});

describe('computeWakeSignalDigest', () => {
  it('returns "__none__" for null', () => {
    expect(computeWakeSignalDigest(null)).toBe('__none__');
  });

  it('returns "__none__" for undefined', () => {
    expect(computeWakeSignalDigest(undefined)).toBe('__none__');
  });

  it('returns "__none__" for empty array', () => {
    expect(computeWakeSignalDigest([])).toBe('__none__');
  });

  it('produces a stable hex digest for non-empty signals', () => {
    const digest = computeWakeSignalDigest([
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1000 },
    ]);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces identical digests for identical signals', () => {
    const signals = [
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1000 },
    ];
    expect(computeWakeSignalDigest(signals)).toBe(computeWakeSignalDigest(signals));
  });

  it('produces identical digests regardless of insertion order (sorted by source)', () => {
    const orderA = [
      { source: 'reminder', reason: 'check positions', receivedAt: 2000 },
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1000 },
    ];
    const orderB = [
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 3000 },
      { source: 'reminder', reason: 'check positions', receivedAt: 1500 },
    ];
    expect(computeWakeSignalDigest(orderA)).toBe(computeWakeSignalDigest(orderB));
  });

  it('produces identical digests for same-source signals with different reasons regardless of insertion order', () => {
    const orderA = [
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1000 },
      { source: 'price_alert', reason: 'BTC below 90k', receivedAt: 2000 },
    ];
    const orderB = [
      { source: 'price_alert', reason: 'BTC below 90k', receivedAt: 3000 },
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1500 },
    ];
    expect(computeWakeSignalDigest(orderA)).toBe(computeWakeSignalDigest(orderB));
  });

  it('produces different digests when a signal is added', () => {
    const before = [
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1000 },
    ];
    const after = [
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1000 },
      { source: 'reminder', reason: 'check positions', receivedAt: 2000 },
    ];
    expect(computeWakeSignalDigest(before)).not.toBe(computeWakeSignalDigest(after));
  });

  it('does NOT change when only timestamps differ', () => {
    const tick1 = [
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1000 },
    ];
    const tick2 = [
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 9999 },
    ];
    expect(computeWakeSignalDigest(tick1)).toBe(computeWakeSignalDigest(tick2));
  });

  it('produces different digests when a signal reason changes', () => {
    const before = [
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1000 },
    ];
    const after = [
      { source: 'price_alert', reason: 'BTC below 90k', receivedAt: 2000 },
    ];
    expect(computeWakeSignalDigest(before)).not.toBe(computeWakeSignalDigest(after));
  });

  it('produces different digests when a signal source changes', () => {
    const before = [
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1000 },
    ];
    const after = [
      { source: 'watch_trigger', reason: 'BTC above 100k', receivedAt: 2000 },
    ];
    expect(computeWakeSignalDigest(before)).not.toBe(computeWakeSignalDigest(after));
  });
});

describe('computeDecisionContextHash with watchSummaryDigest', () => {
  it('produces the same hash as before when watchSummaryDigest is not provided (backward compat)', () => {
    const hashWithout = computeDecisionContextHash({
      positionSide: 'long',
      latestPrice: 100,
      portfolioPnlUsd: 50,
    });
    const hashWithUndefined = computeDecisionContextHash({
      positionSide: 'long',
      latestPrice: 100,
      portfolioPnlUsd: 50,
      watchSummaryDigest: undefined,
    });
    expect(hashWithout).toBe(hashWithUndefined);
  });

  it('produces different hashes when watchSummaryDigest differs', () => {
    const summaryA = makeWatchSummary({ lines: ['BTC above $50000 status=not_met'] });
    const summaryB = makeWatchSummary({ lines: ['BTC above $50000 status=met'] });
    const digestA = computeWatchSummaryDigest(summaryA);
    const digestB = computeWatchSummaryDigest(summaryB);

    const hashA = computeDecisionContextHash({
      positionSide: 'long',
      latestPrice: 100,
      portfolioPnlUsd: 50,
      watchSummaryDigest: digestA,
    });
    const hashB = computeDecisionContextHash({
      positionSide: 'long',
      latestPrice: 100,
      portfolioPnlUsd: 50,
      watchSummaryDigest: digestB,
    });
    expect(hashA).not.toBe(hashB);
  });

  it('includes watchSummaryDigest in multi-instrument hash path', () => {
    const digest = computeWatchSummaryDigest(makeWatchSummary());
    const hashWith = computeDecisionContextHash({
      instrumentSnapshots: [{ symbol: 'BTC/USD:USD', priceBucket: '100', pnlBucket: '10', side: 'long' }],
      watchSummaryDigest: digest,
    });
    const hashWithout = computeDecisionContextHash({
      instrumentSnapshots: [{ symbol: 'BTC/USD:USD', priceBucket: '100', pnlBucket: '10', side: 'long' }],
    });
    expect(hashWith).not.toBe(hashWithout);
  });

  it('produces the same hash when wakeSignalDigest is undefined vs omitted (backward compat)', () => {
    const hashWithout = computeDecisionContextHash({
      positionSide: 'long',
      latestPrice: 100,
      portfolioPnlUsd: 50,
    });
    const hashWithUndefined = computeDecisionContextHash({
      positionSide: 'long',
      latestPrice: 100,
      portfolioPnlUsd: 50,
      wakeSignalDigest: undefined,
    });
    expect(hashWithout).toBe(hashWithUndefined);
  });

  it('produces the same hash when wakeSignalDigest is undefined vs omitted in multi-instrument path (backward compat)', () => {
    const hashWithout = computeDecisionContextHash({
      instrumentSnapshots: [{ symbol: 'BTC/USD:USD', priceBucket: '100', pnlBucket: '10', side: 'long' }],
    });
    const hashWithUndefined = computeDecisionContextHash({
      instrumentSnapshots: [{ symbol: 'BTC/USD:USD', priceBucket: '100', pnlBucket: '10', side: 'long' }],
      wakeSignalDigest: undefined,
    });
    expect(hashWithout).toBe(hashWithUndefined);
  });
});

describe('shouldSkipTick', () => {
  it('skips when regime is unfavorable and there are no open positions', async () => {
    const evaluateRegime = vi.fn().mockResolvedValue(makeRegimeResult(false, ['market is choppy']));

    const result = await shouldSkipTick(
      { tickNumber: 1, hasOpenPositions: false },
      { evaluateRegime },
    );

    expect(result.skip).toBe(true);
    expect(result.reason).toContain('regime_unfavorable');
    expect(evaluateRegime).toHaveBeenCalledTimes(1);
  });

  it('never skips when positions are open', async () => {
    const evaluateRegime = vi.fn().mockResolvedValue(makeRegimeResult(false, ['market is choppy']));

    const result = await shouldSkipTick(
      { tickNumber: 1, hasOpenPositions: true },
      { evaluateRegime },
    );

    expect(result.skip).toBe(false);
    expect(evaluateRegime).not.toHaveBeenCalled();
  });

  it('does not skip when no regime evaluator is available', async () => {
    const result = await shouldSkipTick(
      { tickNumber: 1, hasOpenPositions: false },
      {},
    );

    expect(result.skip).toBe(false);
  });

  it('skips outside configured trading hours when flat', async () => {
    const result = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        tradingHours: { allowedHoursUtc: [9, 10], weekendPause: false },
        now: new Date('2026-06-08T12:00:00.000Z'),
      },
      {},
    );

    expect(result.skip).toBe(true);
    expect(result.gate).toBe('session');
  });

  it('skips when decision context is unchanged before the forced tenth tick', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);
    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    const second = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        previousContextHash: first.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    expect(second.skip).toBe(true);
    expect(second.reason).toBe('context_unchanged');
  });

  it('does not skip when hasWakeSignal is true even if context hash matches (flat position)', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);
    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 0,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    const wakeTickResult = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: false,
        hasWakeSignal: true,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 0,
        previousContextHash: first.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    expect(wakeTickResult.skip).toBe(false);
  });

  it('does not skip when hasWakeSignal is true even if context hash matches (open position)', async () => {
    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: true,
        positionSide: 'long',
        latestPrice: 100,
        portfolioPnlUsd: 5,
      },
      {},
    );

    const wakeTickResult = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: true,
        hasWakeSignal: true,
        positionSide: 'long',
        latestPrice: 100,
        portfolioPnlUsd: 5,
        previousContextHash: first.contextHash,
      },
      {},
    );

    expect(wakeTickResult.skip).toBe(false);
  });

  it('forces a full evaluation every tenth tick even when the context hash matches', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);
    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    const tenth = await shouldSkipTick(
      {
        tickNumber: 10,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        previousContextHash: first.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    expect(tenth.skip).toBe(false);
  });

  it('skips when context AND watch digest are both unchanged (flat position)', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);
    const watchDigest = computeWatchSummaryDigest(makeWatchSummary());

    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        watchSummaryDigest: watchDigest,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    const second = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        watchSummaryDigest: watchDigest,
        previousContextHash: first.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    expect(second.skip).toBe(true);
    expect(second.reason).toBe('context_unchanged');
  });

  it('does NOT skip when watch digest changes but price/PnL stay the same (flat position)', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);
    const watchBefore = computeWatchSummaryDigest(makeWatchSummary({
      lines: ['BTC above $50000 status=not_met'],
    }));
    const watchAfter = computeWatchSummaryDigest(makeWatchSummary({
      lines: ['BTC above $50000 status=met'],
    }));

    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        watchSummaryDigest: watchBefore,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    const second = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        watchSummaryDigest: watchAfter,
        previousContextHash: first.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    expect(second.skip).toBe(false);
  });

  it('does NOT skip when watch digest changes but price/PnL stay the same (open positions)', async () => {
    const watchBefore = computeWatchSummaryDigest(makeWatchSummary({
      lines: ['BTC above $50000 status=not_met'],
    }));
    const watchAfter = computeWatchSummaryDigest(makeWatchSummary({
      lines: ['BTC above $50000 status=met'],
    }));

    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: true,
        positionSide: 'long',
        latestPrice: 100,
        portfolioPnlUsd: 5,
        watchSummaryDigest: watchBefore,
      },
      {},
    );

    const second = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: true,
        positionSide: 'long',
        latestPrice: 100,
        portfolioPnlUsd: 5,
        watchSummaryDigest: watchAfter,
        previousContextHash: first.contextHash,
      },
      {},
    );

    expect(second.skip).toBe(false);
  });

  it('does NOT skip when watch digest is unknown (__unknown__ sentinel forces evaluation)', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);

    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        watchSummaryDigest: '__unknown__',
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    // Even though price/PnL are identical, the __unknown__ sentinel causes
    // a per-tick hash variation so the gate never skips on unknown watch state.
    const second = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        watchSummaryDigest: '__unknown__',
        previousContextHash: first.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    expect(second.skip).toBe(false);
  });

  it('still bypasses the context hash gate when hasWakeSignal is true regardless of watch digest', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);
    const watchDigest = computeWatchSummaryDigest(makeWatchSummary());

    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 0,
        watchSummaryDigest: watchDigest,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    const wakeTickResult = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: false,
        hasWakeSignal: true,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 0,
        watchSummaryDigest: watchDigest,
        previousContextHash: first.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    expect(wakeTickResult.skip).toBe(false);
  });

  // ── Wake signal digest gate tests ────────────────────────────────────────

  it('skips when wake signal digest is unchanged (no new signals between ticks, flat position)', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);
    const wakeDigest = computeWakeSignalDigest([
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1000 },
    ]);

    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        wakeSignalDigest: wakeDigest,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    const second = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        wakeSignalDigest: wakeDigest,
        previousContextHash: first.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    expect(second.skip).toBe(true);
    expect(second.reason).toBe('context_unchanged');
  });

  it('does NOT skip when wake signal digest changes (new signals arrived, flat position)', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);
    const beforeDigest = computeWakeSignalDigest([
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1000 },
    ]);
    const afterDigest = computeWakeSignalDigest([
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1000 },
      { source: 'reminder', reason: 'check positions', receivedAt: 2000 },
    ]);

    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        wakeSignalDigest: beforeDigest,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    const second = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        wakeSignalDigest: afterDigest,
        previousContextHash: first.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    expect(second.skip).toBe(false);
  });

  it('skips when wake signal digest is "__none__" on both ticks (stable no-signal state, flat position)', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);

    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        wakeSignalDigest: '__none__',
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    const second = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        wakeSignalDigest: '__none__',
        previousContextHash: first.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    expect(second.skip).toBe(true);
    expect(second.reason).toBe('context_unchanged');
  });

  it('does NOT skip when wake signal digest transitions from "__none__" to a real digest (signals arrived, flat position)', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);
    const realDigest = computeWakeSignalDigest([
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1000 },
    ]);

    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        wakeSignalDigest: '__none__',
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    const second = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        wakeSignalDigest: realDigest,
        previousContextHash: first.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    expect(second.skip).toBe(false);
  });

  it('wake bypass still works with wake signal digest present', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);
    const wakeDigest = computeWakeSignalDigest([
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1000 },
    ]);

    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 0,
        wakeSignalDigest: wakeDigest,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    const wakeTickResult = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: false,
        hasWakeSignal: true,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 0,
        wakeSignalDigest: wakeDigest,
        previousContextHash: first.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    expect(wakeTickResult.skip).toBe(false);
  });

  it('does NOT skip when wake signal digest changes but price/PnL stay the same (open positions)', async () => {
    const beforeDigest = computeWakeSignalDigest([
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1000 },
    ]);
    const afterDigest = computeWakeSignalDigest([
      { source: 'price_alert', reason: 'BTC above 100k', receivedAt: 1000 },
      { source: 'reminder', reason: 'check positions', receivedAt: 2000 },
    ]);

    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: true,
        positionSide: 'long',
        latestPrice: 100,
        portfolioPnlUsd: 5,
        wakeSignalDigest: beforeDigest,
      },
      {},
    );

    const second = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: true,
        positionSide: 'long',
        latestPrice: 100,
        portfolioPnlUsd: 5,
        wakeSignalDigest: afterDigest,
        previousContextHash: first.contextHash,
      },
      {},
    );

    expect(second.skip).toBe(false);
  });

  it('returns current interval without throwing when fetchVolatilityCandles fails', async () => {
    const fetchVolatilityCandles = vi.fn().mockRejectedValue(new Error('AbortError: This operation was aborted'));

    const result = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        currentTickIntervalMs: 60_000,
        baseTickIntervalMs: 900_000,
      },
      { fetchVolatilityCandles },
    );

    expect(result.nextTickIntervalMs).toBe(60_000);
    expect(result.degraded).toBe(true);
    expect(result.degradationReason).toBe('adaptive_interval_unavailable');
  });

  it('returns base interval fallback when fetchVolatilityCandles fails and no current interval is set', async () => {
    const fetchVolatilityCandles = vi.fn().mockRejectedValue(new Error('timeout'));

    const result = await shouldSkipTick(
      { tickNumber: 1, hasOpenPositions: false, baseTickIntervalMs: 600_000 },
      { fetchVolatilityCandles },
    );

    expect(result.nextTickIntervalMs).toBe(600_000);
    expect(result.degraded).toBe(true);
  });

  it('preserves adaptive-interval degradation metadata on session skips', async () => {
    const fetchVolatilityCandles = vi.fn().mockRejectedValue(new Error('timeout'));

    const result = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        now: new Date('2026-06-08T12:00:00.000Z'),
        tradingHours: { allowedHoursUtc: [9], weekendPause: false },
        currentTickIntervalMs: 60_000,
        baseTickIntervalMs: 900_000,
      },
      { fetchVolatilityCandles },
    );

    expect(result.skip).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.degradationReason).toBe('adaptive_interval_unavailable');
  });

  it('preserves adaptive-interval degradation metadata when positions are open', async () => {
    const fetchVolatilityCandles = vi.fn().mockRejectedValue(new Error('timeout'));

    const result = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: true,
        currentTickIntervalMs: 60_000,
        baseTickIntervalMs: 900_000,
      },
      { fetchVolatilityCandles },
    );

    expect(result.skip).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.degradationReason).toBe('adaptive_interval_unavailable');
  });

  it('makes no candle calls and returns deterministically when fetchVolatilityCandles is undefined', async () => {
    const result = await shouldSkipTick(
      { tickNumber: 1, hasOpenPositions: false, baseTickIntervalMs: 900_000 },
      {},
    );

    expect(result.nextTickIntervalMs).toBe(900_000);
    expect(result.degraded).toBeUndefined();
  });

  it('returns without throwing and marks regime degraded when evaluateRegime fails', async () => {
    const evaluateRegime = vi.fn().mockRejectedValue(new Error('AbortError: This operation was aborted'));

    const result = await shouldSkipTick(
      { tickNumber: 1, hasOpenPositions: false },
      { evaluateRegime },
    );

    expect(result.skip).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.degradationReason).toBe('regime_unavailable');
    expect(result.regime).toBeUndefined();
  });

  it('still applies context-hash gate when evaluateRegime fails', async () => {
    const evaluateRegime = vi.fn().mockRejectedValue(new Error('timeout'));
    const first = await shouldSkipTick(
      { tickNumber: 1, hasOpenPositions: false, positionSide: 'flat', latestPrice: 100, portfolioPnlUsd: 0 },
      { evaluateRegime },
    );

    const second = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 0,
        previousContextHash: first.contextHash,
      },
      { evaluateRegime },
    );

    expect(second.skip).toBe(true);
    expect(second.gate).toBe('context_hash');
    expect(second.degraded).toBe(true);
    expect(second.degradationReason).toBe('regime_unavailable');
  });

  it('does NOT skip when watch digest is unknown with open positions', async () => {
    const result1 = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: true,
        positionSide: 'long',
        latestPrice: 100,
        portfolioPnlUsd: 5,
        watchSummaryDigest: computeWatchSummaryDigest(null),
      },
      {},
    );
    // tick 1 — no previous hash to compare against, so it should not skip
    expect(result1.skip).toBe(false);

    const result2 = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: true,
        positionSide: 'long',
        latestPrice: 100,
        portfolioPnlUsd: 5,
        watchSummaryDigest: computeWatchSummaryDigest(null),
        previousContextHash: result1.contextHash ?? null,
      },
      {},
    );
    // tick 2 — hash includes __unknown__2 which differs from __unknown__1, so should NOT skip
    expect(result2.skip).toBe(false);
  });

  it('forces evaluation on the 10th tick even when watch digest is present and context matches', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);
    const watchDigest = computeWatchSummaryDigest(makeWatchSummary());

    // Build a reference hash from tick 1 with the watch digest
    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        watchSummaryDigest: watchDigest,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    // tick 10 with same context + same watch digest should NOT skip (forced evaluation)
    const tenth = await shouldSkipTick(
      {
        tickNumber: 10,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        watchSummaryDigest: watchDigest,
        previousContextHash: first.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    expect(tenth.skip).toBe(false);
  });

  it('transitions from __unknown__ to known digest: evaluate → evaluate → skip', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);
    const realDigest = computeWatchSummaryDigest(makeWatchSummary());

    // Tick 1: unknown watch state — must evaluate
    const tick1 = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        watchSummaryDigest: '__unknown__',
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );
    expect(tick1.skip).toBe(false);

    // Tick 2: real digest — hash differs from __unknown__1, must evaluate
    const tick2 = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        watchSummaryDigest: realDigest,
        previousContextHash: tick1.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );
    expect(tick2.skip).toBe(false);

    // Tick 3: same real digest — hash matches tick 2, should skip
    const tick3 = await shouldSkipTick(
      {
        tickNumber: 3,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        watchSummaryDigest: realDigest,
        previousContextHash: tick2.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );
    expect(tick3.skip).toBe(true);
    expect(tick3.reason).toBe('context_unchanged');
  });
});

describe('trading-hours helpers', () => {
  it('allows all hours when the list is empty', () => {
    expect(isWithinTradingHours(new Date('2026-06-08T12:00:00.000Z'), { allowedHoursUtc: [], weekendPause: false })).toBe(true);
  });

  it('applies weekend pause until sunday noon UTC', () => {
    expect(isWithinTradingHours(new Date('2026-06-07T11:00:00.000Z'), { allowedHoursUtc: [], weekendPause: true })).toBe(false);
    expect(isWithinTradingHours(new Date('2026-06-07T12:00:00.000Z'), { allowedHoursUtc: [], weekendPause: true })).toBe(true);
  });
});

describe('isWithinTradingHours — trading sessions', () => {
  it('allows tick during Asia session (EDT)', () => {
    // 2026-07-01T01:30:00Z = 9:30 pm EDT (UTC-4) → inside Asia (8 pm–12 am ET = 0–3 UTC)
    expect(isWithinTradingHours(
      new Date('2026-07-01T01:30:00Z'),
      { tradingSessions: ['asia'] },
    )).toBe(true);
  });

  it('blocks tick outside Asia session (EDT)', () => {
    // 2026-07-01T10:00:00Z = 6 am EDT → outside Asia
    expect(isWithinTradingHours(
      new Date('2026-07-01T10:00:00Z'),
      { tradingSessions: ['asia'] },
    )).toBe(false);
  });

  it('sessions union correctly — Asia + London covers both windows', () => {
    // 2026-07-01T06:30:00Z = 2:30 am EDT → inside London (1–5 am ET = 5–8 UTC)
    expect(isWithinTradingHours(
      new Date('2026-07-01T06:30:00Z'),
      { tradingSessions: ['asia', 'london'] },
    )).toBe(true);
  });

  it('sessions respected in winter (EST — UTC-5)', () => {
    // 2026-01-07T06:30:00Z = 1:30 am EST → inside London (1–5 am ET, UTC-5 → UTC 6–10)
    expect(isWithinTradingHours(
      new Date('2026-01-07T06:30:00Z'),
      { tradingSessions: ['london'] },
    )).toBe(true);
  });

  it('weekendPause takes priority over sessions', () => {
    // Saturday UTC
    expect(isWithinTradingHours(
      new Date('2026-07-04T02:00:00Z'),
      { tradingSessions: ['asia'], weekendPause: true },
    )).toBe(false);
  });

  it('empty tradingSessions falls back to allowedHoursUtc', () => {
    expect(isWithinTradingHours(
      new Date('2026-07-01T05:00:00Z'),
      { tradingSessions: [], allowedHoursUtc: [5] },
    )).toBe(true);
  });

  it('tradingSessions undefined falls back to allowedHoursUtc', () => {
    expect(isWithinTradingHours(
      new Date('2026-07-01T14:00:00Z'),
      { allowedHoursUtc: [14] },
    )).toBe(true);
  });

  it('blocks tick outside NY Afternoon session (EDT)', () => {
    // 2026-07-01T20:00:00Z = 4 pm EDT → edge of NY Afternoon (12–4 pm ET = 16–19 UTC)
    // 4 pm EDT = 20:00 UTC, which is past 19:00 → should be outside
    expect(isWithinTradingHours(
      new Date('2026-07-01T20:00:00Z'),
      { tradingSessions: ['ny-afternoon'] },
    )).toBe(false);
  });
});

describe('adaptive interval helpers', () => {
  const lowVolCandles = Array.from({ length: 14 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 5, 8, index)).toISOString(),
    open: 100,
    high: 100.05,
    low: 99.95,
    close: 100,
    volume: 1_000,
  }));

  const highVolCandles = Array.from({ length: 14 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 5, 8, index)).toISOString(),
    open: 100,
    high: 102,
    low: 98,
    close: 100,
    volume: 1_000,
  }));

  it('calculates ATR as a percent of the last close', () => {
    expect(calculateAtrPercent(lowVolCandles)).toBeLessThan(0.3);
    expect(calculateAtrPercent(highVolCandles)).toBeGreaterThan(0.3);
  });

  it('doubles the interval in low-volatility conditions', () => {
    const result = resolveAdaptiveIntervalMs({
      candles: lowVolCandles,
      baseTickIntervalMs: 60_000,
      currentTickIntervalMs: 60_000,
    });

    expect(result.nextTickIntervalMs).toBe(120_000);
  });

  it('halves the interval in higher-volatility conditions without going below base', () => {
    const result = resolveAdaptiveIntervalMs({
      candles: highVolCandles,
      baseTickIntervalMs: 60_000,
      currentTickIntervalMs: 240_000,
    });

    expect(result.nextTickIntervalMs).toBe(120_000);
  });

  it('treats an explicit base cadence as the floor while still allowing slowdown and recovery', () => {
    const slowed = resolveAdaptiveIntervalMs({
      candles: lowVolCandles,
      baseTickIntervalMs: 600_000,
      currentTickIntervalMs: 600_000,
    });

    expect(slowed.nextTickIntervalMs).toBe(1_200_000);

    const recovered = resolveAdaptiveIntervalMs({
      candles: highVolCandles,
      baseTickIntervalMs: 600_000,
      currentTickIntervalMs: slowed.nextTickIntervalMs,
    });

    expect(recovered.nextTickIntervalMs).toBe(600_000);
  });
});