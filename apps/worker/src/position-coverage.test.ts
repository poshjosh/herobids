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
    ...overrides,
  };
}

function makePosition(overrides: Partial<PositionInput> = {}): PositionInput {
  return {
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
        makePosition({ symbol: 'BTC-USD', side: 'long' }),
        makePosition({ symbol: 'ETH-USD', side: 'short' }),
        makePosition({ symbol: 'SOL-USD', side: 'long' }),
      ],
      watches: [
        makeWatch({ watchId: 'w1', symbol: 'BTC-USD', purpose: 'stop_loss' }),
        makeWatch({ watchId: 'w2', symbol: 'ETH-USD', purpose: 'monitor' }),
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
    const position = makePosition({ symbol: 'XYZ-USD', side: 'long' });
    const watch = makeWatch({
      symbol: 'COMPLETELY-DIFFERENT',
      purpose: 'stop_loss',
      coverage: { positionKey: 'XYZ-USD::long' },
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

  it('legacy watch without structured identity does NOT provide protective coverage (conservative gating)', () => {
    const position = makePosition({ symbol: 'BTC-USD', side: 'short' });
    const watch = makeWatch({
      symbol: 'btc-perp',
      purpose: 'exit',
      schemaVersion: undefined, // Explicitly legacy — no structured identity
      // No instrument, no coverage
    });

    const result = evaluatePositionCoverage({
      positions: [position],
      watches: [watch],
    });

    // Legacy watches are NOT trustable for coverage — position is uncovered
    expect(result.positions[0]!.hasProtectiveCoverage).toBe(false);
    expect(result.positions[0]!.protectiveWatchCount).toBe(0);
    expect(result.hasUncoveredPosition).toBe(true);
  });

  it('v2 watch with schemaVersion provides protective coverage via symbol fallback', () => {
    const position = makePosition({ symbol: 'BTC-USD', side: 'short' });
    const watch = makeWatch({
      symbol: 'btc-perp',
      purpose: 'exit',
      schemaVersion: 2,
      // v2 trustable — symbol fallback is acceptable
    });

    const result = evaluatePositionCoverage({
      positions: [position],
      watches: [watch],
    });

    expect(result.positions[0]!.hasProtectiveCoverage).toBe(true);
    expect(result.positions[0]!.protectiveWatchCount).toBe(1);
  });

  it.each([
    { schemaVersion: 2, expectedCoverage: true, desc: 'v2' },
    { schemaVersion: undefined, expectedCoverage: false, desc: 'legacy (undefined)' },
    { schemaVersion: 1, expectedCoverage: false, desc: 'legacy (v1)' },
  ] as const)('schemaVersion=$desc → hasProtectiveCoverage=$expectedCoverage for stop_loss watch',
    ({ schemaVersion, expectedCoverage }) => {
      const result = evaluatePositionCoverage({
        positions: [makePosition()],
        watches: [makeWatch({ purpose: 'stop_loss', schemaVersion })],
      });

      expect(result.positions[0]!.hasProtectiveCoverage).toBe(expectedCoverage);
      if (!expectedCoverage) {
        expect(result.positions[0]!.protectiveWatchCount).toBe(0);
        expect(result.hasUncoveredPosition).toBe(true);
      }
    },
  );

  it('watch with coverage.positionKey provides coverage even without schemaVersion', () => {
    const position = makePosition({ symbol: 'XYZ-USD', side: 'long' });
    const watch = makeWatch({
      symbol: 'COMPLETELY-DIFFERENT',
      purpose: 'stop_loss',
      schemaVersion: undefined,
      coverage: { positionKey: 'XYZ-USD::long' },
    });

    const result = evaluatePositionCoverage({
      positions: [position],
      watches: [watch],
    });

    expect(result.positions[0]!.hasProtectiveCoverage).toBe(true);
  });

  it('v2 watch without purpose is not protective', () => {
    const result = evaluatePositionCoverage({
      positions: [makePosition()],
      watches: [makeWatch({ purpose: undefined })],
    });

    expect(result.positions[0]!.hasProtectiveCoverage).toBe(false);
    expect(result.hasUncoveredPosition).toBe(true);
  });

  it('legacy watch (no schemaVersion) without purpose is not protective', () => {
    const result = evaluatePositionCoverage({
      positions: [makePosition()],
      watches: [makeWatch({ purpose: undefined, schemaVersion: undefined })],
    });

    expect(result.positions[0]!.hasProtectiveCoverage).toBe(false);
    expect(result.positions[0]!.protectiveWatchCount).toBe(0);
    expect(result.hasUncoveredPosition).toBe(true);
  });

  // ── Aggregate flags ───────────────────────────────────────────────

  it('hasUncoveredPosition aggregate flag', () => {
    const result = evaluatePositionCoverage({
      positions: [
        makePosition({ symbol: 'BTC-USD', side: 'long' }),
        makePosition({ symbol: 'ETH-USD', side: 'long' }),
      ],
      watches: [
        makeWatch({ watchId: 'w1', symbol: 'BTC-USD', purpose: 'stop_loss' }),
      ],
    });

    expect(result.positions[0]!.hasProtectiveCoverage).toBe(true);
    expect(result.positions[1]!.hasProtectiveCoverage).toBe(false);
    expect(result.hasUncoveredPosition).toBe(true);
  });

  it('hasTriggeredProtectiveWatch aggregate flag across multiple positions', () => {
    const result = evaluatePositionCoverage({
      positions: [
        makePosition({ symbol: 'BTC-USD', side: 'long' }),
        makePosition({ symbol: 'ETH-USD', side: 'long' }),
      ],
      watches: [
        makeWatch({ watchId: 'w1', symbol: 'BTC-USD', purpose: 'stop_loss', lastConditionMet: true }),
        makeWatch({ watchId: 'w2', symbol: 'ETH-USD', purpose: 'take_profit', lastConditionMet: false }),
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

  it('positionKey uses instrumentId when available', () => {
    const position = makePosition({ instrumentId: 'INST-001', symbol: 'BTC-USD', side: 'short' });
    const result = evaluatePositionCoverage({
      positions: [position],
      watches: [],
    });

    expect(result.positions[0]!.positionKey).toBe('INST-001::short');
  });

  it('positionKey falls back to symbol when no instrumentId', () => {
    const position = makePosition({ symbol: 'ETH-USD', side: 'long' });
    const result = evaluatePositionCoverage({
      positions: [position],
      watches: [],
    });

    expect(result.positions[0]!.positionKey).toBe('ETH-USD::long');
  });

  // ── PROTECTIVE_WATCH_PURPOSES constant ─────────────────────────────

  it('PROTECTIVE_WATCH_PURPOSES includes stop_loss, take_profit, exit', () => {
    expect(PROTECTIVE_WATCH_PURPOSES).toEqual(['stop_loss', 'take_profit', 'exit']);
  });
});
