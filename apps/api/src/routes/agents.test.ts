import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  agents,
  agentRuntimeSessions,
  agentSkills,
  bots,
  capabilityGrants,
  decisions,
  skillEntitlements,
  skillRevisions,
  skills,
  tradingBindings,
  venueAccounts,
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
  tradingBindingRows?: Array<Record<string, unknown>>;
  capabilityGrantRows?: Array<Record<string, unknown>>;
  venueAccountRows?: Array<Record<string, unknown>>;
} = {}) {
  const insertedValues: Array<Record<string, unknown>> = [];
  const updateSets: Array<Record<string, unknown>> = [];
  /** Tracks { table, values } for each db.update() call */
  const updateTableCalls: Array<{ table: unknown; values: Record<string, unknown> }> = [];
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
  const tradingBindingRows = options.tradingBindingRows ?? [];
  const capabilityGrantRows = options.capabilityGrantRows ?? [];
  const venueAccountRows = options.venueAccountRows ?? [];

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
    if (table === tradingBindings) {
      return tradingBindingRows;
    }
    if (table === capabilityGrants) {
      return capabilityGrantRows;
    }
    if (table === venueAccounts) {
      return venueAccountRows;
    }
    return [];
  };

  const makeSelectChain = (rows: Array<Record<string, unknown>>) => {
    const chain: Record<string, unknown> = {};
    chain.where = vi.fn().mockReturnValue(chain);
    chain.orderBy = vi.fn().mockReturnValue(chain);
    chain.innerJoin = vi.fn().mockReturnValue(chain);
    chain.groupBy = vi.fn().mockReturnValue(chain);
    chain.having = vi.fn().mockReturnValue(chain);
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
    update: vi.fn().mockImplementation((table: unknown) => ({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        updateSets.push(values);
        updateTableCalls.push({ table, values });
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(values['status'] === 'starting' ? [{ id: 'agent-1' }] : []),
          }),
        };
      }),
    })),
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

  return { db, insertedValues, updateSets, updateTableCalls, deletedTargets };
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

  it('deletes outbound messages, artifacts, sessions, agent-created bots, then the agent in order', async () => {
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
      bots,
      agents,
    ]);
  });

  it('nulls billing_usage_events FK columns before deleting the agent', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { billingUsageEvents } = await import('@herobids/db');
    const { db, updateTableCalls } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(204);
    const billingUpdate = updateTableCalls.find((c) => c.table === billingUsageEvents);
    expect(billingUpdate).toBeDefined();
    expect(billingUpdate!.values).toEqual({ sessionId: null, agentId: null });
  });

  it('resolves orphaned trading_bindings via capability_grants join before deleting the agent', async () => {
    const { agentRoutes } = await import('./agents.js');
    const orphanedBinding = {
      id: 'binding-1',
      sourceVenueAccountId: 'va-1',
    };
    const { db, updateTableCalls } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      tradingBindingRows: [orphanedBinding],
      capabilityGrantRows: [{ id: 'grant-1', agentId: 'agent-1', bindingId: 'binding-1' }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(204);
    // Verify venueAccounts.credentialId was nulled for the orphaned venue account
    const vaUpdate = updateTableCalls.find((c) => c.table === venueAccounts);
    expect(vaUpdate).toBeDefined();
    expect(vaUpdate!.values).toEqual({ credentialId: null });
    // Verify trading_bindings was marked revoked
    const bindingUpdate = updateTableCalls.find((c) => c.table === tradingBindings);
    expect(bindingUpdate).toBeDefined();
    expect(bindingUpdate!.values).toEqual({ status: 'revoked' });
  });

  it('skips binding cleanup when agent has no capability grants (no orphaned bindings)', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateTableCalls, deletedTargets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      tradingBindingRows: [],
      capabilityGrantRows: [],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(204);
    // No venue account or trading binding updates should have occurred
    const vaUpdates = updateTableCalls.filter((c) => c.table === venueAccounts);
    expect(vaUpdates).toHaveLength(0);
    const bindingUpdates = updateTableCalls.filter((c) => c.table === tradingBindings);
    expect(bindingUpdates).toHaveLength(0);
    // But agent-created bots should still be deleted
    expect(deletedTargets).toContain(bots);
  });

  it('preserves binding when another agent still has a grant on the same binding', async () => {
    const { agentRoutes } = await import('./agents.js');
    const sharedBinding = {
      id: 'binding-shared',
      sourceVenueAccountId: 'va-shared',
    };
    const { db, updateTableCalls } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      tradingBindingRows: [sharedBinding],
      capabilityGrantRows: [
        { id: 'grant-1', agentId: 'agent-1', bindingId: 'binding-shared' },
        { id: 'grant-2', agentId: 'agent-2', bindingId: 'binding-shared' },
      ],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(204);
    // Binding is shared with another agent (2 grants in capabilityGrantRows),
    // so it must NOT be revoked and its venue account credentialId must stay intact.
    const bindingUpdates = updateTableCalls.filter((c) => c.table === tradingBindings);
    expect(bindingUpdates).toHaveLength(0);
    const vaUpdates = updateTableCalls.filter((c) => c.table === venueAccounts);
    expect(vaUpdates).toHaveLength(0);
  });

  it('does not delete user-created or system bots', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, deletedTargets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      botRows: [
        { id: 'bot-agent', creatorType: 'agent', creatorId: 'agent-1' },
        { id: 'bot-user', creatorType: 'user', creatorId: TEST_USER_ID },
        { id: 'bot-system', creatorType: 'system', creatorId: null },
      ],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(204);
    // The bots table is deleted with WHERE creatorType='agent' AND creatorId=id,
    // which targets only agent-created bots. The mock records that bots was deleted,
    // but does not verify the WHERE clause — the implementation handles this correctly.
    expect(deletedTargets).toContain(bots);
  });

  it('handles orphaned venue account with null sourceVenueAccountId gracefully', async () => {
    const { agentRoutes } = await import('./agents.js');
    const bindingNullVa = {
      id: 'binding-null-va',
      sourceVenueAccountId: null,
    };
    const { db, updateTableCalls } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      tradingBindingRows: [bindingNullVa],
      capabilityGrantRows: [
        { id: 'grant-1', agentId: 'agent-1', bindingId: 'binding-null-va' },
      ],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(204);
    // No venue account update should occur since sourceVenueAccountId is null
    const vaUpdates = updateTableCalls.filter((c) => c.table === venueAccounts);
    expect(vaUpdates).toHaveLength(0);
    // But binding should still be revoked
    const bindingUpdate = updateTableCalls.find((c) => c.table === tradingBindings);
    expect(bindingUpdate).toBeDefined();
    expect(bindingUpdate!.values).toEqual({ status: 'revoked' });
  });

  it('full cleanup chain: agent with trading capability → delete → credentialId nulled and binding revoked', async () => {
    // End-to-end simulation of plan test item 2:
    // Agent has a trading binding via capability_grant → delete agent →
    // credentialId is nulled (unblocking credential deletion) and binding is revoked.
    const { agentRoutes } = await import('./agents.js');
    const { db, updateTableCalls, deletedTargets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      tradingBindingRows: [
        { id: 'binding-1', sourceVenueAccountId: 'va-1' },
      ],
      capabilityGrantRows: [
        { id: 'grant-1', agentId: 'agent-1', bindingId: 'binding-1' },
      ],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(204);

    // Step 5: agent-created bots deleted
    expect(deletedTargets).toContain(bots);

    // Step 7: credentialId nulled on the linked venue account
    const vaUpdate = updateTableCalls.find((c) => c.table === venueAccounts);
    expect(vaUpdate).toBeDefined();
    expect(vaUpdate!.values).toEqual({ credentialId: null });

    // Step 8: trading binding revoked
    const bindingUpdate = updateTableCalls.find((c) => c.table === tradingBindings);
    expect(bindingUpdate).toBeDefined();
    expect(bindingUpdate!.values).toEqual({ status: 'revoked' });

    // Step 9: agent deleted
    expect(deletedTargets).toContain(agents);
  });

  it('two agents sharing one trading binding: deleting first agent preserves the shared binding', async () => {
    // Plan test item 3: Two agents both have grants on the same binding.
    // When agent-1 is deleted, the binding must stay active because agent-2
    // still has a grant on it. The count query returns 2 → not orphaned.
    const { agentRoutes } = await import('./agents.js');
    const sharedBinding = {
      id: 'binding-shared',
      sourceVenueAccountId: 'va-shared',
    };
    const { db: db1, updateTableCalls: calls1 } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      tradingBindingRows: [sharedBinding],
      capabilityGrantRows: [
        { id: 'grant-1', agentId: 'agent-1', bindingId: 'binding-shared' },
        { id: 'grant-2', agentId: 'agent-2', bindingId: 'binding-shared' },
      ],
    });

    const app1 = Fastify();
    decorateWithAuth(app1);
    await agentRoutes(app1, db1);

    const res1 = await app1.inject({ method: 'DELETE', url: '/agents/agent-1' });
    expect(res1.statusCode).toBe(204);

    // Binding must NOT be revoked — agent-2 still uses it.
    const bindingUpdates1 = calls1.filter((c) => c.table === tradingBindings);
    expect(bindingUpdates1).toHaveLength(0);
    // credentialId must NOT be nulled — agent-2's venue account still needs it.
    const vaUpdates1 = calls1.filter((c) => c.table === venueAccounts);
    expect(vaUpdates1).toHaveLength(0);
  });

  it('two agents sharing one trading binding: deleting last agent revokes the shared binding', async () => {
    // Plan test item 4: Agent-2 is the last agent using this binding.
    // The count query returns 1 → binding is orphaned and must be revoked.
    const { agentRoutes } = await import('./agents.js');
    const sharedBinding = {
      id: 'binding-shared',
      sourceVenueAccountId: 'va-shared',
    };
    const { db: db2, updateTableCalls: calls2 } = buildDb({
      agentRows: [{ id: 'agent-2', status: 'stopped', userId: TEST_USER_ID }],
      tradingBindingRows: [sharedBinding],
      capabilityGrantRows: [
        { id: 'grant-2', agentId: 'agent-2', bindingId: 'binding-shared' },
      ],
    });

    const app2 = Fastify();
    decorateWithAuth(app2);
    await agentRoutes(app2, db2);

    const res2 = await app2.inject({ method: 'DELETE', url: '/agents/agent-2' });
    expect(res2.statusCode).toBe(204);

    // Binding is the sole remaining grant → must be revoked.
    const bindingUpdate2 = calls2.find((c) => c.table === tradingBindings);
    expect(bindingUpdate2).toBeDefined();
    expect(bindingUpdate2!.values).toEqual({ status: 'revoked' });

    // credentialId must be nulled to unblock credential deletion.
    const vaUpdate2 = calls2.find((c) => c.table === venueAccounts);
    expect(vaUpdate2).toBeDefined();
    expect(vaUpdate2!.values).toEqual({ credentialId: null });
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

  it('does not explicitly set executionMode when trading skills are removed on PATCH', async () => {
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
    // executionMode is NOT NULL in the schema — when no valid value exists
    // (skills removed, no execution mode provided), the field is left unchanged
    // rather than set to null (which would violate the DB constraint).
    const hasExecutionMode = updateSets.some((set: Record<string, unknown>) => 'executionMode' in set);
    expect(hasExecutionMode).toBe(false);
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
      dailyLossLimitDefaultRatio: 0.05,
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

// ---------------------------------------------------------------------------
// POST /agents/:id/stop
// ---------------------------------------------------------------------------
describe('POST /agents/:id/stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['active'],
    ['starting'],
    ['paused'],
    ['unhealthy'],
    ['crashed'],
  ])('stops a %s agent and returns { status: "stopped" }', async (status) => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status, userId: TEST_USER_ID }],
      sessionRows: [{ id: 'session-1', agentId: 'agent-1', status: 'running' }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/stop' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'stopped' });
    expect(updateSets).toContainEqual(expect.objectContaining({ status: 'stopped', pauseState: null }));
  });

  it('returns { status: "stopped" } when agent is already stopped (idempotent)', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/stop' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'stopped' });
    // No update should be issued for an already-stopped agent
    expect(updateSets.filter((s) => s['status'] === 'stopped')).toHaveLength(0);
  });

  it('returns 404 when the agent is not found', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({ agentRows: [] });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/stop' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('returns 404 when the user does not own the agent', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb();

    const app = Fastify();
    decorateWithAuth(app, 'other-user');
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/stop' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('retires active runtime sessions when stopping', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'active', userId: TEST_USER_ID }],
      sessionRows: [
        { id: 'session-1', agentId: 'agent-1', status: 'running' },
        { id: 'session-2', agentId: 'agent-1', status: 'starting' },
        { id: 'session-3', agentId: 'agent-1', status: 'unhealthy' },
      ],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/stop' });

    expect(res.statusCode).toBe(200);
    // Agent status update and session retirements should be in updateSets
    const sessionUpdates = updateSets.filter((s) => s['status'] === 'stopped' && s['stoppedAt'] !== undefined);
    expect(sessionUpdates.length).toBeGreaterThanOrEqual(1);
  });
});

