import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { agentInteractivityRoutes, telegramWebhookHandler } from './agent-interactivity.js';
import type { Database } from '@herobids/db';
import type { AlertsConfig } from '@herobids/domain';
import { AGENT_STREAM_MAXLEN } from '@herobids/domain';
import type { Redis } from 'ioredis';

const TEST_USER_ID = 'user-1';
const AGENT_ID = 'agent-1';

/** Flush all pending promise micro-tasks — needed after webhook inject calls
 *  because the handler now fires delivery work asynchronously. */
function flushPromises() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.decorateRequest('isAdmin', false);
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = 'free';
    request.isAdmin = false;
  });
}

function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'offset']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

const stubAgent = {
  id: AGENT_ID,
  userId: TEST_USER_ID,
  name: 'My Agent',
  prompt: 'Trade BTC aggressively',
  skillIds: [],
  status: 'stopped',
  toolPolicy: null,
  modelPolicy: null,
  telegramChatId: null,
  executionMode: null,
  dailyTokenBudget: null,
  dailyLossLimit: null,
  maxBots: null,
  maxSlippageBps: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function buildAgentDb(agent: Record<string, unknown> | null) {
  const rows = agent ? [agent] : [];
  return {
    select: vi.fn().mockImplementation(() => makeChain(rows)),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  } as unknown as Database;
}

function buildMockRedis(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    xadd: vi.fn().mockResolvedValue('1-1'),
    hgetall: vi.fn().mockResolvedValue(null),
    get: vi.fn().mockResolvedValue(null),
    fetch: vi.fn(),
    ...overrides,
  } as unknown as Redis;
}

function buildAlertsConfig(telegramOverrides: Partial<AlertsConfig['telegram']> = {}): AlertsConfig {
  return {
    enabled: false,
    dispatchIntervalMs: 10_000,
    defaultCooldownMs: 0,
    maxBatchSize: 10,
    maxRetries: 3,
    telegram: {
      botToken: 'test-token',
      webhookSecret: 'telegram-secret',
      channels: [],
      ...telegramOverrides,
    },
    email: {
      apiKey: '',
      fromEmail: '',
      timeoutMs: 10_000,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── PUT /agents/:id ──────────────────────────────────────────────────────

describe('PUT /agents/:id', () => {
  it('returns 200 when agent is stopped and body is complete', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1 ? [stubAgent] : [stubAgent]);
      }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${AGENT_ID}`,
      payload: { name: 'Updated', prompt: 'New prompt' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('stores and returns only canonical model fields', async () => {
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    let selectCount = 0;
    const updatedAgent = {
      ...stubAgent,
      name: 'Updated',
      prompt: 'New prompt',
      modelPolicy: {
        provider: 'openai',
        lightModel: 'gpt-4o-mini',
        heavyModel: 'gpt-4o',
      },
    };
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1 ? [stubAgent] : [updatedAgent]);
      }),
      update: vi.fn().mockReturnValue({ set: updateSet }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${AGENT_ID}`,
      payload: {
        name: 'Updated',
        prompt: 'New prompt',
        provider: 'openai',
        lightModel: 'gpt-4o-mini',
        heavyModel: 'gpt-4o',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      modelPolicy: {
        provider: 'openai',
        lightModel: 'gpt-4o-mini',
        heavyModel: 'gpt-4o',
      },
    }));
    expect(res.json()).toEqual(expect.objectContaining({
      provider: 'openai',
      lightModel: 'gpt-4o-mini',
      heavyModel: 'gpt-4o',
    }));
    expect(res.json().scoutModel).toBeUndefined();
  });

  it('rejects an ollama model that is not in the discovered catalog when catalog context is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'deepseek-r1:latest' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = buildAgentDb({
      ...stubAgent,
      modelPolicy: {
        provider: 'ollama',
        lightModel: 'deepseek-r1:latest',
        heavyModel: 'deepseek-r1:latest',
      },
    });
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(
      app,
      db,
      redis,
      undefined,
      {
        db: db,
        providersYaml: {
          providers: {
            ollama: {
              catalogMode: 'dynamic',
              models: {},
            },
          },
        },
        context: {
          provider: 'ollama',
          model: 'deepseek-r1:latest',
          baseUrl: 'http://localhost:11434/v1',
          catalogTimeoutMs: 3_000,
          catalogCacheTtlMs: 86_400_000,
        },
      },
    );

    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${AGENT_ID}`,
      payload: {
        name: 'Updated',
        prompt: 'New prompt',
        provider: 'ollama',
        lightModel: 'ghost-model:latest',
        heavyModel: 'deepseek-r1:latest',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual([
      {
        code: 'custom',
        path: ['lightModel'],
        message: 'Selected economy model is not available for this provider',
      },
    ]);

    vi.unstubAllGlobals();
  });

  it('normalizes capital on PUT', async () => {
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    let selectCount = 0;
    const updatedAgent = {
      ...stubAgent,
      name: 'Updated',
      prompt: 'New prompt',
      capital: '750',
    };
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1 ? [stubAgent] : [updatedAgent]);
      }),
      update: vi.fn().mockReturnValue({ set: updateSet }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${AGENT_ID}`,
      payload: {
        name: 'Updated',
        prompt: 'New prompt',
        capital: '750.00',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      capital: '750',
    }));
    expect(res.json()).toEqual(expect.objectContaining({
      capital: '750',
      dailyLlmTokenBudget: null,
    }));
  });

  it('preserves execution defaults when trading skills are removed on PUT', async () => {
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const insertOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    let selectCount = 0;
    const updatedAgent = {
      ...stubAgent,
      skillIds: ['task-management'],
      executionDefaults: null,
    };
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return makeChain([{ ...stubAgent, executionDefaults: { mode: 'paper' } }]);
        }
        if (selectCount === 2) {
          return makeChain([{ skillId: 'trading' }]);
        }
        if (selectCount === 3) {
          // hasAgentConnections lookup (agent_connections) — no active connections.
          return makeChain([]);
        }
        if (selectCount === 4) {
          return makeChain([{
            id: 'task-management',
            authorId: TEST_USER_ID,
            publicationStatus: 'published',
            priceCents: 0,
            currentRevisionId: 'task-management:v1',
          }]);
        }
        if (selectCount === 5) {
          return makeChain([]);
        }
        if (selectCount === 6) {
          return makeChain([]);
        }
        if (selectCount === 7) {
          return makeChain([{ skillId: 'trading', skillRevisionId: 'trading:v1' }]);
        }
        if (selectCount === 8) {
          return makeChain([updatedAgent]);
        }
        return makeChain([{ skillId: 'task-management' }]);
      }),
      update: vi.fn().mockReturnValue({ set: updateSet }),
      delete: vi.fn().mockReturnValue({ where: deleteWhere }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ onConflictDoUpdate: insertOnConflictDoUpdate }),
      }),
      transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${AGENT_ID}`,
      payload: {
        name: 'Updated',
        prompt: 'New prompt',
        skillIds: ['task-management'],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ executionDefaults: { mode: 'paper' } }));
  });

  it('returns 409 when agent is running', async () => {
    const db = buildAgentDb({ ...stubAgent, status: 'running' });
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${AGENT_ID}`,
      payload: { name: 'Updated', prompt: 'New prompt' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('agent_not_editable');
  });

  it('returns 409 when agent is crashed (only stopped allowed by PUT)', async () => {
    const db = buildAgentDb({ ...stubAgent, status: 'crashed' });
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${AGENT_ID}`,
      payload: { name: 'Updated', prompt: 'New prompt' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 400 when name is missing (required field)', async () => {
    const db = buildAgentDb(stubAgent);
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${AGENT_ID}`,
      payload: { prompt: 'New prompt' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('returns 404 when agent not found', async () => {
    const db = buildAgentDb(null);
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${AGENT_ID}`,
      payload: { name: 'Updated', prompt: 'New prompt' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('preserves an already-assigned non-selectable skill when updating unrelated fields', async () => {
    let selectCount = 0;
    const updatedAgent = {
      ...stubAgent,
      name: 'Updated',
    };
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return makeChain([{ ...stubAgent, name: 'Old', executionMode: null }]);
        }
        if (selectCount === 2) {
          return makeChain([{ skillId: 'paid-skill' }]);
        }
        if (selectCount === 3) {
          // hasAgentConnections lookup (agent_connections) — no active connections.
          return makeChain([]);
        }
        if (selectCount === 4) {
          return makeChain([{
            id: 'paid-skill',
            authorId: 'other-user',
            publicationStatus: 'delisted',
            priceCents: 500,
            currentRevisionId: 'paid-skill:v2',
          }]);
        }
        if (selectCount === 5) {
          return makeChain([]);
        }
        if (selectCount === 6) {
          return makeChain([]);
        }
        if (selectCount === 7) {
          return makeChain([{ skillId: 'paid-skill', skillRevisionId: 'paid-skill:v2' }]);
        }
        if (selectCount === 8) {
          return makeChain([updatedAgent]);
        }
        return makeChain([{ skillId: 'paid-skill' }]);
      }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }),
      }),
      transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${AGENT_ID}`,
      payload: { name: 'Updated', prompt: stubAgent.prompt, skillIds: ['paid-skill'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expect.objectContaining({
      name: 'Updated',
      skillIds: ['paid-skill'],
    }));
  });
});

// ─── POST /agents/:id/message ─────────────────────────────────────────────

describe('POST /agents/:id/message', () => {
  it('returns 202 when agent is running', async () => {
    const db = buildAgentDb({ ...stubAgent, status: 'running' });
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/message`,
      payload: { message: 'Hello agent' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().delivered).toBe(true);
    expect(redis.xadd).toHaveBeenCalledWith(
      `agent:outbound:${AGENT_ID}`, 'MAXLEN', '~', AGENT_STREAM_MAXLEN, '*', 'envelope', expect.any(String),
    );
  });

  it('returns 409 when agent is stopped', async () => {
    const db = buildAgentDb(stubAgent);
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/message`,
      payload: { message: 'Hello' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('agent_not_running');
  });

  it('returns 429 when rate limit exceeded', async () => {
    const db = buildAgentDb({ ...stubAgent, status: 'running' });
    const redis = buildMockRedis({ incr: vi.fn().mockResolvedValue(11) });
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/message`,
      payload: { message: 'Overload' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('rate_limited');
  });

  it('returns 400 when message is missing', async () => {
    const db = buildAgentDb({ ...stubAgent, status: 'running' });
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/message`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── GET /agents/:id/memory ───────────────────────────────────────────────

describe('GET /agents/:id/memory', () => {
  it('returns empty entries when redis hash is null', async () => {
    const db = buildAgentDb(stubAgent);
    const redis = buildMockRedis({ hgetall: vi.fn().mockResolvedValue(null) });
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/memory` });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toEqual([]);
  });

  it('returns filtered entries when prefix is specified', async () => {
    const db = buildAgentDb(stubAgent);
    const redis = buildMockRedis({
      hgetall: vi.fn().mockResolvedValue({ 'trade:1': 'buy', 'note:1': 'context' }),
    });
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/memory?prefix=trade` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].key).toBe('trade:1');
  });

  it('returns only keys when keysOnly=true', async () => {
    const db = buildAgentDb(stubAgent);
    const redis = buildMockRedis({
      hgetall: vi.fn().mockResolvedValue({ 'k1': 'v1', 'k2': 'v2' }),
    });
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/memory?keysOnly=true` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries[0]).not.toHaveProperty('value');
    expect(body.entries[0]).toHaveProperty('key');
  });

  it('returns 404 when agent not found', async () => {
    const db = buildAgentDb(null);
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/memory` });
    expect(res.statusCode).toBe(404);
  });
});

// ─── GET /agents/:id/prompt ───────────────────────────────────────────────

describe('GET /agents/:id/prompt', () => {
  it('returns 200 with full prompt shape when keys exist in Redis', async () => {
    const db = buildAgentDb(stubAgent);
    const redis = buildMockRedis({
      get: vi.fn()
        .mockResolvedValueOnce('Judge system prompt')
        .mockResolvedValueOnce('Scout system prompt')
        .mockResolvedValueOnce('User context text')
        .mockResolvedValueOnce('Judge user context text')
        .mockResolvedValueOnce('Hybrid system prompt'),
    });
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/prompt` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agentId).toBe(AGENT_ID);
    expect(body.judgeSystem).toBe('Judge system prompt');
    expect(body.scoutSystem).toBe('Scout system prompt');
    expect(body.userContext).toBe('User context text');
    expect(body.judgeUserContext).toBe('Judge user context text');
    expect(body.hybridSystem).toBe('Hybrid system prompt');
  });

  it('returns 404 when no prompt in Redis (agent not running)', async () => {
    const db = buildAgentDb(stubAgent);
    const redis = buildMockRedis({ get: vi.fn().mockResolvedValue(null) });
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/prompt` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('prompt_not_available');
  });

  it('returns 200 when only scout prompt surfaces exist', async () => {
    const db = buildAgentDb(stubAgent);
    const redis = buildMockRedis({
      get: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('Scout system prompt')
        .mockResolvedValueOnce('Scout user context')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    });
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/prompt` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.judgeSystem).toBeNull();
    expect(body.scoutSystem).toBe('Scout system prompt');
    expect(body.userContext).toBe('Scout user context');
    expect(body.judgeUserContext).toBeNull();
    expect(body.hybridSystem).toBeNull();
  });

  it('returns 404 when agent not owned by user', async () => {
    const db = buildAgentDb(null);
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/prompt` });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when the plan disallows viewing own prompts', async () => {
    const db = buildAgentDb(stubAgent);
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(
      app,
      db,
      redis,
      undefined,
      undefined,
      {
        defaultPlanId: 'free',
        plans: {
          free: {
            entitlements: {
              skills: {
                canCreatePrivateSkills: false,
                canViewMarketplaceSkills: true,
                canPublishToMarketplace: true,
                autoPublishNonDraftSkills: true,
                canPriceSkills: false,
                canLikeMarketplaceSkills: true,
              },
              agents: {
                canViewOwnPrompts: false,
              },
              limits: {
                maxAgents: 5,
                maxBots: 5,
                maxConnections: 5,
                maxCredentials: 5,
                maxBindings: 5,
                maxVenueAccounts: 5,
                maxConcurrentBacktests: 3,
                liveEnabled: false,
              },
            },
            usage: {},
          },
        },
      },
    );

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/prompt` });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('plan.agents_prompt_visibility_disabled');
  });
});

// ─── GET /agents/telegram-bot ─────────────────────────────────────────────

describe('GET /agents/telegram-bot', () => {
  it('returns 501 when Telegram is not configured', async () => {
    const db = buildAgentDb(null);
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    // No alertsConfig → no botToken
    await agentInteractivityRoutes(app, db, redis, buildAlertsConfig({ botToken: '' }));

    const res = await app.inject({ method: 'GET', url: '/agents/telegram-bot' });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_configured');
  });
});

// ─── POST /agents/verify-telegram ────────────────────────────────────────

describe('POST /agents/verify-telegram', () => {
  it('returns 501 when Telegram is not configured', async () => {
    const db = buildAgentDb(null);
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis, buildAlertsConfig({ botToken: '' }));

    const res = await app.inject({
      method: 'POST',
      url: '/agents/verify-telegram',
      payload: { chatId: '12345' },
    });
    expect(res.statusCode).toBe(501);
  });

  it('returns 400 when chatId is missing (token configured)', async () => {
    // Token must be non-empty so endpoint reaches body validation; mock fetch to avoid real HTTP
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ result: { username: 'test_bot' } }),
    } as Response);

    const db = buildAgentDb(null);
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis, buildAlertsConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/agents/verify-telegram',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    fetchSpy.mockRestore();
  });
});

describe('POST /telegram/webhook', () => {
  it('returns 501 when Telegram webhook auth is not fully configured', async () => {
    const app = Fastify();
    await telegramWebhookHandler(app, buildAgentDb(null), buildMockRedis(), buildAlertsConfig({ webhookSecret: '' }));

    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      payload: {},
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: 'not_configured' });
  });

  it('returns 401 when the webhook secret header is missing or wrong', async () => {
    const app = Fastify();
    await telegramWebhookHandler(app, buildAgentDb(null), buildMockRedis(), buildAlertsConfig());

    const missing = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      payload: {},
    });
    const wrong = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
      payload: {},
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
  });

  it('returns 200 when the webhook secret header matches', async () => {
    const app = Fastify();
    await telegramWebhookHandler(app, buildAgentDb(null), buildMockRedis(), buildAlertsConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('routes Telegram replies to the owning agent stream and confirms delivery', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        return makeChain(selectCount === 1
          ? [{ userId: TEST_USER_ID }]
          : [{ agentId: AGENT_ID, agentName: 'My Agent', status: 'active', userId: TEST_USER_ID }]);
      }),
    } as unknown as Database;
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: {
        message: {
          chat: { id: '12345' },
          text: 'Adjust the watchlist',
          reply_to_message: { message_id: 777 },
        },
      },
    });
    await flushPromises();

    expect(res.statusCode).toBe(200);
    expect(redis.xadd).toHaveBeenCalledWith(
      `agent:outbound:${AGENT_ID}`,
      'MAXLEN', '~', AGENT_STREAM_MAXLEN,
      '*',
      'envelope',
      expect.any(String),
    );
    expect(JSON.parse((redis.xadd as ReturnType<typeof vi.fn>).mock.calls[0][6] as string)).toEqual(expect.objectContaining({
      initiatorId: TEST_USER_ID,
      agentId: AGENT_ID,
      type: 'user.message',
      payload: { message: 'Adjust the watchlist' },
    }));
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.body).toContain('Delivered to My Agent.');
    fetchSpy.mockRestore();
  });

  it('routes replies from an agent-level chat override to the owning agent stream', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) {
          // User-level chat binding lookup — no match (the chat is only bound at agent level).
          return makeChain([]);
        }
        // resolveAgentForTelegramReply — resolves directly from the outbound
        // message record, returning the userId from the agent's owner row.
        return makeChain([{ agentId: AGENT_ID, agentName: 'My Agent', status: 'active', userId: TEST_USER_ID }]);
      }),
    } as unknown as Database;
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: {
        message: {
          chat: { id: 'agent-chat-1' },
          text: 'Use the override route',
          reply_to_message: { message_id: 777 },
        },
      },
    });
    await flushPromises();

    expect(res.statusCode).toBe(200);
    expect(redis.xadd).toHaveBeenCalledTimes(1);
    expect(JSON.parse((redis.xadd as ReturnType<typeof vi.fn>).mock.calls[0][6] as string)).toEqual(expect.objectContaining({
      initiatorId: TEST_USER_ID,
      agentId: AGENT_ID,
      payload: { message: 'Use the override route' },
    }));
    expect(String((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? '')).toContain('Delivered to My Agent.');
    fetchSpy.mockRestore();
  });

  it('sends a fallback when the reply target cannot be resolved or the agent is stopped', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);

    for (const rows of [
      // First iteration: user found but reply can't be resolved → fallback message.
      [{ userId: TEST_USER_ID }, null],
      // Second iteration: reply resolved but agent is stopped → fallback message.
      [{ userId: TEST_USER_ID }, { agentId: AGENT_ID, agentName: 'My Agent', status: 'stopped', userId: TEST_USER_ID }],
    ] as const) {
      const redis = buildMockRedis();
      let selectCount = 0;
      const db = {
        select: vi.fn().mockImplementation(() => {
          selectCount += 1;
          if (selectCount === 1) {
            return makeChain(rows[0] ? [rows[0]] : []);
          }
          return makeChain(rows[1] ? [rows[1]] : []);
        }),
      } as unknown as Database;
      const app = Fastify();
      await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

      const res = await app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
        payload: {
          message: {
            chat: { id: '12345' },
            text: 'Ping',
            reply_to_message: { message_id: 888 },
          },
        },
      });
      await flushPromises();

      expect(res.statusCode).toBe(200);
      expect(redis.xadd).not.toHaveBeenCalled();
    }

    const bodies = fetchSpy.mock.calls.map((call) => String((call[1] as RequestInit | undefined)?.body ?? ''));
    expect(bodies.some((body) => body.includes("I couldn't find which agent that reply belongs to."))).toBe(true);
    expect(bodies.some((body) => body.includes('Agent My Agent is stopped and cannot receive messages right now.'))).toBe(true);
    fetchSpy.mockRestore();
  });

  it('ignores non-reply messages from an agent-level chat override', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: {
        message: {
          chat: { id: 'agent-chat-1' },
          text: '/to Momentum buy BTC now',
        },
      },
    });
    await flushPromises();

    expect(res.statusCode).toBe(200);
    expect(redis.xadd).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('routes /to commands to matching agent names', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) {
          return makeChain([{ userId: TEST_USER_ID }]);
        }
        return makeChain([{ agentId: AGENT_ID, agentName: 'Momentum', status: 'active' }]);
      }),
    } as unknown as Database;
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: {
        message: {
          chat: { id: '12345' },
          text: '/to Momentum check BTC price',
        },
      },
    });
    await flushPromises();

    expect(res.statusCode).toBe(200);
    expect(redis.xadd).toHaveBeenCalledTimes(1);
    expect(JSON.parse((redis.xadd as ReturnType<typeof vi.fn>).mock.calls[0][6] as string)).toEqual(expect.objectContaining({
      agentId: AGENT_ID,
      payload: { message: 'check BTC price' },
    }));
    expect(String((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? '')).toContain('Delivered to Momentum.');
    fetchSpy.mockRestore();
  });

  it('broadcasts /to all messages to each routable agent once', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) {
          return makeChain([{ userId: TEST_USER_ID }]);
        }
        return makeChain([
          { agentId: 'agent-1', agentName: 'Momentum', status: 'active' },
          { agentId: 'agent-2', agentName: 'DCA Bot', status: 'paused' },
        ]);
      }),
    } as unknown as Database;
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: {
        message: {
          chat: { id: '12345' },
          text: '/to all daily summary please',
        },
      },
    });
    await flushPromises();

    expect(res.statusCode).toBe(200);
    expect(redis.xadd).toHaveBeenCalledTimes(2);
    const confirmationBody = String((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? '');
    expect(confirmationBody).toContain('Delivered to Momentum.');
    expect(confirmationBody).toContain('Delivered to DCA Bot.');
    fetchSpy.mockRestore();
  });

  it('default-routes plain Telegram messages when exactly one agent can receive them', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) {
          return makeChain([{ userId: TEST_USER_ID }]);
        }
        return makeChain([{ agentId: AGENT_ID, agentName: 'Solo Agent', status: 'unhealthy' }]);
      }),
    } as unknown as Database;
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: {
        message: {
          chat: { id: '12345' },
          text: 'check ETH too',
        },
      },
    });
    await flushPromises();

    expect(res.statusCode).toBe(200);
    expect(redis.xadd).toHaveBeenCalledTimes(1);
    expect(String((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? '')).toContain('Delivered to Solo Agent.');
    fetchSpy.mockRestore();
  });

  it('prompts for /to when multiple agents are running and no command target is provided', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) {
          return makeChain([{ userId: TEST_USER_ID }]);
        }
        return makeChain([
          { agentId: 'agent-1', agentName: 'Momentum', status: 'active' },
          { agentId: 'agent-2', agentName: 'DCA Bot', status: 'starting' },
        ]);
      }),
    } as unknown as Database;
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: {
        message: {
          chat: { id: '12345' },
          text: 'what is your P&L?',
        },
      },
    });
    await flushPromises();

    expect(res.statusCode).toBe(200);
    expect(redis.xadd).not.toHaveBeenCalled();
    expect(String((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? '')).toContain('Use /to <agent name> <message>');
    fetchSpy.mockRestore();
  });

  it('replies "No agent named X found" when /to targets an unknown agent name', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) {
          return makeChain([{ userId: TEST_USER_ID }]);
        }
        // User has one running agent named "Momentum" — not "GhostAgent"
        return makeChain([{ agentId: AGENT_ID, agentName: 'Momentum', status: 'active' }]);
      }),
    } as unknown as Database;
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: {
        message: {
          chat: { id: '12345' },
          text: '/to GhostAgent buy BTC',
        },
      },
    });
    await flushPromises();

    expect(res.statusCode).toBe(200);
    expect(redis.xadd).not.toHaveBeenCalled();
    expect(String((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? '')).toContain('No agent named GhostAgent found.');
    fetchSpy.mockRestore();
  });

  it('handles /connect with existing connections even when setup links are unavailable', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) {
          return makeChain([{ userId: TEST_USER_ID }]);
        }
        if (selectCount === 2) {
          return makeChain([{ ...stubAgent, name: 'Momentum', status: 'stopped' }]);
        }
        return makeChain([
          { id: 'a2b32d6c-1111', label: '1inch', provider: '1inch', status: 'active' },
        ]);
      }),
    } as unknown as Database;
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig(), undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: {
        message: {
          chat: { id: '12345' },
          text: '/connect Momentum',
        },
      },
    });
    await flushPromises();

    expect(res.statusCode).toBe(200);
    const body = String((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? '');
    expect(body).toContain('Choose a connection for Momentum:');
    expect(body).toContain('Open the web app to create one.');
    fetchSpy.mockRestore();
  });
});
