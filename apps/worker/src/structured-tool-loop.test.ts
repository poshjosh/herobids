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

  it('injects turn hints and disables tools on the final turn', async () => {
    const requests: Array<{ messages: Array<{ role: string; content: string }>; toolChoice?: string }> = [];

    vi.mocked(callLlmWithRetry).mockImplementation(async (_config, request) => {
      requests.push({
        messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
        toolChoice: request.toolChoice,
      });

      const turnNumber = requests.length;
      if (turnNumber === 1) {
        return {
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
        };
      }

      if (turnNumber === 2) {
        return {
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
        };
      }

      return {
        result: {
          ok: true,
          data: {
            content: '{"disposition":"escalate","reason":"done"}',
            toolCalls: [],
            model: 'test-model',
            provider: 'openai',
            tokensUsed: 8,
            latencyMs: 3,
            cached: false,
          },
        },
        attempts: 1,
        delaysMs: [],
      };
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
      tools: [
        { name: 'check_regime', description: 'Check regime', inputSchema: { type: 'object' } },
        { name: 'list_positions', description: 'List positions', inputSchema: { type: 'object' } },
      ],
      maxTurns: 3,
      executeTool: async (toolCall) => {
        if (toolCall.name === 'check_regime') {
          return JSON.stringify({ pass: true });
        }
        return JSON.stringify({ positions: [] });
      },
      onBeforeTurn: ({ turnsRemaining }) => {
        if (turnsRemaining === 2) {
          return 'You have 2 tool call rounds left. Consolidate your remaining calls now.';
        }
        if (turnsRemaining === 1) {
          return {
            message: 'This is your final tool call round — you must now respond with your JSON decision only: {"disposition":"hold","reason":"short reason"}. Do not request any more tools.',
            toolChoice: 'none',
          };
        }
        return undefined;
      },
    });

    expect(result).toEqual({
      ok: true,
      assistantResponse: '{"disposition":"escalate","reason":"done"}',
      toolCalls: [],
      turnsUsed: 3,
      terminatedByLimit: false,
    });
    expect(requests).toHaveLength(3);
    expect(requests[0]?.messages).toEqual([
      { role: 'user', content: 'hello' },
    ]);
    expect(requests[1]?.messages.at(-1)).toEqual({ role: 'user', content: 'You have 2 tool call rounds left. Consolidate your remaining calls now.' });
    expect(requests[1]?.toolChoice).toBe('auto');
    expect(requests[2]?.messages.at(-1)).toEqual({ role: 'user', content: 'This is your final tool call round — you must now respond with your JSON decision only: {"disposition":"hold","reason":"short reason"}. Do not request any more tools.' });
    expect(requests[2]?.toolChoice).toBe('none');
  });

  it('applies the final-turn hint on a single-turn loop', async () => {
    const requests: Array<{ messages: Array<{ role: string; content: string }>; toolChoice?: string }> = [];

    vi.mocked(callLlmWithRetry).mockImplementation(async (_config, request) => {
      requests.push({
        messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
        toolChoice: request.toolChoice,
      });

      return {
        result: {
          ok: true,
          data: {
            content: '{"disposition":"hold","reason":"enough context"}',
            toolCalls: [],
            model: 'test-model',
            provider: 'openai',
            tokensUsed: 7,
            latencyMs: 2,
            cached: false,
          },
        },
        attempts: 1,
        delaysMs: [],
      };
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
      tools: [],
      maxTurns: 1,
      executeTool: async () => null,
      onBeforeTurn: ({ turnsRemaining }) => {
        if (turnsRemaining === 1) {
          return {
            message: 'This is your final tool call round — respond with JSON only, with disposition "hold" or "escalate" and a short reason. Do not request any more tools.',
            toolChoice: 'none',
          };
        }
        return undefined;
      },
    });

    expect(result).toEqual({
      ok: true,
      assistantResponse: '{"disposition":"hold","reason":"enough context"}',
      toolCalls: [],
      turnsUsed: 1,
      terminatedByLimit: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'This is your final tool call round — respond with JSON only, with disposition "hold" or "escalate" and a short reason. Do not request any more tools.' },
    ]);
    expect(requests[0]?.toolChoice).toBe('none');
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
      turnsUsed: 2,
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
      turnsUsed: 2,
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
      turnsUsed: 2,
      terminatedByLimit: false,
    });
    expect(toolExecutions).toEqual(['check_regime', 'list_positions']);
    expect(vi.mocked(callLlmWithRetry)).toHaveBeenCalledTimes(2);
  });

  describe('retryPolicy option', () => {
    it('passes retryPolicy fields to callLlmWithRetry', async () => {
      vi.mocked(callLlmWithRetry).mockResolvedValueOnce({
        result: {
          ok: true,
          data: {
            content: 'done',
            toolCalls: [],
            model: 'test-model',
            provider: 'openai',
            tokensUsed: 5,
            latencyMs: 3,
            cached: false,
          },
        },
        attempts: 1,
        delaysMs: [],
      });

      const retryPolicy = {
        maxRetries: 3,
        timeoutBackoffMs: [3_000, 9_000],
        serverErrorBackoffMs: 7_000,
        defaultRateLimitBackoffMs: 30_000,
      };

      await runStructuredToolLoop({
        providerConfig: { provider: 'openai', model: 'test-model', maxTokens: 128, timeoutMs: 1_000 },
        requestBase: { maxTokens: 128, temperature: 0 },
        initialMessages: [{ role: 'user', content: 'hello' }],
        tools: [],
        maxTurns: 1,
        retryPolicy,
        executeTool: async () => null,
      });

      expect(vi.mocked(callLlmWithRetry)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          maxRetries: 3,
          timeoutBackoffMs: [3_000, 9_000],
          serverErrorBackoffMs: 7_000,
          defaultRateLimitBackoffMs: 30_000,
        }),
      );
    });

    it('works without a retryPolicy (uses defaults internally)', async () => {
      vi.mocked(callLlmWithRetry).mockResolvedValueOnce({
        result: {
          ok: true,
          data: {
            content: 'ok',
            toolCalls: [],
            model: 'test-model',
            provider: 'openai',
            tokensUsed: 5,
            latencyMs: 3,
            cached: false,
          },
        },
        attempts: 1,
        delaysMs: [],
      });

      const result = await runStructuredToolLoop({
        providerConfig: { provider: 'openai', model: 'test-model', maxTokens: 128, timeoutMs: 1_000 },
        requestBase: { maxTokens: 128, temperature: 0 },
        initialMessages: [{ role: 'user', content: 'hello' }],
        tools: [],
        maxTurns: 1,
        executeTool: async () => null,
      });

      expect(result.ok).toBe(true);
    });
  });
});
