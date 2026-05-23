import { describe, it, expect } from 'vitest';
import { ok, err } from '@herobids/domain';

describe('Result type', () => {
  it('ok() creates a success result', () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(42);
    }
  });

  it('err() creates a failure result', () => {
    const result = err({ code: 'test.error', message: 'something failed' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('test.error');
    }
  });
});
