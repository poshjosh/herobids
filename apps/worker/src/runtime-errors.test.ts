import { describe, expect, it, vi } from 'vitest';
import { callLlmWithRetry, classifyRuntimeError } from './runtime-errors.js';

describe('classifyRuntimeError', () => {
  it('classifies LLM timeout as recoverable', () => {
    expect(classifyRuntimeError('llm', {
      code: 'provider.timeout',
      message: 'timed out',
      retryable: true,
    })).toMatchObject({ mode: 'recoverable', reasonCode: 'llm.timeout' });
  });

  it('classifies LLM rate limits with retry-after', () => {
    expect(classifyRuntimeError('llm', {
      code: 'provider.http_429',
      message: 'rate limited',
      retryable: true,
      retryAfterMs: 12_000,
    })).toMatchObject({ mode: 'recoverable', reasonCode: 'llm.rate_limit', retryAfterMs: 12_000 });
  });

  it('classifies invalid credentials as fatal', () => {
    expect(classifyRuntimeError('llm', {
      code: 'provider.http_401',
      message: 'unauthorized',
      retryable: false,
    })).toMatchObject({ mode: 'fatal', reasonCode: 'llm.credentials' });
  });

  it('classifies invalid tool arguments as fatal', () => {
    expect(classifyRuntimeError('llm', {
      code: 'provider.invalid_tool_args',
      message: 'tool args malformed',
      retryable: false,
    })).toMatchObject({ mode: 'fatal', reasonCode: 'llm.invalid_tool_args' });
  });

  it('classifies database outages as degraded', () => {
    expect(classifyRuntimeError('database', new Error('db unavailable'))).toMatchObject({
      mode: 'degraded',
      reasonCode: 'database.unavailable',
    });
  });

  it('classifies sandbox expiry as fatal', () => {
    expect(classifyRuntimeError('sandbox', new Error('expired'))).toMatchObject({
      mode: 'fatal',
      reasonCode: 'sandbox.expired',
    });
  });

  it('classifies tick-gate failures as degraded with tick_gate.degraded reason code', () => {
    expect(classifyRuntimeError('tick-gate', new Error('AbortError: This operation was aborted'))).toMatchObject({
      source: 'tick-gate',
      mode: 'degraded',
      reasonCode: 'tick_gate.degraded',
    });
  });
});

describe('callLlmWithRetry', () => {
  it('retries timeouts and eventually succeeds', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'provider.timeout', message: 'timed out', retryable: true } })
      .mockResolvedValueOnce({ ok: true, data: { content: 'ok', model: 'test', provider: 'openai', tokensUsed: 10, latencyMs: 10, cached: false } });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await callLlmWithRetry(
      { provider: 'openai', model: 'test', maxTokens: 100, timeoutMs: 1000 },
      { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100 },
      { call, sleep },
    );

    expect(result.result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('honors retry-after for 429 responses', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'provider.http_429', message: 'rate limit', retryable: true, retryAfterMs: 9_000 } })
      .mockResolvedValueOnce({ ok: true, data: { content: 'ok', model: 'test', provider: 'openai', tokensUsed: 10, latencyMs: 10, cached: false } });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await callLlmWithRetry(
      { provider: 'openai', model: 'test', maxTokens: 100, timeoutMs: 1000 },
      { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100 },
      { call, sleep },
    );

    expect(result.result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(9_000);
  });

  it('does not retry fatal credential failures', async () => {
    const call = vi.fn().mockResolvedValue({ ok: false, error: { code: 'provider.http_403', message: 'forbidden', retryable: false } });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await callLlmWithRetry(
      { provider: 'openai', model: 'test', maxTokens: 100, timeoutMs: 1000 },
      { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100 },
      { call, sleep },
    );

    expect(result.result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(result.classification).toMatchObject({ mode: 'fatal', reasonCode: 'llm.credentials' });
  });

  it('retries 5xx responses with fixed backoff', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'provider.http_503', message: 'server error', retryable: true } })
      .mockResolvedValueOnce({ ok: true, data: { content: 'ok', model: 'test', provider: 'openai', tokensUsed: 10, latencyMs: 10, cached: false } });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await callLlmWithRetry(
      { provider: 'openai', model: 'test', maxTokens: 100, timeoutMs: 1000 },
      { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100 },
      { call, sleep },
    );

    expect(result.result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(10_000);
  });

  it('retries network errors and eventually succeeds', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'provider.network_error', message: 'fetch failed', retryable: true } })
      .mockResolvedValueOnce({ ok: true, data: { content: 'ok', model: 'test', provider: 'openai', tokensUsed: 10, latencyMs: 10, cached: false } });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await callLlmWithRetry(
      { provider: 'openai', model: 'test', maxTokens: 100, timeoutMs: 1000 },
      { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100 },
      { call, sleep },
    );

    expect(result.result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('stops retrying network errors after maxRetries', async () => {
    const networkError = { ok: false, error: { code: 'provider.network_error', message: 'fetch failed', retryable: true } };
    const call = vi.fn()
      .mockResolvedValueOnce(networkError)
      .mockResolvedValueOnce(networkError)
      .mockResolvedValueOnce(networkError);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await callLlmWithRetry(
      { provider: 'openai', model: 'test', maxTokens: 100, timeoutMs: 1000 },
      { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100 },
      { call, sleep, maxRetries: 2 },
    );

    expect(result.result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  describe('custom retry config parameters', () => {
    it('uses custom timeoutBackoffMs for timeout retries', async () => {
      const call = vi.fn()
        .mockResolvedValueOnce({ ok: false, error: { code: 'provider.timeout', message: 'timed out', retryable: true } })
        .mockResolvedValueOnce({ ok: true, data: { content: 'ok', model: 'test', provider: 'openai', tokensUsed: 5, latencyMs: 5, cached: false } });
      const sleep = vi.fn().mockResolvedValue(undefined);

      const result = await callLlmWithRetry(
        { provider: 'openai', model: 'test', maxTokens: 100, timeoutMs: 1000 },
        { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100 },
        { call, sleep, timeoutBackoffMs: [3_000, 9_000] },
      );

      expect(result.result.ok).toBe(true);
      expect(sleep).toHaveBeenCalledWith(3_000);
    });

    it('uses custom serverErrorBackoffMs for 5xx retries', async () => {
      const call = vi.fn()
        .mockResolvedValueOnce({ ok: false, error: { code: 'provider.http_500', message: 'internal error', retryable: true } })
        .mockResolvedValueOnce({ ok: true, data: { content: 'ok', model: 'test', provider: 'openai', tokensUsed: 5, latencyMs: 5, cached: false } });
      const sleep = vi.fn().mockResolvedValue(undefined);

      const result = await callLlmWithRetry(
        { provider: 'openai', model: 'test', maxTokens: 100, timeoutMs: 1000 },
        { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100 },
        { call, sleep, serverErrorBackoffMs: 7_000 },
      );

      expect(result.result.ok).toBe(true);
      expect(sleep).toHaveBeenCalledWith(7_000);
    });

    it('uses custom defaultRateLimitBackoffMs when no retry-after header present', async () => {
      const call = vi.fn()
        .mockResolvedValueOnce({ ok: false, error: { code: 'provider.http_429', message: 'rate limited', retryable: true } })
        .mockResolvedValueOnce({ ok: true, data: { content: 'ok', model: 'test', provider: 'openai', tokensUsed: 5, latencyMs: 5, cached: false } });
      const sleep = vi.fn().mockResolvedValue(undefined);

      const result = await callLlmWithRetry(
        { provider: 'openai', model: 'test', maxTokens: 100, timeoutMs: 1000 },
        { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100 },
        { call, sleep, defaultRateLimitBackoffMs: 30_000 },
      );

      expect(result.result.ok).toBe(true);
      expect(sleep).toHaveBeenCalledWith(30_000);
    });

    it('retry-after header still takes precedence over defaultRateLimitBackoffMs', async () => {
      const call = vi.fn()
        .mockResolvedValueOnce({ ok: false, error: { code: 'provider.http_429', message: 'rate limited', retryable: true, retryAfterMs: 8_000 } })
        .mockResolvedValueOnce({ ok: true, data: { content: 'ok', model: 'test', provider: 'openai', tokensUsed: 5, latencyMs: 5, cached: false } });
      const sleep = vi.fn().mockResolvedValue(undefined);

      await callLlmWithRetry(
        { provider: 'openai', model: 'test', maxTokens: 100, timeoutMs: 1000 },
        { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100 },
        { call, sleep, defaultRateLimitBackoffMs: 30_000 },
      );

      expect(sleep).toHaveBeenCalledWith(8_000);
    });

    it('progresses through multiple timeout delays from the custom array', async () => {
      const call = vi.fn()
        .mockResolvedValueOnce({ ok: false, error: { code: 'provider.timeout', message: 'timed out', retryable: true } })
        .mockResolvedValueOnce({ ok: false, error: { code: 'provider.timeout', message: 'timed out again', retryable: true } })
        .mockResolvedValueOnce({ ok: true, data: { content: 'ok', model: 'test', provider: 'openai', tokensUsed: 5, latencyMs: 5, cached: false } });
      const sleep = vi.fn().mockResolvedValue(undefined);

      const result = await callLlmWithRetry(
        { provider: 'openai', model: 'test', maxTokens: 100, timeoutMs: 1000 },
        { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100 },
        { call, sleep, maxRetries: 3, timeoutBackoffMs: [2_000, 8_000] },
      );

      expect(result.result.ok).toBe(true);
      expect(sleep.mock.calls[0]).toEqual([2_000]);
      expect(sleep.mock.calls[1]).toEqual([8_000]); // clamps to last element
    });
  });
});