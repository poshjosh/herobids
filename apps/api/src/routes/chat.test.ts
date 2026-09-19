import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { Database, UsageBillingRepository } from '@herobids/db';
import { ChatUsageBillingRecorder } from '../billing/chat-usage-billing-recorder.js';
import type { Redis } from 'ioredis';
import type { ProvidersYaml } from '@herobids/domain';
import { chatRoutes, executeChatAction, invokeOnboardingLlm, synthesizePrompt, resolveCreateAgentConnection, buildSystemPrompt, buildTradingPrompt, buildConnectionChoiceActions, buildBaseHeader, buildBasePrompt, buildPersonalAssistantPrompt, buildCustomPrompt } from './chat.js';
import type { LlmToolCall } from '@herobids/llm';

vi.mock('../agents/trading-profile-reconciliation-adapter.js', () => ({
  reconcileTradingProfile: vi.fn().mockResolvedValue({
    upserts: [], clears: [], selectedBinding: { previous: null, next: null }, inverseActions: [],
  }),
}));

import { reconcileTradingProfile } from '../agents/trading-profile-reconciliation-adapter.js';

// Mock createProviderLink to avoid needing CREDENTIAL_ENCRYPTION_KEY in tests
vi.mock('./setup.js', () => ({
  createProviderLink: vi.fn(),
}));

const { createProviderLink } = await import('./setup.js');
const createProviderLinkMock = vi.mocked(createProviderLink);

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

function makeMockRecorder() {
  const record = vi.fn().mockResolvedValue(undefined);
  const recorder = { record } as unknown as ChatUsageBillingRecorder;
  return { recorder, record };
}

async function buildAppWithRecorder(overrides: Partial<Record<string, unknown>> = {}) {
  const { db, state } = buildMockDb(overrides);
  const app = Fastify({ logger: false });
  decorateWithAuth(app);
  const { recorder, record } = makeMockRecorder();
  await chatRoutes(
    app, db, LLM_CONFIG, EMPTY_PROVIDERS_YAML, {} as Redis,
    undefined, // usageBillingRepo (not needed for metering tests)
    recorder,  // chatUsageBillingRecorder
  );
  await app.ready();
  return { app, db, state, recorder, record };
}

beforeEach(() => {
  callMock.mockReset();
  createProviderLinkMock.mockReset();
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
    const eventMessage = callMock.mock.calls[0]![1]!.messages.at(-2) as { role: string; content: string };
    expect(eventMessage.role).toBe('user');
    expect(eventMessage.content).toContain('System event:');
    expect(eventMessage.content).toContain('Continue the Guided Setup flow');
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

// ── executeChatAction: list_available_skills ────────────────────────────────

describe('executeChatAction — list_available_skills', () => {
  it('returns skills from the database when published skills exist', async () => {
    const { db } = buildMockDb();

    // Override the select mock to handle the skills query chain:
    // db.select(...).from(skills).where(...).orderBy(...).limit(50)
    db.select = vi.fn().mockImplementation((_cols?: unknown) => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'trading', name: 'Trading', description: 'Trade crypto', capabilityFamilies: ['trading'] },
              { id: 'email', name: 'Email', description: 'Send emails', capabilityFamilies: ['communication'] },
            ]),
          }),
        }),
      });
      return chain;
    });

    const result = await executeChatAction(
      makeToolCall('list_available_skills'),
      db,
      TEST_USER_ID,
      EMPTY_PROVIDERS_YAML,
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.skills).toBeDefined();
    expect(Array.isArray(parsed.skills)).toBe(true);
    expect((parsed.skills as Array<Record<string, unknown>>).length).toBe(2);
    expect((parsed.skills as Array<Record<string, unknown>>)[0]!.id).toBe('trading');
    expect((parsed.skills as Array<Record<string, unknown>>)[0]!.name).toBe('Trading');
    expect((parsed.skills as Array<Record<string, unknown>>)[0]!.capabilityFamilies).toEqual(['trading']);
  });

  it('returns empty skills array on error', async () => {
    const { db } = buildMockDb();
    db.select = vi.fn().mockImplementation(() => {
      throw new Error('DB error');
    });

    const result = await executeChatAction(
      makeToolCall('list_available_skills'),
      db,
      TEST_USER_ID,
      EMPTY_PROVIDERS_YAML,
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.skills).toEqual([]);
    expect(parsed.message).toBe('Could not retrieve available skills.');
  });

  it('returns empty skills array when no published skills exist', async () => {
    const { db } = buildMockDb();
    db.select = vi.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });
      return chain;
    });

    const result = await executeChatAction(
      makeToolCall('list_available_skills'),
      db,
      TEST_USER_ID,
      EMPTY_PROVIDERS_YAML,
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.skills).toEqual([]);
    expect(parsed.message).toContain('No skills');
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

// ── executeChatAction: create_agent billing gate ────────────────────────────

describe('executeChatAction — create_agent billing gate', () => {
  it('returns billing.top_up_required when canSpendNow returns canSpend: false', async () => {
    const { db } = buildMockDb();
    const mockGetAccountByUserId = vi.fn().mockResolvedValue({
      id: 'acct-1', ownerUserId: TEST_USER_ID, status: 'active', currency: 'USD',
      activePlanId: 'free', softCapMicrousd: null, hardCapMicrousd: 10000,
      lastEvaluatedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const mockCanSpendNow = vi.fn().mockResolvedValue({
      canSpend: false, availableMicrousd: 0, hardCapMicrousd: 10000, status: 'hard_limited', reason: 'hard_limited',
    });
    const mockUsageBillingRepo = {
      getAccountByUserId: mockGetAccountByUserId,
      canSpendNow: mockCanSpendNow,
    } as unknown as UsageBillingRepository;

    const result = await executeChatAction(
      makeToolCall('create_agent', { skillPresetId: 'custom' }),
      db,
      TEST_USER_ID,
      EMPTY_PROVIDERS_YAML,
      mockUsageBillingRepo,
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.error).toBe('billing.top_up_required');
    expect(mockGetAccountByUserId).toHaveBeenCalledWith(TEST_USER_ID);
    expect(mockCanSpendNow).toHaveBeenCalledWith('acct-1');
  });

  it('does not return billing error when canSpendNow returns canSpend: true', async () => {
    const { db } = buildMockDb();
    const mockUsageBillingRepo = {
      getAccountByUserId: vi.fn().mockResolvedValue({
        id: 'acct-1', ownerUserId: TEST_USER_ID, status: 'active', currency: 'USD',
        activePlanId: 'free', softCapMicrousd: null, hardCapMicrousd: 10000,
        lastEvaluatedAt: null, createdAt: new Date(), updatedAt: new Date(),
      }),
      canSpendNow: vi.fn().mockResolvedValue({
        canSpend: true, availableMicrousd: 5000, hardCapMicrousd: 10000, status: 'active', reason: 'ok',
      }),
    } as unknown as UsageBillingRepository;

    const result = await executeChatAction(
      makeToolCall('create_agent', { skillPresetId: 'custom' }),
      db,
      TEST_USER_ID,
      EMPTY_PROVIDERS_YAML,
      mockUsageBillingRepo,
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    // Must NOT be blocked by billing — the code proceeds past the gate.
    // The agent creation may fail on mock DB limitations, but the error
    // must not be billing.top_up_required.
    expect(parsed.error).not.toBe('billing.top_up_required');
  });

  it('does not block when getAccountByUserId returns null (fresh user, no billing account)', async () => {
    const { db } = buildMockDb();
    const mockUsageBillingRepo = {
      getAccountByUserId: vi.fn().mockResolvedValue(null),
      canSpendNow: vi.fn(),
    } as unknown as UsageBillingRepository;

    const result = await executeChatAction(
      makeToolCall('create_agent', { skillPresetId: 'custom' }),
      db,
      TEST_USER_ID,
      EMPTY_PROVIDERS_YAML,
      mockUsageBillingRepo,
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.error).not.toBe('billing.top_up_required');
    // canSpendNow must not be called when there is no billing account
    expect(mockUsageBillingRepo.canSpendNow).not.toHaveBeenCalled();
  });
});

// ── invokeOnboardingLlm: billing repo plumbing ──────────────────────────────

describe('invokeOnboardingLlm — billing repo plumbing', () => {
  it('passes usageBillingRepo through to executeChatAction (create_agent gate triggers)', async () => {
    const mockGetAccountByUserId = vi.fn().mockResolvedValue({
      id: 'acct-1', ownerUserId: TEST_USER_ID, status: 'active', currency: 'USD',
      activePlanId: 'free', softCapMicrousd: null, hardCapMicrousd: 10000,
      lastEvaluatedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const mockCanSpendNow = vi.fn().mockResolvedValue({
      canSpend: false, availableMicrousd: 0, hardCapMicrousd: 10000, status: 'hard_limited', reason: 'hard_limited',
    });
    const mockUsageBillingRepo = {
      getAccountByUserId: mockGetAccountByUserId,
      canSpendNow: mockCanSpendNow,
    } as unknown as UsageBillingRepository;

    // LLM returns create_agent, then a plain response.
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: '',
        toolCalls: [makeToolCall('create_agent', { skillPresetId: 'custom' })],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never).mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'You need to add credit first.',
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
      null,
      undefined,
      mockUsageBillingRepo,
    );

    // The billing gate should have been checked (plumbing works).
    expect(mockGetAccountByUserId).toHaveBeenCalledWith(TEST_USER_ID);
    expect(mockCanSpendNow).toHaveBeenCalledWith('acct-1');
    // The LLM response includes the fallback content from the second mock call.
    expect(result.content).toBe('You need to add credit first.');
  });
});

// ── Chat LLM Usage Metering ──────────────────────────────────────────────────

describe('Chat LLM Usage Metering', () => {
  it('records billing on message-send using userMsgId as anchor', async () => {
    const { app, record } = await buildAppWithRecorder({
      threadRows: [{
        id: 'thread-1', userId: TEST_USER_ID, title: 'Guided Setup',
        metadata: { summary: { step: 'conversation' } },
        createdAt: new Date(), updatedAt: new Date(),
      }],
      messageRows: [],
    });

    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Got it!', toolCalls: [],
        model: 'gpt-4o', provider: 'openai',
        inputTokens: 100, outputTokens: 50, thinkingTokens: 0,
        cachedInputTokens: 0, tokensUsed: 150,
        latencyMs: 10, cached: false,
      },
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/messages',
      payload: { content: 'Hello' },
    });

    expect(res.statusCode).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);
    const call = record.mock.calls[0]![0];
    expect(call.phase).toBe('message_send');
    expect(call.threadId).toBe('thread-1');
    expect(typeof call.billingAnchorId).toBe('string');
    expect(call.billingAnchorId).toBeTruthy();
    expect(call.usage.tokensUsed).toBe(150);
    expect(call.usage.inputTokens).toBe(100);
    expect(call.usage.outputTokens).toBe(50);
  });

  it('records billing on action-result using actionId as anchor', async () => {
    const { app, record } = await buildAppWithRecorder({
      threadRows: [{
        id: 'thread-1', userId: TEST_USER_ID, title: 'Guided Setup',
        metadata: { summary: { step: 'conversation' } },
        createdAt: new Date(), updatedAt: new Date(),
      }],
      messageRows: [],
      connectionRows: [{ id: 'conn-1', userId: TEST_USER_ID, status: 'active', provider: 'gmail' }],
    });

    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Your Gmail is linked!', toolCalls: [],
        model: 'gpt-4o', provider: 'openai',
        inputTokens: 200, outputTokens: 80, thinkingTokens: 0,
        cachedInputTokens: 0, tokensUsed: 280,
        latencyMs: 10, cached: false,
      },
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/actions/action-1',
      payload: { result: { connectionId: 'conn-1' } },
    });

    expect(res.statusCode).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);
    const call = record.mock.calls[0]![0];
    expect(call.phase).toBe('action_result');
    expect(call.billingAnchorId).toBe('action-1');
    expect(call.usage.tokensUsed).toBe(280);
  });

  it('records billing on the common no-tool-calls path', async () => {
    const { app, record } = await buildAppWithRecorder({
      threadRows: [{
        id: 'thread-1', userId: TEST_USER_ID, title: 'Guided Setup',
        metadata: { summary: { step: 'conversation' } },
        createdAt: new Date(), updatedAt: new Date(),
      }],
      messageRows: [],
    });

    // LLM responds with content but NO tool calls — this is the common path
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Sure, what kind of agent?', toolCalls: [],
        model: 'gpt-4o', provider: 'openai',
        inputTokens: 50, outputTokens: 30, thinkingTokens: 0,
        cachedInputTokens: 0, tokensUsed: 80,
        latencyMs: 10, cached: false,
      },
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/messages',
      payload: { content: 'I want a trading agent' },
    });

    expect(res.statusCode).toBe(200);
    // Should still record billing even on no-tool-calls path
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0].usage.tokensUsed).toBe(80);
  });

  it('records billing on exhausted-tool-loop final fallback path', async () => {
    const { app, record } = await buildAppWithRecorder({
      threadRows: [{
        id: 'thread-1', userId: TEST_USER_ID, title: 'Guided Setup',
        metadata: { summary: { step: 'conversation' } },
        createdAt: new Date(), updatedAt: new Date(),
      }],
      messageRows: [],
    });

    // First 5 calls (MAX_TOOL_ROUNDS) return tool calls
    for (let i = 0; i < 5; i++) {
      callMock.mockResolvedValueOnce({
        ok: true,
        data: {
          content: '', toolCalls: [makeToolCall('list_available_skills', {})],
          model: 'gpt-4o', provider: 'openai',
          inputTokens: 10, outputTokens: 5, thinkingTokens: 0,
          cachedInputTokens: 0, tokensUsed: 15,
          latencyMs: 10, cached: false,
        },
      } as never);
    }
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Final summary after exhausting tool rounds.',
        toolCalls: [],
        model: 'gpt-4o', provider: 'openai',
        inputTokens: 10, outputTokens: 20, thinkingTokens: 0,
        cachedInputTokens: 0, tokensUsed: 30,
        latencyMs: 10, cached: false,
      },
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/messages',
      payload: { content: 'Help me' },
    });

    expect(res.statusCode).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);
    // 5 tool rounds × 15 tokensUsed + 1 final call × 30 tokensUsed = 105
    expect(record.mock.calls[0]![0].usage.tokensUsed).toBe(105);
  });

  it('does not record billing when provider fails with no successful usage', async () => {
    const { app, record } = await buildAppWithRecorder({
      threadRows: [{
        id: 'thread-1', userId: TEST_USER_ID, title: 'Guided Setup',
        metadata: { summary: { step: 'conversation' } },
        createdAt: new Date(), updatedAt: new Date(),
      }],
      messageRows: [],
    });

    // Provider fails on first call — no successful usage accumulated
    callMock.mockResolvedValueOnce({
      ok: false,
      error: new Error('Provider timeout'),
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/messages',
      payload: { content: 'Hello' },
    });

    expect(res.statusCode).toBe(200); // still returns a response
    // No billing because tokensUsed = 0
    expect(record).not.toHaveBeenCalled();
  });

  it('does not block chat response when billing recorder fails', async () => {
    const { app, record } = await buildAppWithRecorder({
      threadRows: [{
        id: 'thread-1', userId: TEST_USER_ID, title: 'Guided Setup',
        metadata: { summary: { step: 'conversation' } },
        createdAt: new Date(), updatedAt: new Date(),
      }],
      messageRows: [],
    });

    // Make the recorder throw
    record.mockRejectedValue(new Error('DB connection lost'));

    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Got it!', toolCalls: [],
        model: 'gpt-4o', provider: 'openai',
        inputTokens: 100, outputTokens: 50, thinkingTokens: 0,
        cachedInputTokens: 0, tokensUsed: 150,
        latencyMs: 10, cached: false,
      },
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/messages',
      payload: { content: 'Hello' },
    });

    // Response still succeeds despite billing failure
    expect(res.statusCode).toBe(200);
    expect(res.json().message.content).toBe('Got it!');
    expect(record).toHaveBeenCalledTimes(1); // attempted, but failed
  });
});

// ── executeChatAction: create_connection ────────────────────────────────────

describe('executeChatAction — create_connection', () => {
  it('validates provider is required, label is optional', async () => {
    const { db } = buildMockDb();
    const result = await executeChatAction(
      makeToolCall('create_connection', { label: 'test' }),
      db,
      TEST_USER_ID,
      EMPTY_PROVIDERS_YAML,
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.error).toBe('validation_error');
    expect(parsed.message).toBe('provider is required.');
  });

  it('rejects non-generated credentialMode', async () => {
    const { db } = buildMockDb();
    const result = await executeChatAction(
      makeToolCall('create_connection', { provider: 'hyperliquid', label: 'test', credentialMode: 'manual' }),
      db,
      TEST_USER_ID,
      EMPTY_PROVIDERS_YAML,
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.error).toBe('validation_error');
    expect(parsed.message).toContain('only supports credentialMode: generated');
  });

  it('rejects unknown provider', async () => {
    const { db } = buildMockDb();
    const result = await executeChatAction(
      makeToolCall('create_connection', { provider: 'unknown-venue', label: 'test', capability: 'trading', credentialMode: 'generated' }),
      db,
      TEST_USER_ID,
      EMPTY_PROVIDERS_YAML,
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.error).toBe('validation_error');
    expect(parsed.message).toContain('Unknown or deprecated provider');
  });

  it('accepts minimal payload and derives label from provider registry', async () => {
    createProviderLinkMock.mockResolvedValueOnce({
      kind: 'ok',
      credentialId: 'cred-1',
      connectionId: 'conn-1',
      provider: 'hyperliquid',
      label: 'Hyperliquid Wallet',
      venueAccountId: 'va-1',
      wallet: null,
    } as never);

    const { db } = buildMockDb();

    // Override select to handle the user lookup query in create_connection
    db.select = vi.fn().mockImplementation((_cols?: unknown) => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => {
        const fromChain: Record<string, unknown> = {};
        fromChain.where = vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ planId: 'free', isAdmin: false }]),
        }));
        return fromChain;
      });
      return chain;
    });

    const result = await executeChatAction(
      makeToolCall('create_connection', { provider: 'hyperliquid', credentialMode: 'generated' }),
      db,
      TEST_USER_ID,
      EMPTY_PROVIDERS_YAML,
      undefined, // usageBillingRepo
      undefined, // modelDefaults
      undefined, // plansConfig
      undefined, // agentRiskDefaults
      { hyperliquid: { walletGeneration: { enabled: true } }, jupiter: {}, '1inch': {} },
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.success).toBe(true);
    expect(parsed.connectionId).toBe('conn-1');
    expect(parsed.label).toBe('Hyperliquid Wallet');

    // Verify the label was derived by the handler and passed to createProviderLink,
    // not just echoed back from the mock.
    expect(createProviderLinkMock).toHaveBeenCalledTimes(1);
    const callArgs = createProviderLinkMock.mock.calls[0]!;
    expect(callArgs[3]).toMatchObject({ label: 'Hyperliquid Wallet' });
  });
});

// ── executeChatAction: authorizationMode ────────────────────────────────────

describe('executeChatAction — authorizationMode', () => {
  it('accepts authorizationMode in create_agent Zod schema', async () => {
    // Import the schema directly to test validation without the full handler
    const { GuidedSetupCreateAgentInput } = await import('./chat.js');
    const parsed = GuidedSetupCreateAgentInput.safeParse({
      skillPresetId: 'direct-trading',
      capital: '1000',
      authorizationMode: 'approval_required',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.authorizationMode).toBe('approval_required');
    }
  });

  it('rejects invalid authorizationMode value', async () => {
    const { GuidedSetupCreateAgentInput } = await import('./chat.js');
    const parsed = GuidedSetupCreateAgentInput.safeParse({
      skillPresetId: 'direct-trading',
      authorizationMode: 'invalid_mode',
    });
    expect(parsed.success).toBe(false);
  });

  it('allows authorizationMode to be omitted', async () => {
    const { GuidedSetupCreateAgentInput } = await import('./chat.js');
    const parsed = GuidedSetupCreateAgentInput.safeParse({
      skillPresetId: 'direct-trading',
      capital: '500',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.authorizationMode).toBeUndefined();
    }
  });
});

// ── GuidedSetupCreateAgentInput: capital validation ─────────────────────────

describe('GuidedSetupCreateAgentInput — capital validation', () => {
  it('rejects non-numeric capital', async () => {
    const { GuidedSetupCreateAgentInput } = await import('./chat.js');
    const parsed = GuidedSetupCreateAgentInput.safeParse({
      skillPresetId: 'direct-trading',
      capital: 'ABC',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects negative capital', async () => {
    const { GuidedSetupCreateAgentInput } = await import('./chat.js');
    const parsed = GuidedSetupCreateAgentInput.safeParse({
      skillPresetId: 'direct-trading',
      capital: '-500',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects zero capital', async () => {
    const { GuidedSetupCreateAgentInput } = await import('./chat.js');
    const parsed = GuidedSetupCreateAgentInput.safeParse({
      skillPresetId: 'direct-trading',
      capital: '0',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts valid positive decimal capital', async () => {
    const { GuidedSetupCreateAgentInput } = await import('./chat.js');
    const parsed = GuidedSetupCreateAgentInput.safeParse({
      skillPresetId: 'direct-trading',
      capital: '1000',
    });
    expect(parsed.success).toBe(true);
  });

  it('allows capital to be omitted (optional for non-trading presets)', async () => {
    const { GuidedSetupCreateAgentInput } = await import('./chat.js');
    const parsed = GuidedSetupCreateAgentInput.safeParse({
      skillPresetId: 'personal-assistant',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects capital containing injection content', async () => {
    const { GuidedSetupCreateAgentInput } = await import('./chat.js');
    const parsed = GuidedSetupCreateAgentInput.safeParse({
      skillPresetId: 'direct-trading',
      capital: '0\n\n=== INJECTION ===',
    });
    expect(parsed.success).toBe(false);
  });
});

// ── invokeOnboardingLlm: wallet_created action emission ─────────────────────

describe('invokeOnboardingLlm — wallet_created action', () => {
  it('emits a wallet_created confirm action when create_connection returns wallet', async () => {
    createProviderLinkMock.mockResolvedValueOnce({
      kind: 'ok',
      credentialId: 'cred-1',
      connectionId: 'conn-1',
      provider: 'hyperliquid',
      label: 'My Trading Wallet',
      venueAccountId: 'va-1',
      wallet: {
        address: '0x1234abcd',
        network: 'Hyperliquid',
      },
    } as never);

    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: '',
        toolCalls: [makeToolCall('create_connection', {
          provider: 'hyperliquid',
          label: 'My Trading Wallet',
          capability: 'trading',
          credentialMode: 'generated',
        })],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never).mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Your Hyperliquid wallet has been created.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();

    // Mock DB for user lookup in create_connection handler
    db.select = vi.fn().mockImplementation((_cols?: unknown) => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => {
        const fromChain: Record<string, unknown> = {};
        fromChain.where = vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ planId: 'free', isAdmin: false }]),
        }));
        return fromChain;
      });
      return chain;
    });

    const result = await invokeOnboardingLlm(
      LLM_CONFIG,
      EMPTY_PROVIDERS_YAML,
      db,
      TEST_USER_ID,
      [],
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { hyperliquid: { walletGeneration: { enabled: true } }, jupiter: {}, '1inch': {} },
    );

    const walletActions = (result.actions ?? []).filter(
      (a) => a.type === 'confirm' && a.props && typeof a.props === 'object' && 'type' in a.props && a.props.type === 'wallet_created',
    );
    expect(walletActions.length).toBeGreaterThanOrEqual(1);
    expect(createProviderLinkMock).toHaveBeenCalledTimes(1);
  });

  it('does not emit wallet_created action when create_connection fails', async () => {
    createProviderLinkMock.mockResolvedValueOnce({
      kind: 'error',
      code: 'wallet_generation.disabled',
      message: 'Generated wallets are not currently available for provider hyperliquid.',
      params: { provider: 'hyperliquid' },
    } as never);

    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: '',
        toolCalls: [makeToolCall('create_connection', {
          provider: 'hyperliquid',
          label: 'Test',
          capability: 'trading',
          credentialMode: 'generated',
        })],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never).mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Sorry, wallet generation is disabled.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();
    db.select = vi.fn().mockImplementation((_cols?: unknown) => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => {
        const fromChain: Record<string, unknown> = {};
        fromChain.where = vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ planId: 'free', isAdmin: false }]),
        }));
        return fromChain;
      });
      return chain;
    });

    const result = await invokeOnboardingLlm(
      LLM_CONFIG,
      EMPTY_PROVIDERS_YAML,
      db,
      TEST_USER_ID,
      [],
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { hyperliquid: { walletGeneration: { enabled: false } }, jupiter: {}, '1inch': {} },
    );

    const walletActions = (result.actions ?? []).filter(
      (a) => a.type === 'confirm' && a.props && typeof a.props === 'object' && 'type' in a.props && a.props.type === 'wallet_created',
    );
    expect(walletActions.length).toBe(0);
  });
});

// ── resolveCreateAgentConnection: unit tests ────────────────────────────────

/**
 * Build a mock DB where each SELECT call consumes the next array of rows
 * from `responses`. The responses are consumed in order regardless of which
 * table is queried — the test writer controls the sequence.
 *
 * Handles both `.where()` (returns thenable resolving to full array) and
 * `.where().limit(1)` (returns thenable resolving to first element array,
 * matching Drizzle's `[row]` destructure pattern for limit:1 queries).
 */
function buildSelectMock(responses: unknown[][]): Database {
  let callIdx = 0;
  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          const rows = responses[callIdx] ?? [];
          callIdx++;
          // For .where().limit(1): returns [firstRow]
          const limitPromise = Promise.resolve(rows.length > 0 ? [rows[0]] : []);
          // For .where() without .limit(): returns the full rows array
          const fullPromise = Promise.resolve(rows);
          return {
            limit: vi.fn().mockReturnValue(limitPromise),
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => fullPromise.then(resolve, reject),
            catch: (reject: (e: unknown) => unknown) => fullPromise.catch(reject),
          };
        }),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
    transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
      returning: vi.fn().mockResolvedValue([{}]),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };
  return db as unknown as Database;
}

function makeTradingConnection(id: string, label = 'Test', provider = 'hyperliquid') {
  return { id, resolvedVenueAccountId: 'va-1', label, provider };
}

function makeNonTradingConnection(id: string, label = 'Gmail', provider = 'gmail') {
  return { id, resolvedVenueAccountId: null, label, provider };
}

const TRADING_PRESET = 'direct-trading';
const NON_TRADING_PRESET = 'personal-assistant';

describe('resolveCreateAgentConnection', () => {
  it('returns explicit selectedConnectionId when valid and compatible', async () => {
    const db = buildSelectMock([[makeTradingConnection('conn-1')]]);
    const result = await resolveCreateAgentConnection(
      'conn-1',
      TRADING_PRESET,
      { createdConnectionIds: [], recommendedConnectionIds: [], threadConnectionIds: [] },
      db,
      TEST_USER_ID,
    );
    expect(result.connectionId).toBe('conn-1');
    expect(result.error).toBeUndefined();
  });

  it('returns error when explicit selectedConnectionId is not found', async () => {
    const db = buildSelectMock([[]]);
    const result = await resolveCreateAgentConnection(
      'conn-missing',
      TRADING_PRESET,
      { createdConnectionIds: [], recommendedConnectionIds: [], threadConnectionIds: [] },
      db,
      TEST_USER_ID,
    );
    expect(result.connectionId).toBeUndefined();
    expect(result.error).toBeDefined();
    const parsed = JSON.parse(result.error!);
    expect(parsed.error).toBe('connection_not_found');
  });

  it('returns error when explicit selectedConnectionId is incompatible (trading agent, non-trading connection)', async () => {
    const db = buildSelectMock([[makeNonTradingConnection('conn-1')]]);
    const result = await resolveCreateAgentConnection(
      'conn-1',
      TRADING_PRESET,
      { createdConnectionIds: [], recommendedConnectionIds: [], threadConnectionIds: [] },
      db,
      TEST_USER_ID,
    );
    expect(result.connectionId).toBeUndefined();
    expect(result.error).toBeDefined();
    const parsed = JSON.parse(result.error!);
    expect(parsed.error).toBe('connection_incompatible');
    expect(parsed.message).toContain('not a trading venue');
  });

  it('returns error when explicit selectedConnectionId is incompatible (non-trading agent, trading connection)', async () => {
    const db = buildSelectMock([[makeTradingConnection('conn-1')]]);
    const result = await resolveCreateAgentConnection(
      'conn-1',
      NON_TRADING_PRESET,
      { createdConnectionIds: [], recommendedConnectionIds: [], threadConnectionIds: [] },
      db,
      TEST_USER_ID,
    );
    expect(result.connectionId).toBeUndefined();
    expect(result.error).toBeDefined();
    const parsed = JSON.parse(result.error!);
    expect(parsed.error).toBe('connection_incompatible');
    expect(parsed.message).toContain('trading venue');
  });

  it('resolves from same-turn created connection (tier 2)', async () => {
    const db = buildSelectMock([[makeTradingConnection('conn-created')]]);
    const result = await resolveCreateAgentConnection(
      undefined, // omitted
      TRADING_PRESET,
      { createdConnectionIds: ['conn-created'], recommendedConnectionIds: [], threadConnectionIds: [] },
      db,
      TEST_USER_ID,
    );
    expect(result.connectionId).toBe('conn-created');
    expect(result.error).toBeUndefined();
  });

  it('resolves from same-turn recommended connection (tier 3)', async () => {
    const db = buildSelectMock([[makeTradingConnection('conn-rec')]]);
    const result = await resolveCreateAgentConnection(
      undefined,
      TRADING_PRESET,
      { createdConnectionIds: [], recommendedConnectionIds: ['conn-rec'], threadConnectionIds: [] },
      db,
      TEST_USER_ID,
    );
    expect(result.connectionId).toBe('conn-rec');
    expect(result.error).toBeUndefined();
  });

  it('resolves from thread metadata connectionIds (tier 4)', async () => {
    const db = buildSelectMock([[makeNonTradingConnection('thread-conn')]]);
    const result = await resolveCreateAgentConnection(
      undefined,
      NON_TRADING_PRESET,
      { createdConnectionIds: [], recommendedConnectionIds: [], threadConnectionIds: ['thread-conn'] },
      db,
      TEST_USER_ID,
    );
    expect(result.connectionId).toBe('thread-conn');
    expect(result.error).toBeUndefined();
  });

  it('returns ambiguity error when multiple compatible connections exist in thread', async () => {
    const db = buildSelectMock([[
      makeTradingConnection('conn-a', 'Wallet A'),
      makeTradingConnection('conn-b', 'Wallet B'),
    ]]);
    const result = await resolveCreateAgentConnection(
      undefined,
      TRADING_PRESET,
      { createdConnectionIds: [], recommendedConnectionIds: [], threadConnectionIds: ['conn-a', 'conn-b'] },
      db,
      TEST_USER_ID,
    );
    expect(result.connectionId).toBeUndefined();
    expect(result.error).toBeDefined();
    const parsed = JSON.parse(result.error!);
    expect(parsed.error).toBe('connection_ambiguous');
    expect(parsed.connections).toHaveLength(2);
  });

  it('filters out incompatible connections and resolves the single compatible one', async () => {
    // One trading, one non-trading in thread — trading agent should
    // resolve to the single compatible trading connection.
    const db = buildSelectMock([[
      makeTradingConnection('conn-trading'),
      makeNonTradingConnection('conn-nontrading'),
    ]]);
    const result = await resolveCreateAgentConnection(
      undefined,
      TRADING_PRESET,
      { createdConnectionIds: [], recommendedConnectionIds: [], threadConnectionIds: ['conn-trading', 'conn-nontrading'] },
      db,
      TEST_USER_ID,
    );
    expect(result.connectionId).toBe('conn-trading');
    expect(result.error).toBeUndefined();
  });

  it('returns no connection when surfaced connection is incompatible (trading agent, non-trading surfaced)', async () => {
    const db = buildSelectMock([[makeNonTradingConnection('conn-nontrading')]]);
    const result = await resolveCreateAgentConnection(
      undefined,
      TRADING_PRESET,
      { createdConnectionIds: [], recommendedConnectionIds: [], threadConnectionIds: ['conn-nontrading'] },
      db,
      TEST_USER_ID,
    );
    // No compatible connection found → no autowiring, no error
    expect(result.connectionId).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('never auto-binds an unsurfaced connection (no blind DB lookup)', async () => {
    // DB has a connection but it's not in any surfaced context
    const db = buildSelectMock([]);
    const result = await resolveCreateAgentConnection(
      undefined,
      TRADING_PRESET,
      { createdConnectionIds: [], recommendedConnectionIds: [], threadConnectionIds: [] },
      db,
      TEST_USER_ID,
    );
    // No surfaced context → no autowiring
    expect(result.connectionId).toBeUndefined();
    expect(result.error).toBeUndefined();
  });
});

// ── executeChatAction: assignedConnectionId in create_agent result ───────────

describe('executeChatAction — assignedConnectionId', () => {
  it('includes assignedConnectionId in the create_agent result when a connection is bound', async () => {
    vi.mocked(reconcileTradingProfile).mockClear();
    // We need a mock that allows create_agent to succeed far enough to build
    // the result object. Use a spy / manual approach: call executeChatAction
    // but mock the DB deeply enough for the handler to reach the result
    // construction. The simplest path triggers an early failure AFTER the
    // connection handling but BEFORE needing complex mocks — we use the
    // billing gate to short-circuit right at the result construction.

    // Actually, verify at the Zod level: test that when selectedConnectionId is
    // present, the result object includes assignedConnectionId. We can test this
    // by mocking the DB to make create_agent succeed minimally.

    // Build a DB mock that returns user row with model config so it passes the
    // model_settings check, then fails at checkAgentLimit (plansConfig undefined
    // → skipped), then fails at skill resolution... 

    // Simpler: we know from the code structure that `assignedConnectionId` is
    // added to the result object when `connectionIds.length > 0`. This is
    // a deterministic output of `executeChatAction`. Test it by setting up
    // the right conditions.

    // Use a mock DB that provides the user row and connection rows needed
    // for a successful create_agent call. The key path is:
    // 1. User lookup returns a row with aiModelConfig
    // 2. Plan check skipped (plansConfig undefined)
    // 3. prepareAgentCreateFields succeeds
    // 4. Transaction succeeds (inserts are no-ops in mock)
    // 5. syncAgentSkillAssignments succeeds (mock returns ok)

    // The create_agent handler does multiple DB selects. Provide responses in
    // the expected order: user lookup (planId + aiModelConfig), resolveRuntimePolicyOverrides
    // user lookup, then transaction connection validation.
    // Use a non-trading connection (resolvedVenueAccountId: null) to match the custom preset.
    const db = buildSelectMock([
      [{ planId: 'free', isAdmin: false, aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
      [], // resolveRuntimePolicyOverrides user lookup — no aiModelConfig → returns null
      [{ id: 'conn-1', status: 'active', resolvedVenueAccountId: null }], // non-trading connection for custom preset
      [], [], [], [], [], [], [], // extra slots for remaining queries
    ]);

    const mockUsageBillingRepo = {
      getAccountByUserId: vi.fn().mockResolvedValue(null), // fresh user, no billing account
      canSpendNow: vi.fn(),
    } as unknown as UsageBillingRepository;

    const result = await executeChatAction(
      makeToolCall('create_agent', {
        skillPresetId: 'custom',
        selectedConnectionId: 'conn-1',
      }),
      db,
      TEST_USER_ID,
      EMPTY_PROVIDERS_YAML,
      mockUsageBillingRepo,
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.success).toBe(true);
    expect(parsed.assignedConnectionId).toBe('conn-1');
    expect(reconcileTradingProfile).toHaveBeenCalledWith(expect.objectContaining({
      prior: expect.objectContaining({ connections: [] }),
      proposed: expect.objectContaining({
        connections: [expect.objectContaining({ connectionId: 'conn-1' })],
      }),
    }));
  });
});

// ── invokeOnboardingLlm: connection autowiring loop-level test ──────────────

describe('invokeOnboardingLlm — connection autowiring', () => {
  it('auto-wires a same-turn created connection when create_agent omits selectedConnectionId', async () => {
    // Mock createProviderLink to return a successful connection
    createProviderLinkMock.mockResolvedValueOnce({
      kind: 'ok',
      credentialId: 'cred-1',
      connectionId: 'conn-created',
      provider: 'hyperliquid',
      label: 'Hyperliquid Wallet',
      venueAccountId: 'va-1',
      wallet: {
        address: '0xAutoWired',
        network: 'Hyperliquid',
      },
    } as never);

    // LLM: round 1 = create_connection, round 2 = create_agent (no selectedConnectionId)
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: '',
        toolCalls: [makeToolCall('create_connection', {
          provider: 'hyperliquid',
          label: 'Hyperliquid Wallet',
          capability: 'trading',
          credentialMode: 'generated',
        })],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never).mockResolvedValueOnce({
      ok: true,
      data: {
        content: '',
        toolCalls: [makeToolCall('create_agent', {
          skillPresetId: 'direct-trading',
          capital: '1000',
        })],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never).mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Agent created with your wallet.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    // Call-order based mock: each DB select consumes the next response.
    // 0. create_connection → user lookup (planId)
    // 1. resolveCreateAgentConnection → validateSurfacedConnections
    // 2. create_agent → user lookup (planId, isAdmin, aiModelConfig)
    // 3. resolveRuntimePolicyOverrides → user lookup
    // 4. resolveSkillAssignmentsForUser → skill lookup
    // 5. resolveSkillAssignmentsForUser → entitlement lookup
    // 6. resolveSkillAssignmentsForUser → revision lookup
    // 7. transaction → connection validation
    // 8. syncAgentSkillAssignments → agentSkills select
    const db = buildSelectMock([
      [{ planId: 'free', isAdmin: false }],
      [{ id: 'conn-created', resolvedVenueAccountId: 'va-1', label: 'HW', provider: 'hyperliquid' }],
      [{ planId: 'free', isAdmin: false, aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
      [], // resolveRuntimePolicyOverrides user lookup — empty is fine
      [{ id: 'trading', authorId: null, publicationStatus: 'published', priceCents: 0 }],
      [], // entitlements
      [{ skillId: 'trading', revisionId: 'rev-1', version: 1 }],
      [{ id: 'conn-created', resolvedVenueAccountId: 'va-1' }],
      [], // syncAgentSkillAssignments → agentSkills select
      [], [], [], // extra slots
    ]);

    const result = await invokeOnboardingLlm(
      LLM_CONFIG,
      EMPTY_PROVIDERS_YAML,
      db,
      TEST_USER_ID,
      [],
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { hyperliquid: { walletGeneration: { enabled: true } }, jupiter: {}, '1inch': {} },
    );

    // The wallet_created action confirms create_connection ran.
    const walletActions = (result.actions ?? []).filter(
      (a) => a.type === 'confirm' && a.props && typeof a.props === 'object' && 'type' in a.props && a.props.type === 'wallet_created',
    );
    expect(walletActions.length).toBeGreaterThanOrEqual(1);

    // createProviderLink was called — confirms the create_connection path executed.
    expect(createProviderLinkMock).toHaveBeenCalledTimes(1);

    // Verify autowiring: the connectionId from create_connection is captured
    // in summaryFacts, confirming that the connection was created and tracked
    // for subsequent autowiring to create_agent.
    expect(result.summaryFacts?.connectionIds).toContain('conn-created');
  });

  // Gap 1: Loop-level test for tier-3 autowiring (list_compatible_connections → create_agent)
  // Verifies that when list_compatible_connections returns a recommended connection,
  // its ID and provider are captured in summaryFacts for subsequent tier-3 autowiring
  // when create_agent omits selectedConnectionId.
  it('captures recommended connection and venue from list_compatible_connections for tier-3 autowiring', async () => {
    // LLM: round 1 = list_compatible_connections returns a recommended trading connection.
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'I found your trading connection.',
        toolCalls: [makeToolCall('list_compatible_connections', {
          preferredCapability: 'trading',
        })],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never).mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Agent created with your existing connection.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    // DB response: list_compatible_connections → a single trading connection.
    // All subsequent empty slots handle any extra queries in the response path.
    const db = buildSelectMock([
      [{ id: 'conn-rec', resolvedVenueAccountId: 'va-1', label: 'HL Wallet', provider: 'hyperliquid', status: 'active' }],
      [], [], [], [], [], [], [], [], [], [], [], [], [], [], [],
    ]);

    const result = await invokeOnboardingLlm(
      LLM_CONFIG,
      EMPTY_PROVIDERS_YAML,
      db,
      TEST_USER_ID,
      [],
      null,
    );

    // The recommended connection should be captured in summaryFacts,
    // confirming it is available for tier-3 autowiring.
    expect(result.summaryFacts?.connectionIds).toContain('conn-rec');
    // Gap 3: venue is captured from the recommended connection's provider.
    expect(result.summaryFacts?.venue).toBe('hyperliquid');
  });
});

// ── buildSystemPrompt: prompt contract tests ────────────────────────────────

describe('buildSystemPrompt — prompt contract', () => {
  const prompt = buildSystemPrompt();

  it('does not instruct the model to use docs tools proactively', () => {
    // The prompt must not reference the platform documentation tool names
    // or imply they should be actively used.
    expect(prompt).not.toContain('search_app_docs');
    expect(prompt).not.toContain('list_app_docs');
    expect(prompt).not.toContain('read_app_docs');
    expect(prompt).not.toContain('platform documentation tools');
    expect(prompt).not.toContain('docs tools');
  });

  it('does not instruct the model to emit arbitrary quick_replies after the greeting', () => {
    // The prompt must not contain instructions to emit quick_replies in contexts
    // beyond the initial greeting (which is UI-provided).
    const tradingPrompt = buildTradingPrompt('user_msg');
    // "Use quick_replies" as a directive to the model must be absent.
    expect(tradingPrompt).not.toMatch(/Use quick_replies/i);
    // There must be no instruction that implies the model can emit quick_replies
    // outside the initial greeting buttons (which are UI-provided, not model-emitted).
    expect(tradingPrompt).not.toMatch(/emit quick_replies|send quick_replies|present quick_replies|you can use quick_replies/i);
  });

  it('does not claim unconditional auto-selection for selectedConnectionId', () => {
    // The tool description in CHAT_TOOLS is not embedded in the prompt,
    // but the prompt text itself must not contain false claims about
    // unconditional auto-selection of the connection.
    // This constraint lives in the trading-specific General Connection Rules.
    const tradingPrompt = buildTradingPrompt('user_msg');
    // The prompt must not claim the connection will be auto-selected
    // unconditionally (i.e., without context-dependent resolution).
    expect(tradingPrompt).not.toMatch(/auto[- ]select(ed|ing|s)?\s*(the\s*)?connection/i);
    // The prompt should describe autowiring as context-dependent, not automatic.
    // Verify the prompt mentions the autowiring behavior (General Connection Rules).
    expect(tradingPrompt).toContain('auto-assigns');
  });
});

// ── buildConnectionChoiceActions: unit tests ────────────────────────────────

describe('buildConnectionChoiceActions', () => {
  const SAMPLE_CONNECTIONS = [
    { id: 'conn-1', provider: 'hyperliquid', label: 'HL Wallet' },
    { id: 'conn-2', provider: 'jupiter', label: 'JUP Wallet' },
    { id: 'conn-3', provider: 'hyperliquid', label: 'HL Perps' },
  ];

  it('returns a correctly shaped ChatAction with connection options and action buttons', () => {
    const actions = buildConnectionChoiceActions(SAMPLE_CONNECTIONS);

    expect(actions).toHaveLength(1);
    expect(actions[0]!.id).toBe('connection-choice');
    expect(actions[0]!.type).toBe('quick_replies');
    expect(actions[0]!.options).toBeDefined();

    const options = actions[0]!.options!;
    // 3 connections + "generate new wallet" + "enter my own keys" = 5 options
    expect(options).toHaveLength(5);

    // Connection options
    expect(options[0]!.label).toBe('hyperliquid: HL Wallet');
    expect(options[0]!.value).toBe('connection:conn-1');
    expect(options[1]!.label).toBe('jupiter: JUP Wallet');
    expect(options[1]!.value).toBe('connection:conn-2');
    expect(options[2]!.label).toBe('hyperliquid: HL Perps');
    expect(options[2]!.value).toBe('connection:conn-3');

    // Action buttons
    expect(options[3]!.label).toBe('Generate a new wallet');
    expect(options[3]!.value).toBe('action:create_connection');
    expect(options[4]!.label).toBe('Enter my own keys');
    expect(options[4]!.value).toBe('action:request_connection_form');
  });

  it('venue-filters connections when venueHint is provided', () => {
    const actions = buildConnectionChoiceActions(SAMPLE_CONNECTIONS, 'hyperliquid');

    const options = actions[0]!.options!;
    // 2 hyperliquid connections + 2 action buttons = 4 options
    expect(options).toHaveLength(4);
    expect(options[0]!.label).toBe('hyperliquid: HL Wallet');
    expect(options[0]!.value).toBe('connection:conn-1');
    expect(options[1]!.label).toBe('hyperliquid: HL Perps');
    expect(options[1]!.value).toBe('connection:conn-3');
    // Action buttons still present
    expect(options[2]!.label).toBe('Generate a new wallet');
    expect(options[3]!.label).toBe('Enter my own keys');
  });

  it('returns only action buttons when venueHint filters out all connections', () => {
    const actions = buildConnectionChoiceActions(SAMPLE_CONNECTIONS, '1inch');

    const options = actions[0]!.options!;
    // No 1inch connections → only 2 action buttons
    expect(options).toHaveLength(2);
    expect(options[0]!.label).toBe('Generate a new wallet');
    expect(options[1]!.label).toBe('Enter my own keys');
  });

  it('returns only action buttons for empty connections array', () => {
    const actions = buildConnectionChoiceActions([]);

    const options = actions[0]!.options!;
    expect(options).toHaveLength(2);
    expect(options[0]!.label).toBe('Generate a new wallet');
    expect(options[1]!.label).toBe('Enter my own keys');
  });
});

// ── POST /chat/threads/:id/messages — connection-choice button replies ──────

describe('POST /chat/threads/:id/messages — button replies', () => {
  async function buildAppWithThread(overrides: Partial<Record<string, unknown>> = {}) {
    const { db, state } = buildMockDb(overrides);
    const app = Fastify({ logger: false });
    decorateWithAuth(app);
    await chatRoutes(app, db, LLM_CONFIG, EMPTY_PROVIDERS_YAML, {} as Redis);
    await app.ready();
    return { app, db, state };
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

  function mockPlainResponse(content = 'Got it — continuing setup.') {
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content,
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);
  }

  it('detects connection:<id> button reply, updates metadata, and resumes with connection_selected event', async () => {
    const { app, state } = await buildAppWithThread({
      threadRows: threadRow({ summary: { step: 'conversation', preset: 'direct-trading' } }),
      messageRows: [],
      connectionRows: [{ id: 'conn-hl', userId: TEST_USER_ID, status: 'active', provider: 'hyperliquid' }],
    });

    mockPlainResponse('Hyperliquid wallet selected. How much capital?');

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/messages',
      payload: { content: 'connection:conn-hl' },
    });

    expect(res.statusCode).toBe(200);

    // Metadata update should have connectionIds set and step = connection_selected
    // The first updateSet is from the button-reply handling, the second from after LLM.
    const firstUpdate = state.updateSets[0] as Record<string, unknown>;
    const firstMeta = firstUpdate['metadata'] as { summary?: { connectionIds?: string[]; step?: string } };
    expect(firstMeta.summary?.connectionIds).toEqual(['conn-hl']);
    expect(firstMeta.summary?.step).toBe('connection_selected');

    // The resumed LLM call must carry the connection_selected resume event.
    expect(callMock).toHaveBeenCalledTimes(1);
    const systemMessage = callMock.mock.calls[0]![1]!.messages[0] as { role: string; content: string };
    expect(systemMessage.content).toContain('## Resume Event');
    expect(systemMessage.content).toContain('selected connection conn-hl');
    expect(systemMessage.content).toContain('hyperliquid');

    // A transient event message must be present
    const eventMessage = callMock.mock.calls[0]![1]!.messages.at(-2) as { role: string; content: string };
    expect(eventMessage.role).toBe('user');
    expect(eventMessage.content).toContain('System event:');
    expect(eventMessage.content).toContain('selected connection conn-hl');
  });

  it('re-derives venue-coupled config when connection provider differs from summary.venue', async () => {
    const { app, state } = await buildAppWithThread({
      threadRows: threadRow({
        summary: { step: 'conversation', preset: 'direct-trading', venue: 'jupiter' },
      }),
      messageRows: [],
      connectionRows: [{ id: 'conn-hl', userId: TEST_USER_ID, status: 'active', provider: 'hyperliquid' }],
    });

    mockPlainResponse('Switched to Hyperliquid. Let me re-derive the strategy.');

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/messages',
      payload: { content: 'connection:conn-hl' },
    });

    expect(res.statusCode).toBe(200);

    // Venue should be updated and preset cleared since provider changed.
    const firstUpdate = state.updateSets[0] as Record<string, unknown>;
    const firstMeta = firstUpdate['metadata'] as { summary?: { venue?: string; preset?: string; step?: string } };
    expect(firstMeta.summary?.venue).toBe('hyperliquid');
    expect(firstMeta.summary?.preset).toBeUndefined();
    expect(firstMeta.summary?.step).toBe('connection_selected');
  });

  it('does NOT clear preset when connection provider matches summary.venue', async () => {
    const { app, state } = await buildAppWithThread({
      threadRows: threadRow({
        summary: { step: 'conversation', preset: 'direct-trading', venue: 'hyperliquid' },
      }),
      messageRows: [],
      connectionRows: [{ id: 'conn-hl', userId: TEST_USER_ID, status: 'active', provider: 'hyperliquid' }],
    });

    mockPlainResponse('Using your existing Hyperliquid wallet.');

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/messages',
      payload: { content: 'connection:conn-hl' },
    });

    expect(res.statusCode).toBe(200);

    // Same venue → preset should be preserved (not cleared).
    const firstUpdate = state.updateSets[0] as Record<string, unknown>;
    const firstMeta = firstUpdate['metadata'] as { summary?: { venue?: string; preset?: string; step?: string } };
    expect(firstMeta.summary?.step).toBe('connection_selected');
    // Preset is preserved because venue didn't change and the spread carries
    // the existing summary fields forward.
    expect(firstMeta.summary?.preset).toBe('direct-trading');
    // Venue is unchanged
    expect(firstMeta.summary?.venue).toBe('hyperliquid');
  });

  it('detects action:create_connection button reply and updates metadata step', async () => {
    const { app, state } = await buildAppWithThread({
      threadRows: threadRow({ summary: { step: 'conversation', preset: 'direct-trading' } }),
      messageRows: [],
    });

    mockPlainResponse('Let\'s create a new wallet. Which provider?');

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/messages',
      payload: { content: 'action:create_connection' },
    });

    expect(res.statusCode).toBe(200);

    const firstUpdate = state.updateSets[0] as Record<string, unknown>;
    const firstMeta = firstUpdate['metadata'] as { summary?: { step?: string } };
    expect(firstMeta.summary?.step).toBe('create_connection_requested');

    // No resume event for action buttons — just normal resume
    expect(callMock).toHaveBeenCalledTimes(1);
  });

  it('detects action:request_connection_form button reply and updates metadata step', async () => {
    const { app, state } = await buildAppWithThread({
      threadRows: threadRow({ summary: { step: 'conversation', preset: 'direct-trading' } }),
      messageRows: [],
    });

    mockPlainResponse('Opening the connection form for you.');

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/messages',
      payload: { content: 'action:request_connection_form' },
    });

    expect(res.statusCode).toBe(200);

    const firstUpdate = state.updateSets[0] as Record<string, unknown>;
    const firstMeta = firstUpdate['metadata'] as { summary?: { step?: string } };
    expect(firstMeta.summary?.step).toBe('connection_form_requested');
  });

  it('does NOT trigger button-reply handling for normal free-text messages', async () => {
    const { app, state } = await buildAppWithThread({
      threadRows: threadRow({ summary: { step: 'conversation' } }),
      messageRows: [],
    });

    mockPlainResponse('Sure, what kind of agent?');

    const res = await app.inject({
      method: 'POST',
      url: '/chat/threads/thread-1/messages',
      payload: { content: 'I want to use my Hyperliquid wallet' },
    });

    expect(res.statusCode).toBe(200);

    // No extra metadata update before LLM — only the post-LLM update.
    // The first updateSet should be the final metadata update (after LLM),
    // not a button-reply update. With our mock, the after-LLM update also
    // produces one updateSet, so we should have exactly 1 updateSet total.
    expect(state.updateSets.length).toBe(1);
    // Step should be 'conversation', not any button-related step.
    const updateMeta = state.updateSets[0]!['metadata'] as { summary?: { step?: string } };
    expect(updateMeta.summary?.step).toBe('conversation');
  });
});

// ── invokeOnboardingLlm: connection disambiguation quick_replies ────────────

describe('invokeOnboardingLlm — connection disambiguation buttons', () => {
  it('emits quick_replies action when create_agent hits connection_ambiguous for a trading preset', async () => {
    // LLM: round 1 = create_agent without selectedConnectionId → ambiguous.
    // The thread metadata has two connectionIds, so resolveCreateAgentConnection
    // will find them at tier 4 and return a connection_ambiguous error.
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: '',
        toolCalls: [makeToolCall('create_agent', {
          skillPresetId: 'direct-trading',
          capital: '1000',
        })],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never).mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'You have multiple trading connections. Please pick one.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    // DB responses:
    // 0. resolveCreateAgentConnection tier 4: validateSurfacedConnections
    //    queries all active connections and matches against threadConnectionIds.
    const db = buildSelectMock([
      [
        { id: 'conn-a', resolvedVenueAccountId: 'va-a', label: 'Wallet A', provider: 'hyperliquid' },
        { id: 'conn-b', resolvedVenueAccountId: 'va-b', label: 'Wallet B', provider: 'jupiter' },
      ],
      [], [], [], [], [], [], [], [], [], // extra slots
    ]);

    const result = await invokeOnboardingLlm(
      LLM_CONFIG,
      EMPTY_PROVIDERS_YAML,
      db,
      TEST_USER_ID,
      [],
      { summary: { step: 'conversation', preset: 'direct-trading', connectionIds: ['conn-a', 'conn-b'] } },
    );

    // Should have a quick_replies action for connection choice
    const choiceActions = (result.actions ?? []).filter(
      (a) => a.type === 'quick_replies' && a.id?.startsWith('connection-choice'),
    );
    expect(choiceActions.length).toBeGreaterThanOrEqual(1);

    const options = choiceActions[0]!.options!;
    // Two connections + "generate new wallet" + "enter my own keys" = 4
    expect(options.length).toBeGreaterThanOrEqual(3);

    // Verify the connection options are present
    const connValues = options.filter((o) => o.value.startsWith('connection:'));
    expect(connValues.length).toBe(2);
    expect(connValues[0]!.value).toBe('connection:conn-a');
    expect(connValues[1]!.value).toBe('connection:conn-b');

    // Verify action buttons are present
    const actionValues = options.filter((o) => o.value.startsWith('action:'));
    expect(actionValues.length).toBe(2);
    expect(actionValues.map((o) => o.value)).toContain('action:create_connection');
    expect(actionValues.map((o) => o.value)).toContain('action:request_connection_form');

    // Gap 5: Verify the connection_ambiguous structured error was surfaced as
    // a tool result to the LLM. The second callLlmProvider call should include
    // a tool-role message with the connection_ambiguous JSON.
    expect(callMock).toHaveBeenCalledTimes(2);
    const secondCallMessages = callMock.mock.calls[1]?.[1]?.messages as Array<{ role: string; content: string }> | undefined;
    expect(secondCallMessages).toBeDefined();
    const toolMessages = (secondCallMessages ?? []).filter((m) => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThanOrEqual(1);
    const ambiguityToolMsg = toolMessages.find((m) => {
      try {
        const parsed = JSON.parse(m.content) as Record<string, unknown>;
        return parsed.error === 'connection_ambiguous';
      } catch {
        return false;
      }
    });
    expect(ambiguityToolMsg).toBeDefined();
    const ambiguityParsed = JSON.parse(ambiguityToolMsg!.content) as Record<string, unknown>;
    expect(ambiguityParsed.error).toBe('connection_ambiguous');
    expect(ambiguityParsed.connections).toBeDefined();

    // The LLM still sees the ambiguity error as a tool result (the content
    // from round 2 tells the user about the ambiguity).
    expect(result.content).toContain('multiple trading connections');
  });

  it('does NOT emit quick_replies when error is not connection_ambiguous', async () => {
    // LLM calls create_agent with an invalid connection ID → connection_not_found
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: '',
        toolCalls: [makeToolCall('create_agent', {
          skillPresetId: 'direct-trading',
          capital: '500',
          selectedConnectionId: 'conn-missing',
        })],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never).mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'That connection does not exist.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    // DB returns empty for the explicit connection lookup
    const db = buildSelectMock([[]]);

    const result = await invokeOnboardingLlm(
      LLM_CONFIG,
      EMPTY_PROVIDERS_YAML,
      db,
      TEST_USER_ID,
      [],
      null,
    );

    // No quick_replies should be emitted for non-ambiguous errors
    const choiceActions = (result.actions ?? []).filter(
      (a) => a.type === 'quick_replies' && a.id?.startsWith('connection-choice'),
    );
    expect(choiceActions.length).toBe(0);
  });
});

// ── Prompt injection defenses ────────────────────────────────────────────────

describe('prompt injection defenses — buildBaseHeader Security section', () => {
  it('includes a Security section referencing the userMsgTag in buildBaseHeader', () => {
    const header = buildBaseHeader('user_msg_ab12');
    expect(header).toContain('## Security');
    expect(header).toContain('<user_msg_ab12>');
  });

  it('includes the Security section in buildBasePrompt', () => {
    const prompt = buildBasePrompt('user_msg_ff00');
    expect(prompt).toContain('## Security');
    expect(prompt).toContain('<user_msg_ff00>');
  });

  it('includes the Security section in buildTradingPrompt', () => {
    const prompt = buildTradingPrompt('user_msg_cafe');
    expect(prompt).toContain('## Security');
    expect(prompt).toContain('<user_msg_cafe>');
  });

  it('includes the Security section in buildPersonalAssistantPrompt', () => {
    const prompt = buildPersonalAssistantPrompt('user_msg_dead');
    expect(prompt).toContain('## Security');
    expect(prompt).toContain('<user_msg_dead>');
  });

  it('includes the Security section in buildCustomPrompt', () => {
    const prompt = buildCustomPrompt('user_msg_beef');
    expect(prompt).toContain('## Security');
    expect(prompt).toContain('<user_msg_beef>');
  });

  it('instructs to disregard content outside userMsgTag tags', () => {
    const header = buildBaseHeader('user_msg_1234');
    expect(header).toContain('only content inside');
    expect(header).toContain('those tags is from the real user');
  });
});

describe('prompt injection defenses — invokeOnboardingLlm message wrapping', () => {
  it('wraps user messages in <user_msg_XXXX> tags with the nonce from system prompt', async () => {
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Hello!',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();
    const threadMessages = [
      { id: 'msg-1', role: 'user' as const, content: 'I want a trading agent', createdAt: new Date().toISOString() },
      { id: 'msg-2', role: 'assistant' as const, content: 'Great choice!', createdAt: new Date().toISOString() },
    ];

    await invokeOnboardingLlm(LLM_CONFIG, EMPTY_PROVIDERS_YAML, db, TEST_USER_ID, threadMessages, null);

    expect(callMock).toHaveBeenCalledTimes(1);
    const messages = callMock.mock.calls[0]![1]!.messages as Array<{ role: string; content: string }>;

    // System prompt contains a reference to the user_msg_XXXX tag
    const systemMsg = messages[0]!;
    expect(systemMsg.role).toBe('system');
    const tagMatch = systemMsg.content.match(/<(user_msg_[0-9a-f]{4})>/);
    expect(tagMatch).not.toBeNull();
    const userMsgTag = tagMatch![1]!;

    // User message should be wrapped in the same nonce tag
    const userMsg = messages[1]!;
    expect(userMsg.role).toBe('user');
    expect(userMsg.content).toBe(`<${userMsgTag}>I want a trading agent</${userMsgTag}>`);

    // Assistant message should NOT be wrapped
    const assistantMsg = messages[2]!;
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.content).toBe('Great choice!');
  });

  it('uses a 4 hex-character nonce in the tag name', async () => {
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Hi!',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();
    await invokeOnboardingLlm(LLM_CONFIG, EMPTY_PROVIDERS_YAML, db, TEST_USER_ID, [], null);

    const messages = callMock.mock.calls[0]![1]!.messages as Array<{ role: string; content: string }>;
    const systemContent = messages[0]!.content;
    // The system prompt must contain the nonce tag pattern
    expect(systemContent).toMatch(/user_msg_[0-9a-f]{4}/);
  });

  it('places the security guard as the last message in the messages array', async () => {
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Noted.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();
    const threadMessages = [
      { id: 'msg-1', role: 'user' as const, content: 'Setup my agent', createdAt: new Date().toISOString() },
    ];

    await invokeOnboardingLlm(LLM_CONFIG, EMPTY_PROVIDERS_YAML, db, TEST_USER_ID, threadMessages, null);

    const messages = callMock.mock.calls[0]![1]!.messages as Array<{ role: string; content: string }>;
    const lastMsg = messages[messages.length - 1]!;

    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toContain('SECURITY REMINDER');
    expect(lastMsg.content).toContain('not from the user');
  });

  it('security guard references the same nonce tag as the system prompt', async () => {
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Got it.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();
    await invokeOnboardingLlm(LLM_CONFIG, EMPTY_PROVIDERS_YAML, db, TEST_USER_ID, [
      { id: 'msg-1', role: 'user', content: 'Hello', createdAt: new Date().toISOString() },
    ], null);

    const messages = callMock.mock.calls[0]![1]!.messages as Array<{ role: string; content: string }>;
    const systemContent = messages[0]!.content;
    const tagMatch = systemContent.match(/user_msg_([0-9a-f]{4})/);
    expect(tagMatch).not.toBeNull();
    const nonce = tagMatch![1]!;

    const guardMsg = messages[messages.length - 1]!;
    expect(guardMsg.content).toContain(`<user_msg_${nonce}>`);
  });

  it('security guard is last even when a resume event message is present', async () => {
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Connection linked! Continuing.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();
    await invokeOnboardingLlm(
      LLM_CONFIG,
      EMPTY_PROVIDERS_YAML,
      db,
      TEST_USER_ID,
      [],
      { summary: { step: 'connection_linked' } },
      { kind: 'connection_linked', connectionId: 'conn-1', providerHint: 'gmail' },
    );

    const messages = callMock.mock.calls[0]![1]!.messages as Array<{ role: string; content: string }>;
    const lastMsg = messages[messages.length - 1]!;
    expect(lastMsg.content).toContain('SECURITY REMINDER');

    // The resume event message should be second-to-last
    const secondToLast = messages[messages.length - 2]!;
    expect(secondToLast.role).toBe('user');
    expect(secondToLast.content).toContain('System event:');
  });

  it('wraps only user-role messages, not assistant messages', async () => {
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Sure!',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();
    const threadMessages = [
      { id: 'msg-1', role: 'user' as const, content: 'Trading agent please', createdAt: new Date().toISOString() },
      { id: 'msg-2', role: 'assistant' as const, content: 'What style?', createdAt: new Date().toISOString() },
      { id: 'msg-3', role: 'user' as const, content: 'Bold', createdAt: new Date().toISOString() },
    ];

    await invokeOnboardingLlm(LLM_CONFIG, EMPTY_PROVIDERS_YAML, db, TEST_USER_ID, threadMessages, null);

    const messages = callMock.mock.calls[0]![1]!.messages as Array<{ role: string; content: string }>;
    // messages[0] = system, messages[1] = user (wrapped), messages[2] = assistant, messages[3] = user (wrapped), messages[4] = guard

    // Both user messages wrapped
    expect(messages[1]!.content).toMatch(/^<user_msg_[0-9a-f]{4}>Trading agent please<\/user_msg_[0-9a-f]{4}>$/);
    expect(messages[3]!.content).toMatch(/^<user_msg_[0-9a-f]{4}>Bold<\/user_msg_[0-9a-f]{4}>$/);

    // Assistant message not wrapped
    expect(messages[2]!.content).toBe('What style?');
    expect(messages[2]!.content).not.toContain('<user_msg_');
  });

  it('generates different nonces across invocations', async () => {
    callMock.mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'First response.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never).mockResolvedValueOnce({
      ok: true,
      data: {
        content: 'Second response.',
        toolCalls: [],
        model: 'gpt-4o',
        provider: 'openai',
        tokensUsed: 10,
        latencyMs: 10,
        cached: false,
      },
    } as never);

    const { db } = buildMockDb();

    await invokeOnboardingLlm(LLM_CONFIG, EMPTY_PROVIDERS_YAML, db, TEST_USER_ID, [], null);
    await invokeOnboardingLlm(LLM_CONFIG, EMPTY_PROVIDERS_YAML, db, TEST_USER_ID, [], null);

    expect(callMock).toHaveBeenCalledTimes(2);

    const messages1 = callMock.mock.calls[0]![1]!.messages as Array<{ role: string; content: string }>;
    const messages2 = callMock.mock.calls[1]![1]!.messages as Array<{ role: string; content: string }>;

    const nonce1Match = messages1[0]!.content.match(/user_msg_([0-9a-f]{4})/);
    const nonce2Match = messages2[0]!.content.match(/user_msg_([0-9a-f]{4})/);

    expect(nonce1Match).not.toBeNull();
    expect(nonce2Match).not.toBeNull();

    // Nonces should differ between invocations (statistically near-certain with 65536 possibilities)
    expect(nonce1Match![1]).not.toBe(nonce2Match![1]);
  });
});
