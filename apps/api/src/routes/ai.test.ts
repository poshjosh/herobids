import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';
import type { ProvidersYaml } from '@herobids/domain';
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
  catalog: { timeoutMs: 3_000, cacheTtlMs: 86_400_000 },
};

const stubAgentRuntime = {
  llm: {},
} as import('@herobids/domain').AgentRuntimeConfig;

// ─── Providers YAML mocks ─────────────────────────────────────────────────

const emptyProvidersYaml: ProvidersYaml = { providers: {} };

const mockOpenaiProvidersYaml: ProvidersYaml = {
  providers: {
    openai: {
      catalogMode: 'static',
      models: {
        'gpt-4o': { inputUsdPerM: 2.5, outputUsdPerM: 10 },
        'gpt-4o-mini': { inputUsdPerM: 0.15, outputUsdPerM: 0.6 },
      },
    },
  },
};

const mockOpenrouterProvidersYaml: ProvidersYaml = {
  providers: {
    openrouter: {
      catalogMode: 'dynamic',
      isMultiProvider: true,
      models: {},
    },
  },
};

const mockOllamaProvidersYaml: ProvidersYaml = {
  providers: {
    ollama: {
      catalogMode: 'dynamic',
      devOnly: true,
      baseUrl: 'http://localhost:11434/v1',
      models: {},
    },
  },
};

/**
 * Build a DB mock that returns the given models as an active OpenRouter pricing
 * snapshot (simulates a row in `llm_pricing_snapshots`).
 */
function buildDbWithOpenrouterSnapshot(
  models: Record<string, { inputUsdPerM: number; outputUsdPerM: number }>,
): Database {
  return {
    select: vi.fn().mockImplementation(() => makeChain([{ models }])),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
  } as unknown as Database;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env['NODE_ENV'] = 'development';
  // Set a generic API key so providers pass API key gating by default.
  // Individual tests that need to verify no-key behavior should delete it.
  process.env['LLM_API_KEY'] = 'sk-test';
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
    await aiRoutes(app, db, stubLlmConfig, redis, emptyProvidersYaml, stubAgentRuntime);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('no_ai_provider');
  });

  it('returns providers listed in the yaml config', async () => {
    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, stubLlmConfig, redis, mockOpenaiProvidersYaml, stubAgentRuntime);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.providers).toBeInstanceOf(Array);
    const providers = body.providers as Array<{ provider: string }>;
    expect(providers.some((p) => p.provider === 'openai')).toBe(true);
    // Providers absent from the yaml must NOT appear
    expect(providers.every((p) => p.provider !== 'anthropic')).toBe(true);
  });

  it('returns exactly the providers present in the yaml (no extras)', async () => {
    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis, mockOpenaiProvidersYaml, stubAgentRuntime);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ providers: Array<{ provider: string }> }>();
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]!.provider).toBe('openai');
  });

  it('returns ollama with fallback model when no baseUrl is configured (no live discovery)', async () => {
    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'ollama', model: 'qwen3:8b' }, redis, mockOllamaProvidersYaml, stubAgentRuntime);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('ollama');
    // Operator-configured model must appear as the fallback when discovery is unavailable
    expect(body.providers[0]!.models.map((m) => m.id)).toContain('qwen3:8b');
  });

  it('returns OpenRouter pricing metadata sourced from the DB pricing snapshot', async () => {
    const db = buildDbWithOpenrouterSnapshot({
      'anthropic/claude-sonnet-4-5': { inputUsdPerM: 0.15, outputUsdPerM: 0.6 },
      'openai/gpt-4o': { inputUsdPerM: 2.5, outputUsdPerM: 10 },
      'meta-llama/llama-3.3-70b-instruct': { inputUsdPerM: 0.12, outputUsdPerM: 0.5 },
      'google/gemini-2.5-flash': { inputUsdPerM: 0.18, outputUsdPerM: 0.72 },
    });
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5' }, redis, mockOpenrouterProvidersYaml, stubAgentRuntime);

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
    });
  });

  it('returns openrouter with an empty models list when no DB pricing snapshot is available', async () => {
    const db = buildEmptyDb(); // no snapshot rows
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5' }, redis, mockOpenrouterProvidersYaml, stubAgentRuntime);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('openrouter');
    expect(body.providers[0]!.models).toHaveLength(0);
  });

  it('drops OpenRouter models with negative DB snapshot prices instead of surfacing them', async () => {
    const db = buildDbWithOpenrouterSnapshot({
      'openai/gpt-5.4': { inputUsdPerM: -1, outputUsdPerM: -1 }, // sentinel negative — must be filtered
      'anthropic/claude-sonnet-4-5': { inputUsdPerM: 1, outputUsdPerM: 3 },
    });
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openrouter', model: 'openai/gpt-5.4' }, redis, mockOpenrouterProvidersYaml, stubAgentRuntime);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.models.find((model) => model.id === 'openai/gpt-5.4')).toBeUndefined();
    expect(body.providers[0]!.models.find((model) => model.id === 'anthropic/claude-sonnet-4-5')!.pricing).toEqual({
      label: '$1 / $3',
      source: 'openrouter',
      inputUsdPer1M: '1.000000',
      outputUsdPer1M: '3.000000',
    });
  });

  it('labels OpenRouter models with zero DB snapshot prices as Free', async () => {
    const db = buildDbWithOpenrouterSnapshot({
      'openai/gpt-5.4-mini': { inputUsdPerM: 0, outputUsdPerM: 0 },
    });
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openrouter', model: 'openai/gpt-5.4-mini' }, redis, mockOpenrouterProvidersYaml, stubAgentRuntime);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    const model = body.providers[0]!.models.find((m) => m.id === 'openai/gpt-5.4-mini');
    expect(model).toBeDefined();
    expect(model!.pricing?.label).toBe('Free');
  });

  it('does not invent pricing labels for non-OpenRouter remote providers', async () => {
    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai', model: 'gpt-4o' }, redis, mockOpenaiProvidersYaml, stubAgentRuntime);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('openai');
    expect(body.providers[0]!.models.every((model) => model.pricing === undefined)).toBe(true);
  });

  it('returns consistent OpenRouter models for repeated requests', async () => {
    const snapshot = {
      'anthropic/claude-sonnet-4-5': { inputUsdPerM: 0.2, outputUsdPerM: 0.8 },
      'openai/gpt-4o': { inputUsdPerM: 0.2, outputUsdPerM: 0.8 },
      'meta-llama/llama-3.3-70b-instruct': { inputUsdPerM: 0.2, outputUsdPerM: 0.8 },
    };
    const db = buildDbWithOpenrouterSnapshot(snapshot);
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, {
      ...stubLlmConfig,
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-5',
    }, redis, mockOpenrouterProvidersYaml, stubAgentRuntime);

    const first = await app.inject({ method: 'GET', url: '/ai/available-models' });
    const second = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual(second.json());
  });

  it('preserves explicit zero-valued numeric fields when all OpenRouter priced models are free', async () => {
    const db = buildDbWithOpenrouterSnapshot({
      'anthropic/claude-sonnet-4-5': { inputUsdPerM: 0, outputUsdPerM: 0 },
      'openai/gpt-4o': { inputUsdPerM: 0, outputUsdPerM: 0 },
      'meta-llama/llama-3.3-70b-instruct': { inputUsdPerM: 0, outputUsdPerM: 0 },
    });
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5' }, redis, mockOpenrouterProvidersYaml, stubAgentRuntime);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('openrouter');
    expect(body.providers[0]!.models.find((model) => model.id === 'openai/gpt-4o')!.pricing).toEqual({
      label: 'Free',
      source: 'openrouter',
      inputUsdPer1M: '0.000000',
      outputUsdPer1M: '0.000000',
    });
  });

  it('formats pricing labels correctly from DB snapshot values', async () => {
    const db = buildDbWithOpenrouterSnapshot({
      'anthropic/claude-sonnet-4-5': { inputUsdPerM: 0.2, outputUsdPerM: 0.8 },
      'openai/gpt-4o': { inputUsdPerM: 2.5, outputUsdPerM: 10 },
      'meta-llama/llama-3.3-70b-instruct': { inputUsdPerM: 0.12, outputUsdPerM: 0.5 },
    });
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5' }, redis, mockOpenrouterProvidersYaml, stubAgentRuntime);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('openrouter');
    expect(body.providers[0]!.models.find((model) => model.id === 'anthropic/claude-sonnet-4-5')!.pricing).toEqual({
      label: '$0.2 / $0.8',
      source: 'openrouter',
      inputUsdPer1M: '0.200000',
      outputUsdPer1M: '0.800000',
    });
    expect(body.providers[0]!.models.find((model) => model.id === 'openai/gpt-4o')!.pricing).toEqual({
      label: '$2.5 / $10',
      source: 'openrouter',
      inputUsdPer1M: '2.500000',
      outputUsdPer1M: '10.000000',
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
    await aiRoutes(app, db, stubLlmConfig, redis, emptyProvidersYaml, stubAgentRuntime);

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
    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    app.setErrorHandler((error, _request, reply) => {
      reply.status(500).send({ message: error.message, stack: error.stack });
    });
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis, mockOpenaiProvidersYaml, stubAgentRuntime);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/generate-config',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 429 when rate limit exceeded', async () => {
    const db = buildEmptyDb();
    const redis = buildMockRedis({ incr: vi.fn().mockResolvedValue(11) });
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis, mockOpenaiProvidersYaml, stubAgentRuntime);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/generate-config',
      payload: { text: 'Generate momentum strategy' },
    });
    expect(res.statusCode).toBe(429);
  });

  it('returns 200 with configData when LLM returns valid JSON', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{ aiModelConfig: null }])),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis, mockOpenaiProvidersYaml, stubAgentRuntime);

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
  });
});

// ─── POST /ai/analyze-portfolio ───────────────────────────────────────────

describe('POST /ai/analyze-portfolio', () => {
  it('returns 503 when no provider is configured', async () => {

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, stubLlmConfig, redis, emptyProvidersYaml, stubAgentRuntime);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/analyze-portfolio',
      payload: { totalPnl: '100', tradeCount: 5 },
    });
    expect(res.statusCode).toBe(503);
  });

  it('returns 400 for invalid body (wrong types)', async () => {
    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis, mockOpenaiProvidersYaml, stubAgentRuntime);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/analyze-portfolio',
      payload: { tradeCount: 'not-a-number' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── POST /ai/explain-signal ──────────────────────────────────────────────

describe('POST /ai/explain-signal', () => {
  it('returns 503 when no provider is configured', async () => {

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, stubLlmConfig, redis, emptyProvidersYaml, stubAgentRuntime);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/explain-signal',
      payload: { signal: { type: 'buy', confidence: 0.8 } },
    });
    expect(res.statusCode).toBe(503);
  });

  it('returns 400 when signal is missing', async () => {
    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis, mockOpenaiProvidersYaml, stubAgentRuntime);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/explain-signal',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
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
    await aiRoutes(app, db, stubLlmConfig, redis, mockOpenaiProvidersYaml, stubAgentRuntime);

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
    await aiRoutes(app, db, stubLlmConfig, redis, emptyProvidersYaml, stubAgentRuntime);

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
    // openai yaml only has gpt-4o and gpt-4o-mini — claude-haiku-3-5 is not openai → null
    await aiRoutes(app, db, stubLlmConfig, redis, mockOpenaiProvidersYaml, stubAgentRuntime);

    const res = await app.inject({ method: 'GET', url: '/settings/ai-model' });
    expect(res.statusCode).toBe(200);
    expect(res.json().aiModelConfig).toBeNull();
  });
});

describe('PATCH /settings/ai-model', () => {
  it('returns 200 and updated config when valid body provided', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{ aiModelConfig: null }])),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis, mockOpenaiProvidersYaml, stubAgentRuntime);

    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/ai-model',
      payload: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().aiModelConfig).toEqual({ provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' });
  });

  it('returns 200 when setting a field to null (clearing preference)', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }])),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, stubLlmConfig, redis, emptyProvidersYaml, stubAgentRuntime);

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
    await aiRoutes(app, db, stubLlmConfig, redis, emptyProvidersYaml, stubAgentRuntime);

    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/ai-model',
      payload: { provider: 123, lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when the selected provider is not available on this platform', async () => {
    // mockOpenaiProvidersYaml only has openai — anthropic is not available
    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis, mockOpenaiProvidersYaml, stubAgentRuntime);

    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/ai-model',
      payload: { provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when a selected model is not available for the provider', async () => {
    // claude-haiku-3-5 is not in mockOpenaiProvidersYaml’s openai model list
    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis, mockOpenaiProvidersYaml, stubAgentRuntime);

    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/ai-model',
      payload: { provider: 'openai', lightModel: 'claude-haiku-3-5', heavyModel: 'gpt-4o' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when the selected provider is not present in the yaml config', async () => {
    // mockOpenaiProvidersYaml has no ollama entry — selecting ollama must be rejected
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{ aiModelConfig: null }])),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'openai' }, redis, mockOpenaiProvidersYaml, stubAgentRuntime);

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
    await aiRoutes(app, db, { ...stubLlmConfig, provider: 'ollama', model: 'qwen3:8b' }, redis, mockOllamaProvidersYaml, stubAgentRuntime);

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
    clearOllamaModelCache();
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
    }, redis, mockOllamaProvidersYaml, stubAgentRuntime);

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
    }, redis, mockOllamaProvidersYaml, stubAgentRuntime);

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
    }, redis, mockOllamaProvidersYaml, stubAgentRuntime);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('ollama');
    expect(body.providers[0]!.models[0]!.pricing).toEqual({ label: 'Free', source: 'local' });

    vi.unstubAllGlobals();
  });

  it('hides ollama devOnly providers in staging', async () => {
    vi.stubEnv('NODE_ENV', 'staging');

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    const remoteOllamaYaml: ProvidersYaml = {
      providers: {
        ollama: {
          catalogMode: 'dynamic',
          devOnly: true,
          baseUrl: 'https://remote-ollama.example.com/v1',
          models: {},
        },
      },
    };
    await aiRoutes(app, db, {
      ...stubLlmConfig,
      provider: 'ollama',
      model: 'qwen3:8b',
      baseUrl: 'https://remote-ollama.example.com/v1',
    }, redis, remoteOllamaYaml, stubAgentRuntime);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    // devOnly providers are hidden outside development.
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('no_ai_provider');

    vi.unstubAllEnvs();
  });

  it('hides ollama devOnly providers in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    const remoteOllamaYaml: ProvidersYaml = {
      providers: {
        ollama: {
          catalogMode: 'dynamic',
          devOnly: true,
          baseUrl: 'https://remote-ollama.example.com/v1',
          models: {},
        },
      },
    };
    await aiRoutes(app, db, {
      ...stubLlmConfig,
      provider: 'ollama',
      model: 'qwen3:8b',
      baseUrl: 'https://remote-ollama.example.com/v1',
    }, redis, remoteOllamaYaml, stubAgentRuntime);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    // devOnly providers are hidden outside development
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('no_ai_provider');

    vi.unstubAllEnvs();
  });

  it('marks ollama as Free in development environments', async () => {
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
    }, redis, mockOllamaProvidersYaml, stubAgentRuntime);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailableModelsTestResponse>();
    expect(body.providers[0]!.provider).toBe('ollama');
    expect(body.providers[0]!.models[0]!.pricing).toEqual({ label: 'Free', source: 'local' });

    vi.unstubAllGlobals();
  });

  it('hides ollama devOnly providers in production even for localhost', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const db = buildEmptyDb();
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await aiRoutes(app, db, {
      ...stubLlmConfig,
      provider: 'ollama',
      model: 'qwen3:8b',
      baseUrl: 'http://localhost:11434/v1',
    }, redis, mockOllamaProvidersYaml, stubAgentRuntime);

    const res = await app.inject({ method: 'GET', url: '/ai/available-models' });
    // devOnly providers are hidden when NODE_ENV is production, regardless of hostname
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('no_ai_provider');

    vi.unstubAllEnvs();
  });
});

// ─── PATCH /settings/ai-model — Ollama dynamic validation ────────────────────

describe('PATCH /settings/ai-model — Ollama dynamic validation', () => {
  beforeEach(() => {
    clearOllamaModelCache();
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
    }, redis, mockOllamaProvidersYaml, stubAgentRuntime);

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
    }, redis, mockOllamaProvidersYaml, stubAgentRuntime);

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
    }, redis, mockOllamaProvidersYaml, stubAgentRuntime);

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
    }, redis, mockOllamaProvidersYaml, stubAgentRuntime);

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

