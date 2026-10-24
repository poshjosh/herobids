import { describe, expect, it } from 'vitest';
import { EMAIL_CAP_COUNTED_STATUSES } from './notification-delivery-repository.js';

describe('email cap counting', () => {
  it('counts pending and sent rows toward the daily cap', () => {
    expect([...EMAIL_CAP_COUNTED_STATUSES].sort()).toEqual(['pending', 'sent']);
  });

  it('does not count failed or skipped rows, because they never reached the inbox', () => {
    expect(EMAIL_CAP_COUNTED_STATUSES).not.toContain('failed');
    expect(EMAIL_CAP_COUNTED_STATUSES).not.toContain('skipped');
  });
});
