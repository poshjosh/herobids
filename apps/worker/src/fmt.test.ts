import { describe, it, expect } from 'vitest';
import { fmtNum, fmtUsd } from './fmt.js';

describe('fmtNum', () => {
  it('formats millions with M suffix', () => {
    expect(fmtNum(1_234_567)).toBe('1.23M');
  });

  it('formats thousands with K suffix', () => {
    expect(fmtNum(12_345)).toBe('12.3K');
  });

  it('passes through values below 1 000', () => {
    expect(fmtNum(987)).toBe('987');
  });

  it('passes through small decimals', () => {
    expect(fmtNum(0.000123)).toBe('0.000123');
  });

  it('handles negative values', () => {
    expect(fmtNum(-5_500)).toBe('-5.50K');
    expect(fmtNum(-2_000_000)).toBe('-2.00M');
  });

  it('handles zero', () => {
    expect(fmtNum(0)).toBe('0');
  });

  it('handles NaN', () => {
    expect(fmtNum(NaN)).toBe('NaN');
  });

  it('handles Infinity', () => {
    expect(fmtNum(Infinity)).toBe('Infinity');
  });

  it('formats billions with B suffix', () => {
    expect(fmtNum(1_000_000_000)).toBe('1.00B');
  });

  it('formats exact thousands boundary', () => {
    expect(fmtNum(1_000)).toBe('1.00K');
  });

  it('formats exact millions boundary', () => {
    expect(fmtNum(1_000_000)).toBe('1.00M');
  });

  it('formats exact billions boundary', () => {
    expect(fmtNum(1_000_000_000)).toBe('1.00B');
  });

  it('formats trillions with T suffix', () => {
    expect(fmtNum(1_000_000_000_000)).toBe('1.00T');
  });

  // Regression: toPrecision would emit exponential notation near tier boundaries
  it('does not emit exponential at K→M boundary (999_500)', () => {
    expect(fmtNum(999_500)).toBe('1.00M');
  });

  it('does not emit exponential at M→B boundary (999_500_000)', () => {
    expect(fmtNum(999_500_000)).toBe('1.00B');
  });

  it('does not emit exponential at B→T boundary (999_500_000_000)', () => {
    expect(fmtNum(999_500_000_000)).toBe('1.00T');
  });
});

describe('fmtUsd', () => {
  it('formats a USD value', () => {
    expect(fmtUsd(1_234_567)).toBe('$1.23M');
  });

  it('formats a small USD value without compacting', () => {
    expect(fmtUsd(500)).toBe('$500');
  });

  it('returns unavailable for null', () => {
    expect(fmtUsd(null)).toBe('unavailable');
  });

  it('returns unavailable for undefined', () => {
    expect(fmtUsd(undefined)).toBe('unavailable');
  });

  it('formats zero', () => {
    expect(fmtUsd(0)).toBe('$0');
  });

  it('formats negative USD value', () => {
    expect(fmtUsd(-1_500)).toBe('$-1.50K');
  });
});
