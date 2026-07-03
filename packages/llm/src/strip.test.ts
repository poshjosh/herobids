import { describe, it, expect } from 'vitest';
import { stripEmptyValues } from './strip.js';

describe('stripEmptyValues', () => {
  it('removes null, undefined, and empty string values', () => {
    const result = stripEmptyValues({ a: 1, b: null, c: '', d: undefined });
    expect(result).toEqual({ a: 1 });
  });

  it('preserves zero and false', () => {
    const result = stripEmptyValues({ a: 0, b: false, c: 'hello' });
    expect(result).toEqual({ a: 0, b: false, c: 'hello' });
  });

  it('returns empty object for empty input', () => {
    expect(stripEmptyValues({})).toEqual({});
  });

  it('preserves nested objects as-is (no deep stripping)', () => {
    const result = stripEmptyValues({ a: { b: null, c: '' }, d: 1 });
    expect(result).toEqual({ a: { b: null, c: '' }, d: 1 });
  });
});
