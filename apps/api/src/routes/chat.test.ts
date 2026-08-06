import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';
import type { ProvidersYaml } from '@herobids/domain';
import { chatRoutes, executeChatAction, invokeOnboardingLlm, buildCreateAgentPayload, synthesizePrompt } from './chat.js';
import type { LlmToolCall } from '@herobids/llm';

const TEST_USER_ID = 'user-1';

// Mock @herobids/llm so the module can be imported in the test environment.
vi.mock('@herobids/llm', () => ({
  callLlmProvider: vi.fn(),
}));

const { callLlmProvider } = await import('@herobids/llm');
const callMock = vi.mocked(callLlmProvider);

const EMPTY_PROVIDERS_YAML: ProvidersYaml = { providers: {} };

const LLM_CONFIG = {
  provider: 'openai',
  model: 'gpt-4o',
  maxTokens: 4096,
  timeoutMs: 60_000,
  tickIntervalMs: 900_000,
  heartbeatIntervalMs: 5_000,
};

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
  });
}

function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'offset', 'innerJoin']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

function buildMockDb(overrides: Partial<Record<string, unknown>> = {}) {
  const state: Record<string, unknown> = {
    threadRows: [],
    messageRows: [],
    connectionRows: [],
    updateSets: [] as Record<string, unknown>[],
    insertedMessages: [] as Record<string, unknown>[],
    ...overrides,
  };

  // getThreadWithMessages issues two selects in order: thread, then messages.
  // The action-result route issues: thread select, then (for connectionId) a
  // connection select. We route by call order via a simple counter.
  let selectCallCount = 0;

  const db = {
    select: vi.fn().mockImplementation((_cols?: unknown) => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => {
        const fromChain: Record<string, unknown> = {};
        fromChain.where = vi.fn(() => {
          const terminal = () => {
            selectCallCount++;
            if (selectCallCount === 1) return state.threadRows;
            if (selectCallCount === 2) return state.messageRows;
            return state.connectionRows;
          };
          const resultChain: Record<string, unknown> = {};
          resultChain.limit = vi.fn(terminal);
          resultChain.orderBy = vi.fn(terminal);
          return resultChain;
        });
        return fromChain;
      });
      return chain;
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        state.insertedMessages.push(v);
        return Promise.resolve();
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((set: Record<string, unknown>) => {
        state.updateSets.push(set);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
    transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };

  return { db: db as unknown as Database, state };
}

function makeToolCall(name: string, args: Record<string, unknown> = {}): LlmToolCall {
  return { id: `tc-${name}`, name, args };
}

beforeEach(() => {
  callMock.mockReset();
});

// ── executeChatAction: request_connection_form ──────────────────────────────

describe('executeChatAction — request_connection_form', () => {
  it('returns normalized form-request JSON with optional provider hints', async () => {
    const { db } = buildMockDb();
    const result = await executeChatAction(
      makeToolCall('request_connection_form', { preferredCapability: 'email', preferredProvider: 'gmail' }),
      db,
      TEST_USER_ID,
      EMPTY_PROVIDERS_YAML,
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.form).toBe('connection');
    expect(parsed.preferredCapability).toBe('email');
    expect(parsed.preferredProvider).toBe('gmail');
  });

  it('drops a preferredProvider that is not in the provider catalog', async () => {
    const { db } = buildMockDb();
    const result = await executeChatAction(
      makeToolCall('request_connection_form', { preferredProvider: 'hallucinated-provider' }),
      db,
      TEST_USER_ID,
      EMPTY_PROVIDERS_YAML,
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.preferredProvider).toBeNull();
  });

  it('defaults hints to null when absent', async () => {
    const { db } = buildMockDb();
    const result = await executeChatAction(
      makeToolCall('request_connection_form', {}),
      db,
      TEST_USER_ID,
      EMPTY_PROVIDERS_YAML,
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.preferredCapability).toBeNull();
    expect(parsed.preferredProvider).toBeNull();
  });
});

// ── invokeOnboardingLlm: form action emission ───────────────────────────────

describe('invokeOnboardingLlm — form action emission', () => {
  it('emits a form action only when request_connection_form is called', async () => {
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: '',
        toolCalls: [makeToolCall('request_connection_form', { preferredCapability: 'email' })],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never).mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Please connect your email provider.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();
    const result = await invokeOnboardingLlm(LLM_CONFIG, EMPTY_PROVIDERS_YAML, db, TEST_USER_ID, [], null);

    expect(result.actions).toBeDefined();
    expect(result.actions!.length).toBe(1);
    expect(result.actions![0]!.type).toBe('form');
    expect(result.actions![0]!.form).toBe('connection');
    expect(result.actions![0]!.props).toEqual({ preferredCapability: 'email' });
  });

  it('deduplicates multiple request_connection_form calls in one turn', async () => {
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: '',
        toolCalls: [
          makeToolCall('request_connection_form', { preferredCapability: 'trading' }),
          makeToolCall('request_connection_form', { preferredCapability: 'email' }),
        ],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never).mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Please connect a provider.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();
    const result = await invokeOnboardingLlm(LLM_CONFIG, EMPTY_PROVIDERS_YAML, db, TEST_USER_ID, [], null);

    expect(result.actions!.length).toBe(1);
  });

  it('does not emit a form action from list_compatible_connections', async () => {
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: '',
        toolCalls: [makeToolCall('list_compatible_connections', {})],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never).mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'No connections found.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();
    const result = await invokeOnboardingLlm(LLM_CONFIG, EMPTY_PROVIDERS_YAML, db, TEST_USER_ID, [], null);

    // No form action is emitted from list_compatible_connections.
    expect(result.actions).toEqual([]);
  });
});

// ── invokeOnboardingLlm: resume events ──────────────────────────────────────

describe('invokeOnboardingLlm — resume events', () => {
  it('appends explicit resume instructions and a transient event message for connection_linked', async () => {
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Your Gmail is linked. What should your assistant do?',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();
    const result = await invokeOnboardingLlm(
      LLM_CONFIG,
      EMPTY_PROVIDERS_YAML,
      db,
      TEST_USER_ID,
      [],
      { summary: { step: 'connection_linked', connectionIds: ['conn-1'] } },
      { kind: 'connection_linked', connectionId: 'conn-1', providerHint: 'gmail', actionContext: 'guided_setup_connection' },
    );

    expect(result.content).toContain('Gmail is linked');

    // The system prompt must contain the explicit resume-event block, not just
    // the summary.step value.
    const systemMessage = callMock.mock.calls[0]![1]!.messages[0] as { role: string; content: string };
    expect(systemMessage.role).toBe('system');
    expect(systemMessage.content).toContain('## Resume Event');
    expect(systemMessage.content).toContain('linked successfully during Guided Setup');
    expect(systemMessage.content).toContain('gmail');

    // A transient user-like event message must be appended so the model responds
    // to a fresh event rather than its own earlier assistant text.
    const lastMessage = callMock.mock.calls[0]![1]!.messages.at(-1) as { role: string; content: string };
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toContain('System event:');
    expect(lastMessage.content).toContain('Continue the Guided Setup flow');
  });

  it('emits a Guided Setup-specific fallback on empty content during connection_linked resume', async () => {
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: '',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();
    const result = await invokeOnboardingLlm(
      LLM_CONFIG,
      EMPTY_PROVIDERS_YAML,
      db,
      TEST_USER_ID,
      [],
      { summary: { step: 'connection_linked' } },
      { kind: 'connection_linked', connectionId: 'conn-1', providerHint: 'gmail' },
    );

    expect(result.content).not.toContain('I understand. How can I help you further');
    expect(result.content).toContain('connection is linked and ready');
  });

  it('keeps the generic fallback for a normal non-resume turn with empty content', async () => {
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: '',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();
    const result = await invokeOnboardingLlm(LLM_CONFIG, EMPTY_PROVIDERS_YAML, db, TEST_USER_ID, [], null);

    expect(result.content).toBe('I understand. How can I help you further with setting up your agent?');
  });

  it('emits a cancellation-aware fallback on empty content during connection_form_cancelled resume', async () => {
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: '',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();
    const result = await invokeOnboardingLlm(
      LLM_CONFIG,
      EMPTY_PROVIDERS_YAML,
      db,
      TEST_USER_ID,
      [],
      { summary: { step: 'connection_form_cancelled' } },
      { kind: 'connection_form_cancelled' },
    );

    expect(result.content).not.toContain('I understand. How can I help you further');
    expect(result.content).toContain('continue without a new connection');
  });

  it('does not emit a connection-form action on a connection_linked resume', async () => {
    // The model returns no tool calls — it should not re-request the form.
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Your connection is ready. What next?',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();
    const result = await invokeOnboardingLlm(
      LLM_CONFIG,
      EMPTY_PROVIDERS_YAML,
      db,
      TEST_USER_ID,
      [],
      { summary: { step: 'connection_linked', connectionIds: ['conn-1'] } },
      { kind: 'connection_linked', connectionId: 'conn-1', providerHint: 'gmail' },
    );

    expect(result.actions).toEqual([]);
  });
});

// ── buildCreateAgentPayload: non-trading payload contract ───────────────────

describe('buildCreateAgentPayload — non-trading payload contract', () => {
  it('omits trading-only fields for personal-assistant', () => {
    const payload = buildCreateAgentPayload({ skillPresetId: 'personal-assistant' }, TEST_USER_ID);
    expect(payload.capital).toBeUndefined();
    expect(payload.strategyPreset).toBeUndefined();
    expect(payload.strategy).toBeUndefined();
    expect(payload.executionDefaults).toBeUndefined();
    expect(payload.connectionIds).toBeUndefined();
    expect(payload.capabilityMode).toBe('intelligence');
  });

  it('omits trading-only fields for custom', () => {
    const payload = buildCreateAgentPayload({ skillPresetId: 'custom' }, TEST_USER_ID);
    expect(payload.capital).toBeUndefined();
    expect(payload.strategyPreset).toBeUndefined();
    expect(payload.strategy).toBeUndefined();
    expect(payload.executionDefaults).toBeUndefined();
  });

  it('includes trading-only fields for trading-capable presets', () => {
    const payload = buildCreateAgentPayload({ skillPresetId: 'trading', capital: '1000' }, TEST_USER_ID);
    expect(payload.capital).toBe('1000');
    expect(payload.strategyPreset).toBe('momentum');
    expect(payload.strategy).toEqual({ type: 'momentum', decisionMode: 'hybrid' });
    expect(payload.executionDefaults).toBeDefined();
    expect(payload.capabilityMode).toBe('hybrid');
  });

  it('includes connectionIds only when a connection is selected', () => {
    const withConn = buildCreateAgentPayload({ skillPresetId: 'trading', capital: '1000', selectedConnectionId: 'conn-1' }, TEST_USER_ID);
    expect(withConn.connectionIds).toEqual(['conn-1']);

    const withoutConn = buildCreateAgentPayload({ skillPresetId: 'trading', capital: '1000' }, TEST_USER_ID);
    expect(withoutConn.connectionIds).toBeUndefined();
  });
});

// ── synthesizePrompt: no undefined when capital absent ──────────────────────

describe('synthesizePrompt — capital handling', () => {
  it('produces no undefined when capital is absent for trading', () => {
    const prompt = synthesizePrompt(undefined, 'trading', undefined);
    expect(prompt).not.toContain('undefined');
    expect(prompt).toBe('Grow this portfolio');
  });

  it('includes the allocation clause when capital is present', () => {
    const prompt = synthesizePrompt(undefined, 'trading', '5000');
    expect(prompt).toBe('Grow this portfolio with 5000 USDC allocation');
  });

  it('keeps personal-assistant branch capital-free', () => {
    const prompt = synthesizePrompt(undefined, 'personal-assistant', undefined);
    expect(prompt).not.toContain('undefined');
    expect(prompt).toBe('Assist with daily tasks and information retrieval');
  });

  it('keeps custom branch capital-free', () => {
    const prompt = synthesizePrompt(undefined, 'custom', undefined);
    expect(prompt).not.toContain('undefined');
  });
});

// ── POST /chat/threads/:id/actions/:actionId ────────────────────────────────

describe('POST /chat/threads/:id/actions/:actionId', () => {
  async function buildAppWithThread(overrides: Partial<Record<string, unknown>> = {}) {
    const { db, state } = buildMockDb(overrides);
    const app = Fastify({ logger: false });
    decorateWithAuth(app);
    await chatRoutes(app, db, LLM_CONFIG, EMPTY_PROVIDERS_YAML, {} as Redis);
    await app.ready();
    return { app, db, state };
  }

  it('accepts cancellation without an API error and resumes the flow', async () => {
    const { app, state } = await buildAppWithThread({
      threadRows: [{
        id: 'thread-1',
        userId: TEST_USER_ID,
        title: 'Guided Setup',
        metadata: { summary: { step: 'conversation' } },
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      messageRows: [],
    });

    // Resume LLM returns a plain response (no re-open of the form).
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'No problem — we can continue without a connection, or reuse an existing one.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/actions/action-1',
      payload: { result: { cancelled: true } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.acknowledged).toBe(true);
    expect(body.message.content).toContain('No problem');

    // Metadata records the cancellation step.
    const updateSet = state.updateSets[0] as Record<string, unknown>;
    const metadata = updateSet['metadata'] as { summary?: { step?: string } };
    expect(metadata.summary?.step).toBe('connection_form_cancelled');
  });

  it('validates owned active connectionId and rejects another user\'s connection', async () => {
    const { app } = await buildAppWithThread({
      threadRows: [{
        id: 'thread-1',
        userId: TEST_USER_ID,
        title: 'Guided Setup',
        metadata: { summary: { step: 'conversation' } },
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      messageRows: [],
      // The connection belongs to another user, so the ownership-filtered
      // query (userId = TEST_USER_ID) returns no rows.
      connectionRows: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/actions/action-1',
      payload: { result: { connectionId: 'conn-other' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_connection');
  });

  it('deduplicates connectionIds and resumes the flow', async () => {
    const { app, state } = await buildAppWithThread({
      threadRows: [{
        id: 'thread-1',
        userId: TEST_USER_ID,
        title: 'Guided Setup',
        metadata: { summary: { step: 'conversation', connectionIds: ['conn-1'] } },
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      messageRows: [],
      connectionRows: [{ id: 'conn-1', userId: TEST_USER_ID, status: 'active' }],
    });

    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Great, your connection is linked. How much capital?',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/actions/action-1',
      payload: { result: { connectionId: 'conn-1' } },
    });

    expect(res.statusCode).toBe(200);
    const updateSet = state.updateSets[0] as Record<string, unknown>;
    const metadata = updateSet['metadata'] as { summary?: { connectionIds?: string[] } };
    // Deduplicated — still one entry.
    expect(metadata.summary?.connectionIds).toEqual(['conn-1']);
  });

  it('is idempotent for the same actionId — no duplicate resume or message', async () => {
    const { app, state } = await buildAppWithThread({
      threadRows: [{
        id: 'thread-1',
        userId: TEST_USER_ID,
        title: 'Guided Setup',
        metadata: { summary: { step: 'connection_linked' }, processedActionIds: ['action-1'] },
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      messageRows: [],
      connectionRows: [{ id: 'conn-1', userId: TEST_USER_ID, status: 'active' }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/actions/action-1',
      payload: { result: { connectionId: 'conn-1' } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.alreadyProcessed).toBe(true);
    expect(body.message).toBeNull();
    // No LLM call, no new message persisted.
    expect(callMock).not.toHaveBeenCalled();
    expect(state.insertedMessages.length).toBe(0);
  });

  it('passes a connection_linked resume event after a valid linked connection', async () => {
    const { app } = await buildAppWithThread({
      threadRows: [{
        id: 'thread-1',
        userId: TEST_USER_ID,
        title: 'Guided Setup',
        metadata: { summary: { step: 'conversation' } },
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      messageRows: [],
      connectionRows: [{ id: 'conn-1', userId: TEST_USER_ID, status: 'active', provider: 'gmail' }],
    });

    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Your Gmail is linked. What should your assistant do?',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/actions/action-1',
      payload: { result: { connectionId: 'conn-1' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().message.content).toContain('Gmail is linked');

    // The resumed LLM call must carry the explicit connection_linked resume event.
    const systemMessage = callMock.mock.calls[0]![1]!.messages[0] as { role: string; content: string };
    expect(systemMessage.content).toContain('## Resume Event');
    expect(systemMessage.content).toContain('linked successfully during Guided Setup');
    expect(systemMessage.content).toContain('gmail');
  });

  it('passes a connection_form_cancelled resume event after { cancelled: true }', async () => {
    const { app } = await buildAppWithThread({
      threadRows: [{
        id: 'thread-1',
        userId: TEST_USER_ID,
        title: 'Guided Setup',
        metadata: { summary: { step: 'conversation' } },
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      messageRows: [],
    });

    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'No problem — we can continue without a connection.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/actions/action-1',
      payload: { result: { cancelled: true } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().message.content).toContain('No problem');

    const systemMessage = callMock.mock.calls[0]![1]!.messages[0] as { role: string; content: string };
    expect(systemMessage.content).toContain('## Resume Event');
    expect(systemMessage.content).toContain('dismissed the provider connection form');
  });

  it('preserves preset context across a personal-assistant resume', async () => {
    const { app } = await buildAppWithThread({
      threadRows: [{
        id: 'thread-1',
        userId: TEST_USER_ID,
        title: 'Guided Setup',
        metadata: { summary: { step: 'connection_linked', preset: 'personal-assistant', connectionIds: ['conn-1'] } },
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      messageRows: [],
      connectionRows: [{ id: 'conn-1', userId: TEST_USER_ID, status: 'active', provider: 'gmail' }],
    });

    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Your Gmail is linked. What should your assistant do?',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/actions/action-1',
      payload: { result: { connectionId: 'conn-1' } },
    });

    expect(res.statusCode).toBe(200);

    // The summary block must retain the personal-assistant preset across resume.
    const systemMessage = callMock.mock.calls[0]![1]!.messages[0] as { role: string; content: string };
    expect(systemMessage.content).toContain('personal-assistant');
    expect(systemMessage.content).toContain('connection_linked');
  });
});

// ── POST /chat/threads/:id/messages — preset persistence ────────────────────

describe('POST /chat/threads/:id/messages — preset persistence', () => {
  async function buildAppWithThread(overrides: Partial<Record<string, unknown>> = {}) {
    const { db, state } = buildMockDb(overrides);
    const app = Fastify({ logger: false });
    decorateWithAuth(app);
    await chatRoutes(app, db, LLM_CONFIG, EMPTY_PROVIDERS_YAML, {} as Redis);
    await app.ready();
    return { app, db, state };
  }

  function mockPlainResponse() {
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Got it — let\'s set up your personal assistant.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);
  }

  function threadRow(metadata: Record<string, unknown>) {
    return [{
      id: 'thread-1',
      userId: TEST_USER_ID,
      title: 'Guided Setup',
      metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    }];
  }

  it('persists summary.preset when the user selects a known quick-reply preset', async () => {
    const { app, state } = await buildAppWithThread({
      threadRows: threadRow({ summary: { step: 'conversation' } }),
      messageRows: [],
    });

    mockPlainResponse();

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/messages',
      payload: { content: 'preset:personal-assistant' },
    });

    expect(res.statusCode).toBe(200);

    const updateSet = state.updateSets[0] as Record<string, unknown>;
    const metadata = updateSet['metadata'] as { summary?: { preset?: string } };
    expect(metadata.summary?.preset).toBe('personal-assistant');
  });

  it('does not persist a preset when free text merely mentions a preset token', async () => {
    const { app, state } = await buildAppWithThread({
      threadRows: threadRow({ summary: { step: 'conversation' } }),
      messageRows: [],
    });

    mockPlainResponse();

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/messages',
      payload: { content: 'I don\'t want the preset:custom option' },
    });

    expect(res.statusCode).toBe(200);

    const updateSet = state.updateSets[0] as Record<string, unknown>;
    const metadata = updateSet['metadata'] as { summary?: { preset?: string } };
    expect(metadata.summary?.preset).toBeUndefined();
  });
});
