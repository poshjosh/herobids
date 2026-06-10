import { describe, expect, it } from 'vitest';
import { messages as enMessages } from './locales/en.js';
import { messages as arMessages } from './locales/ar.js';
import { messages as hiMessages } from './locales/hi.js';

function sortedKeys(catalog: Record<string, string>): string[] {
  return Object.keys(catalog).sort();
}

describe('locale catalogs', () => {
  it('keep Arabic and Hindi keys aligned with English', () => {
    const englishKeys = sortedKeys(enMessages);

    expect(sortedKeys(arMessages)).toEqual(englishKeys);
    expect(sortedKeys(hiMessages)).toEqual(englishKeys);
  });
});