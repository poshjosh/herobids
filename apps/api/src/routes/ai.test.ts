import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';
import { aiRoutes } from './ai.js';
import { clearOllamaModelCache } from '../ollama-model-discovery.js';

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

interface AvailableModelsTestResponse {
  providers: Array<{
    provider: string;
    models: Array<{
      id: string;
      pricing?: {
        label: string;
        source: string;
        inputUsdPer1M?: string;
        outputUsdPer1M?: string;
        requestUsd?: string;
      };
    }>;
  }>;
}

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
  catalog: { timeoutMs: 3_000, cacheTtlMs: 86_400_000, locality: 'auto' as const },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Ensure no real API keys are set
  delete process.env['LLM_API_KEY'];
  delete process.env['LLM_API_KEY_TEST-PROVIDER'];
  delete process.env['LLM_API_KEY_OPENAI'];
  delete process.env['LLM_API_KEY_ANTHROPIC'];
  delete process.env['LLM_API_KEY_OPENROUTER'];
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

  it('returns 503 for operator ollama when no usable baseUrl is set', async () => {
    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'ollama', model: 'qwen3:8b' }, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('no_ai_provider');
  });

  it('returns OpenRouter pricing metadata sourced from the fetched model payload', async () => {
    process.env['LLM_API_KEY_OPENROUTER'] = 'test-key';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'anthropic/claude-sonnet-4-5',
            pricing: {
              prompt: '0.00000015',
              completion: '0.00000060',
              request: '0.001',
            },
          },
          {
            id: 'openai/gpt-4o',
            pricing: {
              prompt: '0.00000250',
              completion: '0.00001000',
              request: '0.003',
            },
          },
          {
            id: 'meta-llama/llama-3.3-70b-instruct',
            pricing: {
              prompt: '0.00000012',
              completion: '0.00000050',
              request: '0.002',
            },
          },
          {
            id: 'google/gemini-2.5-flash',
            pricing: {
              prompt: '0.00000018',
              completion: '0.00000072',
              request: '0.0025',
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5' }, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('openrouter');
    expect(body.providers[0]!.models.some((model) => model.id === 'google/gemini-2.5-flash')).toBe(true);
    expect(body.providers[0]!.models.find((model) => model.id === 'google/gemini-2.5-flash')!.pricing).toEqual({
      label: '$0.18 / $0.72',
      source: 'openrouter',
      inputUsdPer1M: '0.180000',
      outputUsdPer1M: '0.720000',
      requestUsd: '0.0025',
    });

    vi.unstubAllGlobals();
    delete process.env['LLM_API_KEY_OPENROUTER'];
  });

  it('does not label OpenRouter as Free when only partial pricing fields are zero', async () => {
    process.env['LLM_API_KEY_OPENROUTER'] = 'test-key';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'anthropic/claude-sonnet-4-5',
            pricing: {
              request: '0',
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5' }, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('openrouter');
    expect(body.providers[0]!.models).toHaveLength(0);

    vi.unstubAllGlobals();
    delete process.env['LLM_API_KEY_OPENROUTER'];
  });

  it('drops negative OpenRouter sentinel prices instead of surfacing them in model labels', async () => {
    process.env['LLM_API_KEY_OPENROUTER'] = 'test-key';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'openai/gpt-5.4',
            pricing: {
              prompt: '-1',
              completion: '-1',
              request: '-1',
            },
          },
          {
            id: 'anthropic/claude-sonnet-4-5',
            pricing: {
              prompt: '0.00000100',
              completion: '0.00000300',
              request: '0.001',
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openrouter', model: 'openai/gpt-5.4' }, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.models.find((model) => model.id === 'openai/gpt-5.4')).toBeUndefined();
    expect(body.providers[0]!.models.find((model) => model.id === 'anthropic/claude-sonnet-4-5')!.pricing).toEqual({
      label: '$1 / $3',
      source: 'openrouter',
      inputUsdPer1M: '1.000000',
      outputUsdPer1M: '3.000000',
      requestUsd: '0.001',
    });

    vi.unstubAllGlobals();
    delete process.env['LLM_API_KEY_OPENROUTER'];
  });

  it('does not surface $0 / $0 when token prices are zero but request pricing is invalid', async () => {
    process.env['LLM_API_KEY_OPENROUTER'] = 'test-key';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'openai/gpt-5.4-mini',
            pricing: {
              prompt: '0',
              completion: '0',
              request: '-1',
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openrouter', model: 'openai/gpt-5.4-mini' }, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.models.find((model) => model.id === 'openai/gpt-5.4-mini')).toBeUndefined();

    vi.unstubAllGlobals();
    delete process.env['LLM_API_KEY_OPENROUTER'];
  });

  it('does not invent pricing labels for non-OpenRouter remote providers', async () => {
    process.env['LLM_API_KEY_OPENAI'] = 'test-key';

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai', model: 'gpt-4o' }, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('openai');
    expect(body.providers[0]!.models.every((model) => model.pricing === undefined)).toBe(true);

    delete process.env['LLM_API_KEY_OPENAI'];
  });

  it('reuses cached OpenRouter pricing metadata across requests within TTL', async () => {
    process.env['LLM_API_KEY_OPENROUTER'] = 'test-key';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'anthropic/claude-sonnet-4-5',
            pricing: {
              prompt: '0.00000020',
              completion: '0.00000080',
              request: '0',
            },
          },
          {
            id: 'openai/gpt-4o',
            pricing: {
              prompt: '0.00000020',
              completion: '0.00000080',
              request: '0',
            },
          },
          {
            id: 'meta-llama/llama-3.3-70b-instruct',
            pricing: {
              prompt: '0.00000020',
              completion: '0.00000080',
              request: '0',
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, {
      ...stubLlmConfig,
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-5',
      baseUrl: 'https://openrouter-cache-test.example/v1',
    }, redis);

    const first = await app.inject({ method: 'GET', url: '/ai/available-models' });
    const second = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    delete process.env['LLM_API_KEY_OPENROUTER'];
  });

  it('preserves explicit zero-valued numeric fields when all OpenRouter priced models are free', async () => {
    process.env['LLM_API_KEY_OPENROUTER'] = 'test-key';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'anthropic/claude-sonnet-4-5',
            pricing: {
              prompt: '0',
              completion: '0',
              request: '0',
            },
          },
          {
            id: 'openai/gpt-4o',
            pricing: {
              prompt: '0',
              completion: '0',
              request: '0',
            },
          },
          {
            id: 'meta-llama/llama-3.3-70b-instruct',
            pricing: {
              prompt: '0',
              completion: '0',
              request: '0',
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5' }, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('openrouter');
    expect(body.providers[0]!.models.find((model) => model.id === 'openai/gpt-4o')!.pricing).toEqual({
      label: 'Free',
      source: 'openrouter',
      inputUsdPer1M: '0.000000',
      outputUsdPer1M: '0.000000',
      requestUsd: '0',
    });

    vi.unstubAllGlobals();
    delete process.env['LLM_API_KEY_OPENROUTER'];
  });

  it('preserves model-level requestUsd formatting when present', async () => {
    process.env['LLM_API_KEY_OPENROUTER'] = 'test-key';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'anthropic/claude-sonnet-4-5',
            pricing: {
              prompt: '0.00000020',
              completion: '0.00000080',
              request: '0',
            },
          },
          {
            id: 'openai/gpt-4o',
            pricing: {
              prompt: '0.00000020',
              completion: '0.00000080',
              request: '0.0',
            },
          },
          {
            id: 'meta-llama/llama-3.3-70b-instruct',
            pricing: {
              prompt: '0.00000020',
              completion: '0.00000080',
              request: '0.000',
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5' }, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('openrouter');
    expect(body.providers[0]!.models.find((model) => model.id === 'anthropic/claude-sonnet-4-5')!.pricing).toEqual({
      label: '$0.2 / $0.8',
      source: 'openrouter',
      inputUsdPer1M: '0.200000',
      outputUsdPer1M: '0.800000',
      requestUsd: '0',
    });
    expect(body.providers[0]!.models.find((model) => model.id === 'openai/gpt-4o')!.pricing?.requestUsd).toBe('0.0');

    vi.unstubAllGlobals();
    delete process.env['LLM_API_KEY_OPENROUTER'];
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

  it('returns 400 when selecting ollama with no usable baseUrl configured', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{ aiModelConfig: null }])),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'ollama', model: 'qwen3:8b' }, redis);

    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/ai-model',
      payload: {
        provider: 'ollama',
        lightModel: 'qwen3:8b',
        heavyModel: 'qwen3:8b',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual([
      {
        code: 'custom',
        path: ['provider'],
        message: 'Selected provider is not available on this platform',
      },
    ]);
  });

  it('returns 400 when selecting an ollama model not in the discovered or fallback set', async () => {
    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'ollama', model: 'qwen3:8b' }, redis);

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

// ─── GET /ai/available-models — Ollama dynamic discovery ─────────────────────

describe('GET /ai/available-models — Ollama dynamic discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['LLM_API_KEY'];
  });

  it('returns dynamically discovered models when baseUrl is configured and /api/tags succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'deepseek-r1:latest' },
          { name: 'llama3:8b' },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, {
      ...stubLlmConfig,
      provider: 'ollama',
      model: 'deepseek-r1:latest',
      baseUrl: 'http://localhost:11434/v1',
    }, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]!.provider).toBe('ollama');
    expect(body.providers[0]!.models.map((model) => model.id)).toContain('deepseek-r1:latest');
    expect(body.providers[0]!.models.map((model) => model.id)).toContain('llama3:8b');

    vi.unstubAllGlobals();
  });

  it('returns ollama with configured model as fallback when /api/tags is unavailable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, {
      ...stubLlmConfig,
      provider: 'ollama',
      model: 'qwen3:8b',
      baseUrl: 'http://localhost:11434/v1',
    }, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    // Must NOT return 503 — ollama is configured and must be surfaced even on discovery failure
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('ollama');
    // Operator-configured model must always appear
    expect(body.providers[0]!.models.map((model) => model.id)).toContain('qwen3:8b');

    vi.unstubAllGlobals();
  });

  it('marks ollama as Free only when the configured endpoint is local', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'qwen3:8b' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, {
      ...stubLlmConfig,
      provider: 'ollama',
      model: 'qwen3:8b',
      baseUrl: 'http://localhost:11434/v1',
    }, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('ollama');
    expect(body.providers[0]!.models[0]!.pricing).toEqual({ label: 'Free', source: 'local' });

    vi.unstubAllGlobals();
  });

  it('does not mark remote ollama endpoints as Free', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'qwen3:8b' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, {
      ...stubLlmConfig,
      provider: 'ollama',
      model: 'qwen3:8b',
      baseUrl: 'https://remote-ollama.example.com/v1',
    }, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('ollama');
    expect(body.providers[0]!.models[0]!.pricing).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('marks ollama as Free when locality override is local even for a non-local host', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'qwen3:8b' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, {
      ...stubLlmConfig,
      provider: 'ollama',
      model: 'qwen3:8b',
      baseUrl: 'https://proxy.example.com/v1',
      catalog: { ...stubLlmConfig.catalog, locality: 'local' },
    }, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('ollama');
    expect(body.providers[0]!.models[0]!.pricing).toEqual({ label: 'Free', source: 'local' });

    vi.unstubAllGlobals();
  });

  it('does not mark localhost ollama as Free when locality override is remote', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'qwen3:8b' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, {
      ...stubLlmConfig,
      provider: 'ollama',
      model: 'qwen3:8b',
      baseUrl: 'http://localhost:11434/v1',
      catalog: { ...stubLlmConfig.catalog, locality: 'remote' },
    }, redis);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('ollama');
    expect(body.providers[0]!.models[0]!.pricing).toBeUndefined();

    vi.unstubAllGlobals();
  });
});

// ─── PATCH /settings/ai-model — Ollama dynamic validation ────────────────────

describe('PATCH /settings/ai-model — Ollama dynamic validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['LLM_API_KEY'];
  });

  it('accepts a dynamically discovered ollama model that is not in the static list', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'deepseek-r1:latest' }, { name: 'llama3:8b' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{ aiModelConfig: null }])),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, {
      ...stubLlmConfig,
      provider: 'ollama',
      model: 'deepseek-r1:latest',
      baseUrl: 'http://localhost:11434/v1',
    }, redis);

    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/ai-model',
      payload: { provider: 'ollama', lightModel: 'llama3:8b', heavyModel: 'deepseek-r1:latest' },
    });

    expect(res.statusCode).toBe(200);

    vi.unstubAllGlobals();
  });

  it('rejects an ollama model absent from both discovered and fallback sets', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'deepseek-r1:latest' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, {
      ...stubLlmConfig,
      provider: 'ollama',
      model: 'deepseek-r1:latest',
      baseUrl: 'http://localhost:11434/v1',
    }, redis);

    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/ai-model',
      payload: { provider: 'ollama', lightModel: 'ghost-model:latest', heavyModel: 'deepseek-r1:latest' },
    });

    expect(res.statusCode).toBe(400);

    vi.unstubAllGlobals();
  });
});

// ─── Persisted Ollama selection revalidation ──────────────────────────────

describe('persisted Ollama model revalidation', () => {
  it('GET /settings/ai-model returns null when persisted Ollama model is no longer in discovered catalog', async () => {
    clearOllamaModelCache();
    // Discovery returns only deepseek-r1, but user has llama3:8b persisted
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'deepseek-r1:latest' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{
        aiModelConfig: { provider: 'ollama', lightModel: 'llama3:8b', heavyModel: 'llama3:8b' },
      }])),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, {
      ...stubLlmConfig,
      provider: 'ollama',
      model: 'deepseek-r1:latest',
      baseUrl: 'http://localhost:11434/v1',
    }, redis);

    const res = await app.inject({ method: 'GET', url: '/settings/ai-model' });
    expect(res.statusCode).toBe(200);
    expect(res.json().aiModelConfig).toBeNull();

    vi.unstubAllGlobals();
  });

  it('POST /ai/generate-config falls back to operator config when persisted Ollama model is stale', async () => {
    clearOllamaModelCache();
    // Discovery returns only deepseek-r1, but user has llama3:8b persisted
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'deepseek-r1:latest' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { callLlmProvider } = await import('@herobids/llm');
    const callMock = vi.mocked(callLlmProvider);
    callMock.mockResolvedValue({
      ok: true,
      data: {
        content: '{"strategy":{"preset":"momentum","params":{}},"risk":{"maxPositionSizePct":5,"stopLossPct":2,"takeProfitPct":4},"execution":{"mode":"paper"}}',
        model: 'deepseek-r1:latest',
        tokensUsed: 50,
      },
    });

    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{
        aiModelConfig: { provider: 'ollama', lightModel: 'llama3:8b', heavyModel: 'llama3:8b' },
      }])),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, {
      ...stubLlmConfig,
      provider: 'ollama',
      model: 'deepseek-r1:latest',
      baseUrl: 'http://localhost:11434/v1',
    }, redis);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/generate-config',
      payload: { text: 'Momentum strategy for BTC' },
    });

    expect(res.statusCode).toBe(200);
    // The stale llama3:8b should NOT have been used; operator default deepseek-r1 should be
    const callArgs = callMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.model).toBe('deepseek-r1:latest');

    vi.unstubAllGlobals();
  });
});

