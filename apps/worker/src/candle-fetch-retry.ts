/**
 * In-cycle bounded retry with full jitter for transient candle-fetch failures.
 *
 * Within a single scan, retry a transient_failure symbol up to maxRetries times
 * with short jittered delays before giving up. This recovers symbols inside the
 * current scan and stabilizes the scored population — the thing dedup cares about.
 */

export interface RetryOptions {
  /** Whether retry is enabled. When false the caller should not construct a retry wrapper. */
  enabled: boolean;
  /** Maximum number of retry attempts (not counting the initial call). */
  maxRetries: number;
  /** Initial backoff delay in milliseconds. Grows ×2 per attempt. */
  baseDelayMs: number;
  /** Per-retry delay ceiling in milliseconds. */
  maxDelayMs: number;
  /** Optional AbortSignal to cancel retries early. */
  signal?: AbortSignal;
  /**
   * Optional predicate to decide whether an error is retryable.
   * Called after each failed attempt before the next retry.
   * If it returns false, retry stops immediately and the error is returned.
   */
  shouldRetry?: (error: unknown) => boolean;
}

export type RetryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown; attempts: number };

/**
 * Delay for the given number of milliseconds with full jitter.
 * Respects an optional AbortSignal.
 */
async function delayWithJitter(ms: number, signal?: AbortSignal): Promise<void> {
  const jittered = Math.random() * ms;
  if (signal?.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, jittered);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
    // Unref the timer so it doesn't keep the process alive in tests
    timer.unref?.();
  });
}

/**
 * Execute fn with bounded retry and full-jitter backoff.
 *
 * The first call is attempt 1. If it succeeds, returns { ok: true, value }.
 * If it fails, retries up to maxRetries times with exponentially growing
 * jittered delays (baseDelayMs → baseDelayMs×2 → baseDelayMs×4 … capped at maxDelayMs).
 *
 * On final failure returns { ok: false, error, attempts } where attempts is
 * the total number of calls made (1 + retries used).
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<RetryResult<T>> {
  const { maxRetries, baseDelayMs, maxDelayMs, signal } = options;
  let lastError: unknown;
  let attempts = 0;

  for (let i = 0; i <= maxRetries; i++) {
    // Check signal before each attempt
    if (signal?.aborted) {
      return { ok: false, error: new DOMException('Aborted', 'AbortError'), attempts };
    }

    attempts++;
    try {
      const value = await fn();
      return { ok: true, value };
    } catch (err) {
      lastError = err;

      // If a shouldRetry predicate is provided and returns false, stop immediately.
      if (options.shouldRetry && !options.shouldRetry(err)) {
        return { ok: false, error: lastError, attempts };
      }

      // Don't delay after the last attempt
      if (i < maxRetries) {
        const rawDelay = Math.min(baseDelayMs * Math.pow(2, i), maxDelayMs);
        await delayWithJitter(rawDelay, signal);
      }
    }
  }

  return { ok: false, error: lastError, attempts };
}
