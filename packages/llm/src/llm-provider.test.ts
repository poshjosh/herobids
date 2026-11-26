import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callLlmProvider,
  stripReasoningContent,
  toOpenAiMessages,
  isEffortBasedModel,
  isAdaptiveThinkingOnlyModel,
  isClaudeModel,
  resolveReasoningParams,
} from './llm-provider.js';
import type { LlmMessage, LlmProviderConfig, LlmRequest, ReasoningLevel } from './llm-provider.js';

describe('callLlmProvider thinking controls', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('maps light thinking (backward compat) to effort for Claude models', async () => {
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
    expect(body['thinking']).toEqual({ type: 'adaptive' });
    expect(body['output_config']).toEqual({ effort: 'low' });
    expect(body).not.toHaveProperty('reasoning');
    expect(body['temperature']).toBe(1);
    expect(body['max_tokens']).toBe(512);
  });

  it('maps deep thinking (backward compat) to unified reasoning with default deep budget', async () => {
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
    // Backward compat: 'deep' → ReasoningLevel 'high' → legacy model → max_tokens: deepBudgetTokens (default 10240)
    expect(body['reasoning']).toEqual({ max_tokens: 10240 });
    expect(body).not.toHaveProperty('reasoning_effort');
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

  it('sends unified reasoning for non-OpenAI providers via OpenRouter (backward compat)', async () => {
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
    // Backward compat: 'light' → level 'low' → legacy model → max_tokens: 2048 (default)
    expect(body['reasoning']).toEqual({ max_tokens: 2048 });
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
        message: 'Tool arguments must be a JSON object. Invalid tool arguments for "list_positions" (call toolu_1, call 1 of 1): received null.',
        retryable: false,
      },
    });
  });
});

describe('callLlmProvider invalid tool arguments message', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  async function callWithToolCalls(
    toolCalls: Array<{ id: string; name: string; arguments: string }>,
    finishReason?: string,
  ) {
    return (await invalidToolArgsErrorFor(toolCalls, finishReason)).message;
  }

  async function invalidToolArgsErrorFor(
    toolCalls: Array<{ id: string; name: string; arguments: string }>,
    finishReason?: string,
  ) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        ...(finishReason ? { finish_reason: finishReason } : {}),
        message: {
          content: '',
          tool_calls: toolCalls.map(call => ({
            id: call.id,
            function: { name: call.name, arguments: call.arguments },
          })),
        },
      }],
      usage: { total_tokens: 20 },
      model: 'gpt-4o-mini',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const result = await callLlmProvider(
      { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 512, timeoutMs: 1_000 },
      { messages: [{ role: 'user', content: 'hello' }], maxTokens: 512 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('provider.invalid_tool_args');
    expect(result.error.retryable).toBe(false);
    return result.error;
  }

  it('names the tool and call in the invalid arguments error', async () => {
    const message = await callWithToolCalls([{ id: 'call_1', name: 'write_file', arguments: '{not-json' }]);
    expect(message).toContain('"write_file"');
    expect(message).toContain('call call_1');
    expect(message).toContain('call 1 of 1');
  });

  it('reports the position, length and the characters around the failure for an unescaped quote in a string value', async () => {
    const args = '{"path":"a.json","content":"{"name":"x"}"}';
    const message = await callWithToolCalls([{ id: 'call_1', name: 'write_file', arguments: args }], 'stop');
    const position = Number(/position (\d+)/.exec(message)?.[1]);
    expect(Number.isNaN(position)).toBe(false);
    expect(message).toContain(`The arguments are ${args.length} characters long.`);
    expect(message).toContain(`The character at position ${position} is ${JSON.stringify(args[position])}.`);
    expect(message).toContain(`The character before it is ${JSON.stringify(args[position - 1])}.`);
    expect(message).toContain('finished with reason "stop"');
    expect(message).not.toContain('cut off');
  });

  it('says the output was cut off when the finish reason is length', async () => {
    const message = await callWithToolCalls(
      [{ id: 'call_1', name: 'write_file', arguments: '{"path":"a","content":"abc' }],
      'length',
    );
    expect(message).toContain('cut off');
    expect(message).toContain('finished with reason "length"');
  });

  it('carries the finish reason on the error so a cut-off call can be recovered', async () => {
    const error = await invalidToolArgsErrorFor(
      [{ id: 'call_1', name: 'write_file', arguments: '{"path":"a","content":"abc' }],
      'length',
    );
    expect(error.finishReason).toBe('length');
  });

  it('leaves the finish reason off the error when the provider gives none', async () => {
    const error = await invalidToolArgsErrorFor([{ id: 'call_1', name: 'write_file', arguments: '{not-json' }]);
    expect(error).not.toHaveProperty('finishReason');
  });

  it('keeps the cut-off hint and finish reason for a very long tool name and call id', async () => {
    const message = await callWithToolCalls(
      [{ id: `id_${'i'.repeat(5_000)}`, name: `tool_${'n'.repeat(5_000)}`, arguments: '{"path":"a","content":"abc' }],
      'length',
    );
    expect(message.length).toBeLessThanOrEqual(600);
    expect(message).toContain('cut off');
    expect(message).toContain('finished with reason "length"');
    expect(message).not.toContain('n'.repeat(100));
    expect(message).not.toContain('i'.repeat(100));
  });

  it('escapes a quote and newline in the tool name so the message stays single-line', async () => {
    const message = await callWithToolCalls(
      [{ id: 'call_1', name: 'bad"name\nnext', arguments: '{"path":' }],
      'stop',
    );
    expect(message).toContain('"bad\\"name next"');
    expect(message).not.toContain('\n');
    expect(message).toContain('finished with reason "stop"');
  });

  it('says which of several tool calls was invalid', async () => {
    const message = await callWithToolCalls([
      { id: 'call_a', name: 'read_file', arguments: '{"path":"a"}' },
      { id: 'call_b', name: 'write_file', arguments: '{"path":' },
      { id: 'call_c', name: 'read_file', arguments: '{"path":"c"}' },
    ]);
    expect(message).toContain('"write_file"');
    expect(message).toContain('call 2 of 3');
  });

  it('keeps the raw JSON error message when no position can be read from it', async () => {
    const originalParse = JSON.parse.bind(JSON);
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (text === '{bad') throw new SyntaxError('weird engine failure');
      return originalParse(text, reviver) as unknown;
    });
    let message: string;
    try {
      message = await callWithToolCalls([{ id: 'call_1', name: 'write_file', arguments: '{bad' }]);
    } finally {
      parseSpy.mockRestore();
    }
    expect(message).toContain('"write_file"');
    expect(message).toContain('weird engine failure');
    expect(message).not.toContain('The character at position');
  });

  it('does not include argument text in the message beyond the offending character', async () => {
    const secret = 'SECRET-CV-TEXT-1234567890';
    const args = `{"content":"${secret}" "x":1}`;
    const message = await callWithToolCalls([{ id: 'call_1', name: 'write_file', arguments: args }]);
    expect(message).not.toContain(secret);
    expect(message).not.toContain('SECRET');
  });

  it.each([
    ['SECRETWORD{', "Unexpected token 'S'"],
    ['{"k":SECRET, "z":"y"}', "Unexpected token 'S'"],
    ['undefined', undefined],
    ['[object Object]', undefined],
    [`{"k":SECRET${'x'.repeat(100)}, "z":"y"}`, "Unexpected token 'S'"],
  ])('omits the quoted input excerpt for arguments %j', async (args, leading) => {
    const message = await callWithToolCalls([{ id: 'call_1', name: 'write_file', arguments: args }]);
    expect(message).not.toContain('SECRET');
    expect(message).not.toContain('"z"');
    expect(message).not.toContain('object Object');
    expect(message).not.toContain('"undefined"');
    expect(message).toContain('(input excerpt omitted)');
    if (leading) expect(message).toContain(leading);
  });

  async function callWithRawToolCalls(toolCalls: unknown[]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '', tool_calls: toolCalls } }],
      usage: { total_tokens: 20 },
      model: 'gpt-4o-mini',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    return callLlmProvider(
      { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 512, timeoutMs: 1_000 },
      { messages: [{ role: 'user', content: 'hello' }], maxTokens: 512 },
    );
  }

  it('warns once per dropped tool call and still returns the valid ones', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await callWithRawToolCalls([
      { id: 'call_a', function: { name: 'read_file', arguments: '{"path":"a"}' } },
      { id: 'call_b', function: { arguments: '{}' } },
      'not-an-object',
      { id: 'call_d', function: { name: 'read_file', arguments: '{"path":"d"}' } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.toolCalls?.map(call => call.id)).toEqual(['call_a', 'call_d']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, '[llm-provider] dropped tool call 2 of 4: no function name (id call_b)');
    expect(warn).toHaveBeenNthCalledWith(2, '[llm-provider] dropped tool call 3 of 4: entry is not an object');
  });

  it('keeps the warning single-line and bounded for hostile model-supplied ids', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await callWithRawToolCalls([
      { id: 'x\nFAKE\r\n[llm-provider] forged\u2028line\u0007', function: { arguments: '{}' } },
      { id: 'a'.repeat(5000), function: { arguments: '{}' } },
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const [message] of warn.mock.calls) {
      expect(typeof message).toBe('string');
      expect(message as string).not.toMatch(/[\r\n\u2028\u2029\p{Cc}]/u);
      expect((message as string).length).toBeLessThan(200);
    }
    expect(warn.mock.calls[0]?.[0]).toBe(
      '[llm-provider] dropped tool call 1 of 2: no function name (id x FAKE [llm-provider] forged line)',
    );
    expect(warn.mock.calls[1]?.[0]).toBe(
      `[llm-provider] dropped tool call 2 of 2: no function name (id ${'a'.repeat(64)})`,
    );
  });

  it('does not warn when every call is valid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await callWithRawToolCalls([
      { id: 'call_a', function: { name: 'read_file', arguments: '{"path":"a"}' } },
    ]);
    expect(result.ok).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('includes no argument text in the warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await callWithRawToolCalls([
      { id: 'call_a', function: { arguments: '{"content":"SECRET-CV-TEXT"}' } },
      { id: 'call_b', function: { name: 123, arguments: 'SECRET-CV-TEXT' } },
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('SECRET');
  });

  it('counts only named tool_use blocks in the Anthropic call total', async () => {
    process.env['LLM_API_KEY_ANTHROPIC'] = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [
        { type: 'tool_use', id: 'toolu_1', input: {} },
        { type: 'tool_use', id: 'toolu_2', name: 'write_file', input: 'bad' },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-sonnet-5',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const result = await callLlmProvider(
      { provider: 'anthropic', model: 'claude-sonnet-5', maxTokens: 512, timeoutMs: 1_000 },
      { messages: [{ role: 'user', content: 'hello' }], maxTokens: 512 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.message).toContain('call 1 of 1');
  });

  it('keeps the message under the length cap for very long tool names and arguments', async () => {
    const message = await callWithToolCalls([
      { id: 'call_1', name: 'tool_'.repeat(500), arguments: `{"a":"${'x'.repeat(5_000)}" "b":1}` },
    ]);
    expect(message.length).toBeLessThanOrEqual(600);
  });

  it('names what it received when the arguments are not a JSON object', async () => {
    const message = await callWithToolCalls([{ id: 'call_1', name: 'write_file', arguments: '[1,2]' }]);
    expect(message.startsWith('Tool arguments must be a JSON object')).toBe(true);
    expect(message).toContain('received an array');
    expect(message).toContain('"write_file"');
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

  it('uses effort for Claude models (light) regardless of custom budget config', async () => {
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
    expect(body['thinking']).toEqual({ type: 'adaptive' });
    expect(body['output_config']).toEqual({ effort: 'low' });
    expect(body).not.toHaveProperty('reasoning');
    expect(body['max_tokens']).toBe(512);
  });

  it('uses effort for Claude models (high) regardless of custom budget config', async () => {
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
    expect(body['thinking']).toEqual({ type: 'adaptive' });
    expect(body['output_config']).toEqual({ effort: 'high' });
    expect(body).not.toHaveProperty('reasoning');
    expect(body['max_tokens']).toBe(512);
  });

  it('uses effort for Claude models when config.thinking is absent (backward compat)', async () => {
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
    // Claude model → effort-based (forward-looking), not max_tokens
    expect(body['thinking']).toEqual({ type: 'adaptive' });
    expect(body['output_config']).toEqual({ effort: 'low' });
    expect(body).not.toHaveProperty('reasoning');
  });

  it('does not send reasoning when thinking mode is "none"', async () => {
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
    // 'none' → { max_tokens: 0 } → shouldSendReasoning returns false → not sent
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('output_config');
    expect(body['max_tokens']).toBe(512);
  });
});

// ---------------------------------------------------------------------------
// Prompt caching — cache_control and cached detection
// ---------------------------------------------------------------------------

describe('callLlmProvider prompt caching', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('sends top-level cache_control for OpenRouter and reports cached=true on hit', async () => {
    process.env['LLM_API_KEY_OPENROUTER'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'cached response' } }],
      usage: {
        total_tokens: 100,
        prompt_tokens: 80,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 50 },
      },
      model: 'anthropic/claude-sonnet-4-5',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLlmProvider(
      {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4-5',
        maxTokens: 512,
        timeoutMs: 1_000,
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.cached).toBe(true);
    }

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('reports cached=false for OpenRouter when cached_tokens is 0', async () => {
    process.env['LLM_API_KEY_OPENROUTER'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'fresh response' } }],
      usage: {
        total_tokens: 60,
        prompt_tokens: 50,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 0 },
      },
      model: 'anthropic/claude-sonnet-4-5',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLlmProvider(
      {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4-5',
        maxTokens: 512,
        timeoutMs: 1_000,
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.cached).toBe(false);
    }
  });

  it('includes top-level cache_control for Anthropic native and detects cache hit', async () => {
    process.env['LLM_API_KEY_ANTHROPIC'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'cached response' }],
      usage: { input_tokens: 80, output_tokens: 20, cache_read_input_tokens: 40 },
      model: 'claude-sonnet-4-5',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLlmProvider(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        maxTokens: 512,
        timeoutMs: 1_000,
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.cached).toBe(true);
    }

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('reports cached=false for Anthropic when cache_read_input_tokens is 0', async () => {
    process.env['LLM_API_KEY_ANTHROPIC'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'fresh response' }],
      usage: { input_tokens: 80, output_tokens: 20, cache_read_input_tokens: 0 },
      model: 'claude-sonnet-4-5',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLlmProvider(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        maxTokens: 512,
        timeoutMs: 1_000,
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.cached).toBe(false);
    }
  });
});

describe('callLlmProvider prompt caching with a volatile trailing message', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  const openRouterConfig = (model: string): LlmProviderConfig => ({ provider: 'openrouter', model, maxTokens: 512, timeoutMs: 1_000 });
  const toolTurn: LlmMessage[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'do the task' },
    { role: 'assistant', content: 'checking', toolCalls: [{ id: 'call_1', name: 'list_positions', args: {} }] },
    { role: 'tool', toolCallId: 'call_1', content: '{"positions":[]}' },
  ];
  const clock: LlmMessage = { role: 'user', content: 'Current time is (UTC) 2026-11-14T20:31:02Z', volatile: true };

  async function sendOpenRouter(model: string, messages: LlmMessage[]): Promise<Record<string, unknown>> {
    process.env['LLM_API_KEY_OPENROUTER'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { total_tokens: 10, prompt_tokens: 8, completion_tokens: 2 },
      model,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await callLlmProvider(openRouterConfig(model), { messages, maxTokens: 512 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  async function sendAnthropic(messages: LlmMessage[]): Promise<Record<string, unknown>> {
    process.env['LLM_API_KEY_ANTHROPIC'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 8, output_tokens: 2 },
      model: 'claude-sonnet-4-5',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await callLlmProvider(
      { provider: 'anthropic', model: 'claude-sonnet-4-5', maxTokens: 512, timeoutMs: 1_000 },
      { messages, maxTokens: 512 },
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it('ends the cache on the message before the volatile one for OpenRouter Claude, with no top-level marker', async () => {
    const body = await sendOpenRouter('anthropic/claude-sonnet-4-5', [...toolTurn, clock]);

    const sent = body['messages'] as Array<Record<string, unknown>>;
    expect(body['cache_control']).toBeUndefined();
    expect(sent.at(-2)).toEqual({
      role: 'tool',
      content: [{ type: 'text', text: '{"positions":[]}', cache_control: { type: 'ephemeral' } }],
      tool_call_id: 'call_1',
    });
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'Current time is (UTC) 2026-11-14T20:31:02Z' });
  });

  it('keeps the top-level marker for OpenRouter Claude when no message is volatile', async () => {
    const body = await sendOpenRouter('anthropic/claude-sonnet-4-5', toolTurn);

    expect(body['cache_control']).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(body['messages'])).not.toContain('"cache_control"');
  });

  it('leaves non-Claude OpenRouter requests as they were, even with a volatile message', async () => {
    const body = await sendOpenRouter('xiaomi/mimo-v2.6-flash', [...toolTurn, clock]);

    const sent = body['messages'] as Array<Record<string, unknown>>;
    expect(body['cache_control']).toEqual({ type: 'ephemeral' });
    expect(sent.at(-2)?.['content']).toBe('{"positions":[]}');
  });

  it('keeps the top-level marker when the message before the volatile one has no text to carry the marker', async () => {
    const body = await sendOpenRouter('anthropic/claude-sonnet-4-5', [
      { role: 'user', content: 'do the task' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'list_positions', args: {} }] },
      clock,
    ]);

    expect(body['cache_control']).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(body['messages'])).not.toContain('"cache_control"');
  });

  it('ignores a volatile message that is not the last one', async () => {
    const body = await sendOpenRouter('anthropic/claude-sonnet-4-5', [...toolTurn, clock, { role: 'user', content: 'later' }]);

    expect(body['cache_control']).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(body['messages'])).not.toContain('"cache_control"');
  });

  it('ends the cache on the last tool result for Anthropic native, with the clock after it and no top-level marker', async () => {
    const body = await sendAnthropic([...toolTurn, clock]);

    const sent = body['messages'] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(body['cache_control']).toBeUndefined();
    expect(sent.at(-1)?.role).toBe('user');
    expect(sent.at(-1)?.content).toEqual([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'call_1', cache_control: { type: 'ephemeral' } }),
      { type: 'text', text: 'Current time is (UTC) 2026-11-14T20:31:02Z' },
    ]);
  });

  it('ends the cache on a plain user message for Anthropic native when the clock directly follows it', async () => {
    const body = await sendAnthropic([{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'do the task' }, clock]);

    const sent = body['messages'] as Array<{ content: Array<Record<string, unknown>> }>;
    expect(body['cache_control']).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toEqual([
      { type: 'text', text: 'do the task', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Current time is (UTC) 2026-11-14T20:31:02Z' },
    ]);
  });

  it('keeps the top-level marker for Anthropic native when no message is volatile', async () => {
    const body = await sendAnthropic(toolTurn);

    expect(body['cache_control']).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(body['messages'])).not.toContain('"cache_control"');
  });
});

// ---------------------------------------------------------------------------
// toOpenAiMessages — message formatting
// ---------------------------------------------------------------------------

describe('toOpenAiMessages', () => {
  const makeAssistantMsg = (content: string, toolCalls?: LlmMessage['toolCalls']): LlmMessage => ({
    role: 'assistant',
    content,
    ...(toolCalls ? { toolCalls } : {}),
  });

  const makeToolCall = (name: string, args: Record<string, unknown> = {}): NonNullable<LlmMessage['toolCalls']>[number] => ({
    id: `call_${name}`,
    name,
    args,
  });

  it('(a) assistant with tool calls and empty content → content field omitted', () => {
    const messages: LlmMessage[] = [
      makeAssistantMsg('', [makeToolCall('get_price', { symbol: 'BTC' })]),
    ];

    const result = toOpenAiMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('content');
    expect(result[0]!['role']).toBe('assistant');
    expect(result[0]!['tool_calls']).toEqual([
      {
        id: 'call_get_price',
        type: 'function',
        function: { name: 'get_price', arguments: '{"symbol":"BTC"}' },
      },
    ]);
  });

  it('(b) assistant without tool calls and empty content → { content: \'\' }', () => {
    const messages: LlmMessage[] = [
      makeAssistantMsg(''),
    ];

    const result = toOpenAiMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]!['role']).toBe('assistant');
    expect(result[0]!['content']).toBe('');
    expect(result[0]).not.toHaveProperty('tool_calls');
  });

  it('(c) assistant with non-empty content → { content: \'...\' }', () => {
    const messages: LlmMessage[] = [
      makeAssistantMsg('Here is my analysis of the market conditions.'),
    ];

    const result = toOpenAiMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]!['role']).toBe('assistant');
    expect(result[0]!['content']).toBe('Here is my analysis of the market conditions.');
    expect(result[0]).not.toHaveProperty('tool_calls');
  });

  it('assistant with tool calls and non-empty content → both content and tool_calls present', () => {
    const messages: LlmMessage[] = [
      makeAssistantMsg('Fetching price data now.', [makeToolCall('get_price', { symbol: 'ETH' })]),
    ];

    const result = toOpenAiMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]!['content']).toBe('Fetching price data now.');
    expect(result[0]!['tool_calls']).toEqual([
      {
        id: 'call_get_price',
        type: 'function',
        function: { name: 'get_price', arguments: '{"symbol":"ETH"}' },
      },
    ]);
  });

  it('multiple tool calls with empty content → content field omitted', () => {
    const messages: LlmMessage[] = [
      makeAssistantMsg('', [
        makeToolCall('get_price', { symbol: 'BTC' }),
        makeToolCall('get_funding_rates', { symbols: ['BTC', 'ETH'] }),
      ]),
    ];

    const result = toOpenAiMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('content');
    const toolCalls = result[0]!['tool_calls'] as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]!['function']['name']).toBe('get_price');
    expect(toolCalls[1]!['function']['name']).toBe('get_funding_rates');
  });

  it('mixed messages (system, user, assistant, tool) are all converted correctly', () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'You are a trading agent.' },
      { role: 'user', content: 'What is the price of BTC?' },
      makeAssistantMsg('', [makeToolCall('get_price', { symbol: 'BTC' })]),
      { role: 'tool', content: '{"price": 97000}', toolCallId: 'call_get_price', toolName: 'get_price' },
      makeAssistantMsg('BTC is trading at $97,000.'),
    ];

    const result = toOpenAiMessages(messages);

    expect(result).toHaveLength(5);
    // system
    expect(result[0]!['role']).toBe('system');
    expect(result[0]!['content']).toBe('You are a trading agent.');
    // user
    expect(result[1]!['role']).toBe('user');
    expect(result[1]!['content']).toBe('What is the price of BTC?');
    // assistant with tool calls, empty content
    expect(result[2]!['role']).toBe('assistant');
    expect(result[2]).not.toHaveProperty('content');
    expect(result[2]!['tool_calls']).toHaveLength(1);
    // tool result
    expect(result[3]!['role']).toBe('tool');
    expect(result[3]!['content']).toBe('{"price": 97000}');
    expect(result[3]!['tool_call_id']).toBe('call_get_price');
    // assistant with content, no tool calls
    expect(result[4]!['role']).toBe('assistant');
    expect(result[4]!['content']).toBe('BTC is trading at $97,000.');
    expect(result[4]).not.toHaveProperty('tool_calls');
  });
});

// ---------------------------------------------------------------------------
// Model detection helpers — isEffortBasedModel / isAdaptiveThinkingOnlyModel
// ---------------------------------------------------------------------------

describe('isEffortBasedModel', () => {
  it('returns true for Fable 5 variants', () => {
    expect(isEffortBasedModel('anthropic/claude-fable-5')).toBe(true);
    expect(isEffortBasedModel('claude-fable')).toBe(true);
  });

  it('returns true for Sonnet 5 variants', () => {
    expect(isEffortBasedModel('anthropic/claude-sonnet-5')).toBe(true);
    expect(isEffortBasedModel('claude-sonnet-5-20251015')).toBe(true);
  });

  it('returns true for Opus 4.7+ variants', () => {
    expect(isEffortBasedModel('claude-opus-4-7')).toBe(true);
    expect(isEffortBasedModel('claude-opus-4-8')).toBe(true);
    expect(isEffortBasedModel('claude-opus-5')).toBe(true);
  });

  it('returns false for legacy models', () => {
    expect(isEffortBasedModel('claude-sonnet')).toBe(false);
    expect(isEffortBasedModel('claude-opus-4-5')).toBe(false);
    expect(isEffortBasedModel('gpt-4o')).toBe(false);
    expect(isEffortBasedModel('qwen')).toBe(false);
  });
});

describe('isAdaptiveThinkingOnlyModel', () => {
  it('returns true for Fable 5', () => {
    expect(isAdaptiveThinkingOnlyModel('claude-fable')).toBe(true);
    expect(isAdaptiveThinkingOnlyModel('anthropic/claude-fable-5')).toBe(true);
  });

  it('returns false for other models', () => {
    expect(isAdaptiveThinkingOnlyModel('claude-sonnet-5')).toBe(false);
    expect(isAdaptiveThinkingOnlyModel('claude-opus-4-7')).toBe(false);
    expect(isAdaptiveThinkingOnlyModel('claude-sonnet')).toBe(false);
  });
});

describe('isClaudeModel', () => {
  it('returns true for Claude-family models', () => {
    expect(isClaudeModel('claude-sonnet')).toBe(true);
    expect(isClaudeModel('claude-fable')).toBe(true);
    expect(isClaudeModel('claude-opus-4-7')).toBe(true);
    expect(isClaudeModel('anthropic/claude-sonnet-5')).toBe(true);
    expect(isClaudeModel('claude-future-model')).toBe(true);
  });

  it('returns false for non-Claude models', () => {
    expect(isClaudeModel('gpt-4o')).toBe(false);
    expect(isClaudeModel('qwen')).toBe(false);
    expect(isClaudeModel('o4-mini')).toBe(false);
    expect(isClaudeModel('some-new-model')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveReasoningParams — model-aware reasoning resolution
// ---------------------------------------------------------------------------

describe('resolveReasoningParams', () => {
  const defaultThinkingConfig = { lightBudgetTokens: 2048, deepBudgetTokens: 10240 };

  describe('level: none', () => {
    it('returns { max_tokens: 0 } for legacy (non-Claude) models', () => {
      expect(resolveReasoningParams('none', 'gpt-4o', defaultThinkingConfig))
        .toEqual({ max_tokens: 0 });
    });

    it('returns { max_tokens: 0 } for effort-based non-adaptive models', () => {
      expect(resolveReasoningParams('none', 'claude-sonnet-5', defaultThinkingConfig))
        .toEqual({ max_tokens: 0 });
    });

    it('returns { effort: "minimal" } for adaptive-thinking-only models (Fable 5)', () => {
      expect(resolveReasoningParams('none', 'claude-fable', defaultThinkingConfig))
        .toEqual({ effort: 'minimal' });
    });
  });

  describe('level: low', () => {
    it('returns { effort: "low" } for effort-based models', () => {
      expect(resolveReasoningParams('low', 'claude-fable', defaultThinkingConfig))
        .toEqual({ effort: 'low' });
      expect(resolveReasoningParams('low', 'claude-sonnet-5', defaultThinkingConfig))
        .toEqual({ effort: 'low' });
      expect(resolveReasoningParams('low', 'claude-opus-4-7', defaultThinkingConfig))
        .toEqual({ effort: 'low' });
    });

    it('returns { max_tokens: lightBudgetTokens } for non-Claude models', () => {
      expect(resolveReasoningParams('low', 'gpt-4o', defaultThinkingConfig))
        .toEqual({ max_tokens: 2048 });
    });

    it('uses default 2048 when thinkingConfig is undefined', () => {
      expect(resolveReasoningParams('low', 'gpt-4o', undefined))
        .toEqual({ max_tokens: 2048 });
    });
  });

  describe('level: medium', () => {
    it('returns { effort: "medium" } for effort-based models', () => {
      expect(resolveReasoningParams('medium', 'claude-sonnet-5', defaultThinkingConfig))
        .toEqual({ effort: 'medium' });
    });

    it('returns { max_tokens: (light+deep)/2 } for non-Claude models', () => {
      expect(resolveReasoningParams('medium', 'gpt-4o', defaultThinkingConfig))
        .toEqual({ max_tokens: Math.round((2048 + 10240) / 2) }); // 6144
    });

    it('uses defaults when thinkingConfig is undefined', () => {
      expect(resolveReasoningParams('medium', 'gpt-4o', undefined))
        .toEqual({ max_tokens: Math.round((2048 + 10240) / 2) });
    });
  });

  describe('level: high', () => {
    it('returns { effort: "high" } for effort-based models', () => {
      expect(resolveReasoningParams('high', 'claude-opus-5', defaultThinkingConfig))
        .toEqual({ effort: 'high' });
    });

    it('returns { max_tokens: deepBudgetTokens } for non-Claude models', () => {
      expect(resolveReasoningParams('high', 'gpt-4o', defaultThinkingConfig))
        .toEqual({ max_tokens: 10240 });
    });

    it('uses default 10240 when thinkingConfig is undefined', () => {
      expect(resolveReasoningParams('high', 'gpt-4o', undefined))
        .toEqual({ max_tokens: 10240 });
    });
  });

  describe('unrecognised model fallback', () => {
    it('falls back to effort for unrecognised Claude models (forward-looking)', () => {
      expect(resolveReasoningParams('low', 'claude-future-model', defaultThinkingConfig))
        .toEqual({ effort: 'low' });
      expect(resolveReasoningParams('medium', 'claude-next-gen', defaultThinkingConfig))
        .toEqual({ effort: 'medium' });
      expect(resolveReasoningParams('high', 'claude-experimental', defaultThinkingConfig))
        .toEqual({ effort: 'high' });
    });

    it('falls back to max_tokens for truly unknown non-Claude models', () => {
      expect(resolveReasoningParams('low', 'some-new-model', defaultThinkingConfig))
        .toEqual({ max_tokens: 2048 });
      expect(resolveReasoningParams('medium', 'unknown-provider-model', defaultThinkingConfig))
        .toEqual({ max_tokens: Math.round((2048 + 10240) / 2) });
      expect(resolveReasoningParams('high', 'unknown-ai-model', defaultThinkingConfig))
        .toEqual({ max_tokens: 10240 });
    });

    it('falls back to max_tokens for unrecognised non-Claude with undefined config', () => {
      expect(resolveReasoningParams('high', 'some-new-model', undefined))
        .toEqual({ max_tokens: 10240 });
    });
  });

  // 004: Reasoning level cost ordering — lower levels must not exceed higher levels.
  // This guarantees that a user selecting 'low' never accidentally pays for 'high'.
  describe('cost ordering', () => {
    const config = { lightBudgetTokens: 2048, deepBudgetTokens: 10240 };

    const nonClaudeModel = 'gpt-4o';

    it('non-Claude: none < low < medium < high in token budget', () => {
      const none = resolveReasoningParams('none', nonClaudeModel, config);
      const low = resolveReasoningParams('low', nonClaudeModel, config);
      const medium = resolveReasoningParams('medium', nonClaudeModel, config);
      const high = resolveReasoningParams('high', nonClaudeModel, config);

      expect((none as { max_tokens: number }).max_tokens).toBe(0);
      expect((low as { max_tokens: number }).max_tokens).toBe(2048);
      expect((medium as { max_tokens: number }).max_tokens).toBe(6144);
      expect((high as { max_tokens: number }).max_tokens).toBe(10240);

      // Monotonicity: each level ≤ next level
      expect((none as { max_tokens: number }).max_tokens)
        .toBeLessThanOrEqual((low as { max_tokens: number }).max_tokens);
      expect((low as { max_tokens: number }).max_tokens)
        .toBeLessThanOrEqual((medium as { max_tokens: number }).max_tokens);
      expect((medium as { max_tokens: number }).max_tokens)
        .toBeLessThanOrEqual((high as { max_tokens: number }).max_tokens);
    });

    it('effort-based: none < low < medium < high in effort level (Claude Fable — always adaptive)', () => {
      const effortOrder: Record<string, number> = { minimal: 0, low: 1, medium: 2, high: 3 };
      const model = 'claude-fable';

      const none = resolveReasoningParams('none', model, config);
      const low = resolveReasoningParams('low', model, config);
      const medium = resolveReasoningParams('medium', model, config);
      const high = resolveReasoningParams('high', model, config);

      const noneEffort = effortOrder[(none as { effort: string }).effort];
      const lowEffort = effortOrder[(low as { effort: string }).effort];
      const mediumEffort = effortOrder[(medium as { effort: string }).effort];
      const highEffort = effortOrder[(high as { effort: string }).effort];

      expect(noneEffort).toBeLessThanOrEqual(lowEffort);
      expect(lowEffort).toBeLessThanOrEqual(mediumEffort);
      expect(mediumEffort).toBeLessThanOrEqual(highEffort);
    });
  });
});

// ---------------------------------------------------------------------------
// Unified reasoning parameter — direct usage (non-deprecated path)
// ---------------------------------------------------------------------------

describe('callLlmProvider unified reasoning parameter', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('sends reasoning.effort for effort-based models when reasoning is set directly', async () => {
    process.env['LLM_API_KEY_ANTHROPIC'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'response' }],
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0 },
      model: 'claude-fable',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await callLlmProvider(
      {
        provider: 'anthropic',
        model: 'claude-fable',
        maxTokens: 512,
        timeoutMs: 1_000,
        thinking: { lightBudgetTokens: 2048, deepBudgetTokens: 10240 },
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
        reasoning: { effort: 'high' },
      },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['thinking']).toEqual({ type: 'adaptive' });
    expect(body['output_config']).toEqual({ effort: 'high' });
    expect(body).not.toHaveProperty('reasoning');
    // Effort-based models don't need max_tokens adjustment
    expect(body['max_tokens']).toBe(512);
    expect(body['temperature']).toBe(1);
  });

  it('sends reasoning.max_tokens for legacy models when reasoning is set directly', async () => {
    process.env['LLM_API_KEY_ANTHROPIC'] = 'test-key';
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
        thinking: { lightBudgetTokens: 2048, deepBudgetTokens: 10240 },
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
        reasoning: { max_tokens: 5000 },
      },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 5000 });
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('output_config');
    // Legacy models add reasoning max_tokens to total max_tokens
    expect(body['max_tokens']).toBe(512 + 5000);
    expect(body['temperature']).toBe(1);
  });

  it('new reasoning field takes precedence over deprecated thinking field', async () => {
    process.env['LLM_API_KEY_ANTHROPIC'] = 'test-key';
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
        thinking: { lightBudgetTokens: 2048, deepBudgetTokens: 10240 },
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
        thinking: 'light',
        reasoning: { effort: 'high' },
      },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // reasoning takes precedence over thinking
    expect(body['thinking']).toEqual({ type: 'adaptive' });
    expect(body['output_config']).toEqual({ effort: 'high' });
    expect(body).not.toHaveProperty('reasoning');
  });

  it('does not send reasoning when max_tokens is 0 and no effort', async () => {
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { total_tokens: 12 },
      model: 'gpt-4o',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await callLlmProvider(
      {
        provider: 'openai',
        model: 'gpt-4o',
        maxTokens: 512,
        timeoutMs: 1_000,
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
        reasoning: { max_tokens: 0 },
      },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('reasoning');
  });

  it('sends reasoning with enabled flag', async () => {
    process.env['LLM_API_KEY_ANTHROPIC'] = 'test-key';
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
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
        reasoning: { enabled: true },
      },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // enabled: true without budget or effort → adaptive thinking (model chooses depth)
    expect(body['thinking']).toEqual({ type: 'adaptive' });
    expect(body).not.toHaveProperty('output_config');
    expect(body).not.toHaveProperty('reasoning');
  });
});


// ---------------------------------------------------------------------------
// OpenRouter provider controls emission
// ---------------------------------------------------------------------------

describe('OpenRouter provider controls emission', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env['LLM_API_KEY_OPENROUTER'] = 'test-key';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const openrouterConfig: LlmProviderConfig = {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4-20250514',
    maxTokens: 4096,
    timeoutMs: 30_000,
    baseUrl: 'https://openrouter.ai/api/v1',
  };

  const baseRequest: LlmRequest = {
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 1024,
  };

  function mockFetch() {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      model: 'anthropic/claude-sonnet-4-20250514',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function getRequestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it('includes provider.data_collection and provider.zdr when controls are set', async () => {
    const fetchMock = mockFetch();

    const result = await callLlmProvider(
      {
        ...openrouterConfig,
        openRouterProviderControls: {
          dataCollection: 'deny',
          zdr: true,
        },
      },
      baseRequest,
    );

    expect(result.ok).toBe(true);
    const body = getRequestBody(fetchMock);
    expect(body['provider']).toEqual({
      data_collection: 'deny',
      zdr: true,
    });
  });

  it('omits undefined fields from the provider object', async () => {
    const fetchMock = mockFetch();

    await callLlmProvider(
      {
        ...openrouterConfig,
        openRouterProviderControls: {
          zdr: true,
        },
      },
      baseRequest,
    );

    const body = getRequestBody(fetchMock);
    expect(body['provider']).toEqual({ zdr: true });
    expect(body['provider']).not.toHaveProperty('data_collection');
    expect(body['provider']).not.toHaveProperty('allow_fallbacks');
    expect(body['provider']).not.toHaveProperty('only');
    expect(body['provider']).not.toHaveProperty('order');
  });

  it('does not include a provider object for non-OpenRouter requests', async () => {
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      model: 'gpt-4o',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await callLlmProvider(
      {
        provider: 'openai',
        model: 'gpt-4o',
        maxTokens: 4096,
        timeoutMs: 30_000,
        openRouterProviderControls: {
          dataCollection: 'deny',
          zdr: true,
        },
      },
      baseRequest,
    );

    const body = getRequestBody(fetchMock);
    expect(body).not.toHaveProperty('provider');
  });

  it('does not emit provider key when openRouterProviderControls is empty (all fields undefined)', async () => {
    const fetchMock = mockFetch();

    await callLlmProvider(
      {
        ...openrouterConfig,
        openRouterProviderControls: {},
      },
      baseRequest,
    );

    const body = getRequestBody(fetchMock);
    expect(body).not.toHaveProperty('provider');
  });

  it('preserves existing cache_control behavior alongside the provider object', async () => {
    const fetchMock = mockFetch();

    await callLlmProvider(
      {
        ...openrouterConfig,
        openRouterProviderControls: {
          dataCollection: 'deny',
          zdr: true,
        },
      },
      baseRequest,
    );

    const body = getRequestBody(fetchMock);
    expect(body['cache_control']).toEqual({ type: 'ephemeral' });
    expect(body['provider']).toEqual({
      data_collection: 'deny',
      zdr: true,
    });
  });

  it('maps all five control fields correctly to snake_case wire format', async () => {
    const fetchMock = mockFetch();

    await callLlmProvider(
      {
        ...openrouterConfig,
        openRouterProviderControls: {
          dataCollection: 'deny',
          zdr: true,
          allowFallbacks: false,
          only: ['anthropic'],
          order: ['anthropic', 'openai'],
        },
      },
      baseRequest,
    );

    const body = getRequestBody(fetchMock);
    expect(body['provider']).toEqual({
      data_collection: 'deny',
      zdr: true,
      allow_fallbacks: false,
      only: ['anthropic'],
      order: ['anthropic', 'openai'],
    });
  });
});

describe('callLlmProvider diagnostics for an empty reply', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';
    process.env['LLM_API_KEY_ANTHROPIC'] = 'test-key';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('reports the finish reason and the text length before thinking was removed (OpenAI-compatible)', async () => {
    const raw = '<thinking>planning the next step</thinking>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: raw } }],
      usage: { total_tokens: 20, completion_tokens: 8 },
      model: 'gpt-4o-mini',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const result = await callLlmProvider(
      { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 512, timeoutMs: 1_000 },
      { messages: [{ role: 'user', content: 'hello' }], maxTokens: 512 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.content).toBe('');
    expect(result.data.finishReason).toBe('length');
    expect(result.data.contentCharsBeforeStrip).toBe(raw.length);
  });

  it('reports zero text and no finish reason when the model sent nothing and the provider named none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '' } }],
      usage: { total_tokens: 20 },
      model: 'gpt-4o-mini',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const result = await callLlmProvider(
      { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 512, timeoutMs: 1_000 },
      { messages: [{ role: 'user', content: 'hello' }], maxTokens: 512 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.finishReason).toBeUndefined();
    expect(result.data.contentCharsBeforeStrip).toBe(0);
  });

  it('reports the stop reason and text length on the Anthropic path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_1',
      content: [{ type: 'text', text: '<thinking>x</thinking>' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 4 },
      model: 'claude-test',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const result = await callLlmProvider(
      { provider: 'anthropic', model: 'claude-test', maxTokens: 512, timeoutMs: 1_000 },
      { messages: [{ role: 'user', content: 'hello' }], maxTokens: 512 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.content).toBe('');
    expect(result.data.finishReason).toBe('max_tokens');
    expect(result.data.contentCharsBeforeStrip).toBe('<thinking>x</thinking>'.length);
  });
});

describe('callLlmProvider reasoning tokens on the OpenAI-compatible path', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env['LLM_API_KEY_OPENROUTER'] = 'test-key';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  async function callWithUsage(usage: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage,
      model: 'anthropic/claude-haiku-5.5',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    return callLlmProvider(
      { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', maxTokens: 4096, timeoutMs: 1_000 },
      { messages: [{ role: 'user', content: 'hello' }], maxTokens: 4096 },
    );
  }

  it('reads reasoning tokens from completion_tokens_details, where Chat Completions reports them', async () => {
    const result = await callWithUsage({ prompt_tokens: 100, completion_tokens: 900, total_tokens: 1000, completion_tokens_details: { reasoning_tokens: 700 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.thinkingTokens).toBe(700);
  });

  it('counts only visible output as output tokens, so output plus reasoning is not billed twice', async () => {
    const result = await callWithUsage({ prompt_tokens: 100, completion_tokens: 900, total_tokens: 1000, completion_tokens_details: { reasoning_tokens: 700 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outputTokens).toBe(200);
    expect((result.data.outputTokens ?? 0) + (result.data.thinkingTokens ?? 0)).toBe(900);
    expect(result.data.tokensUsed).toBe(1000);
  });

  it('keeps output tokens equal to completion tokens when the provider reports no reasoning', async () => {
    const result = await callWithUsage({ prompt_tokens: 100, completion_tokens: 300, total_tokens: 400 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.thinkingTokens).toBe(0);
    expect(result.data.outputTokens).toBe(300);
  });

  it('falls back to output_tokens_details when that is the name the provider uses', async () => {
    const result = await callWithUsage({ prompt_tokens: 100, completion_tokens: 300, total_tokens: 400, output_tokens_details: { reasoning_tokens: 120 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.thinkingTokens).toBe(120);
    expect(result.data.outputTokens).toBe(180);
  });

  it('never reports negative output tokens if the provider reports more reasoning than completion tokens', async () => {
    const result = await callWithUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, completion_tokens_details: { reasoning_tokens: 80 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outputTokens).toBe(0);
  });

  it('leaves output tokens unset when the provider gives no completion token count', async () => {
    const result = await callWithUsage({ total_tokens: 400 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outputTokens).toBeUndefined();
  });
});
