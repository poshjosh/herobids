import { describe, it, expect } from 'vitest';
import {
  evaluatePositionCoverage,
  PROTECTIVE_WATCH_PURPOSES,
  DEFAULT_STALE_THRESHOLD_MS,
  type PositionInput,
  type WatchInput,
} from './position-coverage.js';

function makeWatch(overrides: Partial<WatchInput> = {}): WatchInput {
  return {
    watchId: '00000000-0000-0000-0000-000000000001',
    symbol: 'BTC-USD',
    lastConditionMet: null,
    schemaVersion: 2,
    instrument: { venue: 'hyperliquid', instrumentId: 'BTC-USD', symbol: 'BTC-USD' },
    ...overrides,
  };
}

function makePosition(overrides: Partial<PositionInput> = {}): PositionInput {
  return {
    venue: 'hyperliquid',
    instrumentId: 'BTC-USD',
    symbol: 'BTC-USD',
    side: 'long',
    ...overrides,
  };
}

describe('evaluatePositionCoverage', () => {
  // ── Basic protective coverage ──────────────────────────────────────

  it('position with protective stop_loss watch → hasProtectiveCoverage = true', () => {
    const result = evaluatePositionCoverage({
      positions: [makePosition()],
      watches: [makeWatch({ purpose: 'stop_loss', lastConditionMet: false })],
    });

    expect(result.totalOpenPositions).toBe(1);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]!.hasProtectiveCoverage).toBe(true);
    expect(result.positions[0]!.protectiveWatchCount).toBe(1);
    expect(result.hasUncoveredPosition).toBe(false);
    expect(result.hasTriggeredProtectiveWatch).toBe(false);
  });

  it('position with only monitor watch → hasProtectiveCoverage = false', () => {
    const result = evaluatePositionCoverage({
      positions: [makePosition()],
      watches: [makeWatch({ purpose: 'monitor' })],
    });

    expect(result.positions[0]!.hasProtectiveCoverage).toBe(false);
    expect(result.positions[0]!.protectiveWatchCount).toBe(0);
    expect(result.hasUncoveredPosition).toBe(true);
  });

  it('position with no watches → hasProtectiveCoverage = false', () => {
    const result = evaluatePositionCoverage({
      positions: [makePosition()],
      watches: [],
    });

    expect(result.positions[0]!.hasProtectiveCoverage).toBe(false);
    expect(result.positions[0]!.protectiveWatchCount).toBe(0);
    expect(result.hasUncoveredPosition).toBe(true);
  });

  it('position with watch lacking purpose → hasProtectiveCoverage = false', () => {
    const result = evaluatePositionCoverage({
      positions: [makePosition()],
      watches: [makeWatch({ purpose: undefined })],
    });

    expect(result.positions[0]!.hasProtectiveCoverage).toBe(false);
    expect(result.hasUncoveredPosition).toBe(true);
  });

  // ── Triggered and stale flags ──────────────────────────────────────

  it('triggered protective watch → triggeredProtectiveWatch = true', () => {
    const result = evaluatePositionCoverage({
      positions: [makePosition()],
      watches: [makeWatch({ purpose: 'stop_loss', lastConditionMet: true })],
    });

    expect(result.positions[0]!.triggeredProtectiveWatch).toBe(true);
    expect(result.hasTriggeredProtectiveWatch).toBe(true);
  });

  it('stale protective watch → staleProtectiveWatch = true', () => {
    const longAgo = new Date(Date.now() - DEFAULT_STALE_THRESHOLD_MS - 60_000).toISOString();
    const result = evaluatePositionCoverage({
      positions: [makePosition()],
      watches: [makeWatch({ purpose: 'take_profit', lastCheckedAt: longAgo })],
    });

    expect(result.positions[0]!.staleProtectiveWatch).toBe(true);
    expect(result.hasStaleProtectiveWatch).toBe(true);
  });

  it('protective watch with no lastCheckedAt → not stale (never checked, may be newly created)', () => {
    const result = evaluatePositionCoverage({
      positions: [makePosition()],
      watches: [makeWatch({ purpose: 'exit', lastCheckedAt: undefined })],
    });

    expect(result.positions[0]!.staleProtectiveWatch).toBe(false);
    expect(result.hasStaleProtectiveWatch).toBe(false);
  });

  it('fresh protective watch → staleProtectiveWatch = false', () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    const result = evaluatePositionCoverage({
      positions: [makePosition()],
      watches: [makeWatch({ purpose: 'stop_loss', lastCheckedAt: recent })],
    });

    expect(result.positions[0]!.staleProtectiveWatch).toBe(false);
    expect(result.hasStaleProtectiveWatch).toBe(false);
  });

  // ── Multiple positions, mixed coverage ────────────────────────────

  it('multiple positions with mixed coverage', () => {
    const result = evaluatePositionCoverage({
      positions: [
        makePosition({ instrumentId: 'BTC-USD', symbol: 'BTC-USD', side: 'long' }),
        makePosition({ instrumentId: 'ETH-USD', symbol: 'ETH-USD', side: 'short' }),
        makePosition({ instrumentId: 'SOL-USD', symbol: 'SOL-USD', side: 'long' }),
      ],
      watches: [
        makeWatch({ watchId: 'w1', symbol: 'BTC-USD', purpose: 'stop_loss', instrument: { venue: 'hyperliquid', instrumentId: 'BTC-USD', symbol: 'BTC-USD' } }),
        makeWatch({ watchId: 'w2', symbol: 'ETH-USD', purpose: 'monitor', instrument: { venue: 'hyperliquid', instrumentId: 'ETH-USD', symbol: 'ETH-USD' } }),
      ],
    });

    expect(result.positions).toHaveLength(3);
    // BTC: covered
    expect(result.positions[0]!.hasProtectiveCoverage).toBe(true);
    // ETH: watch exists but not protective
    expect(result.positions[1]!.hasProtectiveCoverage).toBe(false);
    // SOL: no watch at all
    expect(result.positions[2]!.hasProtectiveCoverage).toBe(false);

    expect(result.hasUncoveredPosition).toBe(true); // ETH and SOL uncovered
    expect(result.totalOpenPositions).toBe(3);
  });

  // ── Matching strategies ───────────────────────────────────────────

  it('direct linkage via coverage.positionKey', () => {
    const position = makePosition({ venue: 'hyperliquid', symbol: 'XYZ-USD', side: 'long' });
    const watch = makeWatch({
      symbol: 'COMPLETELY-DIFFERENT',
      purpose: 'stop_loss',
      coverage: { positionKey: 'hyperliquid::XYZ-USD::long' },
    });

    const result = evaluatePositionCoverage({
      positions: [position],
      watches: [watch],
    });

    expect(result.positions[0]!.hasProtectiveCoverage).toBe(true);
  });

  it('matching via instrument.instrumentId', () => {
    const position = makePosition({ instrumentId: 'BTC-USD-PERP', symbol: 'BTC-PERP', side: 'long' });
    const watch = makeWatch({
      symbol: 'BTC/USDT',
      purpose: 'take_profit',
      instrument: { venue: 'hyperliquid', instrumentId: 'BTC-USD-PERP', symbol: 'BTC-USD' },
    });

    const result = evaluatePositionCoverage({
      positions: [position],
      watches: [watch],
    });

    expect(result.positions[0]!.hasProtectiveCoverage).toBe(true);
  });

  it('watch without structured identity does NOT provide protective coverage', () => {
    const position = makePosition({ symbol: 'BTC-USD', side: 'short' });
    const watch = makeWatch({
      symbol: 'btc-perp',
      purpose: 'exit',
      schemaVersion: undefined,
      instrument: undefined,
      // No instrument, no coverage → not trustable
    });

    const result = evaluatePositionCoverage({
      positions: [position],
      watches: [watch],
    });

    // Watches without structured identity are NOT trustable for coverage
    expect(result.positions[0]!.hasProtectiveCoverage).toBe(false);
    expect(result.positions[0]!.protectiveWatchCount).toBe(0);
    expect(result.hasUncoveredPosition).toBe(true);
  });

  it('v2 watch with instrument identity provides protective coverage via instrumentId matching', () => {
    const position = makePosition({ instrumentId: 'BTC-USD-PERP', symbol: 'BTC-PERP', side: 'short' });
    const watch = makeWatch({
      symbol: 'BTC/USDT',
      purpose: 'exit',
      schemaVersion: 2,
      instrument: { venue: 'hyperliquid', instrumentId: 'BTC-USD-PERP', symbol: 'BTC-USD' },
    });

    const result = evaluatePositionCoverage({
      positions: [position],
      watches: [watch],
    });

    expect(result.positions[0]!.hasProtectiveCoverage).toBe(true);
    expect(result.positions[0]!.protectiveWatchCount).toBe(1);
  });

  it('watch with instrument.instrumentId provides protective coverage via identity matching', () => {
    const position = makePosition({ venue: 'hyperliquid', instrumentId: 'BTC-USD-PERP', symbol: 'BTC-PERP', side: 'short' });
    const watch = makeWatch({
      symbol: 'BTC/USDT',
      purpose: 'exit',
      instrument: { venue: 'hyperliquid', instrumentId: 'BTC-USD-PERP', symbol: 'BTC-USD' },
    });

    const result = evaluatePositionCoverage({
      positions: [position],
      watches: [watch],
    });

    expect(result.positions[0]!.hasProtectiveCoverage).toBe(true);
    expect(result.positions[0]!.protectiveWatchCount).toBe(1);
  });

  it('watch with coverage.positionKey provides coverage even without instrument identity', () => {
    const position = makePosition({ venue: 'jupiter', instrumentId: undefined, symbol: 'XYZ-USD', side: 'long' });
    const watch = makeWatch({
      symbol: 'COMPLETELY-DIFFERENT',
      purpose: 'stop_loss',
      instrument: undefined,
      coverage: { positionKey: 'jupiter::XYZ-USD::long' },
    });

    const result = evaluatePositionCoverage({
      positions: [position],
      watches: [watch],
    });

    expect(result.positions[0]!.hasProtectiveCoverage).toBe(true);
  });

  it('watch without purpose is not protective', () => {
    const result = evaluatePositionCoverage({
      positions: [makePosition()],
      watches: [makeWatch({ purpose: undefined })],
    });

    expect(result.positions[0]!.hasProtectiveCoverage).toBe(false);
    expect(result.hasUncoveredPosition).toBe(true);
  });

  // ── Aggregate flags ───────────────────────────────────────────────

  it('hasUncoveredPosition aggregate flag', () => {
    const result = evaluatePositionCoverage({
      positions: [
        makePosition({ instrumentId: 'BTC-USD', symbol: 'BTC-USD', side: 'long' }),
        makePosition({ instrumentId: 'ETH-USD', symbol: 'ETH-USD', side: 'long' }),
      ],
      watches: [
        makeWatch({ watchId: 'w1', symbol: 'BTC-USD', purpose: 'stop_loss', instrument: { venue: 'hyperliquid', instrumentId: 'BTC-USD', symbol: 'BTC-USD' } }),
      ],
    });

    expect(result.positions[0]!.hasProtectiveCoverage).toBe(true);
    expect(result.positions[1]!.hasProtectiveCoverage).toBe(false);
    expect(result.hasUncoveredPosition).toBe(true);
  });

  it('hasTriggeredProtectiveWatch aggregate flag across multiple positions', () => {
    const result = evaluatePositionCoverage({
      positions: [
        makePosition({ instrumentId: 'BTC-USD', symbol: 'BTC-USD', side: 'long' }),
        makePosition({ instrumentId: 'ETH-USD', symbol: 'ETH-USD', side: 'long' }),
      ],
      watches: [
        makeWatch({ watchId: 'w1', symbol: 'BTC-USD', purpose: 'stop_loss', lastConditionMet: true, instrument: { venue: 'hyperliquid', instrumentId: 'BTC-USD', symbol: 'BTC-USD' } }),
        makeWatch({ watchId: 'w2', symbol: 'ETH-USD', purpose: 'take_profit', lastConditionMet: false, instrument: { venue: 'hyperliquid', instrumentId: 'ETH-USD', symbol: 'ETH-USD' } }),
      ],
    });

    expect(result.hasTriggeredProtectiveWatch).toBe(true);
    expect(result.positions[0]!.triggeredProtectiveWatch).toBe(true);
    expect(result.positions[1]!.triggeredProtectiveWatch).toBe(false);
  });

  // ── All protective purposes ────────────────────────────────────────

  it.each(['stop_loss', 'take_profit', 'exit'] as const)(
    '%s is a protective purpose',
    (purpose) => {
      const result = evaluatePositionCoverage({
        positions: [makePosition()],
        watches: [makeWatch({ purpose })],
      });

      expect(result.positions[0]!.hasProtectiveCoverage).toBe(true);
    },
  );

  it.each(['entry', 'monitor', 'alert'] as const)(
    '%s is NOT a protective purpose',
    (purpose) => {
      const result = evaluatePositionCoverage({
        positions: [makePosition()],
        watches: [makeWatch({ purpose })],
      });

      expect(result.positions[0]!.hasProtectiveCoverage).toBe(false);
    },
  );

  // ── Edge cases ─────────────────────────────────────────────────────

  it('empty positions → all flags false, totalOpenPositions = 0', () => {
    const result = evaluatePositionCoverage({
      positions: [],
      watches: [makeWatch({ purpose: 'stop_loss' })],
    });

    expect(result.totalOpenPositions).toBe(0);
    expect(result.positions).toHaveLength(0);
    expect(result.hasUncoveredPosition).toBe(false);
    expect(result.hasTriggeredProtectiveWatch).toBe(false);
    expect(result.hasStaleProtectiveWatch).toBe(false);
  });

  it('custom staleThresholdMs', () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const result = evaluatePositionCoverage({
      positions: [makePosition()],
      watches: [makeWatch({ purpose: 'stop_loss', lastCheckedAt: twoMinutesAgo })],
      staleThresholdMs: 3 * 60 * 1000, // 3 min threshold, 2 min old → NOT stale
    });

    expect(result.positions[0]!.staleProtectiveWatch).toBe(false);

    const result2 = evaluatePositionCoverage({
      positions: [makePosition()],
      watches: [makeWatch({ purpose: 'stop_loss', lastCheckedAt: twoMinutesAgo })],
      staleThresholdMs: 1 * 60 * 1000, // 1 min threshold, 2 min old → stale
    });

    expect(result2.positions[0]!.staleProtectiveWatch).toBe(true);
  });

  it('positionKey includes venue and uses instrumentId when available', () => {
    const position = makePosition({ venue: 'hyperliquid', instrumentId: 'INST-001', symbol: 'BTC-USD', side: 'short' });
    const result = evaluatePositionCoverage({
      positions: [position],
      watches: [],
    });

    expect(result.positions[0]!.positionKey).toBe('hyperliquid::INST-001::short');
  });

  it('positionKey includes venue and falls back to symbol when no instrumentId', () => {
    const position = makePosition({ venue: 'jupiter', instrumentId: undefined, symbol: 'ETH-USD', side: 'long' });
    const result = evaluatePositionCoverage({
      positions: [position],
      watches: [],
    });

    expect(result.positions[0]!.positionKey).toBe('jupiter::ETH-USD::long');
  });

  // ── PROTECTIVE_WATCH_PURPOSES constant ─────────────────────────────

  it('PROTECTIVE_WATCH_PURPOSES includes stop_loss, take_profit, exit', () => {
    expect(PROTECTIVE_WATCH_PURPOSES).toEqual(['stop_loss', 'take_profit', 'exit']);
  });

  // ── Native exit-level protection ───────────────────────────────────

  it('position with native stopLoss → hasNativeProtection = true, hasUnprotectedPosition = false', () => {
    const result = evaluatePositionCoverage({
      positions: [makePosition({ nativeExitLevels: { stopLoss: true } })],
      watches: [],
    });

    expect(result.positions[0]!.hasNativeProtection).toBe(true);
    expect(result.positions[0]!.hasProtectiveCoverage).toBe(false);
    // hasUncoveredPosition = true (no watch coverage), but hasUnprotectedPosition = false (has native)
    expect(result.hasUncoveredPosition).toBe(true);
    expect(result.hasUnprotectedPosition).toBe(false);
  });

  it('position with native takeProfit → hasNativeProtection = true', () => {
    const result = evaluatePositionCoverage({
      positions: [makePosition({ nativeExitLevels: { takeProfit: true } })],
      watches: [],
    });

    expect(result.positions[0]!.hasNativeProtection).toBe(true);
    expect(result.hasUnprotectedPosition).toBe(false);
  });

  it('position with both native stopLoss and takeProfit → hasNativeProtection = true', () => {
    const result = evaluatePositionCoverage({
      positions: [makePosition({ nativeExitLevels: { stopLoss: true, takeProfit: true } })],
      watches: [],
    });

    expect(result.positions[0]!.hasNativeProtection).toBe(true);
    expect(result.hasUnprotectedPosition).toBe(false);
  });

  it('position with neither native protection nor watch → truly unprotected', () => {
    const result = evaluatePositionCoverage({
      positions: [makePosition({ nativeExitLevels: undefined })],
      watches: [],
    });

    expect(result.positions[0]!.hasNativeProtection).toBe(false);
    expect(result.positions[0]!.hasProtectiveCoverage).toBe(false);
    expect(result.hasUncoveredPosition).toBe(true);
    expect(result.hasUnprotectedPosition).toBe(true);
  });

  it('position with watch coverage and native protection → fully covered', () => {
    const result = evaluatePositionCoverage({
      positions: [makePosition({ nativeExitLevels: { stopLoss: true } })],
      watches: [makeWatch({ purpose: 'stop_loss', lastConditionMet: false })],
    });

    expect(result.positions[0]!.hasNativeProtection).toBe(true);
    expect(result.positions[0]!.hasProtectiveCoverage).toBe(true);
    expect(result.hasUncoveredPosition).toBe(false);
    expect(result.hasUnprotectedPosition).toBe(false);
  });

  it('position with native protection but no watch → uncovered but not unprotected', () => {
    const result = evaluatePositionCoverage({
      positions: [makePosition({ nativeExitLevels: { takeProfit: true } })],
      watches: [makeWatch({ purpose: 'monitor' })], // monitor is not protective
    });

    expect(result.positions[0]!.hasNativeProtection).toBe(true);
    expect(result.positions[0]!.hasProtectiveCoverage).toBe(false);
    expect(result.hasUncoveredPosition).toBe(true);
    // Native protection exists, so position is NOT truly unprotected
    expect(result.hasUnprotectedPosition).toBe(false);
  });

  it('nativeExitLevels with both entries false → no native protection', () => {
    const result = evaluatePositionCoverage({
      positions: [makePosition({ nativeExitLevels: { stopLoss: false, takeProfit: false } })],
      watches: [],
    });

    expect(result.positions[0]!.hasNativeProtection).toBe(false);
    expect(result.hasUnprotectedPosition).toBe(true);
  });

  it('hasUnprotectedPosition aggregate — one native-protected, one truly bare', () => {
    const result = evaluatePositionCoverage({
      positions: [
        makePosition({ instrumentId: 'BTC-USD', symbol: 'BTC-USD', side: 'long', nativeExitLevels: { stopLoss: true } }),
        makePosition({ instrumentId: 'ETH-USD', symbol: 'ETH-USD', side: 'long', nativeExitLevels: undefined }),
      ],
      watches: [],
    });

    // BTC has native protection → not unprotected
    expect(result.positions[0]!.hasNativeProtection).toBe(true);
    // ETH has nothing → unprotected
    expect(result.positions[1]!.hasNativeProtection).toBe(false);
    expect(result.hasUnprotectedPosition).toBe(true);
  });

  it('empty positions → hasUnprotectedPosition = false', () => {
    const result = evaluatePositionCoverage({
      positions: [],
      watches: [],
    });

    expect(result.hasUnprotectedPosition).toBe(false);
  });
});
