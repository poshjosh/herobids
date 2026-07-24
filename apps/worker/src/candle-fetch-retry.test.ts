import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retryWithBackoff, type RetryOptions } from './candle-fetch-retry.js';

function makeOptions(overrides: Partial<RetryOptions> = {}): RetryOptions {
  return {
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 10,
    maxDelayMs: 50,
    ...overrides,
  };
}

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('succeeds on first attempt (no retries)', async () => {
    const fn = vi.fn().mockResolvedValue('result');
    const result = await retryWithBackoff(fn, makeOptions());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('result');
    }
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries exactly maxRetries times before failing', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('transient'));
    const resultPromise = retryWithBackoff(fn, makeOptions({ maxRetries: 2 }));

    // Advance timers between retries
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(3); // 1 initial + 2 retries
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('transient');
    }
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('succeeds on the nth retry attempt', async () => {
    let call = 0;
    const fn = vi.fn().mockImplementation(() => {
      call++;
      if (call < 3) throw new Error('transient');
      return Promise.resolve('recovered');
    });

    const resultPromise = retryWithBackoff(fn, makeOptions());
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('recovered');
    }
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('returns final failure shape with correct attempts count', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always failing'));
    const resultPromise = retryWithBackoff(fn, makeOptions({ maxRetries: 1 }));

    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(2);
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it('shouldRetry predicate filters non-retryable errors immediately', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('HTTP error: 400 Bad Request'));
    const shouldRetry = vi.fn((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return !msg.includes('400');
    });

    const result = await retryWithBackoff(fn, makeOptions({ shouldRetry }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(1); // stopped immediately
    }
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  it('shouldRetry allows retryable errors to be retried', async () => {
    let call = 0;
    const fn = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) throw new Error('HTTP error: 500 Server Error');
      return Promise.resolve('ok');
    });
    const shouldRetry = vi.fn((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.includes('500'); // 5xx is retryable
    });

    const resultPromise = retryWithBackoff(fn, makeOptions({ shouldRetry }));
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('ok');
    }
    expect(fn).toHaveBeenCalledTimes(2);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  it('aborts mid-retry when AbortSignal is triggered', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error('transient'));

    const resultPromise = retryWithBackoff(fn, makeOptions({ signal: controller.signal }));

    // Abort after first failure (which is the first attempt)
    // The first attempt fails, then delayWithJitter starts. Abort during the delay.
    controller.abort();

    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(DOMException);
    }
  });
});
