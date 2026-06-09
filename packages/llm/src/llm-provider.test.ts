import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callLlmProvider, stripReasoningContent } from './llm-provider.js';

describe('callLlmProvider thinking controls', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('maps light thinking to Anthropic thinking budget tokens', async () => {
    process.env['LLM_API_KEY_ANTHROPIC'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [
        { type: 'thinking', text: 'hidden' },
        { type: 'text', text: 'visible response' },
      ],
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 3 },
      model: 'claude-sonnet',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLlmProvider(
      {
        provider: 'anthropic',
        model: 'claude-sonnet',
        maxTokens: 512,
        timeoutMs: 1_000,
      },
      {
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'hello' },
        ],
        maxTokens: 512,
        temperature: 0.3,
        thinking: 'light',
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.content).toBe('visible response');
      expect(result.data.thinkingTokens).toBe(3);
    }

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(body['temperature']).toBe(1);
    expect(body['max_tokens']).toBe(2560);
  });

  it('maps deep thinking to OpenAI reasoning effort', async () => {
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { total_tokens: 20, output_tokens_details: { reasoning_tokens: 7 } },
      model: 'o4-mini',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLlmProvider(
      {
        provider: 'openai',
        model: 'o4-mini',
        maxTokens: 512,
        timeoutMs: 1_000,
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
        thinking: 'deep',
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.thinkingTokens).toBe(7);
    }

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['reasoning_effort']).toBe('high');
  });

  it('ignores thinking for non-OpenAI compatible providers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { total_tokens: 12 },
      model: 'qwen',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLlmProvider(
      {
        provider: 'openrouter',
        model: 'qwen',
        maxTokens: 512,
        timeoutMs: 1_000,
        baseUrl: 'https://openrouter.example/v1',
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
        thinking: 'light',
      },
    );

    expect(result.ok).toBe(true);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('thinking');
  });

  it('strips provider reasoning wrappers from visible content', () => {
    expect(stripReasoningContent('<thinking>hidden</thinking>Visible answer')).toBe('Visible answer');
    expect(stripReasoningContent('```reasoning\nprivate\n```\n{"tool":"send_message","args":{}}')).toBe('{"tool":"send_message","args":{}}');
  });
});

describe('callLlmProvider retryAfterMs propagation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  const providerConfig = {
    provider: 'openai' as const,
    model: 'gpt-4o',
    maxTokens: 256,
    timeoutMs: 1_000,
  };

  it('parses numeric seconds Retry-After header from 429 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': '30' },
      }),
    ));

    const result = await callLlmProvider(providerConfig, {
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 256,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryAfterMs).toBe(30_000); // 30 seconds → 30 000 ms
      expect(result.error.retryable).toBe(true);
    }
  });

  it('parses HTTP-date Retry-After header', async () => {
    const futureDate = new Date(Date.now() + 15_000).toUTCString();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': futureDate },
      }),
    ));

    const result = await callLlmProvider(providerConfig, {
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 256,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Should be approximately 15 000 ms; give ±2 000 ms tolerance for test execution time
      expect(result.error.retryAfterMs).toBeGreaterThan(12_000);
      expect(result.error.retryAfterMs).toBeLessThan(17_000);
    }
  });

  it('leaves retryAfterMs undefined when Retry-After header is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('rate limited', { status: 429 }),
    ));

    const result = await callLlmProvider(providerConfig, {
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 256,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryAfterMs).toBeUndefined();
    }
  });

  it('returns retryAfterMs=0 when Retry-After date is already in the past', async () => {
    const pastDate = new Date(Date.now() - 5_000).toUTCString();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': pastDate },
      }),
    ));

    const result = await callLlmProvider(providerConfig, {
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 256,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryAfterMs).toBe(0);
    }
  });

  it('propagates retryAfterMs from Anthropic 429 response', async () => {
    process.env['LLM_API_KEY_ANTHROPIC'] = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('overloaded', {
        status: 429,
        headers: { 'retry-after': '10' },
      }),
    ));

    const result = await callLlmProvider(
      { provider: 'anthropic', model: 'claude-3-haiku', maxTokens: 256, timeoutMs: 1_000 },
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 256 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryAfterMs).toBe(10_000);
    }
  });
});