import { describe, expect, it } from 'vitest';
import { formatCadence, deriveExpectedCadence, estimateDailySpend, hasExplicitTickInterval, PRESET_TICK_INTERVALS } from './agent-cadence.js';

describe('formatCadence', () => {
  it('formats sub-minute intervals in seconds', () => {
    expect(formatCadence(30_000)).toBe('every 30s');
  });

  it('formats minute-range intervals in minutes', () => {
    expect(formatCadence(900_000)).toBe('every 15 min');
    expect(formatCadence(60_000)).toBe('every 1 min');
  });

  it('formats hour-range intervals in hours', () => {
    expect(formatCadence(3_600_000)).toBe('every 1h');
    expect(formatCadence(7_200_000)).toBe('every 2h');
  });
});

describe('deriveExpectedCadence', () => {
  it('uses explicit tick interval when set', () => {
    expect(deriveExpectedCadence(900_000, 'standard', 10)).toBe('every 15 min');
  });

  it('falls back to preset-derived cadence when tick interval is not set', () => {
    expect(deriveExpectedCadence(null, 'standard')).toBe('every 30 min');
    expect(deriveExpectedCadence(null, 'minimal')).toBe('every 90 min');
    expect(deriveExpectedCadence(null, 'premium')).toBe('every 10 min');
  });

  it('derives custom cadence from the configured daily budget', () => {
    expect(deriveExpectedCadence(null, 'custom', 0.5)).toBe('every 6h');
  });

  it('returns null when neither interval nor known preset is provided', () => {
    expect(deriveExpectedCadence(null, null)).toBeNull();
    expect(deriveExpectedCadence(null, 'unknown')).toBeNull();
    expect(deriveExpectedCadence(undefined, undefined)).toBeNull();
  });

  it('accepts string values for tick interval', () => {
    expect(deriveExpectedCadence('900000', null)).toBe('every 15 min');
  });
});

describe('estimateDailySpend', () => {
  it('returns the daily budget directly when set', () => {
    expect(estimateDailySpend(null, null, 15)).toBe(15);
  });

  it('falls back to preset daily budget defaults when preset metadata exists', () => {
    expect(estimateDailySpend(null, 'minimal', null)).toBe(3);
    expect(estimateDailySpend(null, 'standard', null)).toBe(10);
    expect(estimateDailySpend(null, 'premium', null)).toBe(30);
    expect(estimateDailySpend(null, 'custom', null)).toBe(5);
  });

  it('uses an explicit tick interval estimate before preset fallback', () => {
    expect(estimateDailySpend(600_000, 'premium', null)).toBe(44.64);
  });

  it('estimates from tick interval when no budget is given', () => {
    const spend = estimateDailySpend(900_000, null, null);
    expect(spend).not.toBeNull();
    expect(spend!).toBeGreaterThan(0);
  });

  it('returns null when not enough information is available', () => {
    expect(estimateDailySpend(null, null, null)).toBeNull();
    expect(estimateDailySpend(null, 'unknown', null)).toBeNull();
  });
});

describe('hasExplicitTickInterval', () => {
  it('returns true for positive numeric values', () => {
    expect(hasExplicitTickInterval(900_000)).toBe(true);
    expect(hasExplicitTickInterval('300000')).toBe(true);
  });

  it('returns false for null, undefined, or empty string', () => {
    expect(hasExplicitTickInterval(null)).toBe(false);
    expect(hasExplicitTickInterval(undefined)).toBe(false);
    expect(hasExplicitTickInterval('')).toBe(false);
  });

  it('returns false for zero', () => {
    expect(hasExplicitTickInterval(0)).toBe(false);
  });
});

describe('PRESET_TICK_INTERVALS', () => {
  it('has correct values for each preset', () => {
    expect(PRESET_TICK_INTERVALS.minimal).toBe(5_400_000);
    expect(PRESET_TICK_INTERVALS.standard).toBe(1_800_000);
    expect(PRESET_TICK_INTERVALS.premium).toBe(600_000);
  });
});
