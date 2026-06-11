import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { agentInteractivityRoutes } from './agent-interactivity.js';
import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';

const TEST_USER_ID = 'user-1';
const AGENT_ID = 'agent-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
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

  it('normalizes capital and canonical dailyLlmTokenBudget on PUT', async () => {
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    let selectCount = 0;
    const updatedAgent = {
      ...stubAgent,
      name: 'Updated',
      prompt: 'New prompt',
      capital: '750',
      dailyTokenBudget: 12_000,
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
        dailyLlmTokenBudget: 12_000,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      capital: '750',
      dailyTokenBudget: 12_000,
    }));
    expect(res.json()).toEqual(expect.objectContaining({
      capital: '750',
      dailyLlmTokenBudget: 12_000,
      dailyTokenBudget: 12_000,
    }));
  });

  it('clears execution mode when trading skills are removed on PUT', async () => {
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    let selectCount = 0;
    const updatedAgent = {
      ...stubAgent,
      skillIds: ['task-management'],
      executionMode: null,
    };
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1 ? [{ ...stubAgent, skillIds: ['trading'], executionMode: 'paper' }] : [updatedAgent]);
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
        skillIds: ['task-management'],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ executionMode: null, skillIds: ['task-management'] }));
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
      `agent:outbound:${AGENT_ID}`, '*', 'envelope', expect.any(String),
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
  it('returns 200 with prompt when key exists in Redis', async () => {
    const db = buildAgentDb(stubAgent);
    const redis = buildMockRedis({ get: vi.fn().mockResolvedValue('You are an agent...') });
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/prompt` });
    expect(res.statusCode).toBe(200);
    expect(res.json().prompt).toBe('You are an agent...');
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

  it('returns 404 when agent not owned by user', async () => {
    const db = buildAgentDb(null);
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, redis);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/prompt` });
    expect(res.statusCode).toBe(404);
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
    await agentInteractivityRoutes(app, db, redis, { enabled: false, dispatchIntervalMs: 10000, defaultCooldownMs: 0, maxBatchSize: 10, maxRetries: 3, telegram: { botToken: '', channels: [] } });

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
    await agentInteractivityRoutes(app, db, redis, { enabled: false, dispatchIntervalMs: 10000, defaultCooldownMs: 0, maxBatchSize: 10, maxRetries: 3, telegram: { botToken: '', channels: [] } });

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
    await agentInteractivityRoutes(app, db, redis, { enabled: false, dispatchIntervalMs: 10000, defaultCooldownMs: 0, maxBatchSize: 10, maxRetries: 3, telegram: { botToken: 'test-token', channels: [] } });

    const res = await app.inject({
      method: 'POST',
      url: '/agents/verify-telegram',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    fetchSpy.mockRestore();
  });
});
