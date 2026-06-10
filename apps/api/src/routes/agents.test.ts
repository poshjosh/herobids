import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const TEST_USER_ID = 'user-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = 'free';
  });
}

function buildDb(options: {
  agentRows?: Array<Record<string, unknown>>;
  activeLinkRows?: Array<Record<string, unknown>>;
  txAgentRows?: Array<Record<string, unknown>>;
} = {}) {
  const insertedValues: Array<Record<string, unknown>> = [];
  const updateSets: Array<Record<string, unknown>> = [];
  const deletedTargets: unknown[] = [];
  const selectResponses = [
    ...(options.agentRows ? [options.agentRows] : [[]]),
    ...(options.activeLinkRows ? [options.activeLinkRows] : [[]]),
    ...(options.txAgentRows ? [options.txAgentRows] : [[]]),
  ];

  const db: any = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => Promise.resolve(selectResponses.shift() ?? [])),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        updateSets.push(values);
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(values['status'] === 'starting' ? [{ id: 'agent-1' }] : []),
          }),
        };
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        insertedValues.push(values);
        return Promise.resolve();
      }),
    }),
    transaction: vi.fn().mockImplementation(async (callback: (tx: any) => Promise<unknown>) => callback(db)),
    delete: vi.fn().mockImplementation((target: unknown) => {
      deletedTargets.push(target);
      return {
        where: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };

  return { db, insertedValues, updateSets, deletedTargets };
}

describe('agent routes lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns starting and persists a starting session when /start is called', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, insertedValues, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      txAgentRows: [{ id: 'agent-1' }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/start' });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(expect.objectContaining({ status: 'starting', sessionId: expect.any(String) }));
    expect(updateSets).toContainEqual(expect.objectContaining({ status: 'starting', pauseState: null }));
    expect(insertedValues).toContainEqual(expect.objectContaining({ agentId: 'agent-1', status: 'starting' }));
  });

  it('rejects a second /start when the agent is already starting', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'starting', userId: TEST_USER_ID }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/start' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_stopped');
  });

  it('returns 404 when the user does not own the agent', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb();

    const app = Fastify();
    decorateWithAuth(app, 'other-user');
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/start' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('rejects start when agent is running (not stopped)', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'running', userId: TEST_USER_ID }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/start' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_stopped');
  });

  it('deletes outbound messages before deleting the agent', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { agentOutboundMessages, agentArtifacts, agentRuntimeSessions, agents } = await import('@herobids/db');
    const { db, deletedTargets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(204);
    expect(deletedTargets).toEqual([
      agentOutboundMessages,
      agentArtifacts,
      agentRuntimeSessions,
      agents,
    ]);
  });
});

describe('agent routes config update (PATCH /agents/:id)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['active'],
    ['starting'],
    ['paused'],
    ['unhealthy'],
  ])('rejects PATCH with 409 when agent status is %s', async (status) => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status, userId: TEST_USER_ID, skillIds: [] }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { name: 'new name' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('agent_not_editable');
  });

  it.each([
    ['stopped'],
    ['crashed'],
  ])('allows PATCH and persists changes when agent status is %s', async (status) => {
    const { agentRoutes } = await import('./agents.js');
    const updatedAgent = { id: 'agent-1', userId: TEST_USER_ID, status, skillIds: [], name: 'new name', prompt: 'p' };
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status, userId: TEST_USER_ID, skillIds: [], toolPolicy: null }],
      activeLinkRows: [updatedAgent],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { name: 'new name' },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(expect.objectContaining({ name: 'new name' }));
  });

  it('returns 404 when the agent does not exist or belongs to another user', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({ agentRows: [] });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { name: 'new name' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('returns 400 for an invalid payload', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [] }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      // name must be min(1) — empty string should fail validation
      payload: { name: '' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('persists provider, lightModel, and heavyModel fields on create', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      modelPolicy: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
    };
    const { db, insertedValues } = buildDb({ agentRows: [createdAgent] });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'new agent',
        prompt: 'trade carefully',
        provider: 'openai',
        lightModel: 'gpt-4o-mini',
        heavyModel: 'gpt-4o',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(insertedValues).toContainEqual(expect.objectContaining({
      modelPolicy: expect.objectContaining({ provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' }),
    }));
    expect(res.json()).toMatchObject({ provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' });
  });

  it('rejects create when model fields are provided without a provider', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb();

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'new agent',
        prompt: 'trade carefully',
        lightModel: 'gpt-4o-mini',
        heavyModel: 'gpt-4o',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'validation_error',
      details: [expect.objectContaining({ path: ['provider'] })],
    });
  });

  it('rejects create when the provider and models do not belong together', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb();

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'new agent',
        prompt: 'trade carefully',
        provider: 'openai',
        lightModel: 'claude-haiku-3-5',
        heavyModel: 'gpt-4o',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('allows PATCH and persists the new model fields when agent status is stopped', async () => {
    const { agentRoutes } = await import('./agents.js');
    const updatedAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      name: 'new name',
      prompt: 'p',
      modelPolicy: { provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5' },
    };
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], modelPolicy: null }],
      activeLinkRows: [updatedAgent],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        name: 'new name',
        provider: 'anthropic',
        lightModel: 'claude-haiku-3-5',
        heavyModel: 'claude-sonnet-4-5',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(expect.objectContaining({
      modelPolicy: expect.objectContaining({ provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5' }),
    }));
    expect(res.json()).toMatchObject({ provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5' });
  });

  it('clears explicit model overrides when nullable fields are sent', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateSets } = buildDb({
      agentRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        skillIds: [],
        modelPolicy: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
      }],
      activeLinkRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        skillIds: [],
        modelPolicy: null,
      }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        provider: null,
        lightModel: null,
        heavyModel: null,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(expect.objectContaining({ modelPolicy: null }));
    expect(res.json()).toMatchObject({ provider: null, lightModel: null, heavyModel: null });
  });

  it('persists only the canonical model fields on update', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], modelPolicy: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
      activeLinkRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], modelPolicy: null }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        provider: 'openai',
        lightModel: 'gpt-4o-mini',
        heavyModel: 'gpt-4o',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(expect.objectContaining({
      modelPolicy: expect.objectContaining({
        provider: 'openai',
        lightModel: 'gpt-4o-mini',
        heavyModel: 'gpt-4o',
      }),
    }));
    expect((updateSets[0] as { modelPolicy?: Record<string, unknown> }).modelPolicy).not.toHaveProperty('scoutModel');
  });

  it('rejects patch when model fields are provided without a provider', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], modelPolicy: null }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        lightModel: 'gpt-4o-mini',
        heavyModel: 'gpt-4o',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'validation_error',
      details: [expect.objectContaining({ path: ['provider'] })],
    });
  });
});

// ---------------------------------------------------------------------------
// Bug 005 — GET /agents/:id must not return a stale activeSession for stopped
// or crashed agents, even when a lingering unhealthy runtime session exists.
// ---------------------------------------------------------------------------
describe('GET /agents/:id — activeSession suppression for terminal-state agents (bug 005)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Build a db mock suitable for GET /agents/:id.
   * The GET handler issues at most two SELECT queries:
   *   1. agents.where(...)                         — always
   *   2. agentRuntimeSessions.where(...).orderBy() — only for non-terminal agents
   *
   * To support the optional .orderBy() chain on the second query, the object
   * returned by .where() is made thenable (so `await query` works) AND carries
   * an .orderBy() method that returns the same resolved data.
   */
  function buildGetAgentDb(
    agentRow: Record<string, unknown> | null,
    sessionRow: Record<string, unknown> | null = null,
  ) {
    const agentRows = agentRow ? [agentRow] : [];
    const sessionRows = sessionRow ? [sessionRow] : [];
    let selectCallIndex = 0;

    function makeQueryable(rows: Record<string, unknown>[]) {
      const resolved = Promise.resolve(rows);
      // A thenable that also exposes .orderBy() so drizzle-style chains work.
      return {
        then: (
          resolve: (v: Record<string, unknown>[]) => unknown,
          reject?: (e: unknown) => unknown,
        ) => resolved.then(resolve, reject ?? undefined),
        orderBy: vi.fn().mockReturnValue(resolved),
      };
    }

    const db: any = {
      select: vi.fn().mockImplementation(() => {
        const rows = selectCallIndex++ === 0 ? agentRows : sessionRows;
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue(makeQueryable(rows)),
          }),
        };
      }),
    };

    return { db };
  }

  it.each([
    ['stopped'],
    ['crashed'],
  ])('returns activeSession: null for a %s agent even when a lingering unhealthy session exists', async (status) => {
    const { agentRoutes } = await import('./agents.js');
    const agent = { id: 'agent-1', status, userId: TEST_USER_ID, modelPolicy: null, skillIds: [] };
    const staleSession = { id: 'session-99', status: 'unhealthy', agentId: 'agent-1', startedAt: new Date().toISOString() };
    const { db } = buildGetAgentDb(agent, staleSession);

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(200);
    // The stale session must not leak into the response — regression for bug 005.
    expect(res.json().activeSession).toBeNull();
    // The session SELECT should not have been called at all for terminal agents.
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('returns the activeSession for an active agent that has an unhealthy session', async () => {
    const { agentRoutes } = await import('./agents.js');
    const agent = {
      id: 'agent-1',
      status: 'active',
      userId: TEST_USER_ID,
      modelPolicy: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
      skillIds: [],
    };
    const session = { id: 'session-42', status: 'unhealthy', agentId: 'agent-1', startedAt: new Date().toISOString() };
    const { db } = buildGetAgentDb(agent, session);

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(200);
    expect(res.json().activeSession).toMatchObject({ id: 'session-42', status: 'unhealthy' });
    expect(res.json()).toMatchObject({ provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' });
    // Two SELECTs: agent lookup + session lookup.
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('returns 404 when the agent is not found', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildGetAgentDb(null);

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// tickIntervalMs and capital round-trip tests (feature 003)
// ---------------------------------------------------------------------------
describe('agent routes — tickIntervalMs and capital fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists tickIntervalMs and capital on create', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      modelPolicy: null,
      tickIntervalMs: 600_000,
      dailyTokenBudget: 42_000,
      capital: '5000',
    };
    const { db, insertedValues } = buildDb({ agentRows: [createdAgent] });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'agent with controls',
        prompt: 'trade carefully',
        tickIntervalMs: 600_000,
        dailyLlmTokenBudget: 42_000,
        capital: '5000.00',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(insertedValues).toContainEqual(expect.objectContaining({
      tickIntervalMs: 600_000,
      dailyTokenBudget: 42_000,
      capital: '5000',
    }));
    expect(res.json()).toEqual(expect.objectContaining({
      dailyLlmTokenBudget: 42_000,
      dailyTokenBudget: 42_000,
      capital: '5000',
    }));
  });

  it('rejects conflicting dailyLlmTokenBudget aliases on create', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb();

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'agent',
        prompt: 'p',
        dailyLlmTokenBudget: 1000,
        dailyTokenBudget: 2000,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'validation_error',
      details: [expect.objectContaining({ path: ['dailyLlmTokenBudget'] })],
    });
  });

  it('rejects tickIntervalMs below 1000ms on create', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb();

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'agent',
        prompt: 'p',
        tickIntervalMs: 500,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('persists tickIntervalMs on PATCH', async () => {
    const { agentRoutes } = await import('./agents.js');
    const updatedAgent = {
      id: 'agent-1', userId: TEST_USER_ID, status: 'stopped',
      skillIds: [], modelPolicy: null, tickIntervalMs: 1_200_000, capital: null,
    };
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], toolPolicy: null, modelPolicy: null }],
      activeLinkRows: [updatedAgent],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { tickIntervalMs: 1_200_000 },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(expect.objectContaining({ tickIntervalMs: 1_200_000 }));
  });

  it('normalizes capital and canonical token budget on PATCH', async () => {
    const { agentRoutes } = await import('./agents.js');
    const updatedAgent = {
      id: 'agent-1', userId: TEST_USER_ID, status: 'stopped', skillIds: [], modelPolicy: null,
      tickIntervalMs: null, capital: '750', dailyTokenBudget: 12_000,
    };
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], toolPolicy: null, modelPolicy: null }],
      activeLinkRows: [updatedAgent],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { capital: '750.00', dailyLlmTokenBudget: 12_000 },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(expect.objectContaining({ capital: '750', dailyTokenBudget: 12_000 }));
    expect(res.json()).toEqual(expect.objectContaining({ capital: '750', dailyLlmTokenBudget: 12_000 }));
  });

  it('clears tickIntervalMs when null is sent on PATCH', async () => {
    const { agentRoutes } = await import('./agents.js');
    const updatedAgent = {
      id: 'agent-1', userId: TEST_USER_ID, status: 'stopped',
      skillIds: [], modelPolicy: null, tickIntervalMs: null, capital: null,
    };
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], toolPolicy: null, modelPolicy: null, tickIntervalMs: 900_000 }],
      activeLinkRows: [updatedAgent],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { tickIntervalMs: null },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(expect.objectContaining({ tickIntervalMs: null }));
  });
});

