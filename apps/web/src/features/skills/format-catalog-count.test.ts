import { describe, expect, it } from 'vitest';
import { formatCatalogCount } from './SkillsPage.js';

/** Minimal intl stub that mimics Intl.NumberFormat for en-US locale. */
const intlStub = {
  formatNumber: (n: number) => new Intl.NumberFormat('en-US').format(n),
};

describe('formatCatalogCount', () => {
  it('returns the exact number for counts below 1000', () => {
    expect(formatCatalogCount(0, intlStub)).toBe('0');
    expect(formatCatalogCount(1, intlStub)).toBe('1');
    expect(formatCatalogCount(12, intlStub)).toBe('12');
    expect(formatCatalogCount(999, intlStub)).toBe('999');
  });

  it('rounds down to the nearest thousand and appends "+" for counts >= 1000', () => {
    expect(formatCatalogCount(1000, intlStub)).toBe('1,000+');
    expect(formatCatalogCount(1001, intlStub)).toBe('1,000+');
    expect(formatCatalogCount(1999, intlStub)).toBe('1,000+');
    expect(formatCatalogCount(34000, intlStub)).toBe('34,000+');
    expect(formatCatalogCount(34567, intlStub)).toBe('34,000+');
  });

  it('handles multiples of 1000 exactly', () => {
    expect(formatCatalogCount(5000, intlStub)).toBe('5,000+');
    expect(formatCatalogCount(100000, intlStub)).toBe('100,000+');
  });

  it('uses the provided intl formatter for locale-specific output', () => {
    const deIntl = {
      formatNumber: (n: number) => new Intl.NumberFormat('de-DE').format(n),
    };

    // German locale uses period as thousand separator
    expect(formatCatalogCount(34000, deIntl)).toBe('34.000+');
    expect(formatCatalogCount(12, deIntl)).toBe('12');
  });

  it('returns "0" for zero', () => {
    expect(formatCatalogCount(0, intlStub)).toBe('0');
  });
});
