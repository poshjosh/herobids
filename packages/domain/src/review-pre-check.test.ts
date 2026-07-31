import { describe, it, expect } from 'vitest';
import { ReviewPreCheckReasonCodes, ReviewPreCheckReasonDescriptions } from './review-pre-check.js';

describe('ReviewPreCheckReasonDescriptions', () => {
  it('has a description for every reason code', () => {
    const codes = Object.values(ReviewPreCheckReasonCodes);
    for (const code of codes) {
      expect(ReviewPreCheckReasonDescriptions[code]).toBeDefined();
      expect(typeof ReviewPreCheckReasonDescriptions[code]).toBe('string');
    }
  });

  it('has no extra descriptions beyond the defined reason codes', () => {
    const codeKeys = Object.values(ReviewPreCheckReasonCodes) as string[];
    const descKeys = Object.keys(ReviewPreCheckReasonDescriptions);
    expect(descKeys.sort()).toEqual(codeKeys.sort());
  });
});
