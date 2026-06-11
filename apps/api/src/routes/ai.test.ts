import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';
import { aiRoutes } from './ai.js';

// Mock @herobids/llm so the module can be imported in the test environment
vi.mock('@herobids/llm', () => ({
  callLlmProvider: vi.fn().mockResolvedValue({
    ok: true,
    data: {
      content: '{"strategy":{"preset":"momentum","params":{}},"risk":{"maxPositionSizePct":5,"stopLossPct":2,"takeProfitPct":4},"execution":{"mode":"paper"}}',
      model: 'gpt-4o',
      tokensUsed: 64,
    },
  }),
}));

const TEST_USER_ID = 'user-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>) {
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = TEST_USER_ID;
  });
}

function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'offset']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

function buildEmptyDb() {
  return {
    select: vi.fn().mockImplementation(() => makeChain([])),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
  } as unknown as Database;
}

function buildMockRedis(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as Redis;
}

const stubLlmConfig = {
  provider: 'test-provider',
  model: 'test-model',
  baseUrl: undefined,
  maxTokens: 4096,
  timeoutMs: 60_000,
  tickIntervalMs: 900_000,
  heartbeatIntervalMs: 5_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Ensure no real API keys are set
  delete process.env['LLM_API_KEY'];
  delete process.env['LLM_API_KEY_TEST-PROVIDER'];
  delete process.env['LLM_API_KEY_OPENAI'];
  delete process.env['LLM_API_KEY_ANTHROPIC'];
});

// ─── GET /ai/available-models ─────────────────────────────────────────────

describe('GET /ai/available-models', () => {
  it('returns 503 when no provider is configured', async () => {

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, stubLlmConfig, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('no_ai_provider');
  });

  it('returns configured providers when API key is set', async () => {
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, stubLlmConfig, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.providers).toBeInstanceOf(Array);
    const providers = body.providers as Array<{ provider: string }>;
    expect(providers.some((p) => p.provider === 'openai')).toBe(true);
    // Unconfigured providers must NOT appear
    expect(providers.every((p) => p.provider !== 'anthropic')).toBe(true);
    delete process.env['LLM_API_KEY_OPENAI'];
  });

  it('returns 200 with the operator provider when only the generic LLM_API_KEY is set', async () => {
    // Deployment pattern: LLM_API_KEY (generic) + operator config provider=openai.
    // The provider must be available — only that one provider is shown, not all 8.
    process.env['LLM_API_KEY'] = 'generic-key';

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    // Use openai as operator provider so it appears in PROVIDER_MODELS
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ providers: Array<{ provider: string }> }>();
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]!.provider).toBe('openai');
    // No other providers must appear — the generic key must not advertise all 8.
    delete process.env['LLM_API_KEY'];
  });

  it('returns the operator ollama provider and static models without an API key', async () => {
    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'ollama' }, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      providers: [
        {
          provider: 'ollama',
          models: ['qwen3-coder:30b', 'qwen3.6:35b-a3b-q4_K_M'],
        },
      ],
    });
  });
});

// ─── POST /ai/generate-config ─────────────────────────────────────────────

describe('POST /ai/generate-config', () => {
  it('returns 503 when no provider is configured', async () => {

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, stubLlmConfig, redis);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/generate-config',
      payload: { text: 'Aggressive momentum strategy' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('no_ai_provider');
  });

  it('returns 400 for missing text field', async () => {
    // Provider must be configured so we get past the 503 guard to reach body validation
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';
    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    app.setErrorHandler((error, _request, reply) => {
      reply.status(500).send({ message: error.message, stack: error.stack });
    });
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/generate-config',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    delete process.env['LLM_API_KEY_OPENAI'];
  });

  it('returns 429 when rate limit exceeded', async () => {
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';

    const db = buildEmptyDb();
    const redis = buildMockRedis({ incr: vi.fn().mockResolvedValue(11) });
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/generate-config',
      payload: { text: 'Generate momentum strategy' },
    });
    expect(res.statusCode).toBe(429);
    delete process.env['LLM_API_KEY_OPENAI'];
  });

  it('returns 200 with configData when LLM returns valid JSON', async () => {
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';

    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{ aiModelConfig: null }])),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/generate-config',
      payload: { text: 'Momentum strategy on BTC' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ configData: { strategy: unknown; risk: unknown; execution: unknown }; model: string }>();
    expect(body.configData).toHaveProperty('strategy');
    expect(body.configData).toHaveProperty('risk');
    expect(body.configData).toHaveProperty('execution');
    expect(body.model).toBe('gpt-4o');
    delete process.env['LLM_API_KEY_OPENAI'];
  });
});

// ─── POST /ai/analyze-portfolio ───────────────────────────────────────────

describe('POST /ai/analyze-portfolio', () => {
  it('returns 503 when no provider is configured', async () => {

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, stubLlmConfig, redis);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/analyze-portfolio',
      payload: { totalPnl: '100', tradeCount: 5 },
    });
    expect(res.statusCode).toBe(503);
  });

  it('returns 400 for invalid body (wrong types)', async () => {
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';
    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/analyze-portfolio',
      payload: { tradeCount: 'not-a-number' },
    });
    expect(res.statusCode).toBe(400);
    delete process.env['LLM_API_KEY_OPENAI'];
  });
});

// ─── POST /ai/explain-signal ──────────────────────────────────────────────

describe('POST /ai/explain-signal', () => {
  it('returns 503 when no provider is configured', async () => {

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, stubLlmConfig, redis);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/explain-signal',
      payload: { signal: { type: 'buy', confidence: 0.8 } },
    });
    expect(res.statusCode).toBe(503);
  });

  it('returns 400 when signal is missing', async () => {
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';
    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/explain-signal',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    delete process.env['LLM_API_KEY_OPENAI'];
  });
});

// ─── PATCH /settings/ai-model ─────────────────────────────────────────────

describe('GET /settings/ai-model', () => {
  it('returns normalized current settings when present', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }])),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, stubLlmConfig, redis);

    const res = await app.inject({ method: 'GET', url: '/settings/ai-model' });
    expect(res.statusCode).toBe(200);
    expect(res.json().aiModelConfig).toEqual({ provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' });
  });

  it('returns null when persisted settings still use the removed legacy shape', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([
        {
          aiModelConfig: {
            primary: { provider: 'openai', model: 'gpt-4o' },
            fallback1: { provider: 'openai', model: 'gpt-4o-mini' },
          },
        },
      ])),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, stubLlmConfig, redis);

    const res = await app.inject({ method: 'GET', url: '/settings/ai-model' });
    expect(res.statusCode).toBe(200);
    expect(res.json().aiModelConfig).toBeNull();
  });

  it('returns null when persisted settings are no longer valid for the catalog', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([
        {
          aiModelConfig: {
            provider: 'openai',
            lightModel: 'claude-haiku-3-5',
            heavyModel: 'gpt-4o',
          },
        },
      ])),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, stubLlmConfig, redis);

    const res = await app.inject({ method: 'GET', url: '/settings/ai-model' });
    expect(res.statusCode).toBe(200);
    expect(res.json().aiModelConfig).toBeNull();
  });
});

describe('PATCH /settings/ai-model', () => {
  it('returns 200 and updated config when valid body provided', async () => {
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';

    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{ aiModelConfig: null }])),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis);

    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/ai-model',
      payload: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().aiModelConfig).toEqual({ provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' });
    delete process.env['LLM_API_KEY_OPENAI'];
  });

  it('returns 200 when setting a field to null (clearing preference)', async () => {

    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }])),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, stubLlmConfig, redis);

    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/ai-model',
      payload: { provider: null, lightModel: null, heavyModel: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().aiModelConfig).toBeNull();
  });

  it('returns 400 for invalid provider shape', async () => {

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, stubLlmConfig, redis);

    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/ai-model',
      payload: { provider: 123, lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when the selected provider is not available on this platform', async () => {
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis);

    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/ai-model',
      payload: { provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5' },
    });

    expect(res.statusCode).toBe(400);
    delete process.env['LLM_API_KEY_OPENAI'];
  });

  it('returns 400 when a selected model is not available for the provider', async () => {
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis);

    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/ai-model',
      payload: { provider: 'openai', lightModel: 'claude-haiku-3-5', heavyModel: 'gpt-4o' },
    });

    expect(res.statusCode).toBe(400);
    delete process.env['LLM_API_KEY_OPENAI'];
  });

  it('returns 200 when selecting static ollama models', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{ aiModelConfig: null }])),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'ollama' }, redis);

    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/ai-model',
      payload: {
        provider: 'ollama',
        lightModel: 'qwen3-coder:30b',
        heavyModel: 'qwen3.6:35b-a3b-q4_K_M',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().aiModelConfig).toEqual({
      provider: 'ollama',
      lightModel: 'qwen3-coder:30b',
      heavyModel: 'qwen3.6:35b-a3b-q4_K_M',
    });
  });

  it('returns 400 when selecting an ollama model outside the static list', async () => {
    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'ollama' }, redis);

    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/ai-model',
      payload: {
        provider: 'ollama',
        lightModel: 'missing-model',
        heavyModel: 'qwen3.6:35b-a3b-q4_K_M',
      },
    });

    expect(res.statusCode).toBe(400);
  });
});
