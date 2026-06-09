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
        thinking: { lightBudgetTokens: 2_048, deepBudgetTokens: 10_240 },
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

  it('maps provider-neutral tools to OpenAI tool definitions and normalizes tool calls', async () => {
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: 'Need fresh data',
          tool_calls: [{
            id: 'call_1',
            function: {
              name: 'check_regime',
              arguments: '{"symbol":"BTC"}',
            },
          }],
        },
      }],
      usage: { total_tokens: 20 },
      model: 'gpt-4o-mini',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLlmProvider(
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        maxTokens: 512,
        timeoutMs: 1_000,
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
        tools: [{
          name: 'check_regime',
          description: 'Inspect the current regime',
          inputSchema: {
            type: 'object',
            properties: { symbol: { type: 'string' } },
            required: ['symbol'],
          },
        }],
        toolChoice: 'required',
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.toolCalls).toEqual([{ id: 'call_1', name: 'check_regime', args: { symbol: 'BTC' } }]);
    }

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['tool_choice']).toBe('required');
    expect(body['tools']).toEqual([{
      type: 'function',
      function: {
        name: 'check_regime',
        description: 'Inspect the current regime',
        parameters: {
          type: 'object',
          properties: { symbol: { type: 'string' } },
          required: ['symbol'],
        },
      },
    }]);
  });

  it('fails when OpenAI tool arguments are malformed', async () => {
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: 'Need fresh data',
          tool_calls: [{
            id: 'call_1',
            function: {
              name: 'check_regime',
              arguments: '{not-json',
            },
          }],
        },
      }],
      usage: { total_tokens: 20 },
      model: 'gpt-4o-mini',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLlmProvider(
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        maxTokens: 512,
        timeoutMs: 1_000,
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
        tools: [{
          name: 'check_regime',
          description: 'Inspect the current regime',
          inputSchema: { type: 'object' },
        }],
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: 'provider.invalid_tool_args',
        retryable: false,
      });
      expect(result.error.message).toContain('JSON');
    }
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

  it('maps Anthropic tool messages and normalizes tool_use responses', async () => {
    process.env['LLM_API_KEY_ANTHROPIC'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [
        { type: 'text', text: 'Looking up positions' },
        { type: 'tool_use', id: 'toolu_1', name: 'list_positions', input: { botId: 'bot-1' } },
      ],
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0 },
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
          { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_1', name: 'list_positions', args: { botId: 'bot-1' } }] },
          { role: 'tool', content: '{"positions":[]}', toolCallId: 'toolu_1' },
        ],
        maxTokens: 512,
        tools: [{
          name: 'list_positions',
          description: 'List positions',
          inputSchema: {
            type: 'object',
            properties: { botId: { type: 'string' } },
          },
        }],
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.content).toBe('Looking up positions');
      expect(result.data.toolCalls).toEqual([{ id: 'toolu_1', name: 'list_positions', args: { botId: 'bot-1' } }]);
    }

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['tools']).toEqual([{
      name: 'list_positions',
      description: 'List positions',
      input_schema: {
        type: 'object',
        properties: { botId: { type: 'string' } },
      },
    }]);
    expect(body['messages']).toEqual([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'list_positions', input: { botId: 'bot-1' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"positions":[]}', is_error: false }],
      },
    ]);
  });

  it('uses a configured Anthropic baseUrl without changing the native wire format', async () => {
    process.env['LLM_API_KEY_ANTHROPIC'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0 },
      model: 'claude-sonnet',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLlmProvider(
      {
        provider: 'anthropic',
        model: 'claude-sonnet',
        maxTokens: 512,
        timeoutMs: 1_000,
        baseUrl: 'https://anthropic.example/v1',
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
      },
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://anthropic.example/v1/messages');

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'claude-sonnet',
      max_tokens: 512,
      temperature: 0,
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('fails when Anthropic tool arguments are not objects', async () => {
    process.env['LLM_API_KEY_ANTHROPIC'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'list_positions', input: null },
      ],
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0 },
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
        tools: [{
          name: 'list_positions',
          description: 'List positions',
          inputSchema: { type: 'object' },
        }],
      },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'provider.invalid_tool_args',
        message: 'Tool arguments must be a JSON object',
        retryable: false,
      },
    });
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

describe('callLlmProvider thinking budget config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env['LLM_API_KEY_ANTHROPIC'] = 'test-key';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('uses custom lightBudgetTokens from config.thinking', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'response' }],
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0 },
      model: 'claude-sonnet',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await callLlmProvider(
      {
        provider: 'anthropic',
        model: 'claude-sonnet',
        maxTokens: 512,
        timeoutMs: 1_000,
        thinking: { lightBudgetTokens: 4_096, deepBudgetTokens: 20_480 },
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
        thinking: 'light',
      },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 4_096 });
    expect(body['max_tokens']).toBe(512 + 4_096); // maxTokens + lightBudget
  });

  it('uses custom deepBudgetTokens from config.thinking', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'response' }],
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0 },
      model: 'claude-sonnet',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await callLlmProvider(
      {
        provider: 'anthropic',
        model: 'claude-sonnet',
        maxTokens: 512,
        timeoutMs: 1_000,
        thinking: { lightBudgetTokens: 1_000, deepBudgetTokens: 20_000 },
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
        thinking: 'deep',
      },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 20_000 });
    expect(body['max_tokens']).toBe(512 + 20_000);
  });

  it('skips thinking block when config.thinking is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'response' }],
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0 },
      model: 'claude-sonnet',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await callLlmProvider(
      { provider: 'anthropic', model: 'claude-sonnet', maxTokens: 512, timeoutMs: 1_000 },
      { messages: [{ role: 'user', content: 'hello' }], maxTokens: 512, thinking: 'light' },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['thinking']).toBeUndefined();
  });

  it('returns zero thinking budget when thinking mode is "none"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'response' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await callLlmProvider(
      {
        provider: 'anthropic',
        model: 'claude-sonnet',
        maxTokens: 512,
        timeoutMs: 1_000,
        thinking: { lightBudgetTokens: 4_096, deepBudgetTokens: 20_480 },
      },
      { messages: [{ role: 'user', content: 'hello' }], maxTokens: 512, thinking: 'none' },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // No thinking block should appear in the body when mode is 'none'
    expect(body['thinking']).toBeUndefined();
    expect(body['max_tokens']).toBe(512);
  });
});