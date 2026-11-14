import { describe, expect, it } from 'vitest';
import { formatElapsed, formatRunStatusHint } from './run-status-hint.js';

describe('formatElapsed', () => {
  it('shows seconds under a minute', () => {
    expect(formatElapsed(46_000)).toBe('46s');
  });

  it('shows minutes and seconds under an hour', () => {
    expect(formatElapsed(137_000)).toBe('2m17s');
  });

  it('shows hours and minutes from one hour', () => {
    expect(formatElapsed(3_900_000)).toBe('1h5m');
  });

  it('rounds down to whole seconds', () => {
    expect(formatElapsed(46_999)).toBe('46s');
  });

  it('reads as zero for negative or non-finite input', () => {
    expect(formatElapsed(-5_000)).toBe('0s');
    expect(formatElapsed(Number.NaN)).toBe('0s');
  });
});

describe('formatRunStatusHint', () => {
  const startedAtMs = Date.parse('2026-11-14T20:30:16.000Z');

  it('includes the current UTC time and the elapsed run time', () => {
    const nowMs = Date.parse('2026-11-14T20:31:02.000Z');
    expect(formatRunStatusHint({ nowMs, runStartedAtMs: startedAtMs })).toBe(
      'Current time is (UTC) 2026-11-14T20:31:02Z; this run has been in progress for 46s',
    );
  });

  it('drops milliseconds from the time', () => {
    const nowMs = Date.parse('2026-11-14T20:31:02.789Z');
    expect(formatRunStatusHint({ nowMs, runStartedAtMs: startedAtMs })).toContain('2026-11-14T20:31:02Z;');
  });

  it('states facts without instructing the model', () => {
    const nowMs = Date.parse('2026-11-14T20:47:57.000Z');
    const line = formatRunStatusHint({ nowMs, runStartedAtMs: startedAtMs });
    expect(line).toContain('17m41s');
    expect(line).not.toMatch(/\b(should|must|continue|stop)\b/i);
  });
});
