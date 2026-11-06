import { describe, expect, it } from 'vitest';
import { isFullMessageId, parseMessageRef, shortMessageId } from './message-ref.js';

const FULL = 'A3F9C1D2-0000-4000-8000-0000000000AB';

describe('shortMessageId', () => {
  it('is the first 8 hex characters of the id, lowercase', () => {
    expect(shortMessageId(FULL)).toBe('a3f9c1d2');
  });
});

describe('parseMessageRef', () => {
  it('accepts an 8-hex short ref, with or without #, in any case', () => {
    expect(parseMessageRef('a3f9c1d2')).toBe('a3f9c1d2');
    expect(parseMessageRef('#A3F9C1D2')).toBe('a3f9c1d2');
  });

  it('accepts a full UUID and lowercases it', () => {
    expect(parseMessageRef(FULL)).toBe(FULL.toLowerCase());
  });

  it('rejects wildcards, short or long hex, and other text, so no LIKE pattern reaches the query', () => {
    for (const input of ['%', '_', 'a3f9c1d', 'a3f9c1d2a', 'a3f9c1d%', 'zzzzzzzz', '', '#']) {
      expect(parseMessageRef(input)).toBeNull();
    }
    expect(parseMessageRef(' a3f9c1d2 ')).toBe('a3f9c1d2');
  });
});

describe('isFullMessageId', () => {
  it('is true only for a UUID', () => {
    expect(isFullMessageId(FULL)).toBe(true);
    expect(isFullMessageId('a3f9c1d2')).toBe(false);
  });
});
