import { describe, expect, it } from 'vitest';
import {
  formatTickIntervalMinutesForInput,
  getTickIntervalValidationMessageId,
  isWholeMinuteTickInterval,
  parseTickIntervalMinutesInput,
} from './tick-interval.js';

describe('tick interval helpers', () => {
  it('accepts empty values as unset', () => {
    expect(parseTickIntervalMinutesInput('')).toEqual({ kind: 'empty' });
  });

  it('rejects sub-minute values', () => {
    expect(getTickIntervalValidationMessageId('0')).toBe('agents.controls.tickInterval.validation.minimum');
  });

  it('rejects non-integer minute values', () => {
    expect(getTickIntervalValidationMessageId('1.5')).toBe('agents.controls.tickInterval.validation.wholeMinutes');
  });

  it('converts valid minute inputs to milliseconds', () => {
    expect(parseTickIntervalMinutesInput('15')).toEqual({ kind: 'valid', minutes: 15, tickIntervalMs: 900_000 });
  });

  it('rounds legacy millisecond values up for display without marking exact minute cadences as legacy', () => {
    expect(formatTickIntervalMinutesForInput(90_000)).toBe('2');
    expect(isWholeMinuteTickInterval(120_000)).toBe(true);
    expect(isWholeMinuteTickInterval(90_000)).toBe(false);
  });
});