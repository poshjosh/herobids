import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { agentInteractivityRoutes as registerAgentInteractivityRoutes, telegramWebhookHandler } from './agent-interactivity.js';
import { ChatTypingIndicator } from './chat-typing-indicator.js';
import { registerBackendRefFamilies } from './agent-config-helpers.js';
import { chatSuppressions, type Database } from '@herobids/db';
import type { ResolvedTelegramChatConfig } from '@herobids/domain';
import { AlertsConfigSchema, MessagingConfigSchema, resolveTelegramChatConfig } from '@herobids/domain';
import { AGENT_STREAM_MAXLEN } from '@herobids/domain';
import type { Redis } from 'ioredis';
import { buildInMemoryConversationDeps } from '../__tests__/helpers/in-memory-conversation-store.js';

vi.mock('../agents/trading-profile-reconciliation-adapter.js', () => ({
  loadActiveTradingProfileConnections: vi.fn().mockResolvedValue([]),
}));

import {
  loadActiveTradingProfileConnections,
} from '../agents/trading-profile-reconciliation-adapter.js';

const TEST_USER_ID = 'user-1';
const AGENT_ID = 'agent-1';
let currentProfiles = new Map<string, {
  actorId: string;
  venueAccountId: string;
  capital: string | null;
  riskPosture: Record<string, unknown> | null;
  executionDefaults: { mode: 'paper' | 'shadow' | 'live' } | null;
}>();
const readCurrentProfiles = vi.fn(async () => currentProfiles);
const stagedPlannerInputs: unknown[] = [];

function buildProfileSaga(db: Database) {
  return {
    readCurrentProfiles,
    executeStaged: vi.fn(async (input: {
      preparePlannerInput: () => Promise<unknown> | unknown;
      commitLocal: (tx: Database, markLocalCommitted: () => Promise<void>) => Promise<unknown>;
    }) => {
      stagedPlannerInputs.push(await input.preparePlannerInput());
      return input.commitLocal(db, async () => undefined);
    }),
  };
}

function agentInteractivityRoutes(
  ...args: Parameters<typeof registerAgentInteractivityRoutes>
): ReturnType<typeof registerAgentInteractivityRoutes> {
  return registerAgentInteractivityRoutes(
    args[0], args[1], args[2], args[3], args[4], args[5], buildProfileSaga(args[1]) as never, args[7], args[8],
  );
}

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
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'offset']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

/**
 * db.select() for webhook tests that queue rows by select order. Reads of chat_suppressions return no
 * rows and are not counted, so the queued order describes the other lookups only.
 */
function selectSkippingSuppressions(impl: () => unknown) {
  return vi.fn().mockImplementation(() => ({
    from: vi.fn((table: unknown) => (
      table === chatSuppressions ? makeChain([]) : (impl() as { from: (t: unknown) => unknown }).from(table)
    )),
  }));
}

/**
 * The row a mocked reply lookup returns for both of its selects: the agent that sent the message the reply points at,
 * and that agent's current address for the provider (which must be the replying chat).
 */
function replyRow(chatId: string, overrides: Record<string, unknown> = {}) {
  return { agentId: AGENT_ID, agentName: 'My Agent', status: 'active', userId: TEST_USER_ID, rowAgentId: AGENT_ID, address: chatId, isActive: true, ...overrides };
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

function buildTelegramChatConfig(telegramOverrides: Partial<ResolvedTelegramChatConfig> = {}): ResolvedTelegramChatConfig {
  return {
    botToken: 'test-token',
    webhookSecret: 'telegram-secret',
    webhookUrl: undefined,
    ...telegramOverrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentProfiles = new Map();
  stagedPlannerInputs.length = 0;
  vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue([]);
  // Phase 4 (EC-3): trading capability resolves from the external crypto-trading
  // ref via the config-registered backend-ref family map (mirrors API startup).
  registerBackendRefFamilies([{
    refs: [
      'traderton/skills/crypto-trading',
      'traderton/skills/crypto-bot-management',
      'traderton/skills/crypto-risk-monitoring',
    ],
    family: 'trading',
  }]);
});

// ─── PUT /agents/:id ──────────────────────────────────────────────────────

describe('PUT /agents/:id', () => {
  it('loads active bindings before staging an execution-default update', async () => {
    const connectedAgent = { ...stubAgent, executionDefaults: null, risk: null, capital: null };
    const db = buildAgentDb(connectedAgent);
    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue([{
      connectionId: 'connection-1',
      venueAccountId: 'venue-account-1',
      active: true,
      ready: true,
      grantedAt: new Date('2026-01-01T00:00:00.000Z'),
      assignmentId: 'assignment-1',
    }]);
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, buildMockRedis());

    const response = await app.inject({
      method: 'PUT',
      url: `/agents/${AGENT_ID}`,
      payload: { name: 'Updated', prompt: 'New prompt' },
    });

    expect(response.statusCode).toBe(200);
    expect(loadActiveTradingProfileConnections).toHaveBeenCalledWith(db, AGENT_ID);
  });

  it('preserves an unchanged selected live mode and stages the remote profile map', async () => {
    const profile = {
      actorId: AGENT_ID,
      venueAccountId: 'venue-account-1',
      capital: '1000',
      riskPosture: { maxDrawdownPct: 10 },
      executionDefaults: { mode: 'live' as const },
    };
    currentProfiles = new Map([[profile.venueAccountId, profile]]);
    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue([{
      connectionId: 'connection-1', venueAccountId: profile.venueAccountId, active: true, ready: true,
    }]);
    const db = buildAgentDb({ ...stubAgent, skillIds: ['traderton/skills/crypto-trading'] });
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, buildMockRedis());

    const response = await app.inject({
      method: 'PUT',
      url: `/agents/${AGENT_ID}`,
      payload: { name: 'Updated', prompt: 'New prompt' },
    });

    expect(response.statusCode).toBe(200);
    expect(readCurrentProfiles).toHaveBeenCalledWith(TEST_USER_ID, AGENT_ID, expect.any(Array));
    expect(stagedPlannerInputs[0]).toMatchObject({ prior: { profiles: currentProfiles } });
  });

  it('uses selected remote capital and risk posture when validating a risk overlay', async () => {
    currentProfiles = new Map([['venue-account-1', {
      actorId: AGENT_ID,
      venueAccountId: 'venue-account-1',
      capital: '1000',
      riskPosture: { dailyMaxLossPct: 5, maxDrawdownPct: 10 },
      executionDefaults: { mode: 'paper' },
    }]]);
    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue([{
      connectionId: 'connection-1', venueAccountId: 'venue-account-1', active: true, ready: true,
    }]);
    const db = buildAgentDb({ ...stubAgent, skillIds: ['traderton/skills/crypto-trading'] });
    const app = Fastify();
    decorateWithAuth(app);
    await agentInteractivityRoutes(app, db, buildMockRedis());

    const response = await app.inject({
      method: 'PUT',
      url: `/agents/${AGENT_ID}`,
      payload: { name: 'Updated', prompt: 'New prompt', maxDrawdownPct: 12 },
    });

    expect(response.statusCode).toBe(200);
  });

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
    currentProfiles = new Map([['venue-account-1', {
      actorId: AGENT_ID,
      venueAccountId: 'venue-account-1',
      capital: null,
      riskPosture: null,
      executionDefaults: { mode: 'paper' },
    }]]);
    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue([{
      connectionId: 'connection-1', venueAccountId: 'venue-account-1', active: true, ready: true,
    }]);
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const insertOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    let selectCount = 0;
    const updatedAgent = {
      ...stubAgent,
      skillIds: ['email'],
      executionDefaults: null,
    };
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return makeChain([{ ...stubAgent, executionDefaults: { mode: 'paper' } }]);
        }
        if (selectCount === 2) {
          return makeChain([{ skillId: 'traderton/skills/crypto-trading' }]);
        }
        if (selectCount === 3) {
          // hasAgentConnections lookup (agent_connections) — no active connections.
          return makeChain([]);
        }
        if (selectCount === 4) {
          return makeChain([{
            id: 'email',
            authorId: TEST_USER_ID,
            publicationStatus: 'published',
            priceCents: 0,
            currentRevisionId: 'email:v1',
          }]);
        }
        if (selectCount === 5) {
          return makeChain([]);
        }
        if (selectCount === 6) {
          return makeChain([]);
        }
        if (selectCount === 7) {
          return makeChain([{ skillId: 'traderton/skills/crypto-trading', skillRevisionId: 'traderton/skills/crypto-trading:v1' }]);
        }
        if (selectCount === 8) {
          return makeChain([updatedAgent]);
        }
        return makeChain([{ skillId: 'email' }]);
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
        skillIds: ['email'],
      },
    });

    expect(res.statusCode).toBe(200);
    const staged = stagedPlannerInputs[0] as { proposed: { profiles: Map<string, { executionDefaults: { mode: string } | null }> } };
    expect(staged.proposed.profiles.get('venue-account-1')?.executionDefaults).toEqual({ mode: 'paper' });
  });

  it('preserves execution defaults when no executionMode is sent and trading skills remain unchanged', async () => {
    currentProfiles = new Map([['venue-account-1', {
      actorId: AGENT_ID,
      venueAccountId: 'venue-account-1',
      capital: null,
      riskPosture: null,
      executionDefaults: { mode: 'paper' },
    }]]);
    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue([{
      connectionId: 'connection-1', venueAccountId: 'venue-account-1', active: true, ready: true,
    }]);
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const insertOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    let selectCount = 0;
    const updatedAgent = {
      ...stubAgent,
      name: 'Updated',
      prompt: 'New prompt',
      skillIds: ['traderton/skills/crypto-trading'],
      executionDefaults: { mode: 'paper' },
    };
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return makeChain([{ ...stubAgent, executionDefaults: { mode: 'paper' }, skillIds: ['traderton/skills/crypto-trading'] }]);
        }
        if (selectCount === 2) {
          return makeChain([{ skillId: 'traderton/skills/crypto-trading' }]);
        }
        if (selectCount === 3) {
          // hasAgentConnections lookup (agent_connections) — no active connections.
          return makeChain([]);
        }
        if (selectCount === 4) {
          return makeChain([{
            id: 'traderton/skills/crypto-trading',
            authorId: null,
            publicationStatus: 'published',
            priceCents: 0,
            currentRevisionId: 'traderton/skills/crypto-trading:v1',
          }]);
        }
        if (selectCount === 5) {
          return makeChain([]);
        }
        if (selectCount === 6) {
          return makeChain([]);
        }
        if (selectCount === 7) {
          return makeChain([{ skillId: 'traderton/skills/crypto-trading', skillRevisionId: 'traderton/skills/crypto-trading:v1' }]);
        }
        if (selectCount === 8) {
          return makeChain([updatedAgent]);
        }
        return makeChain([{ skillId: 'traderton/skills/crypto-trading' }]);
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
        skillIds: ['traderton/skills/crypto-trading'],
      },
    });

    expect(res.statusCode).toBe(200);
    const staged = stagedPlannerInputs[0] as { proposed: { profiles: Map<string, { executionDefaults: { mode: string } | null }> } };
    expect(staged.proposed.profiles.get('venue-account-1')?.executionDefaults).toEqual({ mode: 'paper' });
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

/** The webhook with an in-memory conversation store, since these tests run on a mocked database. */
function webhookWithMemoryStore(app: ReturnType<typeof Fastify>, db: Database, redis: Redis, telegram: Parameters<typeof telegramWebhookHandler>[3], conversations = buildInMemoryConversationDeps()) {
  return telegramWebhookHandler(app, db, redis, telegram, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, conversations);
}

// ─── POST /agents/:id/message ─────────────────────────────────────────────

const CLIENT_ID = '0b7d4f3e-6f0e-4c52-9a7e-3a1f5d2c9b11';

async function buildMessageApp(options: { agent?: Record<string, unknown> | null; redis?: Redis; userId?: string } = {}) {
  const db = buildAgentDb(options.agent === undefined ? { ...stubAgent, status: 'running' } : options.agent);
  const redis = options.redis ?? buildMockRedis();
  const conversations = buildInMemoryConversationDeps();
  const app = Fastify();
  decorateWithAuth(app, options.userId);
  await agentInteractivityRoutes(app, db, redis, undefined, undefined, undefined, undefined, undefined, conversations);
  return { app, db, redis, conversations };
}

describe('POST /agents/:id/message', () => {
  it('records the user message first, publishes it under the same id, and returns 202 with the sent row', async () => {
    const { app, redis, conversations } = await buildMessageApp();

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/message`,
      payload: { message: 'Hello agent', clientMessageId: CLIENT_ID },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().delivered).toBe(true);
    expect(res.json().message).toMatchObject({ id: CLIENT_ID, senderType: 'user', senderId: TEST_USER_ID, channel: 'web', body: 'Hello agent', deliveryStatus: 'sent' });
    expect(conversations.store.messages).toHaveLength(1);
    expect(redis.xadd).toHaveBeenCalledTimes(1);
    const envelope = JSON.parse(vi.mocked(redis.xadd).mock.calls[0]?.[6] as string) as Record<string, unknown>;
    expect(envelope).toMatchObject({ messageId: CLIENT_ID, type: 'user.message', initiatorType: 'user', initiatorId: TEST_USER_ID, payload: { message: 'Hello agent' } });
    expect(redis.xadd).toHaveBeenCalledWith(
      `agent:outbound:${AGENT_ID}`, 'MAXLEN', '~', AGENT_STREAM_MAXLEN, '*', 'envelope', expect.any(String),
    );
  });

  it('generates the message id when the client sends none', async () => {
    const { app, conversations } = await buildMessageApp();

    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/message`, payload: { message: 'Hi' } });

    expect(res.statusCode).toBe(202);
    expect(res.json().message.id).toBe(conversations.store.messages[0]?.id);
  });

  it('returns the stored row for a repeated client message id without publishing again', async () => {
    const { app, redis, conversations } = await buildMessageApp();
    const send = () => app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/message`, payload: { message: 'Once', clientMessageId: CLIENT_ID } });

    const first = await send();
    const second = await send();

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json().message).toMatchObject({ id: CLIENT_ID, body: 'Once' });
    expect(conversations.store.messages).toHaveLength(1);
    expect(redis.xadd).toHaveBeenCalledTimes(1);
  });

  it('returns 503 and keeps the row as failed when publishing fails, then publishes on a retry of the same id', async () => {
    const xadd = vi.fn().mockRejectedValueOnce(new Error('redis down')).mockResolvedValue('1-1');
    const { app, conversations } = await buildMessageApp({ redis: buildMockRedis({ xadd }) });
    const send = () => app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/message`, payload: { message: 'Try me', clientMessageId: CLIENT_ID } });

    const failed = await send();

    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ error: 'message_delivery_unavailable', messageId: CLIENT_ID });
    expect(conversations.store.messages[0]).toMatchObject({ id: CLIENT_ID, deliveryStatus: 'failed', deliveryDetail: 'publish_failed' });

    const retry = await send();

    expect(retry.statusCode).toBe(202);
    expect(retry.json().message).toMatchObject({ id: CLIENT_ID, deliveryStatus: 'sent' });
    expect(conversations.store.messages).toHaveLength(1);
    expect(xadd).toHaveBeenCalledTimes(2);
  });

  it('re-publishes a message that was stuck queued (process died before publishing) on a same-id retry, once', async () => {
    const { app, redis, conversations } = await buildMessageApp();
    await conversations.service.recordUserMessage({ id: CLIENT_ID, ownerUserId: TEST_USER_ID, agentId: AGENT_ID, channel: 'web', body: 'Stuck' });
    const send = () => app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/message`, payload: { message: 'Stuck', clientMessageId: CLIENT_ID } });

    const tooSoon = await send();

    expect(tooSoon.statusCode).toBe(202);
    expect(tooSoon.json().message).toMatchObject({ id: CLIENT_ID, deliveryStatus: 'queued', stuck: false });
    expect(redis.xadd).not.toHaveBeenCalled();

    conversations.advanceClock((conversations.limits.staleQueuedAfterSeconds + 1) * 1000);
    const retried = await send();
    const again = await send();

    expect(retried.statusCode).toBe(202);
    expect(retried.json().message).toMatchObject({ id: CLIENT_ID, deliveryStatus: 'sent' });
    expect(again.statusCode).toBe(202);
    expect(redis.xadd).toHaveBeenCalledTimes(1);
    expect(conversations.store.messages).toHaveLength(1);
  });

  it('does not publish twice when a stale queued retry loses the claim to another request', async () => {
    const { app, redis, conversations } = await buildMessageApp();
    await conversations.service.recordUserMessage({ id: CLIENT_ID, ownerUserId: TEST_USER_ID, agentId: AGENT_ID, channel: 'web', body: 'Stuck' });
    conversations.advanceClock((conversations.limits.staleQueuedAfterSeconds + 1) * 1000);
    const send = () => app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/message`, payload: { message: 'Stuck', clientMessageId: CLIENT_ID } });

    const responses = await Promise.all([send(), send(), send()]);

    expect(responses.map((res) => res.statusCode)).toEqual([202, 202, 202]);
    expect(redis.xadd).toHaveBeenCalledTimes(1);
  });

  it('marks a stale queued row as stuck in the thread so the web can offer Retry', async () => {
    const { app, conversations } = await buildMessageApp();
    await conversations.service.recordUserMessage({ id: CLIENT_ID, ownerUserId: TEST_USER_ID, agentId: AGENT_ID, channel: 'web', body: 'Stuck' });
    const stuckFlags = async () => (await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/conversation` })).json().messages.map((m: { stuck: boolean }) => m.stuck);

    expect(await stuckFlags()).toEqual([false]);

    conversations.advanceClock((conversations.limits.staleQueuedAfterSeconds + 1) * 1000);

    expect(await stuckFlags()).toEqual([true]);
  });

  it('returns the stored row of an already delivered message even though the agent has since stopped', async () => {
    const { app, redis, conversations } = await buildMessageApp({ agent: stubAgent });
    await conversations.service.recordUserMessage({ id: CLIENT_ID, ownerUserId: TEST_USER_ID, agentId: AGENT_ID, channel: 'web', body: 'Done' });
    await conversations.service.markDelivery({ messageId: CLIENT_ID, status: 'sent' });

    const repeat = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/message`, payload: { message: 'Done', clientMessageId: CLIENT_ID } });

    expect(repeat.statusCode).toBe(202);
    expect(repeat.json()).toMatchObject({ delivered: true, message: { id: CLIENT_ID, deliveryStatus: 'sent' } });
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('still refuses a retry of a failed message with 409 when the agent is stopped, and keeps the row failed', async () => {
    const { app, redis, conversations } = await buildMessageApp({ agent: stubAgent });
    await conversations.service.recordUserMessage({ id: CLIENT_ID, ownerUserId: TEST_USER_ID, agentId: AGENT_ID, channel: 'web', body: 'Failed' });
    await conversations.service.markDelivery({ messageId: CLIENT_ID, status: 'failed', detail: 'publish_failed' });

    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/message`, payload: { message: 'Failed', clientMessageId: CLIENT_ID } });

    expect(res.statusCode).toBe(409);
    expect(conversations.store.messages[0]?.deliveryStatus).toBe('failed');
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('does not spend rate limit tokens on an idempotent repeat of a delivered message', async () => {
    const incr = vi.fn().mockResolvedValue(1);
    const { app } = await buildMessageApp({ redis: buildMockRedis({ incr }) });
    const send = () => app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/message`, payload: { message: 'Once', clientMessageId: CLIENT_ID } });

    await send();
    await send();
    await send();

    expect(incr).toHaveBeenCalledTimes(1);
  });

  it('returns 503 and publishes nothing when the conversation store fails', async () => {
    const { app, redis, conversations } = await buildMessageApp();
    conversations.store.failWith = 'conversation.store_failed';

    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/message`, payload: { message: 'Hello' } });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('conversation_unavailable');
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('returns 404 for another user\'s agent and writes nothing', async () => {
    const { app, redis, conversations } = await buildMessageApp({ agent: null });

    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/message`, payload: { message: 'Hello', clientMessageId: CLIENT_ID } });

    expect(res.statusCode).toBe(404);
    expect(conversations.store.messages).toHaveLength(0);
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('refuses a client message id that already belongs to another sender with 409, and publishes nothing', async () => {
    const { app, redis, conversations } = await buildMessageApp();
    await conversations.service.recordAgentMessage({ id: CLIENT_ID, ownerUserId: TEST_USER_ID, agentId: AGENT_ID, channel: 'web', body: 'from the agent' });

    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/message`, payload: { message: 'forged', clientMessageId: CLIENT_ID } });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('message_id_conflict');
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it.each([
    ['not a uuid', 'abc'],
    ['too long', `${CLIENT_ID}-${'x'.repeat(200)}`],
    ['empty', ''],
    ['a thread id lookalike', 'user_agent:agent-1'],
  ])('rejects a client message id that is %s', async (_label, clientMessageId) => {
    const { app, conversations } = await buildMessageApp();

    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/message`, payload: { message: 'Hello', clientMessageId } });

    expect(res.statusCode).toBe(400);
    expect(conversations.store.messages).toHaveLength(0);
  });

  it('rejects a message over the configured length', async () => {
    const { app } = await buildMessageApp();

    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/message`, payload: { message: 'x'.repeat(4001) } });

    expect(res.statusCode).toBe(400);
  });

  it('rejects a whitespace-only message', async () => {
    const { app, conversations } = await buildMessageApp();

    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/message`, payload: { message: '   ' } });

    expect(res.statusCode).toBe(400);
    expect(conversations.store.messages).toHaveLength(0);
  });

  it('returns 409 when agent is stopped', async () => {
    const { app, conversations } = await buildMessageApp({ agent: stubAgent });

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/message`,
      payload: { message: 'Hello' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('agent_not_running');
    expect(conversations.store.messages).toHaveLength(0);
  });

  it('returns 429 when rate limit exceeded', async () => {
    const { app, conversations } = await buildMessageApp({ redis: buildMockRedis({ incr: vi.fn().mockResolvedValue(11) }) });

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/message`,
      payload: { message: 'Overload' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('rate_limited');
    expect(conversations.store.messages).toHaveLength(0);
  });

  it('returns 400 when message is missing', async () => {
    const { app } = await buildMessageApp();

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/message`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── GET /agents/:id/conversation ─────────────────────────────────────────

describe('GET /agents/:id/conversation', () => {
  async function seeded(count: number, options: Parameters<typeof buildMessageApp>[0] = {}) {
    const built = await buildMessageApp(options);
    for (let index = 1; index <= count; index += 1) {
      await built.conversations.service.recordUserMessage({ ownerUserId: TEST_USER_ID, agentId: AGENT_ID, channel: 'web', body: `m${index}` });
    }
    return built;
  }

  it('returns the thread oldest first with explicit fields only', async () => {
    const { app } = await seeded(2);

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/conversation` });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { messages: Array<Record<string, unknown>>; nextCursor: string | null };
    expect(body.messages.map((message) => message['body'])).toEqual(['m1', 'm2']);
    expect(Object.keys(body.messages[0] ?? {}).sort()).toEqual([
      'body', 'channel', 'createdAt', 'deliveryStatus', 'id', 'messageClass', 'senderId', 'senderType', 'stuck', 'subject',
    ]);
    expect(body.nextCursor).toBeNull();
    expect((res.json() as { maxMessageChars: number }).maxMessageChars).toBe(4000);
  });

  it('pages older rows with the (createdAt, id) cursor and no gaps or repeats', async () => {
    const { app } = await seeded(5);

    const first = (await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/conversation?limit=2` })).json() as { messages: Array<{ body: string }>; nextCursor: string | null };
    const second = (await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/conversation?limit=2&before=${first.nextCursor}` })).json() as { messages: Array<{ body: string }>; nextCursor: string | null };
    const third = (await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/conversation?limit=2&before=${second.nextCursor}` })).json() as { messages: Array<{ body: string }>; nextCursor: string | null };

    expect(first.messages.map((message) => message.body)).toEqual(['m4', 'm5']);
    expect(second.messages.map((message) => message.body)).toEqual(['m2', 'm3']);
    expect(third.messages.map((message) => message.body)).toEqual(['m1']);
    expect(third.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor and a bad limit with 400', async () => {
    const { app } = await seeded(1);

    const badCursor = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/conversation?before=not-a-cursor` });
    const badLimit = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/conversation?limit=0` });

    expect(badCursor.statusCode).toBe(400);
    expect(badLimit.statusCode).toBe(400);
  });

  it('returns 404 for another user\'s agent without reading the thread', async () => {
    const { app } = await seeded(1, { agent: null });

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/conversation` });

    expect(res.statusCode).toBe(404);
  });

  it('returns 503 when the store fails', async () => {
    const { app, conversations } = await seeded(1);
    conversations.store.listUserAgentThread = async () => ({ ok: false, error: { code: 'conversation.store_failed', message: 'conversation_store_failed' } });

    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/conversation` });

    expect(res.statusCode).toBe(503);
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
    await agentInteractivityRoutes(app, db, redis, buildTelegramChatConfig({ botToken: '' }));

    const res = await app.inject({ method: 'GET', url: '/agents/telegram-bot' });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_configured');
  });
});

describe('POST /telegram/webhook', () => {
  it('returns 501 when Telegram webhook auth is not fully configured', async () => {
    const app = Fastify();
    await webhookWithMemoryStore(app, buildAgentDb(null), buildMockRedis(), buildTelegramChatConfig({ webhookSecret: '' }));

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
    await webhookWithMemoryStore(app, buildAgentDb(null), buildMockRedis(), buildTelegramChatConfig());

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
    await webhookWithMemoryStore(app, buildAgentDb(null), buildMockRedis(), buildTelegramChatConfig());

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
      select: selectSkippingSuppressions(() => {
        selectCount += 1;
        return makeChain(selectCount === 1
          ? [{ userId: TEST_USER_ID }]
          : [replyRow('12345')]);
      }),
    } as unknown as Database;
    const app = Fastify();
    await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig());

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
      select: selectSkippingSuppressions(() => {
        selectCount += 1;
        if (selectCount === 1) {
          // User-level chat binding lookup — no match (the chat is only bound at agent level).
          return makeChain([]);
        }
        // resolveAgentForChatReply — resolves directly from the conversation
        // message record, returning the userId from the agent's owner row.
        return makeChain([replyRow('agent-chat-1')]);
      }),
    } as unknown as Database;
    const app = Fastify();
    await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig());

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
      [{ userId: TEST_USER_ID }, replyRow('12345', { status: 'stopped' })],
    ] as const) {
      const redis = buildMockRedis();
      let selectCount = 0;
      const db = {
        select: selectSkippingSuppressions(() => {
          selectCount += 1;
          if (selectCount === 1) {
            return makeChain(rows[0] ? [rows[0]] : []);
          }
          return makeChain(rows[1] ? [rows[1]] : []);
        }),
      } as unknown as Database;
      const app = Fastify();
      await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig());

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

  /** db whose chat_suppressions reads return `suppressed` and every other read returns `otherRows`. */
  function buildSuppressionDb(suppressed: unknown[], otherRows: unknown[]) {
    return {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn((table: unknown) => makeChain(table === chatSuppressions ? suppressed : otherRows)),
      })),
    } as unknown as Database;
  }

  it('does not bind a suppressed chat to a user: a plain message is neither routed nor answered', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    const db = buildSuppressionDb(
      [{ address: '12345' }],
      [{ userId: TEST_USER_ID, planId: 'free', isAdmin: false, agentId: AGENT_ID, agentName: 'My Agent', status: 'running' }],
    );
    const app = Fastify();
    await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: { message: { chat: { id: '12345' }, text: 'Hello agent' } },
    });
    await flushPromises();

    expect(res.statusCode).toBe(200);
    expect(redis.xadd).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('drops a reply from a suppressed address silently: it is neither routed nor answered', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    const db = buildSuppressionDb(
      [{ address: '12345' }],
      [{ userId: TEST_USER_ID, planId: 'free', isAdmin: false, agentId: AGENT_ID, agentName: 'My Agent', status: 'running' }],
    );
    const app = Fastify();
    await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig());

    await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: { message: { chat: { id: '12345' }, text: 'Ping', reply_to_message: { message_id: 777 } } },
    });
    await flushPromises();

    expect(redis.xadd).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('fails closed when the suppression lookup errors: nothing is routed', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    const db = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn((table: unknown) => {
          if (table === chatSuppressions) throw new Error('db down');
          return makeChain([{ userId: TEST_USER_ID, planId: 'free', isAdmin: false }]);
        }),
      })),
    } as unknown as Database;
    const app = Fastify();
    await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: { message: { chat: { id: '12345' }, text: 'Hello agent' } },
    });
    await flushPromises();

    expect(res.statusCode).toBe(200);
    expect(redis.xadd).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('ignores non-reply messages from an agent-level chat override', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;
    const app = Fastify();
    await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig());

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
      select: selectSkippingSuppressions(() => {
        selectCount += 1;
        if (selectCount === 1) {
          return makeChain([{ userId: TEST_USER_ID }]);
        }
        return makeChain([{ agentId: AGENT_ID, agentName: 'Momentum', status: 'active' }]);
      }),
    } as unknown as Database;
    const app = Fastify();
    await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig());

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
      select: selectSkippingSuppressions(() => {
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
    await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig());

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
      select: selectSkippingSuppressions(() => {
        selectCount += 1;
        if (selectCount === 1) {
          return makeChain([{ userId: TEST_USER_ID }]);
        }
        return makeChain([{ agentId: AGENT_ID, agentName: 'Solo Agent', status: 'unhealthy' }]);
      }),
    } as unknown as Database;
    const app = Fastify();
    await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig());

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

  it('records a plain Telegram message in the agent thread on the telegram channel, then publishes it under the row id', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    let selectCount = 0;
    const db = {
      select: selectSkippingSuppressions(() => {
        selectCount += 1;
        return makeChain(selectCount === 1
          ? [{ userId: TEST_USER_ID }]
          : [{ agentId: AGENT_ID, agentName: 'Solo Agent', status: 'running' }]);
      }),
    } as unknown as Database;
    const conversations = buildInMemoryConversationDeps();
    const app = Fastify();
    await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig(), conversations);

    await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: { message: { chat: { id: '12345' }, text: 'check ETH too' } },
    });
    await flushPromises();

    expect(conversations.store.messages).toHaveLength(1);
    const [row] = conversations.store.messages;
    expect(row).toMatchObject({ senderType: 'user', senderId: TEST_USER_ID, channel: 'telegram', body: 'check ETH too', deliveryStatus: 'sent' });
    const envelope = JSON.parse((redis.xadd as ReturnType<typeof vi.fn>).mock.calls[0]![6] as string) as Record<string, unknown>;
    expect(envelope).toMatchObject({ messageId: row?.id, type: 'user.message', payload: { message: 'check ETH too' } });
    fetchSpy.mockRestore();
  });

  it('does not publish a Telegram message that cannot be recorded, and tells the user', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    let selectCount = 0;
    const db = {
      select: selectSkippingSuppressions(() => {
        selectCount += 1;
        return makeChain(selectCount === 1
          ? [{ userId: TEST_USER_ID }]
          : [{ agentId: AGENT_ID, agentName: 'Solo Agent', status: 'running' }]);
      }),
    } as unknown as Database;
    const conversations = buildInMemoryConversationDeps();
    const tooLong = 'x'.repeat(conversations.limits.userMessageMaxChars + 1);
    const app = Fastify();
    await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig(), conversations);

    await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: { message: { chat: { id: '12345' }, text: tooLong } },
    });
    await flushPromises();

    expect(redis.xadd).not.toHaveBeenCalled();
    expect(conversations.store.messages).toHaveLength(0);
    expect(String((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? '')).toContain('too long');
    fetchSpy.mockRestore();
  });

  it('answers nothing, not even /help, to a suppressed chat', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    const db = buildSuppressionDb([{ address: '12345' }], []);
    const app = Fastify();
    await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: { message: { chat: { id: '12345' }, text: '/help' } },
    });
    await flushPromises();

    expect(res.statusCode).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(redis.xadd).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('answers a chat that is not suppressed to /help as before', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const db = buildSuppressionDb([], []);
    const app = Fastify();
    await webhookWithMemoryStore(app, db, buildMockRedis(), buildTelegramChatConfig());

    await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: { message: { chat: { id: '12345' }, text: '/help' } },
    });
    await flushPromises();

    expect(String((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? '')).toContain('Your chat ID: 12345');
    fetchSpy.mockRestore();
  });

  it('prompts for /to when multiple agents are running and no command target is provided', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    let selectCount = 0;
    const db = {
      select: selectSkippingSuppressions(() => {
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
    await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig());

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
      select: selectSkippingSuppressions(() => {
        selectCount += 1;
        if (selectCount === 1) {
          return makeChain([{ userId: TEST_USER_ID }]);
        }
        // User has one running agent named "Momentum" — not "GhostAgent"
        return makeChain([{ agentId: AGENT_ID, agentName: 'Momentum', status: 'active' }]);
      }),
    } as unknown as Database;
    const app = Fastify();
    await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig());

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
      select: selectSkippingSuppressions(() => {
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
    await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig());

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



// ─── Neutral chat webhook and messaging.chat.telegram config ─────────────

const TELEGRAM_WEBHOOK_ROUTES = [
  ['Telegram alias', '/telegram/webhook'],
  ['neutral chat route', '/messaging/chat/telegram/webhook'],
] as const;

describe.each(TELEGRAM_WEBHOOK_ROUTES)('Telegram webhook through the %s', (_label, url) => {
  it('returns 401 when the secret header is missing or wrong', async () => {
    const app = Fastify();
    await webhookWithMemoryStore(app, buildAgentDb(null), buildMockRedis(), buildTelegramChatConfig());

    const missing = await app.inject({ method: 'POST', url, payload: {} });
    const wrong = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
      payload: {},
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
  });

  it('returns 501 when the Telegram webhook secret is not configured', async () => {
    const app = Fastify();
    await webhookWithMemoryStore(app, buildAgentDb(null), buildMockRedis(), buildTelegramChatConfig({ webhookSecret: '' }));

    const res = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: {},
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: 'not_configured' });
  });

  it('acknowledges a valid update with 200 and delivers a reply to the owning agent', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    const redis = buildMockRedis();
    let selectCount = 0;
    const db = {
      select: selectSkippingSuppressions(() => {
        selectCount += 1;
        return makeChain(selectCount === 1
          ? [{ userId: TEST_USER_ID }]
          : [replyRow('chat-1')]);
      }),
    } as unknown as Database;
    const app = Fastify();
    await webhookWithMemoryStore(app, db, redis, buildTelegramChatConfig());

    const res = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: {
        message: {
          chat: { id: 'chat-1' },
          text: 'Adjust the watchlist',
          reply_to_message: { message_id: 777 },
        },
      },
    });
    await flushPromises();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(redis.xadd).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({ method: 'POST' }),
    );
    fetchSpy.mockRestore();
  });
});

describe('POST /messaging/chat/:provider/webhook', () => {
  it('returns 404 for a provider with no registered adapter', async () => {
    const app = Fastify();
    await webhookWithMemoryStore(app, buildAgentDb(null), buildMockRedis(), buildTelegramChatConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/messaging/chat/whatsapp/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('returns 405 for the GET verify request on a provider without a verify handshake', async () => {
    const app = Fastify();
    await webhookWithMemoryStore(app, buildAgentDb(null), buildMockRedis(), buildTelegramChatConfig());

    const telegram = await app.inject({ method: 'GET', url: '/messaging/chat/telegram/webhook' });
    const unknown = await app.inject({ method: 'GET', url: '/messaging/chat/whatsapp/webhook' });

    expect(telegram.statusCode).toBe(405);
    expect(unknown.statusCode).toBe(404);
  });
});

describe('messaging.chat.telegram config drives the Telegram webhook', () => {
  function resolvedFrom(alertsTelegram: Record<string, unknown>, chatTelegram: Record<string, unknown>) {
    return resolveTelegramChatConfig({
      alerts: AlertsConfigSchema.parse({ telegram: alertsTelegram }),
      messaging: MessagingConfigSchema.parse({ chat: { telegram: chatTelegram } }),
    });
  }

  it.each(TELEGRAM_WEBHOOK_ROUTES)('accepts the secret set only under messaging.chat.telegram on the %s', async (_label, url) => {
    const app = Fastify();
    await webhookWithMemoryStore(app, buildAgentDb(null), buildMockRedis(), resolvedFrom({}, { botToken: 'chat-token', webhookSecret: 'chat-secret' }));

    const res = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-telegram-bot-api-secret-token': 'chat-secret' },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
  });

  it.each(TELEGRAM_WEBHOOK_ROUTES)('rejects a wrong secret when only messaging.chat.telegram is set on the %s', async (_label, url) => {
    const app = Fastify();
    await webhookWithMemoryStore(app, buildAgentDb(null), buildMockRedis(), resolvedFrom({}, { botToken: 'chat-token', webhookSecret: 'chat-secret' }));

    const res = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
      payload: {},
    });

    expect(res.statusCode).toBe(401);
  });

  it('ignores a legacy alerts.telegram secret and checks the messaging.chat.telegram secret', async () => {
    const app = Fastify();
    await telegramWebhookHandler(
      app,
      buildAgentDb(null),
      buildMockRedis(),
      resolvedFrom({ botToken: 'legacy-token', webhookSecret: 'legacy-secret' }, { botToken: 'chat-token', webhookSecret: 'chat-secret' }),
    );

    const legacy = await app.inject({
      method: 'POST',
      url: '/messaging/chat/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'legacy-secret' },
      payload: {},
    });
    const chat = await app.inject({
      method: 'POST',
      url: '/messaging/chat/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'chat-secret' },
      payload: {},
    });

    expect(legacy.statusCode).toBe(401);
    expect(chat.statusCode).toBe(200);
  });

  it('is not configured when only the legacy alerts.telegram keys are set', async () => {
    const app = Fastify();
    await telegramWebhookHandler(
      app,
      buildAgentDb(null),
      buildMockRedis(),
      resolvedFrom({ botToken: 'legacy-token', webhookSecret: 'legacy-secret' }, {}),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/messaging/chat/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'legacy-secret' },
      payload: {},
    });

    expect(res.statusCode).toBe(501);
  });
});

describe('telegramWebhookHandler typing indicator lifecycle', () => {
  it('disposes the typing indicator when the app closes', async () => {
    const dispose = vi.spyOn(ChatTypingIndicator.prototype, 'dispose');
    const app = Fastify();
    await telegramWebhookHandler(
      app,
      buildAgentDb(null),
      buildMockRedis(),
      buildTelegramChatConfig(),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { refreshIntervalMs: 4000, maxWindowMs: 10000 },
    );
    await app.ready();

    await app.close();

    expect(dispose).toHaveBeenCalledTimes(1);
    dispose.mockRestore();
  });

  it('does not dispose anything on close when typing is not configured', async () => {
    const dispose = vi.spyOn(ChatTypingIndicator.prototype, 'dispose');
    const app = Fastify();
    await webhookWithMemoryStore(app, buildAgentDb(null), buildMockRedis(), buildTelegramChatConfig());
    await app.ready();

    await app.close();

    expect(dispose).not.toHaveBeenCalled();
    dispose.mockRestore();
  });
});
