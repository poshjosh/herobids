import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runStructuredToolLoop } from './structured-tool-loop.js';
import { callLlmWithRetry } from './runtime-errors.js';

vi.mock('./runtime-errors.js', () => ({
  callLlmWithRetry: vi.fn(),
}));

describe('runStructuredToolLoop', () => {
  beforeEach(() => {
    vi.mocked(callLlmWithRetry).mockReset();
  });

  it('executes tool turns until the model returns a final response', async () => {
    vi.mocked(callLlmWithRetry)
      .mockResolvedValueOnce({
        result: {
          ok: true,
          data: {
            content: 'Need regime',
            toolCalls: [{ id: 'call_1', name: 'check_regime', args: { symbol: 'BTC' } }],
            model: 'test-model',
            provider: 'openai',
            tokensUsed: 10,
            latencyMs: 5,
            cached: false,
          },
        },
        attempts: 1,
        delaysMs: [],
      })
      .mockResolvedValueOnce({
        result: {
          ok: true,
          data: {
            content: 'Hold for now',
            toolCalls: [],
            model: 'test-model',
            provider: 'openai',
            tokensUsed: 8,
            latencyMs: 4,
            cached: false,
          },
        },
        attempts: 1,
        delaysMs: [],
      });

    const toolExecutions: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const result = await runStructuredToolLoop({
      providerConfig: {
        provider: 'openai',
        model: 'test-model',
        maxTokens: 128,
        timeoutMs: 1_000,
      },
      requestBase: {
        maxTokens: 128,
        temperature: 0,
      },
      initialMessages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
      ],
      tools: [{
        name: 'check_regime',
        description: 'Check regime',
        inputSchema: { type: 'object' },
      }],
      maxTurns: 3,
      executeTool: async (toolCall) => {
        toolExecutions.push({ tool: toolCall.name, args: toolCall.args });
        return JSON.stringify({ pass: true });
      },
    });

    expect(result).toEqual({
      ok: true,
      assistantResponse: 'Hold for now',
      toolCalls: [],
      terminatedByLimit: false,
    });
    expect(toolExecutions).toEqual([{ tool: 'check_regime', args: { symbol: 'BTC' } }]);
    expect(vi.mocked(callLlmWithRetry)).toHaveBeenCalledTimes(2);
  });

  it('preserves the last assistant response when the turn limit is reached', async () => {
    vi.mocked(callLlmWithRetry)
      .mockResolvedValueOnce({
        result: {
          ok: true,
          data: {
            content: 'Need regime',
            toolCalls: [{ id: 'call_1', name: 'check_regime', args: { symbol: 'BTC' } }],
            model: 'test-model',
            provider: 'openai',
            tokensUsed: 10,
            latencyMs: 5,
            cached: false,
          },
        },
        attempts: 1,
        delaysMs: [],
      })
      .mockResolvedValueOnce({
        result: {
          ok: true,
          data: {
            content: 'Still checking',
            toolCalls: [{ id: 'call_2', name: 'list_positions', args: {} }],
            model: 'test-model',
            provider: 'openai',
            tokensUsed: 9,
            latencyMs: 4,
            cached: false,
          },
        },
        attempts: 1,
        delaysMs: [],
      });

    const result = await runStructuredToolLoop({
      providerConfig: {
        provider: 'openai',
        model: 'test-model',
        maxTokens: 128,
        timeoutMs: 1_000,
      },
      requestBase: {
        maxTokens: 128,
        temperature: 0,
      },
      initialMessages: [{ role: 'user', content: 'hello' }],
      tools: [{
        name: 'check_regime',
        description: 'Check regime',
        inputSchema: { type: 'object' },
      }],
      maxTurns: 2,
      executeTool: async () => JSON.stringify({ pass: true }),
    });

    expect(result).toEqual({
      ok: true,
      assistantResponse: 'Still checking',
      toolCalls: [{ id: 'call_2', name: 'list_positions', args: {} }],
      terminatedByLimit: true,
    });
  });

  it('executes each tool call from a structured assistant turn once', async () => {
    vi.mocked(callLlmWithRetry)
      .mockResolvedValueOnce({
        result: {
          ok: true,
          data: {
            content: 'Need two checks',
            toolCalls: [
              { id: 'call_1', name: 'check_regime', args: { symbol: 'BTC' } },
              { id: 'call_2', name: 'list_positions', args: {} },
            ],
            model: 'test-model',
            provider: 'openai',
            tokensUsed: 10,
            latencyMs: 5,
            cached: false,
          },
        },
        attempts: 1,
        delaysMs: [],
      })
      .mockResolvedValueOnce({
        result: {
          ok: true,
          data: {
            content: 'Done',
            toolCalls: [],
            model: 'test-model',
            provider: 'openai',
            tokensUsed: 6,
            latencyMs: 4,
            cached: false,
          },
        },
        attempts: 1,
        delaysMs: [],
      });

    const toolExecutions: string[] = [];
    const result = await runStructuredToolLoop({
      providerConfig: {
        provider: 'openai',
        model: 'test-model',
        maxTokens: 128,
        timeoutMs: 1_000,
      },
      requestBase: {
        maxTokens: 128,
        temperature: 0,
      },
      initialMessages: [{ role: 'user', content: 'hello' }],
      tools: [
        { name: 'check_regime', description: 'Check regime', inputSchema: { type: 'object' } },
        { name: 'list_positions', description: 'List positions', inputSchema: { type: 'object' } },
      ],
      maxTurns: 3,
      executeTool: async (toolCall) => {
        toolExecutions.push(toolCall.name);
        return JSON.stringify({ ok: true });
      },
    });

    expect(result).toEqual({
      ok: true,
      assistantResponse: 'Done',
      toolCalls: [],
      terminatedByLimit: false,
    });
    expect(toolExecutions).toEqual(['check_regime', 'list_positions']);
    expect(vi.mocked(callLlmWithRetry)).toHaveBeenCalledTimes(2);
  });
});
