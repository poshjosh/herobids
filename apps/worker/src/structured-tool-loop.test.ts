import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isKnownAgentToolName } from '@herobids/domain';
import { DURABLE_TOOL_NAMES, runStructuredToolLoop } from './structured-tool-loop.js';
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

  describe('getTools per-turn tool refresh', () => {
    it('calls getTools on each turn and passes the returned tools to the LLM', async () => {
      const toolsPerCall: string[][] = [];

      vi.mocked(callLlmWithRetry).mockImplementation(async (_config, request) => {
        toolsPerCall.push((request.tools ?? []).map(t => t.name));

        if (toolsPerCall.length === 1) {
          return {
            result: {
              ok: true,
              data: {
                content: 'calling tool',
                toolCalls: [{ id: 'call_1', name: 'tool_a', args: {} }],
                model: 'test-model', provider: 'openai', tokensUsed: 10, latencyMs: 5, cached: false,
              },
            },
            attempts: 1, delaysMs: [],
          };
        }
        return {
          result: {
            ok: true,
            data: {
              content: 'done',
              toolCalls: [],
              model: 'test-model', provider: 'openai', tokensUsed: 5, latencyMs: 3, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        };
      });

      const getTools = vi.fn()
        .mockReturnValueOnce([
          { name: 'tool_a', description: 'Tool A', inputSchema: { type: 'object' } },
        ])
        .mockReturnValueOnce([
          { name: 'tool_a', description: 'Tool A', inputSchema: { type: 'object' } },
          { name: 'tool_b', description: 'Tool B', inputSchema: { type: 'object' } },
        ]);

      await runStructuredToolLoop({
        providerConfig: { provider: 'openai', model: 'test-model', maxTokens: 128, timeoutMs: 1_000 },
        requestBase: { maxTokens: 128, temperature: 0 },
        initialMessages: [{ role: 'user', content: 'hello' }],
        tools: [], // static tools ignored when getTools is provided
        maxTurns: 3,
        getTools,
        executeTool: async () => JSON.stringify({ ok: true }),
      });

      expect(getTools).toHaveBeenCalledTimes(2);
      expect(toolsPerCall[0]).toEqual(['tool_a']);
      expect(toolsPerCall[1]).toEqual(['tool_a', 'tool_b']);
    });

    it('falls back to options.tools when getTools is not provided', async () => {
      const toolsPerCall: string[][] = [];

      vi.mocked(callLlmWithRetry).mockImplementation(async (_config, request) => {
        toolsPerCall.push((request.tools ?? []).map(t => t.name));
        return {
          result: {
            ok: true,
            data: {
              content: 'done',
              toolCalls: [],
              model: 'test-model', provider: 'openai', tokensUsed: 5, latencyMs: 3, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        };
      });

      await runStructuredToolLoop({
        providerConfig: { provider: 'openai', model: 'test-model', maxTokens: 128, timeoutMs: 1_000 },
        requestBase: { maxTokens: 128, temperature: 0 },
        initialMessages: [{ role: 'user', content: 'hello' }],
        tools: [
          { name: 'static_tool', description: 'Static', inputSchema: { type: 'object' } },
        ],
        maxTurns: 1,
        executeTool: async () => null,
      });

      expect(toolsPerCall[0]).toEqual(['static_tool']);
    });

    it('after a simulated skill change the next LLM call sees the new tools', async () => {
      // Simulates: turn 1 has tool_a only, executeTool triggers a "skill change"
      // that makes getTools return tool_a + tool_b on turn 2.
      const toolsPerCall: string[][] = [];
      let skillChanged = false;

      const availableTools = [
        { name: 'tool_a', description: 'Tool A', inputSchema: { type: 'object' } },
      ];

      vi.mocked(callLlmWithRetry).mockImplementation(async (_config, request) => {
        toolsPerCall.push((request.tools ?? []).map(t => t.name));

        if (toolsPerCall.length === 1) {
          return {
            result: {
              ok: true,
              data: {
                content: 'adding skill',
                toolCalls: [{ id: 'call_1', name: 'add_skills', args: { skillIds: ['traderton/skills/crypto-trading'] } }],
                model: 'test-model', provider: 'openai', tokensUsed: 10, latencyMs: 5, cached: false,
              },
            },
            attempts: 1, delaysMs: [],
          };
        }
        return {
          result: {
            ok: true,
            data: {
              content: 'done',
              toolCalls: [],
              model: 'test-model', provider: 'openai', tokensUsed: 5, latencyMs: 3, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        };
      });

      const result = await runStructuredToolLoop({
        providerConfig: { provider: 'openai', model: 'test-model', maxTokens: 128, timeoutMs: 1_000 },
        requestBase: { maxTokens: 128, temperature: 0 },
        initialMessages: [{ role: 'user', content: 'hello' }],
        tools: [],
        maxTurns: 3,
        getTools: () => {
          if (skillChanged) {
            return [
              ...availableTools,
              { name: 'submit_decision', description: 'Submit decision', inputSchema: { type: 'object' } },
            ];
          }
          return [...availableTools];
        },
        executeTool: async (toolCall) => {
          if (toolCall.name === 'add_skills') {
            // Simulate skill change side effect
            skillChanged = true;
          }
          return JSON.stringify({ success: true });
        },
      });

      expect(result.ok).toBe(true);
      // Turn 1: only tool_a visible
      expect(toolsPerCall[0]).toEqual(['tool_a']);
      // Turn 2: after skill change, submit_decision is now visible
      expect(toolsPerCall[1]).toEqual(['tool_a', 'submit_decision']);
    });
  });

  describe('getTurnContext per-turn message', () => {
    type Seen = Array<Array<{ role: string; content: string }>>;

    /** Three turns: tool call, tool call, final answer. Returns what the model was sent each turn. */
    async function runThreeTurns(getTurnContext?: (info: { turnIndex: number }) => string | undefined): Promise<Seen> {
      const seen: Seen = [];
      vi.mocked(callLlmWithRetry).mockImplementation(async (_config, request) => {
        seen.push(request.messages.map((message) => ({ role: message.role, content: message.content })));
        const toolCalls = seen.length < 3 ? [{ id: `call_${seen.length}`, name: 'list_positions', args: {} }] : [];
        return {
          result: {
            ok: true,
            data: { content: 'ok', toolCalls, model: 'test-model', provider: 'openai', tokensUsed: 1, latencyMs: 1, cached: false },
          },
          attempts: 1,
          delaysMs: [],
        };
      });

      await runStructuredToolLoop({
        providerConfig: { provider: 'openai', model: 'test-model', maxTokens: 128, timeoutMs: 1_000 },
        requestBase: { maxTokens: 128, temperature: 0 },
        initialMessages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'list_positions', description: 'List positions', inputSchema: { type: 'object' } }],
        maxTurns: 5,
        executeTool: async () => '{"positions":[]}',
        getTurnContext,
      });
      return seen;
    }

    it('sends the turn context as the last message on every turn that returns one', async () => {
      const seen = await runThreeTurns(({ turnIndex }) => `status turn ${turnIndex}`);

      expect(seen).toHaveLength(3);
      expect(seen.map((messages) => messages.at(-1))).toEqual([
        { role: 'user', content: 'status turn 0' },
        { role: 'user', content: 'status turn 1' },
        { role: 'user', content: 'status turn 2' },
      ]);
    });

    it('does not keep earlier turn context in the messages later turns resend', async () => {
      const seen = await runThreeTurns(({ turnIndex }) => `status turn ${turnIndex}`);

      const lastTurn = seen[2]?.map((message) => message.content) ?? [];
      expect(lastTurn).toContain('status turn 2');
      expect(lastTurn).not.toContain('status turn 0');
      expect(lastTurn).not.toContain('status turn 1');
    });

    it('marks the turn context volatile so prompt caching ends before it', async () => {
      const lastMessages: Array<Record<string, unknown> | undefined> = [];
      vi.mocked(callLlmWithRetry).mockImplementation(async (_config, request) => {
        lastMessages.push(request.messages.at(-1) as Record<string, unknown> | undefined);
        return {
          result: {
            ok: true,
            data: { content: 'ok', toolCalls: [], model: 'test-model', provider: 'openai', tokensUsed: 1, latencyMs: 1, cached: false },
          },
          attempts: 1,
          delaysMs: [],
        };
      });

      await runStructuredToolLoop({
        providerConfig: { provider: 'openai', model: 'test-model', maxTokens: 128, timeoutMs: 1_000 },
        requestBase: { maxTokens: 128, temperature: 0 },
        initialMessages: [{ role: 'user', content: 'hello' }],
        tools: [],
        maxTurns: 2,
        executeTool: async () => '{}',
        getTurnContext: () => 'status',
      });

      expect(lastMessages[0]).toEqual({ role: 'user', content: 'status', volatile: true });
    });

    it('sends nothing extra on turns where it returns undefined', async () => {
      const seen = await runThreeTurns(({ turnIndex }) => (turnIndex >= 1 ? 'late status' : undefined));

      expect(seen[0]?.map((message) => message.content)).toEqual(['hello']);
      expect(seen[1]?.at(-1)).toEqual({ role: 'user', content: 'late status' });
    });

    it('sends exactly the same requests as before when it is not provided', async () => {
      const withoutOption = await runThreeTurns();
      const withUndefinedOption = await runThreeTurns(() => undefined);

      expect(withUndefinedOption).toEqual(withoutOption);
      expect(withoutOption[0]).toEqual([{ role: 'user', content: 'hello' }]);
    });
  });

  describe('stale tool result truncation', () => {
    it('truncates tool results only after the full retention window (age > retentionTurns)', async () => {
      // retentionTurns=3: ages 0-3 keep full results; age 4+ truncates.
      vi.mocked(callLlmWithRetry)
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'check 1',
              toolCalls: [{ id: 'call_1', name: 'list_positions', args: {} }],
              model: 'test-model', provider: 'openai', tokensUsed: 10, latencyMs: 5, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        })
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'check 2',
              toolCalls: [{ id: 'call_2', name: 'list_positions', args: {} }],
              model: 'test-model', provider: 'openai', tokensUsed: 10, latencyMs: 5, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        })
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'check 3',
              toolCalls: [{ id: 'call_3', name: 'list_positions', args: {} }],
              model: 'test-model', provider: 'openai', tokensUsed: 10, latencyMs: 5, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        })
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'check 4',
              toolCalls: [{ id: 'call_4', name: 'list_positions', args: {} }],
              model: 'test-model', provider: 'openai', tokensUsed: 10, latencyMs: 5, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        })
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'done',
              toolCalls: [],
              model: 'test-model', provider: 'openai', tokensUsed: 5, latencyMs: 3, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        });

      const result = await runStructuredToolLoop({
        providerConfig: { provider: 'openai', model: 'test-model', maxTokens: 128, timeoutMs: 1_000 },
        requestBase: { maxTokens: 128, temperature: 0 },
        initialMessages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'list_positions', description: 'List positions', inputSchema: { type: 'object' } }],
        maxTurns: 5,
        toolResultFullRetentionTurns: 3,
        toolResultMaxStaleChars: 20,
        executeTool: async () => 'x'.repeat(100),
      });

      expect(result.ok).toBe(true);
      expect(result.turnsUsed).toBe(5);

      // The messages array is mutated in-place across turns. All mock.calls
      // entries share the same reference, so inspecting any one of them
      // reveals the final state after the loop completed.
      const callArgs = vi.mocked(callLlmWithRetry).mock.calls;
      const messages = (callArgs[0]![1] as { messages: Array<{ role: string; content: string }> }).messages;

      // 4 tool results were pushed: one per turn before the final turn
      const toolMsgs = messages.filter(m => m.role === 'tool');
      expect(toolMsgs).toHaveLength(4);

      // Oldest tool result (age 4 at loop end): truncated
      expect(toolMsgs[0]!.content).toBe('x'.repeat(20) + '...[truncated]');

      // Next 3 tool results (ages 3, 2, 1 at loop end): full retention
      for (let i = 1; i < 4; i++) {
        expect(toolMsgs[i]!.content).toBe('x'.repeat(100));
      }
    });

    // Shared loop: turn 0 loads a durable skill (pinned, ~15 KB), turn 1 is a non-durable
    // list_positions result, turns 2-4 are fillers, turn 5 ends. With retentionTurns=3 and
    // maxStaleChars=20, at loop end both the skill (age 5) and the first list_positions (age 4)
    // are past the window, so they exercise the pin exemption and the normal truncation together.
    const runDurableVsTransientLoop = async () => {
      const toolTurn = (id: string, name: string) => ({
        result: {
          ok: true as const,
          data: {
            content: `calling ${name}`,
            toolCalls: [{ id, name, args: {} }],
            model: 'test-model', provider: 'openai' as const, tokensUsed: 10, latencyMs: 5, cached: false,
          },
        },
        attempts: 1, delaysMs: [],
      });

      vi.mocked(callLlmWithRetry)
        .mockResolvedValueOnce(toolTurn('call_1', 'read_skill'))
        .mockResolvedValueOnce(toolTurn('call_2', 'list_positions'))
        .mockResolvedValueOnce(toolTurn('call_3', 'list_positions'))
        .mockResolvedValueOnce(toolTurn('call_4', 'list_positions'))
        .mockResolvedValueOnce(toolTurn('call_5', 'list_positions'))
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'done',
              toolCalls: [],
              model: 'test-model', provider: 'openai', tokensUsed: 5, latencyMs: 3, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        });

      await runStructuredToolLoop({
        providerConfig: { provider: 'openai', model: 'test-model', maxTokens: 128, timeoutMs: 1_000 },
        requestBase: { maxTokens: 128, temperature: 0 },
        initialMessages: [{ role: 'user', content: 'hello' }],
        tools: [
          { name: 'read_skill', description: 'Read a skill', inputSchema: { type: 'object' } },
          { name: 'list_positions', description: 'List positions', inputSchema: { type: 'object' } },
        ],
        maxTurns: 6,
        toolResultFullRetentionTurns: 3,
        toolResultMaxStaleChars: 20,
        executeTool: async (toolCall) => (toolCall.name === 'read_skill' ? 's'.repeat(15_000) : 'x'.repeat(100)),
      });

      const callArgs = vi.mocked(callLlmWithRetry).mock.calls;
      return (callArgs[0]![1] as { messages: Array<{ role: string; content: string; toolName?: string }> }).messages;
    };

    it('does not truncate pinned durable tool results past the retention window', async () => {
      const messages = await runDurableVsTransientLoop();
      const skillMsg = messages.find(m => m.role === 'tool' && m.toolName === 'read_skill');

      // The durable skill result (age 5 at loop end) survives intact despite far exceeding maxStaleChars.
      expect(skillMsg!.content).toBe('s'.repeat(15_000));
    });

    it('still truncates non-durable tool results', async () => {
      const messages = await runDurableVsTransientLoop();
      const firstPositions = messages.find(m => m.role === 'tool' && m.toolName === 'list_positions');

      // The oldest non-durable result (age 4 at loop end) is still truncated — guard against over-exemption.
      expect(firstPositions!.content).toBe('x'.repeat(20) + '...[truncated]');
    });

    it('notifies onToolResultTruncated when a stale tool result is truncated', async () => {
      // retentionTurns=3, maxStaleChars=20: the first list_positions result (age 4 at loop
      // end) is past the window and truncated, so the callback must fire for it.
      vi.mocked(callLlmWithRetry)
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'check 1',
              toolCalls: [{ id: 'call_1', name: 'list_positions', args: {} }],
              model: 'test-model', provider: 'openai', tokensUsed: 10, latencyMs: 5, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        })
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'check 2',
              toolCalls: [{ id: 'call_2', name: 'list_positions', args: {} }],
              model: 'test-model', provider: 'openai', tokensUsed: 10, latencyMs: 5, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        })
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'check 3',
              toolCalls: [{ id: 'call_3', name: 'list_positions', args: {} }],
              model: 'test-model', provider: 'openai', tokensUsed: 10, latencyMs: 5, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        })
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'check 4',
              toolCalls: [{ id: 'call_4', name: 'list_positions', args: {} }],
              model: 'test-model', provider: 'openai', tokensUsed: 10, latencyMs: 5, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        })
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'done',
              toolCalls: [],
              model: 'test-model', provider: 'openai', tokensUsed: 5, latencyMs: 3, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        });

      const onToolResultTruncated = vi.fn();

      const result = await runStructuredToolLoop({
        providerConfig: { provider: 'openai', model: 'test-model', maxTokens: 128, timeoutMs: 1_000 },
        requestBase: { maxTokens: 128, temperature: 0 },
        initialMessages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'list_positions', description: 'List positions', inputSchema: { type: 'object' } }],
        maxTurns: 5,
        toolResultFullRetentionTurns: 3,
        toolResultMaxStaleChars: 20,
        onToolResultTruncated,
        executeTool: async () => 'x'.repeat(100),
      });

      expect(result.ok).toBe(true);

      // Exactly one result ages past the window within this loop: call_1 at age 4.
      expect(onToolResultTruncated).toHaveBeenCalledTimes(1);
      expect(onToolResultTruncated).toHaveBeenCalledWith({
        turnIndex: 4,
        toolName: 'list_positions',
        toolCallId: 'call_1',
        // originalChars is the FULL pre-slice length; retainedChars is the configured cap.
        originalChars: 100,
        retainedChars: 20,
        ageTurns: 4,
      });
    });

    it('does not notify onToolResultTruncated for results within the retention window', async () => {
      // retentionTurns=3 with one tool-producing turn (call_1) plus the final done turn:
      // no result ever reaches age > 3, so nothing is truncated and the callback must not fire.
      vi.mocked(callLlmWithRetry)
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'check 1',
              toolCalls: [{ id: 'call_1', name: 'list_positions', args: {} }],
              model: 'test-model', provider: 'openai', tokensUsed: 10, latencyMs: 5, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        })
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'done',
              toolCalls: [],
              model: 'test-model', provider: 'openai', tokensUsed: 5, latencyMs: 3, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        });

      const onToolResultTruncated = vi.fn();

      const result = await runStructuredToolLoop({
        providerConfig: { provider: 'openai', model: 'test-model', maxTokens: 128, timeoutMs: 1_000 },
        requestBase: { maxTokens: 128, temperature: 0 },
        initialMessages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'list_positions', description: 'List positions', inputSchema: { type: 'object' } }],
        maxTurns: 5,
        toolResultFullRetentionTurns: 3,
        toolResultMaxStaleChars: 20,
        onToolResultTruncated,
        executeTool: async () => 'x'.repeat(100),
      });

      expect(result.ok).toBe(true);
      expect(onToolResultTruncated).not.toHaveBeenCalled();
    });

    it('does not notify onToolResultTruncated for pinned durable tool results', async () => {
      // retentionTurns=3, maxStaleChars=20. The read_skill result (durable, pinned) ages to 5
      // but must survive intact; only the non-durable list_positions results truncate.
      const toolTurn = (id: string, name: string) => ({
        result: {
          ok: true as const,
          data: {
            content: `calling ${name}`,
            toolCalls: [{ id, name, args: {} }],
            model: 'test-model', provider: 'openai' as const, tokensUsed: 10, latencyMs: 5, cached: false,
          },
        },
        attempts: 1, delaysMs: [],
      });

      vi.mocked(callLlmWithRetry)
        .mockResolvedValueOnce(toolTurn('call_1', 'read_skill'))
        .mockResolvedValueOnce(toolTurn('call_2', 'list_positions'))
        .mockResolvedValueOnce(toolTurn('call_3', 'list_positions'))
        .mockResolvedValueOnce(toolTurn('call_4', 'list_positions'))
        .mockResolvedValueOnce(toolTurn('call_5', 'list_positions'))
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'done',
              toolCalls: [],
              model: 'test-model', provider: 'openai', tokensUsed: 5, latencyMs: 3, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        });

      const onToolResultTruncated = vi.fn();

      const result = await runStructuredToolLoop({
        providerConfig: { provider: 'openai', model: 'test-model', maxTokens: 128, timeoutMs: 1_000 },
        requestBase: { maxTokens: 128, temperature: 0 },
        initialMessages: [{ role: 'user', content: 'hello' }],
        tools: [
          { name: 'read_skill', description: 'Read a skill', inputSchema: { type: 'object' } },
          { name: 'list_positions', description: 'List positions', inputSchema: { type: 'object' } },
        ],
        maxTurns: 6,
        toolResultFullRetentionTurns: 3,
        toolResultMaxStaleChars: 20,
        onToolResultTruncated,
        executeTool: async (toolCall) => (toolCall.name === 'read_skill' ? 's'.repeat(15_000) : 'x'.repeat(100)),
      });

      expect(result.ok).toBe(true);

      // The durable read_skill result must never be reported as truncated.
      const reportedCallIds = onToolResultTruncated.mock.calls.map((args) => (args[0] as { toolCallId: string }).toolCallId);
      expect(reportedCallIds).not.toContain('call_1');
      for (const args of onToolResultTruncated.mock.calls) {
        expect((args[0] as { toolName: string | undefined }).toolName).not.toBe('read_skill');
      }
      // Positive guard: the first non-durable list_positions result (call_2, age 4 at loop end)
      // DID truncate, so the callback must still fire for it. This catches a regression where
      // the pin exemption silently suppresses the callback for every result.
      expect(reportedCallIds).toContain('call_2');
    });

    it('does not notify when an aged result is under the stale-char limit', async () => {
      // retentionTurns=3, maxStaleChars=20. The first result ages to 4 (past the window) but is
      // only 10 chars, under the cap, so it is not truncated and the callback must not fire.
      vi.mocked(callLlmWithRetry)
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'check 1',
              toolCalls: [{ id: 'call_1', name: 'list_positions', args: {} }],
              model: 'test-model', provider: 'openai', tokensUsed: 10, latencyMs: 5, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        })
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'check 2',
              toolCalls: [{ id: 'call_2', name: 'list_positions', args: {} }],
              model: 'test-model', provider: 'openai', tokensUsed: 10, latencyMs: 5, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        })
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'check 3',
              toolCalls: [{ id: 'call_3', name: 'list_positions', args: {} }],
              model: 'test-model', provider: 'openai', tokensUsed: 10, latencyMs: 5, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        })
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'check 4',
              toolCalls: [{ id: 'call_4', name: 'list_positions', args: {} }],
              model: 'test-model', provider: 'openai', tokensUsed: 10, latencyMs: 5, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        })
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'done',
              toolCalls: [],
              model: 'test-model', provider: 'openai', tokensUsed: 5, latencyMs: 3, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        });

      const onToolResultTruncated = vi.fn();

      const result = await runStructuredToolLoop({
        providerConfig: { provider: 'openai', model: 'test-model', maxTokens: 128, timeoutMs: 1_000 },
        requestBase: { maxTokens: 128, temperature: 0 },
        initialMessages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'list_positions', description: 'List positions', inputSchema: { type: 'object' } }],
        maxTurns: 5,
        toolResultFullRetentionTurns: 3,
        toolResultMaxStaleChars: 20,
        onToolResultTruncated,
        executeTool: async () => 'x'.repeat(10),
      });

      expect(result.ok).toBe(true);
      expect(onToolResultTruncated).not.toHaveBeenCalled();
    });

    it('truncates and reports a stale result at most once across many subsequent turns', async () => {
      // Idempotency guard. retentionTurns=3, maxStaleChars=20. call_1 is added at turn 0 and
      // ages past the window at turn 4, where it truncates. The loop then continues for several
      // more turns (maxTurns=9) with call_1 still in the message list. Because post-truncation
      // content (maxStaleChars + '...[truncated]') stays longer than maxStaleChars, a naive gate
      // would re-enter the block every turn, re-firing the callback and re-slicing. It must fire
      // EXACTLY ONCE and leave the content as the single-truncation result.
      const toolTurn = (id: string) => ({
        result: {
          ok: true as const,
          data: {
            content: 'calling list_positions',
            toolCalls: [{ id, name: 'list_positions', args: {} }],
            model: 'test-model', provider: 'openai' as const, tokensUsed: 10, latencyMs: 5, cached: false,
          },
        },
        attempts: 1, delaysMs: [],
      });

      vi.mocked(callLlmWithRetry)
        .mockResolvedValueOnce(toolTurn('call_1'))
        .mockResolvedValueOnce(toolTurn('call_2'))
        .mockResolvedValueOnce(toolTurn('call_3'))
        .mockResolvedValueOnce(toolTurn('call_4'))
        .mockResolvedValueOnce(toolTurn('call_5'))
        .mockResolvedValueOnce(toolTurn('call_6'))
        .mockResolvedValueOnce(toolTurn('call_7'))
        .mockResolvedValueOnce(toolTurn('call_8'))
        .mockResolvedValueOnce({
          result: {
            ok: true,
            data: {
              content: 'done',
              toolCalls: [],
              model: 'test-model', provider: 'openai', tokensUsed: 5, latencyMs: 3, cached: false,
            },
          },
          attempts: 1, delaysMs: [],
        });

      const onToolResultTruncated = vi.fn();

      const result = await runStructuredToolLoop({
        providerConfig: { provider: 'openai', model: 'test-model', maxTokens: 128, timeoutMs: 1_000 },
        requestBase: { maxTokens: 128, temperature: 0 },
        initialMessages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'list_positions', description: 'List positions', inputSchema: { type: 'object' } }],
        maxTurns: 9,
        toolResultFullRetentionTurns: 3,
        toolResultMaxStaleChars: 20,
        onToolResultTruncated,
        executeTool: async () => 'x'.repeat(100),
      });

      expect(result.ok).toBe(true);

      // call_1 ages past the window at turn 4 and stays in the list through turns 5-8.
      // It must be reported exactly once despite the extra turns.
      const call1Reports = onToolResultTruncated.mock.calls.filter(
        (args) => (args[0] as { toolCallId: string }).toolCallId === 'call_1',
      );
      expect(call1Reports).toHaveLength(1);
      expect(call1Reports[0]![0]).toEqual({
        turnIndex: 4,
        toolName: 'list_positions',
        toolCallId: 'call_1',
        originalChars: 100,
        retainedChars: 20,
        ageTurns: 4,
      });

      // The stored content is the single-truncation result: sliced to the cap once with one
      // marker — not doubly-marked and not re-sliced to something shorter.
      const callArgs = vi.mocked(callLlmWithRetry).mock.calls;
      const messages = (callArgs[0]![1] as { messages: Array<{ role: string; content: string; toolCallId?: string }> }).messages;
      const call1Msg = messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_1');
      expect(call1Msg!.content).toBe('x'.repeat(20) + '...[truncated]');
    });
  });
});

describe('DURABLE_TOOL_NAMES drift guard', () => {
  // If a durable tool is renamed in the tool registry without updating this set,
  // the pin exemption silently goes stale and the stale-result truncation bug returns.
  it('every durable tool name is a known registered agent tool', () => {
    for (const name of DURABLE_TOOL_NAMES) {
      expect(isKnownAgentToolName(name), `"${name}" is not a registered agent tool name`).toBe(true);
    }
  });
});
