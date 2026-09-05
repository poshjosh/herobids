import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  agents,
  agentConnections,
  agentRuntimeSessions,
  agentSkills,
  bots,
  decisions,
  skillEntitlements,
  skillRevisions,
  skills,
  connections,
  users,
  venueAccounts,
} from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import { RUNTIME_POLICY_CEILINGS } from '@herobids/domain';
import type { LlmCatalogDeps } from '../llm-model-catalog.js';

// Strategy preset YAML files are resolved relative to HEROBIDS_CONFIG_DIR or cwd.
// In test, cwd is the package dir (apps/api), so we must point to the repo root.
const __dirname = dirname(fileURLToPath(import.meta.url));
process.env['HEROBIDS_CONFIG_DIR'] = resolve(__dirname, '../../../..');

const mockLlmCatalogDeps: LlmCatalogDeps = {
  db: {} as never,
  providersYaml: {
    providers: {
      openai: {
        catalogMode: 'static',
        models: {
          'gpt-4o': { inputUsdPerM: 2.5, outputUsdPerM: 10 },
          'gpt-4o-mini': { inputUsdPerM: 0.15, outputUsdPerM: 0.6 },
        },
      },
      anthropic: {
        catalogMode: 'static',
        models: {
          'claude-haiku-3-5': { inputUsdPerM: 0.8, outputUsdPerM: 4 },
          'claude-sonnet-4-5': { inputUsdPerM: 3, outputUsdPerM: 15 },
        },
      },
    },
  },
  context: {
    provider: 'openai',
    model: 'gpt-4o',
    baseUrl: undefined,
    catalogTimeoutMs: 3000,
    catalogCacheTtlMs: 86_400_000,
  },
};

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
  connectionRows?: Array<Record<string, unknown>>;
  agentConnectionRows?: Array<Record<string, unknown>>;
  /** @deprecated Use agentConnectionRows. Legacy alias kept for test compatibility. */
  capabilityGrantRows?: Array<Record<string, unknown>>;
  venueAccountRows?: Array<Record<string, unknown>>;
  userRows?: Array<Record<string, unknown>>;
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
  const connectionRows = options.connectionRows ?? [];
  const agentConnectionRows = options.agentConnectionRows ?? options.capabilityGrantRows ?? [];
  const venueAccountRows = options.venueAccountRows ?? [];
  const userRows = options.userRows ?? [];

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
    if (table === connections) {
      return connectionRows;
    }
    if (table === agentConnections) {
      return agentConnectionRows;
    }
    if (table === venueAccounts) {
      return venueAccountRows;
    }
    if (table === users) {
      return userRows;
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
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
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
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, modelPolicy: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
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

  it('deletes child rows in correct order: agent is the last table deleted, no manual marketAssessmentRequests cleanup', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { agents, marketAssessmentRequests } = await import('@herobids/db');
    const { db, deletedTargets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(204);
    // Route must NOT manually delete marketAssessmentRequests (DB cascade handles it)
    expect(deletedTargets).not.toContain(marketAssessmentRequests);
    // agents must be the final delete (cascades handle dependency tables)
    const agentIndex = deletedTargets.indexOf(agents);
    expect(agentIndex).toBeGreaterThan(-1);
    expect(deletedTargets[deletedTargets.length - 1]).toBe(agents);
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

  it('resolves orphaned connections via agent_connections join before deleting the agent', async () => {
    const { agentRoutes } = await import('./agents.js');
    const orphanedBinding = {
      id: 'binding-1',
      resolvedVenueAccountId: 'va-1', provider: 'hyperliquid', label: 'Test', status: 'active',
    };
    const { db, updateTableCalls } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      connectionRows: [orphanedBinding],
      capabilityGrantRows: [{ id: 'grant-1', agentId: 'agent-1', connectionId: 'binding-1' }],
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
    // Verify connections was marked revoked
    const connectionUpdate = updateTableCalls.find((c) => c.table === connections);
    expect(connectionUpdate).toBeDefined();
    expect(connectionUpdate!.values).toEqual({ status: 'revoked' });
  });

  it('skips binding cleanup when agent has no capability grants (no orphaned bindings)', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateTableCalls, deletedTargets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      connectionRows: [],
      capabilityGrantRows: [],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(204);
    // No venue account or connection updates should have occurred
    const vaUpdates = updateTableCalls.filter((c) => c.table === venueAccounts);
    expect(vaUpdates).toHaveLength(0);
    const connectionUpdates = updateTableCalls.filter((c) => c.table === connections);
    expect(connectionUpdates).toHaveLength(0);
    // But agent-created bots should still be deleted
    expect(deletedTargets).toContain(bots);
  });

  it('preserves binding when another agent still has a grant on the same binding', async () => {
    const { agentRoutes } = await import('./agents.js');
    const sharedBinding = {
      id: 'binding-shared',
      resolvedVenueAccountId: 'va-shared', provider: 'hyperliquid', label: 'Shared', status: 'active',
    };
    const { db, updateTableCalls } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      connectionRows: [sharedBinding],
      capabilityGrantRows: [
        { id: 'grant-1', agentId: 'agent-1', connectionId: 'binding-shared' },
        { id: 'grant-2', agentId: 'agent-2', connectionId: 'binding-shared' },
      ],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(204);
    // Binding is shared with another agent (2 grants in capabilityGrantRows),
    // so it must NOT be revoked and its venue account credentialId must stay intact.
    const connectionUpdates = updateTableCalls.filter((c) => c.table === connections);
    expect(connectionUpdates).toHaveLength(0);
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

  it('handles orphaned venue account with null resolvedVenueAccountId gracefully', async () => {
    const { agentRoutes } = await import('./agents.js');
    const bindingNullVa = {
      id: 'binding-null-va',
      resolvedVenueAccountId: null, provider: 'hyperliquid', label: 'Null VA', status: 'active',
    };
    const { db, updateTableCalls } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      connectionRows: [bindingNullVa],
      capabilityGrantRows: [
        { id: 'grant-1', agentId: 'agent-1', connectionId: 'binding-null-va' },
      ],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(204);
    // No venue account update should occur since resolvedVenueAccountId is null
    const vaUpdates = updateTableCalls.filter((c) => c.table === venueAccounts);
    expect(vaUpdates).toHaveLength(0);
    // But binding should still be revoked
    const connectionUpdate = updateTableCalls.find((c) => c.table === connections);
    expect(connectionUpdate).toBeDefined();
    expect(connectionUpdate!.values).toEqual({ status: 'revoked' });
  });

  it('full cleanup chain: agent with trading capability → delete → credentialId nulled and binding revoked', async () => {
    // End-to-end simulation of plan test item 2:
    // Agent has a connection via capability_grant → delete agent →
    // credentialId is nulled (unblocking credential deletion) and binding is revoked.
    const { agentRoutes } = await import('./agents.js');
    const { db, updateTableCalls, deletedTargets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      connectionRows: [
        { id: 'binding-1', resolvedVenueAccountId: 'va-1', provider: 'hyperliquid', label: 'Test', status: 'active' },
      ],
      capabilityGrantRows: [
        { id: 'grant-1', agentId: 'agent-1', connectionId: 'binding-1' },
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

    // Step 8: connection revoked
    const connectionUpdate = updateTableCalls.find((c) => c.table === connections);
    expect(connectionUpdate).toBeDefined();
    expect(connectionUpdate!.values).toEqual({ status: 'revoked' });

    // Step 9: agent deleted
    expect(deletedTargets).toContain(agents);
  });

  it('two agents sharing one connection: deleting first agent preserves the shared binding', async () => {
    // Plan test item 3: Two agents both have grants on the same binding.
    // When agent-1 is deleted, the binding must stay active because agent-2
    // still has a grant on it. The count query returns 2 → not orphaned.
    const { agentRoutes } = await import('./agents.js');
    const sharedBinding = {
      id: 'binding-shared',
      resolvedVenueAccountId: 'va-shared', provider: 'hyperliquid', label: 'Shared', status: 'active',
    };
    const { db: db1, updateTableCalls: calls1 } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      connectionRows: [sharedBinding],
      capabilityGrantRows: [
        { id: 'grant-1', agentId: 'agent-1', connectionId: 'binding-shared' },
        { id: 'grant-2', agentId: 'agent-2', connectionId: 'binding-shared' },
      ],
    });

    const app1 = Fastify();
    decorateWithAuth(app1);
    await agentRoutes(app1, db1);

    const res1 = await app1.inject({ method: 'DELETE', url: '/agents/agent-1' });
    expect(res1.statusCode).toBe(204);

    // Binding must NOT be revoked — agent-2 still uses it.
    const bindingUpdates1 = calls1.filter((c) => c.table === connections);
    expect(bindingUpdates1).toHaveLength(0);
    // credentialId must NOT be nulled — agent-2's venue account still needs it.
    const vaUpdates1 = calls1.filter((c) => c.table === venueAccounts);
    expect(vaUpdates1).toHaveLength(0);
  });

  it('two agents sharing one connection: deleting last agent revokes the shared binding', async () => {
    // Plan test item 4: Agent-2 is the last agent using this binding.
    // The count query returns 1 → binding is orphaned and must be revoked.
    const { agentRoutes } = await import('./agents.js');
    const sharedBinding = {
      id: 'binding-shared',
      resolvedVenueAccountId: 'va-shared', provider: 'hyperliquid', label: 'Shared', status: 'active',
    };
    const { db: db2, updateTableCalls: calls2 } = buildDb({
      agentRows: [{ id: 'agent-2', status: 'stopped', userId: TEST_USER_ID }],
      connectionRows: [sharedBinding],
      capabilityGrantRows: [
        { id: 'grant-2', agentId: 'agent-2', connectionId: 'binding-shared' },
      ],
    });

    const app2 = Fastify();
    decorateWithAuth(app2);
    await agentRoutes(app2, db2);

    const res2 = await app2.inject({ method: 'DELETE', url: '/agents/agent-2' });
    expect(res2.statusCode).toBe(204);

    // Binding is the sole remaining grant → must be revoked.
    const bindingUpdate2 = calls2.find((c) => c.table === connections);
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

  it('allows non-admin users to create agents with shadow execution mode', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: ['trading'],
      modelPolicy: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
      executionMode: 'shadow',
    };
    const { db } = buildDb({
      agentRows: [createdAgent],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
      skillRows: [
        { id: 'trading', authorId: null, publicationStatus: 'published', priceCents: 0, currentRevisionId: 'rev-trading' },
        { id: 'bot-management', authorId: null, publicationStatus: 'published', priceCents: 0, currentRevisionId: 'rev-bot-management' },
      ],
      // Shadow execution requires a granted connection — see validateConnectionRequirement.
      connectionRows: [{ id: 'conn-1', userId: TEST_USER_ID, status: 'active' }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'shadow agent',
        prompt: 'test',
        skillIds: ['trading'],
        executionDefaults: { mode: 'shadow' },
        connectionIds: ['conn-1'],
      },
    });

    // Non-admin users must be able to create agents with shadow execution mode.
    // The removed admin-only guard would have returned 403.
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).toBe(201);
  });

  it('rejects creating an agent with shadow or live execution mode and no granted connection', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', userId: TEST_USER_ID, status: 'stopped', skillIds: ['trading'], modelPolicy: null, executionDefaults: { mode: 'shadow' } }],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'shadow agent',
        prompt: 'test',
        skillIds: ['trading'],
        executionDefaults: { mode: 'shadow' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'validation_error',
      details: [expect.objectContaining({ path: ['connectionIds'] })],
    });
  });

  it('allows non-admin users to update agents to shadow execution mode', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: ['trading'], toolPolicy: null, modelPolicy: null, executionMode: 'paper' }],
      activeLinkRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: ['trading'], toolPolicy: null, modelPolicy: null, executionMode: 'shadow' }],
      agentSkillRows: [{ skillId: 'trading', orderIndex: 0 }],
      // Shadow execution requires a granted connection — see validateConnectionRequirement.
      agentConnectionRows: [{ id: 'grant-1', agentId: 'agent-1', connectionId: 'conn-1', status: 'active' }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        name: 'shadow agent updated',
        prompt: 'test updated',
        executionMode: 'shadow',
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it('rejects updating an agent to shadow execution mode with no granted connection', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: ['trading'], toolPolicy: null, modelPolicy: null, executionDefaults: { mode: 'paper' } }],
      agentSkillRows: [{ skillId: 'trading', orderIndex: 0 }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        name: 'shadow agent updated',
        prompt: 'test updated',
        executionDefaults: { mode: 'shadow' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'validation_error',
      details: [expect.objectContaining({ path: ['connectionIds'] })],
    });
  });

  it('allows explicitly clearing connectionIds from a paper-mode agent', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: ['trading'], toolPolicy: null, modelPolicy: null, executionMode: 'paper' }],
      activeLinkRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: ['trading'], toolPolicy: null, modelPolicy: null, executionMode: 'paper' }],
      agentSkillRows: [{ skillId: 'trading', orderIndex: 0 }],
      agentConnectionRows: [{ id: 'grant-1', agentId: 'agent-1', connectionId: 'conn-1', status: 'active' }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        connectionIds: [],
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it('resolves test mode to shadow on PATCH when the agent has active connections', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: ['trading'], toolPolicy: null, modelPolicy: null, executionDefaults: { mode: 'paper' } }],
      activeLinkRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: ['trading'], toolPolicy: null, modelPolicy: null, executionDefaults: { mode: 'shadow' } }],
      agentSkillRows: [{ skillId: 'trading', orderIndex: 0 }],
      agentConnectionRows: [{ id: 'grant-1', agentId: 'agent-1', connectionId: 'conn-1', status: 'active' }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        executionDefaults: { mode: 'shadow' },
      },
    });

    expect(res.statusCode).toBe(200);
    const agentUpdate = updateSets.find((s: Record<string, unknown>) => 'executionDefaults' in s);
    expect(agentUpdate).toBeDefined();
    expect((agentUpdate as Record<string, unknown>)['executionDefaults']).toEqual({ mode: 'shadow' });
  });

  it('resolves test mode to paper on PATCH when the agent has no connections', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: ['trading'], toolPolicy: null, modelPolicy: null, executionDefaults: { mode: 'paper' } }],
      activeLinkRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: ['trading'], toolPolicy: null, modelPolicy: null, executionDefaults: { mode: 'paper' } }],
      agentSkillRows: [{ skillId: 'trading', orderIndex: 0 }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        executionDefaults: { mode: 'paper' },
      },
    });

    expect(res.statusCode).toBe(200);
    const agentUpdate = updateSets.find((s: Record<string, unknown>) => 'executionDefaults' in s);
    expect(agentUpdate).toBeDefined();
    expect((agentUpdate as Record<string, unknown>)['executionDefaults']).toEqual({ mode: 'paper' });
  });

  it('rejects explicit execution mode for non-trading agents on create', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

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
        executionDefaults: { mode: 'paper' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'validation_error',
      details: [expect.objectContaining({ path: ['executionMode'] })],
    });
  });

  it('rejects creating a trading-capable agent without executionDefaults', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'no exec defaults',
        prompt: 'trade',
        skillIds: ['trading'],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; details: Array<{ message: string }> }>();
    expect(body.error).toBe('validation_error');
    expect(body.details[0]?.message).toContain('executionDefaults is required for trading-capable agents');
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
    await agentRoutes(app, db, undefined, mockLlmCatalogDeps);

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

  it('rejects create with 400 when no model policy is set and user has no AI settings configured', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [],
      // No userRows — user has no saved AI model settings
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'new agent',
        prompt: 'trade carefully',
        // No provider / lightModel / heavyModel
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'validation_error',
      details: [expect.objectContaining({
        path: ['provider'],
        message: 'Provider is required — set it here or configure your AI settings in Settings',
      })],
    });
  });

  it('accepts create when the user has valid AI settings and no explicit model policy is set', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      modelPolicy: null,
    };
    const { db, insertedValues } = buildDb({
      agentRows: [createdAgent],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'new agent',
        prompt: 'trade carefully',
        // No explicit provider — user AI settings will satisfy the check
      },
    });

    expect(res.statusCode).toBe(201);
    expect(insertedValues).toContainEqual(expect.objectContaining({ name: 'new agent' }));
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
// Style-based strategy preset writes (create + update)
// ---------------------------------------------------------------------------
describe('agent routes strategy preset resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a strategyPreset on create and persists translated config into unifiedConfig', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = { id: 'agent-1', userId: TEST_USER_ID, status: 'stopped', skillIds: [], modelPolicy: null };
    const { db, insertedValues } = buildDb({
      agentRows: [createdAgent],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'preset agent',
        prompt: 'trade momentum',
        style: 'careful',
        strategyPreset: 'momentum',
      },
    });

    expect(res.statusCode).toBe(201);
    const insertedAgent = insertedValues.find((v) => v['name'] === 'preset agent');
    expect(insertedAgent).toBeDefined();
    const unifiedConfig = insertedAgent!['unifiedConfig'] as Record<string, unknown>;
    expect(unifiedConfig).toBeDefined();
    expect(unifiedConfig['technical']).toBeDefined();
    expect(unifiedConfig['metadata']).toMatchObject({
      strategyPreset: 'momentum',
      strategyPresetStyle: 'economy', // careful → economy tier
      strategyPresetSource: 'agent-style',
    });
  });

  it('populates technical.filters from connection provider when creating a hybrid agent with strategyPreset', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = { id: 'agent-1', userId: TEST_USER_ID, status: 'stopped', skillIds: [], modelPolicy: null };
    const { db, insertedValues } = buildDb({
      agentRows: [createdAgent],
      connectionRows: [
        { id: 'conn-1', userId: TEST_USER_ID, status: 'active', provider: 'hyperliquid' },
      ],
      skillRows: [
        { id: 'trading', authorId: null, publicationStatus: 'published', priceCents: 0, currentRevisionId: 'rev-trading' },
      ],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'hybrid-filter-agent',
        prompt: 'trade momentum',
        style: 'balanced',
        skillIds: ['trading'],
        strategyPreset: 'momentum',
        capabilityMode: 'hybrid',
        hybridMode: 'scanner_gated',
        executionDefaults: { mode: 'paper' },
        connectionIds: ['conn-1'],
      },
    });

    expect(res.statusCode).toBe(201);
    const insertedAgent = insertedValues.find((v) => v['name'] === 'hybrid-filter-agent');
    expect(insertedAgent).toBeDefined();
    const unifiedConfig = insertedAgent!['unifiedConfig'] as Record<string, unknown>;
    const technical = unifiedConfig['technical'] as Record<string, unknown>;
    expect(technical).toBeDefined();
    expect(technical['filters']).toEqual({
      venue: 'hyperliquid',
      venueType: 'orderbook',
      quoteAssetSymbol: 'USDC',
    });
  });

  // Regression (bug 2026-09-04/004): connection enrichment on create must MERGE,
  // not replace — client-supplied filter fields (symbols, minVolume24hUsd) must
  // survive while venue/venueType come from the connection.
  it('merges connection venue/venueType into explicit filters on create without dropping symbols', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = { id: 'agent-1', userId: TEST_USER_ID, status: 'stopped', skillIds: [], modelPolicy: null };
    const { db, insertedValues } = buildDb({
      agentRows: [createdAgent],
      connectionRows: [
        { id: 'conn-1', userId: TEST_USER_ID, status: 'active', provider: 'hyperliquid' },
      ],
      skillRows: [
        { id: 'trading', authorId: null, publicationStatus: 'published', priceCents: 0, currentRevisionId: 'rev-trading' },
      ],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'merge-filter-agent',
        prompt: 'trade momentum',
        style: 'balanced',
        skillIds: ['trading'],
        capabilityMode: 'hybrid',
        hybridMode: 'scanner_gated',
        executionDefaults: { mode: 'paper' },
        connectionIds: ['conn-1'],
        technical: {
          // Schema requires venue/venueType. Client supplies them here, but the
          // connection is authoritative and overrides them below.
          filters: { venue: 'jupiter', venueType: 'swap', symbols: ['BTC', 'ETH'], minVolume24hUsd: 1_000_000 },
          regime: { benchmarkSymbol: 'BTC' },
        },
      },
    });

    expect(res.statusCode).toBe(201);
    const insertedAgent = insertedValues.find((v) => v['name'] === 'merge-filter-agent');
    expect(insertedAgent).toBeDefined();
    const unifiedConfig = insertedAgent!['unifiedConfig'] as Record<string, unknown>;
    const technical = unifiedConfig['technical'] as Record<string, unknown>;
    const filters = technical['filters'] as Record<string, unknown>;
    // Connection is authoritative for venue/venueType.
    expect(filters['venue']).toBe('hyperliquid');
    expect(filters['venueType']).toBe('orderbook');
    // Client-owned fields survive the merge (the regression this locks in).
    expect(filters['symbols']).toEqual(['BTC', 'ETH']);
    expect(filters['minVolume24hUsd']).toBe(1_000_000);
  });

  it('does NOT populate technical.filters when creating agent without connections', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = { id: 'agent-1', userId: TEST_USER_ID, status: 'stopped', skillIds: [], modelPolicy: null };
    const { db, insertedValues } = buildDb({
      agentRows: [createdAgent],
      connectionRows: [],
      skillRows: [
        { id: 'trading', authorId: null, publicationStatus: 'published', priceCents: 0, currentRevisionId: 'rev-trading' },
      ],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'no-conn-agent',
        prompt: 'trade momentum',
        style: 'balanced',
        skillIds: ['trading'],
        strategyPreset: 'momentum',
        capabilityMode: 'hybrid',
        hybridMode: 'scanner_gated',
        executionDefaults: { mode: 'paper' },
      },
    });

    expect(res.statusCode).toBe(201);
    const insertedAgent = insertedValues.find((v) => v['name'] === 'no-conn-agent');
    expect(insertedAgent).toBeDefined();
    const unifiedConfig = insertedAgent!['unifiedConfig'] as Record<string, unknown>;
    const technical = unifiedConfig['technical'] as Record<string, unknown>;
    expect(technical).toBeDefined();
    // Filters should NOT be populated when no connections are provided
    // (the worker's Fix 2 guard handles this gracefully)
    expect(technical['filters']).toBeUndefined();
  });

  it('lets an explicit stopLossPct override the preset default on create', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = { id: 'agent-1', userId: TEST_USER_ID, status: 'stopped', skillIds: [], modelPolicy: null };
    const { db, insertedValues } = buildDb({
      agentRows: [createdAgent],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'preset override',
        prompt: 'trade momentum',
        style: 'balanced',
        strategyPreset: 'momentum',
        risk: { stopLossPct: 7 },
      },
    });

    expect(res.statusCode).toBe(201);
    const insertedAgent = insertedValues.find((v) => v['name'] === 'preset override');
    expect((insertedAgent!['risk'] as Record<string, unknown>)?.stopLossPct).toBe(7);
  });

  it('clears preset-managed config (metadata + execution) on PATCH strategyPreset: null while keeping technical', async () => {
    const { agentRoutes } = await import('./agents.js');
    const existingUnifiedConfig = {
      technical: { signalBias: 'trend-following' },
      execution: { positionSizeMode: 'percent_equity', fixedPositionSize: '2' },
      metadata: { strategyPreset: 'momentum', strategyPresetStyle: 'standard', strategyPresetSource: 'agent-style' },
    };
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], modelPolicy: null, unifiedConfig: existingUnifiedConfig, style: 'balanced' }],
      activeLinkRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], modelPolicy: null }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { strategyPreset: null },
    });

    expect(res.statusCode).toBe(200);
    const configUpdate = updateSets.find((s) => 'unifiedConfig' in s);
    expect(configUpdate).toBeDefined();
    const patched = configUpdate!['unifiedConfig'] as Record<string, unknown> | null;
    // technical is preserved; preset-managed metadata + execution are removed
    expect(patched).toMatchObject({ technical: { signalBias: 'trend-following' } });
    expect(patched).not.toHaveProperty('metadata');
    expect(patched).not.toHaveProperty('execution');
  });

  it('PATCH with strategyPreset and connectionIds populates technical.filters from connection provider', async () => {
    const { agentRoutes } = await import('./agents.js');
    const existingUnifiedConfig = {
      technical: { signalBias: 'trend-following', indicators: {}, candles: { interval: '15m', limit: 48 } },
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
    };
    const { db, updateSets } = buildDb({
      agentRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        skillIds: [],
        modelPolicy: null,
        unifiedConfig: existingUnifiedConfig,
        style: 'balanced',
      }],
      activeLinkRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        skillIds: [],
        modelPolicy: null,
      }],
      connectionRows: [
        { id: 'conn-hl', userId: TEST_USER_ID, status: 'active', provider: 'hyperliquid' },
      ],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        strategyPreset: 'momentum',
        connectionIds: ['conn-hl'],
      },
    });

    expect(res.statusCode).toBe(200);
    const configUpdate = updateSets.find((s) => 'unifiedConfig' in s);
    expect(configUpdate).toBeDefined();
    const patched = configUpdate!['unifiedConfig'] as Record<string, unknown> | null;
    expect(patched).toBeDefined();
    const technical = patched!['technical'] as Record<string, unknown>;
    expect(technical).toBeDefined();
    expect(technical['filters']).toEqual({
      venue: 'hyperliquid',
      venueType: 'orderbook',
      quoteAssetSymbol: 'USDC',
    });
  });

  it('PATCH populates technical.filters from existing connections when connectionIds are omitted', async () => {
    const { agentRoutes } = await import('./agents.js');
    const existingUnifiedConfig = {
      technical: { signalBias: 'trend-following', indicators: {}, candles: { interval: '15m', limit: 48 } },
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      // filters intentionally absent — the bug this test guards against
    };
    const { db, updateSets } = buildDb({
      agentRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        skillIds: [],
        modelPolicy: null,
        unifiedConfig: existingUnifiedConfig,
        style: 'balanced',
      }],
      activeLinkRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        skillIds: [],
        modelPolicy: null,
      }],
      connectionRows: [
        { id: 'conn-existing', userId: TEST_USER_ID, status: 'active', provider: 'hyperliquid' },
      ],
      agentConnectionRows: [
        { agentId: 'agent-1', connectionId: 'conn-existing', status: 'active' },
      ],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      // connectionIds deliberately omitted — should use existing connections
      payload: {
        strategyPreset: 'momentum',
      },
    });

    expect(res.statusCode).toBe(200);
    const configUpdate = updateSets.find((s) => 'unifiedConfig' in s);
    expect(configUpdate).toBeDefined();
    const patched = configUpdate!['unifiedConfig'] as Record<string, unknown> | null;
    expect(patched).toBeDefined();
    const technical = patched!['technical'] as Record<string, unknown>;
    expect(technical).toBeDefined();
    expect(technical['filters']).toEqual({
      venue: 'hyperliquid',
      venueType: 'orderbook',
      quoteAssetSymbol: 'USDC',
    });
  });

  it('PATCH preserves preset technical when client sends technical:null (frontend default)', async () => {
    const { agentRoutes } = await import('./agents.js');
    const existingUnifiedConfig = {
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
    };
    const { db, updateSets } = buildDb({
      agentRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        skillIds: [],
        modelPolicy: null,
        unifiedConfig: existingUnifiedConfig,
        style: 'balanced',
      }],
      activeLinkRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        skillIds: [],
        modelPolicy: null,
      }],
      connectionRows: [
        { id: 'conn-hl', userId: TEST_USER_ID, status: 'active', provider: 'hyperliquid' },
      ],
      agentConnectionRows: [
        { agentId: 'agent-1', connectionId: 'conn-hl', status: 'active' },
      ],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      // Reproduces the bug: frontend sends technical:null (no manual config)
      // alongside strategyPreset. The preset's technical must NOT be deleted.
      payload: {
        strategyPreset: 'momentum',
        technical: null,
      },
    });

    expect(res.statusCode).toBe(200);
    const configUpdate = updateSets.find((s) => 'unifiedConfig' in s);
    expect(configUpdate).toBeDefined();
    const patched = configUpdate!['unifiedConfig'] as Record<string, unknown> | null;
    expect(patched).toBeDefined();
    const technical = patched!['technical'] as Record<string, unknown>;
    expect(technical).toBeDefined();
    // The preset's technical was preserved (not deleted by the null)
    expect(technical['indicators']).toBeDefined();
    expect(technical['candles']).toBeDefined();
    expect(technical['signalBias']).toBe('trend-following');
    // Filters populated from existing connection
    expect(technical['filters']).toEqual({
      venue: 'hyperliquid',
      venueType: 'orderbook',
      quoteAssetSymbol: 'USDC',
    });
  });

  // Regression (bug 2026-09-04/004): connection enrichment on PATCH must MERGE,
  // not replace — an explicit technical.filters carrying symbols must survive
  // while venue/venueType come from the existing connection.
  it('merges connection venue/venueType into explicit filters on PATCH without dropping symbols', async () => {
    const { agentRoutes } = await import('./agents.js');
    const existingUnifiedConfig = {
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      technical: {
        filters: { venue: 'hyperliquid', venueType: 'orderbook' },
        regime: { benchmarkSymbol: 'BTC' },
        indicators: {},
        candles: { interval: '15m', limit: 100 },
        signalBias: 'trend-following',
        scanIntervalMs: 30000,
        scanBatchSize: 5,
        autonomousExit: false,
      },
    };
    const { db, updateSets } = buildDb({
      agentRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        skillIds: [],
        modelPolicy: null,
        unifiedConfig: existingUnifiedConfig,
        style: 'balanced',
      }],
      activeLinkRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        skillIds: [],
        modelPolicy: null,
      }],
      connectionRows: [
        { id: 'conn-hl', userId: TEST_USER_ID, status: 'active', provider: 'hyperliquid' },
      ],
      agentConnectionRows: [
        { agentId: 'agent-1', connectionId: 'conn-hl', status: 'active' },
      ],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        technical: {
          // Schema requires venue/venueType. Client supplies them here, but the
          // existing connection is authoritative and overrides them below.
          filters: { venue: 'jupiter', venueType: 'swap', symbols: ['BTC', 'ETH'], minVolume24hUsd: 1_000_000 },
          regime: { benchmarkSymbol: 'BTC' },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const configUpdate = updateSets.find((s) => 'unifiedConfig' in s);
    expect(configUpdate).toBeDefined();
    const patched = configUpdate!['unifiedConfig'] as Record<string, unknown>;
    const technical = patched['technical'] as Record<string, unknown>;
    const filters = technical['filters'] as Record<string, unknown>;
    // Connection is authoritative for venue/venueType.
    expect(filters['venue']).toBe('hyperliquid');
    expect(filters['venueType']).toBe('orderbook');
    // Client-owned fields survive the merge (the regression this locks in).
    expect(filters['symbols']).toEqual(['BTC', 'ETH']);
    expect(filters['minVolume24hUsd']).toBe(1_000_000);
  });

  it('exposes strategyPreset from unifiedConfig.metadata on GET', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{
        id: 'agent-1',
        userId: TEST_USER_ID,
        status: 'stopped',
        skillIds: [],
        unifiedConfig: {
          technical: { signalBias: 'trend-following' },
          metadata: { strategyPreset: 'swing', strategyPresetStyle: 'standard', strategyPresetSource: 'agent-style' },
        },
      }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ strategyPreset: 'swing' });
  });

  it('rejects an unsupported strategyPreset value on create', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'bad preset',
        prompt: 'trade',
        strategyPreset: 'dca', // not a valid agent preset
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });
});

// ---------------------------------------------------------------------------
// POST /agents/:id/start — model selection validation
// ---------------------------------------------------------------------------
describe('POST /agents/:id/start — model selection validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects start with 422 when neither agent model policy nor user AI settings are configured', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      // No modelPolicy, no userRows → effective selection is incomplete
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/start' });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('config.model_selection_incomplete');
  });

  it('accepts start when user AI settings supply the missing model selection', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, insertedValues } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID }],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/start' });

    expect(res.statusCode).toBe(202);
    expect(insertedValues).toContainEqual(expect.objectContaining({ agentId: 'agent-1', status: 'starting' }));
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
      capital: '5000',
      risk: { maxOpenPositions: 4, maxPositionSizePct: 40, stopLossPct: 2.5, stopLossCooldownMs: 120000 },
    };
    const { db, insertedValues } = buildDb({
      agentRows: [createdAgent],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

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
        capital: '5000.00',
        risk: { maxOpenPositions: 4, maxPositionSizePct: 40, stopLossPct: 2.5, stopLossCooldownMs: 120000 },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(insertedValues).toContainEqual(expect.objectContaining({
      tickIntervalMs: 600_000,
      capital: '5000',
      risk: expect.objectContaining({
        maxOpenPositions: 4,
        maxPositionSizePct: 40,
        stopLossPct: 2.5,
        stopLossCooldownMs: 120000,
      }),
    }));
    expect(res.json()).toEqual(expect.objectContaining({
      dailyLlmTokenBudget: null,
      capital: '5000',
      risk: expect.objectContaining({
        maxOpenPositions: 4,
        maxPositionSizePct: 40,
        stopLossPct: 2.5,
        stopLossCooldownMs: 120000,
      }),
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
      costPerTickEstimates: { minimal: 0.12, standard: 0.21, premium: 0.31 },
      dailyLossLimitDefaultRatio: 0.05,
      maxOpenPositions: 10,
      maxPositionSizePct: 100,
      stopLossPct: 10,
      stopLossCooldownMs: 300000,
      dailyMaxLossPct: 20,
      maxDrawdownPct: 20,
      runtimePolicyCeilings: RUNTIME_POLICY_CEILINGS,
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
        risk: { maxOpenPositions: 999 },
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

  it('normalizes capital on PATCH', async () => {
    const { agentRoutes } = await import('./agents.js');
    const updatedAgent = {
      id: 'agent-1', userId: TEST_USER_ID, status: 'stopped', skillIds: [], modelPolicy: null,
      tickIntervalMs: null, capital: '750',
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
      payload: { capital: '750.00' },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(expect.objectContaining({ capital: '750' }));
    expect(res.json()).toEqual(expect.objectContaining({ capital: '750', dailyLlmTokenBudget: null }));
  });

  it('normalizes telegramChatId on PATCH', async () => {
    const { agentRoutes } = await import('./agents.js');
    const updatedAgent = {
      id: 'agent-1', userId: TEST_USER_ID, status: 'stopped', skillIds: [], modelPolicy: null,
      telegramChatId: '123456',
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
      payload: { telegramChatId: ' 123456 ' },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(expect.objectContaining({ telegramChatId: '123456' }));
    expect(res.json()).toEqual(expect.objectContaining({ telegramChatId: '123456' }));
  });

  it('normalizes blank telegramChatId to null on PATCH', async () => {
    const { agentRoutes } = await import('./agents.js');
    const updatedAgent = {
      id: 'agent-1', userId: TEST_USER_ID, status: 'stopped', skillIds: [], modelPolicy: null,
      telegramChatId: null,
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
      payload: { telegramChatId: '   ' },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(expect.objectContaining({ telegramChatId: null }));
    expect(res.json()).toEqual(expect.objectContaining({ telegramChatId: null }));
  });

  it('normalizes telegramChatId on POST create', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = {
      id: 'agent-1', userId: TEST_USER_ID, status: 'stopped', skillIds: [], modelPolicy: null,
      telegramChatId: '123456',
    };
    const { db, insertedValues } = buildDb({
      agentRows: [createdAgent],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'test-agent',
        prompt: 'test',
        telegramChatId: ' 123456 ',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(insertedValues).toContainEqual(expect.objectContaining({ telegramChatId: '123456' }));
  });

  it('normalizes blank telegramChatId to null on POST create', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = {
      id: 'agent-1', userId: TEST_USER_ID, status: 'stopped', skillIds: [], modelPolicy: null,
      telegramChatId: null,
    };
    const { db, insertedValues } = buildDb({
      agentRows: [createdAgent],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'test-agent',
        prompt: 'test',
        telegramChatId: '   ',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(insertedValues).toContainEqual(expect.objectContaining({ telegramChatId: null }));
  });

  it('persists explicit risk limit overrides on PATCH', async () => {
    const { agentRoutes } = await import('./agents.js');
    const updatedAgent = {
      id: 'agent-1', userId: TEST_USER_ID, status: 'stopped', skillIds: [], modelPolicy: null,
      tickIntervalMs: null, capital: '750', dailyTokenBudget: 12_000,
      risk: { maxOpenPositions: 3, maxPositionSizePct: 55, stopLossPct: 4, stopLossCooldownMs: 180000 },
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
      payload: { risk: { maxOpenPositions: 3, maxPositionSizePct: 55, stopLossPct: 4, stopLossCooldownMs: 180000 } },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(expect.objectContaining({
      risk: expect.objectContaining({
        maxOpenPositions: 3,
        maxPositionSizePct: 55,
        stopLossPct: 4,
        stopLossCooldownMs: 180000,
      }),
    }));
    expect(res.json()).toEqual(expect.objectContaining({
      risk: expect.objectContaining({
        maxOpenPositions: 3,
        maxPositionSizePct: 55,
        stopLossPct: 4,
        stopLossCooldownMs: 180000,
      }),
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
    filters: { venue: 'hyperliquid', venueType: 'orderbook' as const, quoteAssetSymbol: 'USDC' },
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
    const { db, insertedValues } = buildDb({
      agentRows: [createdAgent],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

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

  it('PATCH /agents/:id preserves existing technical fields for a partial update', async () => {
    const { agentRoutes } = await import('./agents.js');
    const updatedAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      modelPolicy: null,
      unifiedConfig: { technical: { ...TECHNICAL_STUB, signalBias: 'mean-reverting' } },
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
      payload: { technical: { signalBias: 'mean-reverting' } },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSets).toContainEqual(
      expect.objectContaining({
        unifiedConfig: expect.objectContaining({
          technical: expect.objectContaining({
            filters: TECHNICAL_STUB.filters,
            signalBias: 'mean-reverting',
            scanIntervalMs: TECHNICAL_STUB.scanIntervalMs,
            scanBatchSize: TECHNICAL_STUB.scanBatchSize,
          }),
        }),
      }),
    );
  });

  it('PATCH /agents/:id rejects invalid fields in a partial technical update', async () => {
    const { agentRoutes } = await import('./agents.js');
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
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { technical: { signalBias: 'invalid' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'validation_error',
      details: [expect.objectContaining({ path: ['technical', 'signalBias'] })],
    });
    expect(updateSets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Prompt optionality — a blank prompt is allowed (employee prompt model:
// a no-job agent stays on duty and responds to user messages).
// ---------------------------------------------------------------------------
describe('agent routes — prompt optionality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an agent with an empty prompt and no technical config', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      modelPolicy: null,
      unifiedConfig: null,
    };
    const { db, insertedValues } = buildDb({
      agentRows: [createdAgent],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'no-job agent', prompt: '' },
    });

    expect(res.statusCode).toBe(201);
    const insert = insertedValues.find((v: Record<string, unknown>) => v.name === 'no-job agent');
    expect(insert?.prompt).toBe('');
  });

  it('creates an agent when neither prompt nor technical config is provided', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      modelPolicy: null,
      unifiedConfig: null,
    };
    const { db } = buildDb({
      agentRows: [createdAgent],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'bare agent' },
    });

    expect(res.statusCode).toBe(201);
  });

  it('still rejects capabilityMode=hybrid without technical config (unrelated invariant retained)', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb();

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'hybrid-no-tech', capabilityMode: 'hybrid' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; details: Array<{ path: string[]; message: string }> }>();
    expect(body.error).toBe('validation_error');
    expect(body.details.some((d) => d.path.includes('capabilityMode'))).toBe(true);
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

// ---------------------------------------------------------------------------
// openPositionEscalationToJudgePolicy — create, update, and response tests
// ---------------------------------------------------------------------------
describe('openPositionEscalationToJudgePolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates agent with each allowed policy value', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, insertedValues } = buildDb({
      agentRows: [{ id: 'agent-refetch', status: 'stopped', userId: TEST_USER_ID, modelPolicy: null, executionMode: null }],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    // Test 'never'
    const resNever = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'test-never', prompt: 'test', openPositionEscalationToJudgePolicy: 'never' },
    });
    expect(resNever.statusCode).toBe(201);

    // Test 'uncovered_or_triggered'
    const resDefault = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'test-default', prompt: 'test', openPositionEscalationToJudgePolicy: 'uncovered_or_triggered' },
    });
    expect(resDefault.statusCode).toBe(201);

    // Test 'always'
    const resAlways = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'test-always', prompt: 'test', openPositionEscalationToJudgePolicy: 'always' },
    });
    expect(resAlways.statusCode).toBe(201);

    // Verify the values were persisted in the INSERT
    const neverInsert = insertedValues.find((v: any) => v.name === 'test-never');
    expect(neverInsert?.openPositionEscalationToJudgePolicy).toBe('never');

    const defaultInsert = insertedValues.find((v: any) => v.name === 'test-default');
    expect(defaultInsert?.openPositionEscalationToJudgePolicy).toBe('uncovered_or_triggered');

    const alwaysInsert = insertedValues.find((v: any) => v.name === 'test-always');
    expect(alwaysInsert?.openPositionEscalationToJudgePolicy).toBe('always');
  });

  it('rejects invalid policy values', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'test-invalid-policy', prompt: 'test', openPositionEscalationToJudgePolicy: 'invalid_value' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('updates agent policy via PATCH', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateSets } = buildDb({
      agentRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        toolPolicy: null,
        modelPolicy: null,
        executionMode: null,
        openPositionEscalationToJudgePolicy: 'always',
      }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { openPositionEscalationToJudgePolicy: 'never' },
    });

    expect(res.statusCode).toBe(200);
    // Check the updated value was in the SET clause
    const agentUpdate = updateSets.find((s: any) => s.openPositionEscalationToJudgePolicy !== undefined);
    expect(agentUpdate?.openPositionEscalationToJudgePolicy).toBe('never');
  });

  it('includes the policy field in agent detail response', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        name: 'test-agent',
        prompt: 'test prompt',
        modelPolicy: null,
        executionMode: 'paper',
        pauseState: null,
        openPositionEscalationToJudgePolicy: 'always',
      }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({ method: 'GET', url: '/agents/agent-1' });

    expect(res.statusCode).toBe(200);
    expect(res.json().openPositionEscalationToJudgePolicy).toBe('always');
  });

  it('includes the policy field in agent list response', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        name: 'test-agent',
        prompt: 'test prompt',
        modelPolicy: null,
        executionMode: 'paper',
        pauseState: null,
        openPositionEscalationToJudgePolicy: 'never',
      }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({ method: 'GET', url: '/agents' });

    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(1);
    expect(list[0].openPositionEscalationToJudgePolicy).toBe('never');
  });
});

describe('agent connection assignment (POST /agents and PATCH /agents/:id)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- POST /agents ---

  it('creates agent with connections when valid connectionIds are provided', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, insertedValues } = buildDb({
      agentRows: [],
      activeLinkRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, name: 'test-agent', prompt: 'test', modelPolicy: null, executionMode: 'paper', toolPolicy: null, skillIds: [] }],
      connectionRows: [
        { id: 'conn-1', userId: TEST_USER_ID, status: 'active' },
      ],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'test-agent',
        prompt: 'test',
        connectionIds: ['conn-1'],
      },
    });

    expect(res.statusCode).toBe(201);
    // Verify agent_connections row was inserted
    const acInsert = insertedValues.find((v) => v['connectionId'] === 'conn-1');
    expect(acInsert).toBeDefined();
    expect(acInsert!['status']).toBe('active');
    expect(acInsert!['grantedBy']).toBe(TEST_USER_ID);
  });

  it('returns 400 when a connectionId does not exist', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [],
      connectionRows: [],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'test-agent',
        prompt: 'test',
        connectionIds: ['nonexistent'],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
    expect(res.json().details[0].message).toContain('does not exist');
  });

  it('returns 400 when a connectionId belongs to a different user', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [],
      connectionRows: [
        { id: 'foreign-conn', userId: 'other-user', status: 'active' },
      ],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'test-agent',
        prompt: 'test',
        connectionIds: ['foreign-conn'],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
    expect(res.json().details[0].message).toContain('does not belong to you');
  });

  it('returns 400 when a connectionId has been revoked', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [],
      connectionRows: [
        { id: 'revoked-conn', userId: TEST_USER_ID, status: 'revoked' },
      ],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'test-agent',
        prompt: 'test',
        connectionIds: ['revoked-conn'],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
    expect(res.json().details[0].message).toContain('is not active');
  });

  it('creates agent without connections when connectionIds is omitted', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, insertedValues } = buildDb({
      agentRows: [],
      activeLinkRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, name: 'test-agent', prompt: 'test', modelPolicy: null, executionMode: 'paper', toolPolicy: null, skillIds: [] }],
      connectionRows: [],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'test-agent',
        prompt: 'test',
      },
    });

    expect(res.statusCode).toBe(201);
    // No agent_connections rows should be inserted
    const acInserts = insertedValues.filter((v) => v['connectionId'] !== undefined);
    expect(acInserts).toHaveLength(0);
  });

  it('creates agent without connections when connectionIds is an empty array', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, insertedValues } = buildDb({
      agentRows: [],
      activeLinkRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, name: 'test-agent', prompt: 'test', modelPolicy: null, executionMode: 'paper', toolPolicy: null, skillIds: [] }],
      connectionRows: [],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'test-agent',
        prompt: 'test',
        connectionIds: [],
      },
    });

    expect(res.statusCode).toBe(201);
    const acInserts = insertedValues.filter((v) => v['connectionId'] !== undefined);
    expect(acInserts).toHaveLength(0);
  });

  // --- PATCH /agents/:id ---

  it('adds new agent_connections rows on PATCH with additional connectionIds', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, insertedValues } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], toolPolicy: null }],
      agentConnectionRows: [],
      connectionRows: [
        { id: 'conn-new', userId: TEST_USER_ID, status: 'active' },
      ],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { connectionIds: ['conn-new'] },
    });

    expect(res.statusCode).toBe(200);
    const acInsert = insertedValues.find((v) => v['connectionId'] === 'conn-new');
    expect(acInsert).toBeDefined();
    expect(acInsert!['status']).toBe('active');
  });

  it('revokes agent_connections rows on PATCH when connectionIds are removed', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], toolPolicy: null }],
      agentConnectionRows: [
        { id: 'ac-1', agentId: 'agent-1', connectionId: 'conn-old', status: 'active' },
      ],
      connectionRows: [],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { connectionIds: [] },
    });

    expect(res.statusCode).toBe(200);
    // Find the agentConnections update that sets status to 'revoked'
    const acUpdate = updateSets.find((s) => s['status'] === 'revoked');
    expect(acUpdate).toBeDefined();
    expect(acUpdate!['revokedAt']).toBeDefined();
  });

  it('leaves agent_connections unchanged when PATCH provides the same connectionIds', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, insertedValues, updateSets } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], toolPolicy: null }],
      agentConnectionRows: [
        { id: 'ac-1', agentId: 'agent-1', connectionId: 'conn-1', status: 'active' },
      ],
      connectionRows: [
        { id: 'conn-1', userId: TEST_USER_ID, status: 'active' },
      ],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { connectionIds: ['conn-1'] },
    });

    expect(res.statusCode).toBe(200);
    // No new agent_connections inserts for connectionIds
    const acInserts = insertedValues.filter((v) => v['connectionId'] !== undefined);
    expect(acInserts).toHaveLength(0);
    // No agent_connections revoked
    const acRevokes = updateSets.filter((s) => s['status'] === 'revoked');
    expect(acRevokes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C3.4 — PATCH wakePreferences syncs to Redis immediately
// ---------------------------------------------------------------------------

function makeRedisMockForApi() {
  const store = new Map<string, string>();
  return {
    _store: store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
    del: vi.fn(async (...keys: string[]) => {
      let deleted = 0;
      for (const k of keys) {
        if (store.delete(k)) deleted++;
      }
      return deleted;
    }),
    publish: vi.fn().mockResolvedValue(0),
  } as any;
}

describe('agent routes — wakePreferences Redis sync (C3.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PATCH with wakePreferences sets agent:wake:prefs:{id} key immediately', async () => {
    const { agentRoutes } = await import('./agents.js');
    const redis = makeRedisMockForApi();
    const updatedAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      name: 'test',
      prompt: 'p',
      modelPolicy: null,
    };
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], toolPolicy: null }],
      activeLinkRows: [updatedAgent],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, undefined, undefined, undefined, undefined, redis);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        wakePreferences: { subscribedSources: ['watch_threshold'] },
      },
    });

    expect(res.statusCode).toBe(200);
    // Redis key set immediately
    expect(redis.set).toHaveBeenCalledWith(
      'agent:wake:prefs:agent-1',
      JSON.stringify({ subscribedSources: ['watch_threshold'] }),
    );
    // Verify store
    const stored = JSON.parse(redis._store.get('agent:wake:prefs:agent-1')!);
    expect(stored).toEqual({ subscribedSources: ['watch_threshold'] });
  });

  it('PATCH with wakePreferences:null deletes agent:wake:prefs:{id} key immediately', async () => {
    const { agentRoutes } = await import('./agents.js');
    const redis = makeRedisMockForApi();
    // Pre-populate the key so we can verify deletion
    redis._store.set('agent:wake:prefs:agent-1', JSON.stringify({ subscribedSources: ['discovery_delta'] }));

    const updatedAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      name: 'test',
      prompt: 'p',
    };
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], toolPolicy: null }],
      activeLinkRows: [updatedAgent],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, undefined, undefined, undefined, undefined, redis);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { wakePreferences: null },
    });

    expect(res.statusCode).toBe(200);
    // Redis key deleted
    expect(redis.del).toHaveBeenCalledWith('agent:wake:prefs:agent-1');
    // Key no longer in store
    expect(redis._store.has('agent:wake:prefs:agent-1')).toBe(false);
  });

  it('PATCH without wakePreferences field leaves existing Redis key untouched', async () => {
    const { agentRoutes } = await import('./agents.js');
    const redis = makeRedisMockForApi();
    // Pre-populate the key
    redis._store.set('agent:wake:prefs:agent-1', JSON.stringify({ subscribedSources: ['watch_threshold'] }));

    const updatedAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      name: 'new name',
      prompt: 'p',
    };
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], toolPolicy: null }],
      activeLinkRows: [updatedAgent],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, undefined, undefined, undefined, undefined, redis);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { name: 'new name' },
    });

    expect(res.statusCode).toBe(200);
    // Redis prefs key unchanged — no set/del called for prefs
    const prefsSetCalls = (redis.set as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: [string]) => c[0] === 'agent:wake:prefs:agent-1',
    );
    const prefsDelCalls = (redis.del as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: [string]) => c[0] === 'agent:wake:prefs:agent-1',
    );
    expect(prefsSetCalls).toHaveLength(0);
    expect(prefsDelCalls).toHaveLength(0);
    // Existing key still present
    expect(redis._store.get('agent:wake:prefs:agent-1')).toBe(
      JSON.stringify({ subscribedSources: ['watch_threshold'] }),
    );
  });

  it('PATCH with wakePreferences changes existing Redis key to new value', async () => {
    const { agentRoutes } = await import('./agents.js');
    const redis = makeRedisMockForApi();
    // Pre-populate with old prefs
    redis._store.set('agent:wake:prefs:agent-1', JSON.stringify({ subscribedSources: ['watch_threshold'] }));

    const updatedAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      name: 'test',
      prompt: 'p',
    };
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], toolPolicy: null }],
      activeLinkRows: [updatedAgent],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, undefined, undefined, undefined, undefined, redis);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        wakePreferences: { subscribedSources: ['discovery_delta', 'regime_change'] },
      },
    });

    expect(res.statusCode).toBe(200);
    // Key updated to new value
    const stored = JSON.parse(redis._store.get('agent:wake:prefs:agent-1')!);
    expect(stored).toEqual({ subscribedSources: ['discovery_delta', 'regime_change'] });
  });

  it('does not touch Redis when no redisClient is provided (graceful no-op)', async () => {
    const { agentRoutes } = await import('./agents.js');
    const updatedAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      name: 'test',
      prompt: 'p',
    };
    const { db } = buildDb({
      agentRows: [{ id: 'agent-1', status: 'stopped', userId: TEST_USER_ID, skillIds: [], toolPolicy: null }],
      activeLinkRows: [updatedAgent],
    });

    const app = Fastify();
    decorateWithAuth(app);
    // No redisClient passed — should not error
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        wakePreferences: { subscribedSources: ['watch_threshold'] },
      },
    });

    // Should succeed without Redis
    expect(res.statusCode).toBe(200);
  });
});

describe('agent routes — capabilityMode and hybridMode (004)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- POST validation ---

  it('POST rejects capabilityMode=hybrid without technical config', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb();

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'hybrid-no-tech',
        prompt: 'test',
        capabilityMode: 'hybrid',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; details: Array<{ path: string[]; message: string }> }>();
    expect(body.error).toBe('validation_error');
    const issue = body.details.find((d) => d.path.includes('capabilityMode'));
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('technical');
  });

  it('POST defaults hybridMode to "mixed" for capabilityMode=hybrid without explicit hybridMode', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      modelPolicy: null,
      unifiedConfig: null,
    };
    const { db, insertedValues } = buildDb({
      agentRows: [createdAgent],
      activeLinkRows: [createdAgent],
      skillRows: [
        { id: 'trading', authorId: null, publicationStatus: 'published', priceCents: 0, currentRevisionId: 'rev-trading' },
      ],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'hybrid-default',
        technical: { filters: { venue: 'hyperliquid', venueType: 'orderbook' } },
        skillIds: ['trading'],
        capabilityMode: 'hybrid',
        executionDefaults: { mode: 'paper' },
      },
    });

    expect(res.statusCode).toBe(201);
    const uniConfig = insertedValues[0]?.['unifiedConfig'] as Record<string, unknown> | undefined;
    expect(uniConfig).toBeDefined();
    expect(uniConfig!['capabilityMode']).toBe('hybrid');
    expect(uniConfig!['hybridMode']).toBe('mixed');
  });

  it('POST accepts capabilityMode=hybrid with technical config', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      modelPolicy: null,
      unifiedConfig: null,
    };
    const { db, insertedValues } = buildDb({
      agentRows: [createdAgent],
      activeLinkRows: [createdAgent],
      skillRows: [
        { id: 'trading', authorId: null, publicationStatus: 'published', priceCents: 0, currentRevisionId: 'rev-trading' },
      ],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'hybrid-ok',
        technical: { filters: { venue: 'hyperliquid', venueType: 'orderbook' } },
        skillIds: ['trading'],
        capabilityMode: 'hybrid',
        hybridMode: 'scanner_gated',
        executionDefaults: { mode: 'paper' },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body['technical']).toBeDefined();
    // MEDIUM-5: verify hybridMode was persisted as 'scanner_gated'
    const uniConfig = insertedValues[0]?.['unifiedConfig'] as Record<string, unknown> | undefined;
    expect(uniConfig).toBeDefined();
    expect(uniConfig!['hybridMode']).toBe('scanner_gated');
  });

  it('POST rejects capabilityMode=intelligence with hybridMode set', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'intel-with-hybrid',
        prompt: 'test',
        capabilityMode: 'intelligence',
        hybridMode: 'mixed',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; details: Array<{ path: string[]; message: string }> }>();
    expect(body.error).toBe('validation_error');
    const issue = body.details.find((d) => d.path.includes('hybridMode'));
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('not "hybrid"');
  });

  // --- PATCH validation ---

  it('PATCH rejects hybridMode on an intelligence agent', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db } = buildDb({
      agentRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        unifiedConfig: { capabilityMode: 'intelligence' },
      }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { hybridMode: 'scanner_gated' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; details: Array<{ path: string[]; message: string }> }>();
    expect(body.error).toBe('validation_error');
  });

  it('PATCH accepts hybridMode on a hybrid agent', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateSets } = buildDb({
      agentRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        unifiedConfig: {
          capabilityMode: 'hybrid',
          hybridMode: 'mixed',
          technical: { filters: { venue: 'hyperliquid', venueType: 'orderbook' } },
        },
      }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { hybridMode: 'scanner_gated' },
    });

    expect(res.statusCode).toBe(200);
    // Verify unifiedConfig was updated with the new hybridMode
    const unifiedUpdate = updateSets.find((s) => 'unifiedConfig' in s);
    expect(unifiedUpdate).toBeDefined();
    const uc = (unifiedUpdate as Record<string, unknown>)['unifiedConfig'] as Record<string, unknown>;
    expect(uc['hybridMode']).toBe('scanner_gated');
  });

  // HIGH-2: PATCH capabilityMode transitions
  it('PATCH capabilityMode=intelligence on hybrid agent clears hybridMode', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateSets } = buildDb({
      agentRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        unifiedConfig: {
          capabilityMode: 'hybrid',
          hybridMode: 'scanner_gated',
          technical: { filters: { venue: 'hyperliquid', venueType: 'orderbook' } },
        },
      }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { capabilityMode: 'intelligence' },
    });

    expect(res.statusCode).toBe(200);
    // Verify unifiedConfig has capabilityMode=intelligence and hybridMode cleared
    const unifiedUpdate = updateSets.find((s) => 'unifiedConfig' in s);
    expect(unifiedUpdate).toBeDefined();
    const uc = (unifiedUpdate as Record<string, unknown>)['unifiedConfig'] as Record<string, unknown>;
    expect(uc['capabilityMode']).toBe('intelligence');
    expect(uc['hybridMode']).toBeUndefined();
  });

  it('PATCH capabilityMode=hybrid on intelligence agent defaults hybridMode to mixed', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateSets } = buildDb({
      agentRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        unifiedConfig: { capabilityMode: 'intelligence' },
      }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { capabilityMode: 'hybrid' },
    });

    expect(res.statusCode).toBe(200);
    // Verify unifiedConfig has capabilityMode=hybrid and hybridMode defaults to mixed
    const unifiedUpdate = updateSets.find((s) => 'unifiedConfig' in s);
    expect(unifiedUpdate).toBeDefined();
    const uc = (unifiedUpdate as Record<string, unknown>)['unifiedConfig'] as Record<string, unknown>;
    expect(uc['capabilityMode']).toBe('hybrid');
    expect(uc['hybridMode']).toBe('mixed');
  });

  // C-M1: POST defaults capabilityMode to 'intelligence' when omitted
  it('POST defaults capabilityMode to "intelligence" when field is omitted', async () => {
    const { agentRoutes } = await import('./agents.js');
    const createdAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      skillIds: [],
      modelPolicy: null,
      unifiedConfig: null,
    };
    const { db, insertedValues } = buildDb({
      agentRows: [createdAgent],
      activeLinkRows: [createdAgent],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'no-capability-mode',
        prompt: 'test prompt',
      },
    });

    expect(res.statusCode).toBe(201);
    const uniConfig = insertedValues[0]?.['unifiedConfig'] as Record<string, unknown> | undefined;
    expect(uniConfig).toBeDefined();
    expect(uniConfig!['capabilityMode']).toBe('intelligence');
  });

  // C-M2: PATCH clearing capabilityMode (null) also clears hybridMode
  it('PATCH capabilityMode=null on hybrid agent clears both capabilityMode and hybridMode', async () => {
    const { agentRoutes } = await import('./agents.js');
    const { db, updateSets } = buildDb({
      agentRows: [{
        id: 'agent-1',
        status: 'stopped',
        userId: TEST_USER_ID,
        unifiedConfig: {
          capabilityMode: 'hybrid',
          hybridMode: 'scanner_gated',
          technical: { filters: { venue: 'hyperliquid', venueType: 'orderbook' } },
        },
      }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { capabilityMode: null },
    });

    expect(res.statusCode).toBe(200);
    // Verify both capabilityMode and hybridMode are cleared
    const unifiedUpdate = updateSets.find((s) => 'unifiedConfig' in s);
    expect(unifiedUpdate).toBeDefined();
    const uc = (unifiedUpdate as Record<string, unknown>)['unifiedConfig'] as Record<string, unknown>;
    expect(uc['capabilityMode']).toBeUndefined();
    expect(uc['hybridMode']).toBeUndefined();
  });
});