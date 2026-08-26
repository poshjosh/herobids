import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callLlmProvider } from './llm-provider.js';
import type { LlmProviderConfig, LlmRequest } from './llm-provider.js';

const baseConfig: LlmProviderConfig = {
  provider: 'openai',
  model: 'gpt-4',
  maxTokens: 512,
  timeoutMs: 5000,
};

const baseRequest: LlmRequest = {
  messages: [{ role: 'user', content: 'test prompt' }],
  maxTokens: 512,
};

describe('callLlmProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.stubEnv('LLM_API_KEY_OPENAI', 'sk-test-key');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('returns no_credentials when no API key is set', async () => {
    vi.unstubAllEnvs();
    delete process.env['LLM_API_KEY_OPENAI'];
    delete process.env['LLM_API_KEY'];

    const result = await callLlmProvider(baseConfig, baseRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('provider.no_credentials');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('skips credential check when provider is registered in providersBaseUrlMap', async () => {
    vi.unstubAllEnvs();
    delete process.env['LLM_API_KEY_OLLAMA'];
    delete process.env['LLM_API_KEY'];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'local ok' } }], usage: { total_tokens: 3 } }),
    }) as unknown as typeof fetch;

    const result = await callLlmProvider(
      { ...baseConfig, provider: 'ollama', model: 'qwen3:8b', providersBaseUrlMap: { ollama: 'http://localhost:11434/v1' } },
      baseRequest,
    );

    expect(result.ok).toBe(true);
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('falls back to generic LLM_API_KEY env var', async () => {
    vi.unstubAllEnvs();
    delete process.env['LLM_API_KEY_OPENAI'];
    vi.stubEnv('LLM_API_KEY', 'sk-generic-key');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 5 } }),
    }) as unknown as typeof fetch;

    const result = await callLlmProvider(baseConfig, baseRequest);
    expect(result.ok).toBe(true);
    // Verify the generic key was used (Authorization header)
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].headers['Authorization']).toBe('Bearer sk-generic-key');
  });

  it('uses baseUrl override when provided', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi' } }], usage: { total_tokens: 3 } }),
    }) as unknown as typeof fetch;

    await callLlmProvider({ ...baseConfig, baseUrl: 'http://localhost:8080/v1' }, baseRequest);

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('http://localhost:8080/v1/chat/completions');
  });

  it('routes anthropic provider to native Anthropic messages endpoint without baseUrl', async () => {
    vi.stubEnv('LLM_API_KEY_ANTHROPIC', 'sk-anthropic');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'Hello from Claude' }],
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'claude-sonnet-4-5',
      }),
    }) as unknown as typeof fetch;

    const result = await callLlmProvider({ ...baseConfig, provider: 'anthropic' }, baseRequest);

    expect(result.ok).toBe(true);
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toContain('/messages');
    expect(fetchCall[1].headers['x-api-key']).toBe('sk-anthropic');
  });

  it('allows incompatible provider when baseUrl is supplied', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' } }], usage: {} }),
    }) as unknown as typeof fetch;

    vi.stubEnv('LLM_API_KEY_ANTHROPIC', 'sk-anthropic');
    await callLlmProvider(
      { ...baseConfig, provider: 'anthropic', baseUrl: 'https://proxy.example.com/v1' },
      baseRequest,
    );

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    // @herobids/llm always uses the native Anthropic /messages endpoint, with baseUrl override
    expect(fetchCall[0]).toBe('https://proxy.example.com/v1/messages');
  });

  it('returns retryable error for HTTP 429 (rate limit)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    const result = await callLlmProvider(baseConfig, baseRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('provider.http_429');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('returns non-retryable error for HTTP 400 (bad request)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad request body',
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    const result = await callLlmProvider(baseConfig, baseRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('provider.http_400');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('returns retryable error for HTTP 503', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service unavailable',
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    const result = await callLlmProvider(baseConfig, baseRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(true);
    }
  });

  it('returns timeout error when request is aborted', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      // Simulate abort
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    }) as unknown as typeof fetch;

    const result = await callLlmProvider({ ...baseConfig, timeoutMs: 1 }, baseRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('provider.timeout');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('returns network_error for non-abort fetch failures', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const result = await callLlmProvider(baseConfig, baseRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('provider.network_error');
      expect(result.error.message).toBe('ECONNREFUSED');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('handles missing choices gracefully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [], usage: { total_tokens: 0 } }),
    }) as unknown as typeof fetch;

    const result = await callLlmProvider(baseConfig, baseRequest);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.content).toBe('');
      expect(result.data.tokensUsed).toBe(0);
    }
  });

  it('handles null/undefined usage field', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'response' } }] }),
    }) as unknown as typeof fetch;

    const result = await callLlmProvider(baseConfig, baseRequest);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.tokensUsed).toBe(0);
      expect(result.data.content).toBe('response');
    }
  });

  it('passes temperature and maxTokens in request body', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '' } }], usage: {} }),
      };
    }) as unknown as typeof fetch;

    await callLlmProvider(baseConfig, { ...baseRequest, temperature: 0.7 });

    expect(capturedBody?.temperature).toBe(0.7);
    expect(capturedBody?.max_tokens).toBe(512);
    expect(capturedBody?.model).toBe('gpt-4');
  });

  it('defaults temperature to 0 when not specified', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '' } }], usage: {} }),
      };
    }) as unknown as typeof fetch;

    await callLlmProvider(baseConfig, baseRequest);

    expect(capturedBody?.temperature).toBe(0);
  });

  it('truncates long error response bodies to 200 chars', async () => {
    const longBody = 'X'.repeat(500);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => longBody,
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    const result = await callLlmProvider(baseConfig, baseRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 200 chars of body + prefix text
      expect(result.error.message.length).toBeLessThan(300);
    }
  });

  it('reports latencyMs in successful response', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 1 } }),
      };
    }) as unknown as typeof fetch;

    const result = await callLlmProvider(baseConfig, baseRequest);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.latencyMs).toBeGreaterThan(0);
    }
  });
});
