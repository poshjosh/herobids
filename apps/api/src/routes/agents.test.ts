import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  agents,
  agentRuntimeSessions,
  agentSkills,
  bots,
  decisions,
  skillEntitlements,
  skillRevisions,
  skills,
} from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';

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
  skillRows?: Array<Record<string, unknown>>;
  skillEntitlementRows?: Array<Record<string, unknown>>;
  skillRevisionRows?: Array<Record<string, unknown>>;
  agentSkillRows?: Array<Record<string, unknown>>;
  botRows?: Array<Record<string, unknown>>;
  sessionRows?: Array<Record<string, unknown>>;
} = {}) {
  const insertedValues: Array<Record<string, unknown>> = [];
  const updateSets: Array<Record<string, unknown>> = [];
  const deletedTargets: unknown[] = [];

  const builtinSkillRows: Array<Record<string, unknown>> = [
    {
      id: 'task-management',
      authorId: null,
      publicationStatus: 'published',
      priceCents: 0,
      currentRevisionId: 'rev-task-management',
    },
    {
      id: 'trading',
      authorId: null,
      publicationStatus: 'published',
      priceCents: 0,
      currentRevisionId: 'rev-trading',
    },
    {
      id: 'bot-management',
      authorId: null,
      publicationStatus: 'published',
      priceCents: 0,
      currentRevisionId: 'rev-bot-management',
    },
  ];

  const agentRows = options.agentRows ?? [];
  const postMutationAgentRows = options.activeLinkRows ?? agentRows;
  const decisionRows = options.txAgentRows ?? [];
  const skillRows = options.skillRows ?? builtinSkillRows;
  const skillEntitlementRows = options.skillEntitlementRows ?? [];
  const skillRevisionRows = options.skillRevisionRows ?? skillRows.map((row, index) => ({
    skillId: row['id'],
    revisionId: row['currentRevisionId'] ?? `rev-${String(row['id'])}`,
    version: typeof row['version'] === 'number' ? row['version'] : index + 1,
  }));
  const agentSkillRows = options.agentSkillRows ?? (
    Array.isArray(agentRows[0]?.['skillIds'])
      ? (agentRows[0]!['skillIds'] as unknown[]).map((skillId, orderIndex) => ({ skillId, orderIndex }))
      : []
  );
  const botRows = options.botRows ?? options.activeLinkRows ?? [];
  const sessionRows = options.sessionRows ?? [];

  let agentsSelectCount = 0;

  const rowsForTable = (table: unknown): Array<Record<string, unknown>> => {
    if (table === agents) {
      agentsSelectCount += 1;
      return agentsSelectCount === 1 ? agentRows : postMutationAgentRows;
    }
    if (table === bots) {
      return botRows;
    }
    if (table === decisions) {
      return decisionRows;
    }
    if (table === skills) {
      return skillRows;
    }
    if (table === skillEntitlements) {
      return skillEntitlementRows;
    }
    if (table === skillRevisions) {
      return skillRevisionRows;
    }
    if (table === agentSkills) {
      return agentSkillRows;
    }
    if (table === agentRuntimeSessions) {
      return sessionRows;
    }
    return [];
  };

  const makeSelectChain = (rows: Array<Record<string, unknown>>) => {
    const chain: Record<string, unknown> = {};
    chain.where = vi.fn().mockReturnValue(chain);
    chain.orderBy = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockImplementation(() => Promise.resolve(rows));
    (chain as { then: unknown }).then = (
      resolve: (v: unknown) => unknown,
      reject?: (v: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return chain;
  };

  const db: any = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation((table: unknown) => makeSelectChain(rowsForTable(table))),
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
        return {
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        };
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

function makePlansConfig(): PlansConfig {
  return {
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
            canViewOwnPrompts: true,
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
  };
}

describe('agent route plan enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when agent limit is reached', async () => {
    const { agentRoutes } = await import('./agents.js');
    const plans = makePlansConfig();
    plans.plans['free']!.entitlements.limits.maxAgents = 1;
    const { db, insertedValues } = buildDb({
      agentRows: [{ id: 'existing-agent-1' }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, plans);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'blocked agent',
        prompt: 'test',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('plan.limit_exceeded');
    expect(insertedValues).toHaveLength(0);
  });

  it('rejects reserved Telegram broadcast names on create', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb();

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'all',
        prompt: 'test',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string; details: Array<{ message: string }> }>().error).toBe('validation_error');
    expect(res.json<{ details: Array<{ message: string }> }>().details[0]?.message).toBe('Agent name is reserved for Telegram broadcast targeting');
  });

  it('blocks assigning free marketplace skills when marketplace access is disabled', async () => {
    const { agentRoutes } = await import('./agents.js');
    const plans = makePlansConfig();
    plans.plans['free']!.entitlements.skills.canViewMarketplaceSkills = false;
    const { db, insertedValues } = buildDb({
      agentRows: [],
      skillRows: [{
        id: 'market-skill-1',
        authorId: 'other-user',
        publicationStatus: 'published',
        priceCents: 0,
      }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, plans);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'agent',
        prompt: 'test',
        skillIds: ['market-skill-1'],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
    expect(res.json().message).toContain('not selectable');
    expect(insertedValues).toHaveLength(0);
  });

  it('blocks updating an agent with marketplace skills when marketplace access is disabled', async () => {
    const { agentRoutes } = await import('./agents.js');
    const plans = makePlansConfig();
    plans.plans['free']!.entitlements.skills.canViewMarketplaceSkills = false;

    const selectResponses: Array<Array<Record<string, unknown>>> = [
      [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        toolPolicy: null,
        modelPolicy: null,
        executionMode: null,
      }],
      [],
      [{
        id: 'market-skill-1',
        authorId: 'other-user',
        publicationStatus: 'published',
        priceCents: 0,
      }],
      [],
    ];

    const makeSelectChain = () => {
      const chain: Record<string, unknown> = {};
      chain.where = vi.fn().mockReturnValue(chain);
      chain.orderBy = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockImplementation(() => Promise.resolve(selectResponses.shift() ?? []));
      (chain as { then: unknown }).then = (
        resolve: (v: unknown) => unknown,
        reject?: (v: unknown) => unknown,
      ) => Promise.resolve(selectResponses.shift() ?? []).then(resolve, reject);
      return chain;
    };

    const updateSet = vi.fn();
    const db: any = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation(() => makeSelectChain()),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          updateSet(values);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
      insert: vi.fn(),
      transaction: vi.fn().mockImplementation(async (callback: (tx: any) => Promise<unknown>) => callback(db)),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    };

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, plans);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { skillIds: ['market-skill-1'] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
    expect(updateSet).not.toHaveBeenCalled();
  });
});

describe('agent routes lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns agent-native decisions even when the agent has no bots', async () => {
    const { agentRoutes } = await import('./agents.js');
    const decisionRow = {
      id: 'dec-1',
      actorType: 'agent',
      actorId: 'agent-1',
      instrumentId: 'BTC',
      intent: 'go_long',
    };
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'active', userId: TEST_USER_ID }],
      activeLinkRows: [],
      txAgentRows: [decisionRow],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/agents/agent-1/decisions?limit=10' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([decisionRow]);
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

  it('rejects reserved Telegram broadcast names on update', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', userId: TEST_USER_ID, status: 'stopped', name: 'Old Name', prompt: 'test' }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { name: '*' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string; details: Array<{ message: string }> }>().error).toBe('validation_error');
    expect(res.json<{ details: Array<{ message: string }> }>().details[0]?.message).toBe('Agent name is reserved for Telegram broadcast targeting');
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

  it('rejects explicit execution mode for non-trading agents on create', async () => {
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
        skillIds: ['task-management'],
        executionMode: 'paper',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'validation_error',
      details: [expect.objectContaining({ path: ['executionMode'] })],
    });
  });

  it('clears execution mode when trading skills are removed on PATCH', async () => {
    const { agentRoutes } = await import('./agents.js');
    const updatedAgent = {
      id: 'agent-1', userId: TEST_USER_ID, status: 'stopped', skillIds: ['task-management'], modelPolicy: null, executionMode: null,
    };
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: ['trading'], toolPolicy: null, modelPolicy: null, executionMode: 'paper' }],
      activeLinkRows: [updatedAgent],
      agentSkillRows: [{ skillId: 'task-management', orderIndex: 0 }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { skillIds: ['task-management'] },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(expect.objectContaining({ executionMode: null }));
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
    const skillRows = Array.isArray(agentRow?.['skillIds'])
      ? (agentRow['skillIds'] as unknown[]).map((skillId, orderIndex) => ({ skillId, orderIndex }))
      : [];

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
        return {
          from: vi.fn().mockImplementation((table: unknown) => {
            if (table === agents) {
              return { where: vi.fn().mockReturnValue(makeQueryable(agentRows)) };
            }
            if (table === agentRuntimeSessions) {
              return { where: vi.fn().mockReturnValue(makeQueryable(sessionRows)) };
            }
            if (table === agentSkills) {
              return { where: vi.fn().mockReturnValue(makeQueryable(skillRows)) };
            }
            return { where: vi.fn().mockReturnValue(makeQueryable([])) };
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
    // Two SELECTs: agent lookup + skill assignment lookup.
    expect(db.select).toHaveBeenCalledTimes(2);
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
    // Three SELECTs: agent lookup + session lookup + skill assignment lookup.
    expect(db.select).toHaveBeenCalledTimes(3);
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
      maxOpenPositions: 4,
      maxPositionSizePct: '40',
      stopLossPct: '2.5',
      stopLossCooldownMs: 120000,
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
        maxOpenPositions: 4,
        maxPositionSizePct: 40,
        stopLossPct: 2.5,
        stopLossCooldownMs: 120000,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(insertedValues).toContainEqual(expect.objectContaining({
      tickIntervalMs: 600_000,
      dailyTokenBudget: 42_000,
      capital: '5000',
      maxOpenPositions: 4,
      maxPositionSizePct: '40',
      stopLossPct: '2.5',
      stopLossCooldownMs: 120000,
    }));
    expect(res.json()).toEqual(expect.objectContaining({
      dailyLlmTokenBudget: 42_000,
      dailyTokenBudget: 42_000,
      capital: '5000',
      maxOpenPositions: 4,
      maxPositionSizePct: '40',
      stopLossPct: '2.5',
      stopLossCooldownMs: 120000,
    }));
  });

  it('returns the effective platform risk defaults', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb();

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/agents/risk-defaults' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      maxOpenPositions: 10,
      maxPositionSizePct: 100,
      stopLossPct: 10,
      stopLossCooldownMs: 300000,
    });
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

  it('rejects risk limits above operator defaults on create', async () => {
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
        maxOpenPositions: 999,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'validation_error',
      details: [expect.objectContaining({ path: ['maxOpenPositions'] })],
    });
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

  it('persists explicit risk limit overrides on PATCH', async () => {
    const { agentRoutes } = await import('./agents.js');
    const updatedAgent = {
      id: 'agent-1', userId: TEST_USER_ID, status: 'stopped', skillIds: [], modelPolicy: null,
      tickIntervalMs: null, capital: '750', dailyTokenBudget: 12_000,
      maxOpenPositions: 3, maxPositionSizePct: '55', stopLossPct: '4', stopLossCooldownMs: 180000,
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
      payload: { maxOpenPositions: 3, maxPositionSizePct: 55, stopLossPct: 4, stopLossCooldownMs: 180000 },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(expect.objectContaining({
      maxOpenPositions: 3,
      maxPositionSizePct: '55',
      stopLossPct: '4',
      stopLossCooldownMs: 180000,
    }));
    expect(res.json()).toEqual(expect.objectContaining({
      maxOpenPositions: 3,
      maxPositionSizePct: '55',
      stopLossPct: '4',
      stopLossCooldownMs: 180000,
    }));
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

// ---------------------------------------------------------------------------
// Technical config persistence (Phase 1 / Phase 9)
// ---------------------------------------------------------------------------
describe('agent routes — technical config persistence', () => {
  const TECHNICAL_STUB = {
    filters: { venue: 'hyperliquid', venueType: 'orderbook' as const },
    indicators: {
      rsi: { enabled: true, period: 14, healthyMin: 40, healthyMax: 70, overbought: 80, weakBelow: 30 },
      macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
      volume: { enabled: true, strongRatio: 1.5, weakRatio: 0.5, recentBars: 4, avgBars: 20 },
      choch: { enabled: false, swingLookback: 5, minSwingPct: 0.01, confirmBars: 2, rejectOnBearish: false },
      supportResistance: { enabled: false, lookback: 50, breakoutThreshold: 0.005 },
      confidence: {
        rsiWeight: 0.15, macdCrossoverWeight: 0.2, macdIncreasingWeight: 0.1,
        volumeWeight: 0.15, breakoutWeight: 0.15, chochBullishWeight: 0.15,
        chochBearishPenalty: 0.1, priceActionWeight: 0.1,
        minConfidence: 0.45, minReasons: 2,
      },
    },
    candles: { interval: '15m' as const, limit: 100 },
    signalBias: 'trend-following' as const,
    scanIntervalMs: 60_000,
    scanBatchSize: 5,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POST /agents with technical config stores it in unifiedConfig', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      modelPolicy: null,
      unifiedConfig: { technical: TECHNICAL_STUB },
    };
    const { db, insertedValues } = buildDb({ agentRows: [createdAgent] });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'technical agent', technical: TECHNICAL_STUB },
    });

    expect(res.statusCode).toBe(201);
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        unifiedConfig: expect.objectContaining({
          technical: expect.objectContaining({
            filters: TECHNICAL_STUB.filters,
            signalBias: TECHNICAL_STUB.signalBias,
            scanIntervalMs: TECHNICAL_STUB.scanIntervalMs,
          }),
        }),
      }),
    );
    expect(res.json().technical).toEqual(TECHNICAL_STUB);
  });

  it('PATCH /agents/:id with technical: null removes technical from unifiedConfig', async () => {
    const { agentRoutes } = await import('./agents.js');
    const updatedAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      name: 'technical agent',
      prompt: '',
      skillIds: [],
      modelPolicy: null,
      unifiedConfig: null,
    };
    const { db, updateSets } = buildDb({
      agentRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        skillIds: [],
        toolPolicy: null,
        modelPolicy: null,
        unifiedConfig: { technical: TECHNICAL_STUB },
      }],
      activeLinkRows: [updatedAgent],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { technical: null },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(expect.objectContaining({ unifiedConfig: null }));
    expect(res.json().technical).toBeNull();
  });

  it('GET /agents/:id includes technical from unifiedConfig in the response', async () => {
    const { agentRoutes } = await import('./agents.js');
    const agentRow = {
      id: 'agent-1',
      status: 'stopped',
      userId: TEST_USER_ID,
      modelPolicy: null,
      skillIds: [],
      unifiedConfig: { technical: TECHNICAL_STUB },
    };
    const { db } = buildDb({ agentRows: [agentRow] });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(200);
    expect(res.json().technical).toEqual(TECHNICAL_STUB);
  });

  it('PATCH /agents/:id with technical config merges it into unifiedConfig', async () => {
    const { agentRoutes } = await import('./agents.js');
    const updatedAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      modelPolicy: null,
      unifiedConfig: { someOtherKey: 'value', technical: TECHNICAL_STUB },
    };
    const { db, updateSets } = buildDb({
      agentRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        skillIds: [],
        toolPolicy: null,
        modelPolicy: null,
        unifiedConfig: { someOtherKey: 'value' },
      }],
      activeLinkRows: [updatedAgent],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { technical: TECHNICAL_STUB },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(
      expect.objectContaining({
        unifiedConfig: expect.objectContaining({
          someOtherKey: 'value',
          technical: expect.objectContaining({
            filters: TECHNICAL_STUB.filters,
            signalBias: TECHNICAL_STUB.signalBias,
            scanIntervalMs: TECHNICAL_STUB.scanIntervalMs,
          }),
        }),
      }),
    );
    expect(res.json().technical).toEqual(TECHNICAL_STUB);
  });
});

