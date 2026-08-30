import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Database } from '@herobids/db';
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

// Strategy preset YAML files are resolved relative to HEROBIDS_CONFIG_DIR or cwd.
const __dirname = dirname(fileURLToPath(import.meta.url));
process.env['HEROBIDS_CONFIG_DIR'] = resolve(__dirname, '../../../..');

const TEST_USER_ID = 'user-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = 'free';
  });
}

/**
 * Build a mock Database for agent route tests.
 * Re-uses the pattern from agents.test.ts but simplified for slug resolution
 * scenarios.
 */
function buildDb(options: {
  agentRows?: Array<Record<string, unknown>>;
  postMutationAgentRows?: Array<Record<string, unknown>>;
  skillRows?: Array<Record<string, unknown>>;
  skillEntitlementRows?: Array<Record<string, unknown>>;
  skillRevisionRows?: Array<Record<string, unknown>>;
  agentSkillRows?: Array<Record<string, unknown>>;
  connectionRows?: Array<Record<string, unknown>>;
  agentConnectionRows?: Array<Record<string, unknown>>;
  userRows?: Array<Record<string, unknown>>;
} = {}) {
  const insertedValues: Array<Record<string, unknown>> = [];
  const updateSets: Array<Record<string, unknown>> = [];

  const builtinSkillRows: Array<Record<string, unknown>> = [
    {
      id: 'task-management',
      slug: 'system/task-management',
      authorId: null,
      publicationStatus: 'published',
      priceCents: 0,
      currentRevisionId: 'rev-task-management',
    },
    {
      id: 'trading',
      slug: 'system/trading',
      authorId: null,
      publicationStatus: 'published',
      priceCents: 0,
      currentRevisionId: 'rev-trading',
    },
    {
      id: 'bot-management',
      slug: 'system/bot-management',
      authorId: null,
      publicationStatus: 'published',
      priceCents: 0,
      currentRevisionId: 'rev-bot-management',
    },
  ];

  const agentRows = options.agentRows ?? [];
  const postMutationAgentRows = options.postMutationAgentRows ?? agentRows;
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
  const connectionRows = options.connectionRows ?? [];
  const agentConnectionRows = options.agentConnectionRows ?? [];
  const userRows = options.userRows ?? [];

  let agentsSelectCount = 0;

  const rowsForTable = (table: unknown): Array<Record<string, unknown>> => {
    if (table === agents) {
      agentsSelectCount += 1;
      return agentsSelectCount === 1 ? agentRows : postMutationAgentRows;
    }
    if (table === bots) return [];
    if (table === decisions) return [];
    if (table === skills) return skillRows;
    if (table === skillEntitlements) return skillEntitlementRows;
    if (table === skillRevisions) return skillRevisionRows;
    if (table === agentSkills) return agentSkillRows;
    if (table === agentRuntimeSessions) return [];
    if (table === connections) return connectionRows;
    if (table === agentConnections) return agentConnectionRows;
    if (table === venueAccounts) return [];
    if (table === users) return userRows;
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

  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation((table: unknown) => makeSelectChain(rowsForTable(table))),
    }),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        updateSets.push(values);
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
    transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    delete: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  } as unknown as Database;

  return { db, insertedValues, updateSets };
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
        usage: {
          includedCreditCents: 0,
          topUpPackIds: [],
        },
      },
    },
  };
}

describe('agent routes slug resolution (POST /agents)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves slug-based skillIds to canonical IDs on create', async () => {
    const { agentRoutes } = await import('./agents.js');

    const customSkill = {
      id: 'custom-skill-uuid',
      slug: 'alice/my-strategy',
      authorId: TEST_USER_ID,
      publicationStatus: 'published',
      priceCents: 0,
      currentRevisionId: 'rev-custom',
    };

    const createdAgent = {
      id: 'agent-new',
      userId: TEST_USER_ID,
      name: 'Slug Agent',
      status: 'stopped',
      prompt: 'test',
      skillIds: ['custom-skill-uuid'],
      toolPolicy: null,
      modelPolicy: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
      unifiedConfig: null,
      risk: null,
      strategy: null,
      executionDefaults: null,
      capital: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const { db } = buildDb({
      agentRows: [],
      postMutationAgentRows: [createdAgent],
      skillRows: [
        {
          id: 'task-management',
          slug: 'system/task-management',
          authorId: null,
          publicationStatus: 'published',
          priceCents: 0,
          currentRevisionId: 'rev-task-management',
        },
        customSkill,
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
        name: 'Slug Agent',
        prompt: 'test',
        skillIds: ['alice/my-strategy'],
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it('returns 400 when slug-based skillIds cannot be resolved', async () => {
    const { agentRoutes } = await import('./agents.js');

    const { db } = buildDb({
      agentRows: [],
      skillRows: [
        {
          id: 'task-management',
          slug: 'system/task-management',
          authorId: null,
          publicationStatus: 'published',
          priceCents: 0,
          currentRevisionId: 'rev-task-management',
        },
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
        name: 'Bad Slug Agent',
        prompt: 'test',
        skillIds: ['bob/nonexistent'],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('validation_error');
    expect(body.details[0]?.message).toContain('Unknown skills');
    expect(body.details[0]?.message).toContain('bob/nonexistent');
  });

  it('skips slug resolution when skillIds contain no slugs (plain IDs)', async () => {
    const { agentRoutes } = await import('./agents.js');

    const createdAgent = {
      id: 'agent-plain',
      userId: TEST_USER_ID,
      name: 'Plain ID Agent',
      status: 'stopped',
      prompt: 'test',
      skillIds: ['task-management'],
      toolPolicy: null,
      modelPolicy: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
      unifiedConfig: null,
      risk: null,
      strategy: null,
      executionDefaults: null,
      capital: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const { db } = buildDb({
      agentRows: [],
      postMutationAgentRows: [createdAgent],
      skillRows: [
        {
          id: 'task-management',
          slug: 'system/task-management',
          authorId: null,
          publicationStatus: 'published',
          priceCents: 0,
          currentRevisionId: 'rev-task-management',
        },
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
        name: 'Plain ID Agent',
        prompt: 'test',
        skillIds: ['task-management'],
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it('resolves mixed slug and plain ID refs in the same skillIds array', async () => {
    const { agentRoutes } = await import('./agents.js');

    const customSkill = {
      id: 'custom-skill-uuid',
      slug: 'alice/my-helper',
      authorId: TEST_USER_ID,
      publicationStatus: 'published',
      priceCents: 0,
      currentRevisionId: 'rev-custom',
    };

    const createdAgent = {
      id: 'agent-mixed',
      userId: TEST_USER_ID,
      name: 'Mixed Ref Agent',
      status: 'stopped',
      prompt: 'test',
      skillIds: ['task-management', 'custom-skill-uuid'],
      toolPolicy: null,
      modelPolicy: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
      unifiedConfig: null,
      risk: null,
      strategy: null,
      executionDefaults: null,
      capital: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const { db } = buildDb({
      agentRows: [],
      postMutationAgentRows: [createdAgent],
      skillRows: [
        {
          id: 'task-management',
          slug: 'system/task-management',
          authorId: null,
          publicationStatus: 'published',
          priceCents: 0,
          currentRevisionId: 'rev-task-management',
        },
        customSkill,
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
        name: 'Mixed Ref Agent',
        prompt: 'test',
        // Mix of plain ID and slug in same array
        skillIds: ['task-management', 'alice/my-helper'],
      },
    });

    // Slug resolution should resolve 'alice/my-helper' → 'custom-skill-uuid'
    // while leaving 'task-management' as-is. Both should pass downstream.
    expect(res.statusCode).toBe(201);
  });
});

describe('agent routes slug resolution (PATCH /agents/:id)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves slug-based skillIds on update', async () => {
    const { agentRoutes } = await import('./agents.js');

    const existingAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      name: 'Existing Agent',
      status: 'stopped',
      prompt: 'test',
      toolPolicy: null,
      modelPolicy: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
      unifiedConfig: null,
      risk: null,
      strategy: null,
      executionDefaults: null,
      capital: null,
      maxBots: null,
      tickIntervalMs: null,
      style: null,
      runtimePolicyOverrides: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const customSkill = {
      id: 'custom-skill-uuid',
      slug: 'alice/my-strategy',
      authorId: TEST_USER_ID,
      publicationStatus: 'published',
      priceCents: 0,
      currentRevisionId: 'rev-custom',
    };

    const { db } = buildDb({
      agentRows: [existingAgent],
      postMutationAgentRows: [existingAgent],
      skillRows: [
        {
          id: 'task-management',
          slug: 'system/task-management',
          authorId: null,
          publicationStatus: 'published',
          priceCents: 0,
          currentRevisionId: 'rev-task-management',
        },
        customSkill,
      ],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        skillIds: ['alice/my-strategy'],
      },
    });

    // Should resolve 'alice/my-strategy' → 'custom-skill-uuid' and proceed.
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 for unresolved slugs on update', async () => {
    const { agentRoutes } = await import('./agents.js');

    const existingAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      name: 'Existing Agent',
      status: 'stopped',
      prompt: 'test',
      toolPolicy: null,
      modelPolicy: null,
      unifiedConfig: null,
      risk: null,
      strategy: null,
      executionDefaults: null,
      capital: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const { db } = buildDb({
      agentRows: [existingAgent],
      skillRows: [
        {
          id: 'task-management',
          slug: 'system/task-management',
          authorId: null,
          publicationStatus: 'published',
          priceCents: 0,
          currentRevisionId: 'rev-task-management',
        },
      ],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        skillIds: ['ghost/nonexistent'],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('validation_error');
    expect(body.details[0]?.message).toContain('Unknown skills');
    expect(body.details[0]?.message).toContain('ghost/nonexistent');
  });

  it('skips slug resolution on update when skillIds have no slugs', async () => {
    const { agentRoutes } = await import('./agents.js');

    const existingAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      name: 'Existing Agent',
      status: 'stopped',
      prompt: 'test',
      toolPolicy: null,
      modelPolicy: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
      unifiedConfig: null,
      risk: null,
      strategy: null,
      executionDefaults: null,
      capital: null,
      maxBots: null,
      tickIntervalMs: null,
      style: null,
      runtimePolicyOverrides: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const { db } = buildDb({
      agentRows: [existingAgent],
      postMutationAgentRows: [existingAgent],
      skillRows: [
        {
          id: 'task-management',
          slug: 'system/task-management',
          authorId: null,
          publicationStatus: 'published',
          priceCents: 0,
          currentRevisionId: 'rev-task-management',
        },
      ],
      userRows: [{ aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } }],
    });

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        skillIds: ['task-management'],
      },
    });

    expect(res.statusCode).toBe(200);
  });
});
