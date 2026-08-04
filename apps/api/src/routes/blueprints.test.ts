import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { blueprintRoutes } from './blueprints.js';
import type { Database } from '@herobids/db';
import type { AgentRiskDefaultsConfig, BlueprintExecutionCapabilityResolver, PlansConfig } from '@herobids/domain';
import { createTableAwareDb } from '../__tests__/helpers/table-aware-db-mock.js';
import { buildBlueprint, buildPublishedBlueprint, buildDraftBlueprint, buildRevision, buildRevisionSkill, buildLike, buildAgentPayload, buildBotPayload, BP_ID, REV_ID, USER_ID, OTHER_USER_ID } from '../__tests__/helpers/blueprint-fixtures.js';
import { blueprints, blueprintRevisions, blueprintRevisionSkills, blueprintLikes, skills, skillRevisions } from '@herobids/db';

// Strategy preset YAML files are resolved relative to HEROBIDS_CONFIG_DIR or cwd.
// In test, cwd is the package dir (apps/api), so we must point to the repo root.
const __dirname = dirname(fileURLToPath(import.meta.url));
process.env['HEROBIDS_CONFIG_DIR'] = resolve(__dirname, '../../../..');

const TEST_USER_ID = 'user-1';
const BLUEPRINT_ID = 'bp-1';

const agentRiskDefaults: AgentRiskDefaultsConfig = {
  dailyLossLimitDefaultRatio: 0.05,
  maxOpenPositions: 10,
  maxPositionSizePct: 100,
  maxPositionSize: 1_000_000,
  stopLossPct: 10,
  dailyMaxLossPct: 20,
  stopLossCooldownMs: 300_000,
  maxOrderNotionalMultiplier: 1,
  botConfigInvalidHaltThreshold: 1,
  botExecutionErrorHaltThreshold: 5,
  botLlmProviderErrorHaltThreshold: 1,
  agentDecisionNoContextThreshold: 10,
  agentDecisionSwapInstrumentFormatThreshold: 5,
  maxDrawdown: 1_000_000_000,
  maxDrawdownPct: 20,
  perTradeLevelMonitorIntervalMs: 5_000,
  maxBots: 5,
};

const executionCapabilityResolver: BlueprintExecutionCapabilityResolver = {
  resolve: vi.fn().mockResolvedValue({
    resolvedMode: 'paper',
    errors: [],
    warnings: [],
    resolvedBindings: [],
  }),
  getCapabilityProfile: vi.fn().mockReturnValue(null),
};

const testPlansConfig: PlansConfig = {
  defaultPlanId: 'free',
  plans: {
    free: {
      entitlements: {
        skills: {
          canCreatePrivateSkills: true,
          canViewMarketplaceSkills: false,
          canPublishToMarketplace: false,
          autoPublishNonDraftSkills: false,
          canPriceSkills: false,
          canLikeMarketplaceSkills: true,
        },
        agents: {
          canViewOwnPrompts: true,
        },
        blueprints: {
          canViewMarketplaceBlueprints: true,
          canLikeMarketplaceBlueprints: true,
        },
        limits: {
          maxAgents: 1,
          maxBots: 1,
          maxConnections: 1,
          maxCredentials: 1,
          maxBindings: 1,
          maxVenueAccounts: 1,
          maxConcurrentBacktests: 1,
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

// Builds a chainable DB mock that resolves to a fixed value when awaited.
function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'offset', '$dynamic', 'innerJoin', 'leftJoin', 'groupBy', 'having']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

const stubBlueprint = {
  id: BLUEPRINT_ID,
  authorId: TEST_USER_ID,
  publicationStatus: 'draft',
  publishedAt: null,
  delistedAt: null,
  archivedAt: null,
  currentRevisionId: 'rev-1',
  publishedRevisionId: null,
  kind: 'agent',
  name: 'My Blueprint',
  description: 'A test blueprint',
  strategyType: 'momentum',
  style: 'balanced',
  tags: ['test'],
  venueType: null,
  sourceBlueprintId: null,
  sourceBlueprintRevisionId: null,
  likeCount: 0,
  forkCount: 0,
  popularityScore: 0,
  trendingScore: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const stubRevision = {
  id: 'rev-1',
  blueprintId: BLUEPRINT_ID,
  version: 1,
  kind: 'agent',
  name: 'My Blueprint',
  description: 'A test blueprint',
  strategyType: 'momentum',
  style: 'balanced',
  tags: ['test'],
  venueType: null,
  payload: { strategy: { type: 'momentum', decisionMode: 'mechanical' }, executionDefaults: { mode: 'paper' } },
  createdByUserId: TEST_USER_ID,
  changeSummary: null,
  publishedAt: null,
  createdAt: new Date(),
};

function buildDb(
  selectRows: unknown[] = [stubBlueprint],
  subsequentRows: unknown[] = [],
): Database {
  let selectCallCount = 0;
  const db = {
    select: vi.fn().mockImplementation(() => {
      selectCallCount++;
      return makeChain(selectCallCount === 1 ? selectRows : subsequentRows);
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  } as unknown as Database;
  return db;
}

// ─── GET /blueprints/presets ───────────────────────────────────────────────

describe('GET /blueprints/presets', () => {
  it('returns list of all 7 presets', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'GET', url: '/blueprints/presets' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.presets)).toBe(true);
    expect(body.presets).toHaveLength(7);
    const keys = body.presets.map((p: { key: string }) => p.key);
    expect(keys).toContain('momentum');
    expect(keys).toContain('dca');
    expect(keys).toContain('scalper');
  });
});

// ─── GET /presets/for-agent ───────────────────────────────────────────────

describe('GET /presets/for-agent', () => {
  it('returns an agent-consumable split for a technical strategy', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'GET', url: '/presets/for-agent?strategy=momentum&style=standard' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('technical');
    expect(body).toHaveProperty('risk');
    expect(body).toHaveProperty('execution');
    // Execution uses the unified agent field name
    expect(body.execution).not.toHaveProperty('positionSize');
  });

  it('rejects dca for agent preset application with preset_not_supported_for_agent', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'GET', url: '/presets/for-agent?strategy=dca&style=standard' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('preset_not_supported_for_agent');
  });
});

// ─── GET /blueprints/defaults ─────────────────────────────────────────────

describe('GET /blueprints/defaults', () => {
  it('returns default config fields', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'GET', url: '/blueprints/defaults' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.defaults).toHaveProperty('strategy');
    expect(body.defaults).toHaveProperty('execution');
  });
});

// ─── POST /blueprints/from-preset ────────────────────────────────────────
// Stubbed — endpoint returns 501 until Phase 1 Milestone B.

describe('POST /blueprints/from-preset', () => {
  it('returns 501 (not implemented) for from-preset', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/blueprints/from-preset',
      payload: { preset: 'momentum' },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_implemented');
  });

  it('returns 501 for nonexistent preset as well', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/blueprints/from-preset',
      payload: { preset: 'nonexistent' },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_implemented');
  });

  it('returns 501 for merge overrides', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/blueprints/from-preset',
      payload: { preset: 'momentum', overrides: { myOverride: true } },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_implemented');
  });

  it('returns 501 for nested override merge', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/blueprints/from-preset',
      payload: { preset: 'momentum', overrides: { strategy: { params: { candleLimit: 60 } } } },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_implemented');
  });
});

// ─── GET /blueprints ───────────────────────────────────────────────────────

describe('GET /blueprints', () => {
  // NOTE: SQL-level WHERE clause filtering (publicationStatus, kind, etc.) is NOT
  // tested here — it's owned by blueprints.integration.test.ts. These tests cover
  // routing-layer behavior: response shape, auth gates, and entitlement checks.

  it('returns published blueprints with items and nextCursor', async () => {
    const publishedBp = buildPublishedBlueprint();
    const publishedRev = buildRevision();

    const dbMock = createTableAwareDb();
    dbMock.setTableRows(blueprints, [[publishedBp]]);
    dbMock.setTableRows(blueprintRevisions, [[publishedRev]]);
    dbMock.setTableRows(blueprintLikes, [[]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'GET', url: '/blueprints' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('nextCursor');
    expect(body.nextCursor).toBeNull();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(BP_ID);
    expect(body.items[0].kind).toBe('agent');
  });

  it('accepts kind query param without error', async () => {
    const publishedBp = buildPublishedBlueprint({ kind: 'agent' });
    const publishedRev = buildRevision({ kind: 'agent' });

    // kind=agent — matching blueprint exists
    {
      const dbMock = createTableAwareDb();
      dbMock.setTableRows(blueprints, [[publishedBp]]);
      dbMock.setTableRows(blueprintRevisions, [[publishedRev]]);
      dbMock.setTableRows(blueprintLikes, [[]]);
      const db = dbMock.build();

      const app = Fastify();
      decorateWithAuth(app);
      await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

      const res = await app.inject({ method: 'GET', url: '/blueprints?kind=agent' });
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toHaveLength(1);
      expect(res.json().items[0].id).toBe(BP_ID);
    }

    // kind=bot — no matching blueprints
    {
      const dbMock = createTableAwareDb();
      dbMock.setTableRows(blueprints, [[]]);
      dbMock.setTableRows(blueprintRevisions, [[]]);
      dbMock.setTableRows(blueprintLikes, [[]]);
      const db = dbMock.build();

      const app = Fastify();
      decorateWithAuth(app);
      await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

      const res = await app.inject({ method: 'GET', url: '/blueprints?kind=bot' });
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toHaveLength(0);
    }
  });

  it('returns 403 for plan without marketplace access', async () => {
    const publishedBp = buildPublishedBlueprint();
    const publishedRev = buildRevision();

    const dbMock = createTableAwareDb();
    dbMock.setTableRows(blueprints, [[publishedBp]]);
    dbMock.setTableRows(blueprintRevisions, [[publishedRev]]);
    dbMock.setTableRows(blueprintLikes, [[]]);
    const db = dbMock.build();

    const restrictedPlansConfig: PlansConfig = {
      defaultPlanId: 'free',
      plans: {
        free: {
          ...testPlansConfig.plans.free,
          entitlements: {
            ...testPlansConfig.plans.free.entitlements,
            blueprints: {
              canViewMarketplaceBlueprints: false,
              canLikeMarketplaceBlueprints: true,
            },
          },
        },
      },
    };

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, restrictedPlansConfig);

    const res = await app.inject({ method: 'GET', url: '/blueprints' });
    expect(res.statusCode).toBe(403);
  });

  it('returns empty items when no published blueprints exist', async () => {
    const dbMock = createTableAwareDb();
    dbMock.setTableRows(blueprints, [[]]);
    dbMock.setTableRows(blueprintRevisions, [[]]);
    dbMock.setTableRows(blueprintLikes, [[]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'GET', url: '/blueprints' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);
  });
});

// ─── POST /blueprints ─────────────────────────────────────────────────────

describe('POST /blueprints', () => {
  it('creates an agent blueprint and returns 201 with revision detail', async () => {
    // buildBlueprintDetail re-selects the created blueprint and revision,
    // then queries blueprintRevisionSkills for the detail shape.
    const createdBp = buildDraftBlueprint();
    const createdRev = buildRevision({ payload: buildAgentPayload() });

    const dbMock = createTableAwareDb();
    // Post-transaction re-selects (db, not tx)
    dbMock.setTableRows(blueprints, [[createdBp]]);
    dbMock.setTableRows(blueprintRevisions, [[createdRev]]);
    // getRevisionSkillRefs inside buildBlueprintDetail
    dbMock.setTableRows(blueprintRevisionSkills, [[]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/blueprints',
      payload: { payload: buildAgentPayload() },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(typeof body.id).toBe('string');
    expect(body.publicationStatus).toBe('draft');
    expect(body.revision).toBeDefined();
    expect(body.revision.payload).toBeDefined();
    expect(body.revision.skills).toEqual([]);
    expect(body.revision.version).toBe(1);
  });

  it('returns 400 when name is missing from payload', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/blueprints',
      payload: { payload: { kind: 'agent', description: 'Missing name' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('returns 400 when skills are provided for bot blueprint', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/blueprints',
      payload: {
        payload: buildBotPayload(),
        skills: [{ skillId: 's1', skillRevisionId: 'sr1' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('returns 400 when agent blueprint has non-portable skill dependency', async () => {
    // validateSkillPortability queries skills innerJoin skillRevisions;
    // table-aware mock dispatches on the table passed to .from() (skills).
    const dbMock = createTableAwareDb();
    // Empty → skill not found → portability fails
    dbMock.setTableRows(skills, [[]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/blueprints',
      payload: {
        payload: buildAgentPayload(),
        skills: [{ skillId: 'bad-skill', skillRevisionId: 'bad-rev' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('blueprint.dependency_unavailable');
  });
});

// ─── GET /blueprints/:id ──────────────────────────────────────────────────

describe('GET /blueprints/:id', () => {
  it('returns 200 for owned draft blueprint', async () => {
    const draftBp = buildDraftBlueprint({ authorId: TEST_USER_ID });
    const draftRev = buildRevision({ blueprintId: BP_ID, createdByUserId: TEST_USER_ID });

    const dbMock = createTableAwareDb();
    dbMock.setTableRows(blueprints, [[draftBp]]);
    dbMock.setTableRows(blueprintRevisions, [[draftRev]]);
    dbMock.setTableRows(blueprintLikes, [[]]);
    dbMock.setTableRows(blueprintRevisionSkills, [[]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'GET', url: `/blueprints/${BP_ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(BP_ID);
  });

  it('returns 200 for published blueprint owned by another user', async () => {
    const publishedBp = buildPublishedBlueprint({ authorId: OTHER_USER_ID });
    const publishedRev = buildRevision({ blueprintId: BP_ID, createdByUserId: OTHER_USER_ID });

    const dbMock = createTableAwareDb();
    dbMock.setTableRows(blueprints, [[publishedBp]]);
    dbMock.setTableRows(blueprintRevisions, [[publishedRev]]);
    dbMock.setTableRows(blueprintLikes, [[]]);
    dbMock.setTableRows(blueprintRevisionSkills, [[]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'GET', url: `/blueprints/${BP_ID}` });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 for draft blueprint owned by another user', async () => {
    const draftBp = buildDraftBlueprint({ authorId: OTHER_USER_ID });

    const dbMock = createTableAwareDb();
    // resolveTargetRevision queries blueprints first; non-owner + draft → NOT_FOUND before revision select
    dbMock.setTableRows(blueprints, [[draftBp]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'GET', url: `/blueprints/${BP_ID}` });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 for delisted blueprint accessed by owner', async () => {
    const delistedBp = buildBlueprint({ publicationStatus: 'delisted', authorId: TEST_USER_ID });

    const dbMock = createTableAwareDb();
    // resolveTargetRevision: owner + delisted → LIFECYCLE_CONFLICT before revision select
    dbMock.setTableRows(blueprints, [[delistedBp]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'GET', url: `/blueprints/${BP_ID}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('blueprint.lifecycle_conflict');
  });

  it('returns 404 for delisted blueprint accessed by non-owner', async () => {
    const delistedBp = buildBlueprint({ publicationStatus: 'delisted', authorId: OTHER_USER_ID });

    const dbMock = createTableAwareDb();
    // resolveTargetRevision: non-owner + delisted → NOT_FOUND before revision select
    dbMock.setTableRows(blueprints, [[delistedBp]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'GET', url: `/blueprints/${BP_ID}` });
    expect(res.statusCode).toBe(404);
  });
});

// ─── PUT /blueprints/:id ──────────────────────────────────────────────────
// REMOVED: The PUT endpoint no longer exists. Blueprint edits now use
// POST /blueprints/:id/revisions (CreateBlueprintRevisionSchema).
// These tests are skipped pending a rewrite against the revisions endpoint.

describe.skip('PUT /blueprints/:id', () => {
  it('updates blueprint and increments configVersion when configData changes', async () => {
    let capturedSet: Record<string, unknown> | null = null;
    let selectCallCount = 0;
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        return makeChain(selectCallCount === 1 ? [stubBlueprint] : [stubBlueprint]);
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((fields: Record<string, unknown>) => {
          capturedSet = fields;
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'PUT',
      url: `/blueprints/${BLUEPRINT_ID}`,
      payload: { configData: { strategy: { type: 'dca' } } },
    });

    expect(res.statusCode).toBe(200);
    // configVersion should be stubBlueprint.configVersion + 1 = 2
    expect(capturedSet?.['configVersion']).toBe(2);
    expect((capturedSet?.['configData'] as Record<string, unknown> | undefined)?.['strategy']).toBeDefined();
  });

  it('increments configVersion on every PUT, even when only name changes', async () => {
    let capturedSet: Record<string, unknown> | null = null;
    let selectCallCount = 0;
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        return makeChain(selectCallCount === 1 ? [stubBlueprint] : [stubBlueprint]);
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((fields: Record<string, unknown>) => {
          capturedSet = fields;
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'PUT',
      url: `/blueprints/${BLUEPRINT_ID}`,
      payload: { name: 'Renamed' },
    });

    expect(res.statusCode).toBe(200);
    // configVersion must increment on every PUT regardless of which fields changed.
    expect(capturedSet?.['configVersion']).toBe(stubBlueprint.configVersion + 1);
    expect(capturedSet?.['name']).toBe('Renamed');
  });

  it('PUT configData deep-merges nested params without dropping siblings', async () => {
    // stubBlueprint.configData has strategy with type + decisionMode.
    // Override only strategy.type; existing strategy.decisionMode and
    // untouched sections (execution) must survive.
    let capturedSet: Record<string, unknown> | null = null;
    let selectCallCount = 0;
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        return makeChain(selectCallCount === 1 ? [stubBlueprint] : [stubBlueprint]);
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((fields: Record<string, unknown>) => {
          capturedSet = fields;
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'PUT',
      url: `/blueprints/${BLUEPRINT_ID}`,
      // Only updating one field inside 'strategy'.
      payload: { configData: { strategy: { type: 'scalper' } } },
    });

    expect(res.statusCode).toBe(200);
    const merged = capturedSet?.['configData'] as Record<string, unknown> | undefined;
    // The sent section should be applied.
    expect((merged?.['strategy'] as Record<string, unknown> | undefined)?.['type']).toBe('scalper');
    // The untouched 'execution' section from stubBlueprint.configData must be preserved.
    expect(merged?.['execution']).toBeDefined();
    // Sibling keys within the strategy section must be preserved.
    expect((merged?.['strategy'] as Record<string, unknown> | undefined)?.['decisionMode']).toBe('mechanical');
    // Execution section mode must be preserved.
    expect((merged?.['execution'] as Record<string, unknown> | undefined)?.['mode']).toBe('paper');
  });

  it('serializes concurrent blueprint edits inside a transaction lock', async () => {
    let executedLock = false;
    let capturedSet: Record<string, unknown> | null = null;
    let selectCallCount = 0;
    const tx = {
      execute: vi.fn().mockImplementation(async () => {
        executedLock = true;
        return { rows: [] };
      }),
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        return makeChain(selectCallCount === 1 ? [stubBlueprint] : [stubBlueprint]);
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((fields: Record<string, unknown>) => {
          capturedSet = fields;
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'PUT',
      url: `/blueprints/${BLUEPRINT_ID}`,
      payload: { name: 'Locked update' },
    });

    expect(res.statusCode).toBe(200);
    expect(executedLock).toBe(true);
    expect(capturedSet?.['configVersion']).toBe(stubBlueprint.configVersion + 1);
  });

  it('returns 404 for blueprint not owned by the user', async () => {
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => makeChain([])),
      update: vi.fn(),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'PUT',
      url: `/blueprints/${BLUEPRINT_ID}`,
      payload: { name: 'Hacked' },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── DELETE /blueprints/:id ───────────────────────────────────────────────
// Lifecycle-aware delete: draft-only, 5 ref checks, FK cycle breaking.

describe('DELETE /blueprints/:id', () => {
  it('returns 204 for unreferenced draft blueprint', async () => {
    const draftBp = buildDraftBlueprint({ authorId: TEST_USER_ID });

    const dbMock = createTableAwareDb();
    // Two selects from blueprints: pre-tx lookup + tx FOR UPDATE lock
    dbMock.setTableRows(blueprints, [[draftBp], [draftBp]]);
    // No revisions — handler skips revision-skill deletes
    dbMock.setTableRows(blueprintRevisions, [[]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'DELETE', url: `/blueprints/${BP_ID}` });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('returns 409 for non-draft blueprint (published)', async () => {
    const publishedBp = buildPublishedBlueprint({ authorId: TEST_USER_ID });

    const dbMock = createTableAwareDb();
    // Only pre-tx select — handler rejects before entering transaction
    dbMock.setTableRows(blueprints, [[publishedBp]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'DELETE', url: `/blueprints/${BP_ID}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('blueprint.lifecycle_conflict');
  });

  it('returns 409 for draft blueprint with active bot reference', async () => {
    const draftBp = buildDraftBlueprint({ authorId: TEST_USER_ID });

    const dbMock = createTableAwareDb();
    // Two selects from blueprints: pre-tx + tx FOR UPDATE
    dbMock.setTableRows(blueprints, [[draftBp], [draftBp]]);
    // 5 reference checks run in order: likes, usage events, fork requests,
    // agents, bots. Only the 5th (bots) returns cnt=1 to prove the bots check
    // is the one that fires — not an earlier check.
    dbMock.setExecuteResults([
      [{ cnt: 0 }], // likes
      [{ cnt: 0 }], // usage events
      [{ cnt: 0 }], // fork requests
      [{ cnt: 0 }], // agents
      [{ cnt: 1 }], // bots ← only this one fires
    ]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'DELETE', url: `/blueprints/${BP_ID}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('blueprint.lifecycle_conflict');
  });

  it('returns 409 for draft blueprint with publishedRevisionId set (previously published)', async () => {
    const draftBp = buildBlueprint({
      publicationStatus: 'draft',
      publishedRevisionId: REV_ID,
      publishedAt: new Date('2026-01-01'),
      authorId: TEST_USER_ID,
    });

    const dbMock = createTableAwareDb();
    // Only pre-tx select — handler rejects before entering transaction
    dbMock.setTableRows(blueprints, [[draftBp]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'DELETE', url: `/blueprints/${BP_ID}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('blueprint.lifecycle_conflict');
  });

  it('returns 409 when blueprint was concurrently published (TOCTOU guard)', async () => {
    const draftBp = buildDraftBlueprint({ authorId: TEST_USER_ID });
    const publishedBp = buildPublishedBlueprint({ authorId: TEST_USER_ID });

    const dbMock = createTableAwareDb();
    // Pre-tx select returns draft, FOR UPDATE returns published
    dbMock.setTableRows(blueprints, [[draftBp], [publishedBp]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'DELETE', url: `/blueprints/${BP_ID}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('blueprint.lifecycle_conflict');
  });

  it('returns 404 when blueprint was concurrently deleted (TOCTOU guard)', async () => {
    const draftBp = buildDraftBlueprint({ authorId: TEST_USER_ID });

    const dbMock = createTableAwareDb();
    // Pre-tx select returns draft, FOR UPDATE returns empty (race delete)
    dbMock.setTableRows(blueprints, [[draftBp], []]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'DELETE', url: `/blueprints/${BP_ID}` });
    expect(res.statusCode).toBe(404);
  });

  it('returns 204 when blueprint has revisions (exercises revision-skills deletion)', async () => {
    const draftBp = buildDraftBlueprint({ authorId: TEST_USER_ID });
    const revision = buildRevision({ blueprintId: BP_ID });

    const dbMock = createTableAwareDb();
    // Two selects from blueprints: pre-tx + tx FOR UPDATE
    dbMock.setTableRows(blueprints, [[draftBp], [draftBp]]);
    // Non-empty revisions — handler selects revision IDs, deletes revision
    // skills, then deletes revisions
    dbMock.setTableRows(blueprintRevisions, [[revision]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'DELETE', url: `/blueprints/${BP_ID}` });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('returns 404 for nonexistent blueprint', async () => {
    const dbMock = createTableAwareDb();
    // Empty — pre-tx select returns nothing
    dbMock.setTableRows(blueprints, [[]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'DELETE', url: `/blueprints/${BP_ID}` });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for blueprint owned by another user', async () => {
    const draftBp = buildDraftBlueprint({ authorId: OTHER_USER_ID });

    const dbMock = createTableAwareDb();
    // Only pre-tx select — handler rejects before entering transaction
    dbMock.setTableRows(blueprints, [[draftBp]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'DELETE', url: `/blueprints/${BP_ID}` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('blueprint.forbidden');
  });
});

// ─── POST /blueprints/:id/clone ───────────────────────────────────────────
// TODO (006-blueprint-unit-tests-schema-migration-debt): Rewrite tests against
// the new fork-based clone (BlueprintForkRequestSchema, idempotency, revision copy).

describe.skip('POST /blueprints/:id/clone', () => {
  it('returns 201 with cloned blueprint owned by the caller', async () => {
    const clonedBlueprint = { ...stubBlueprint, id: 'bp-cloned', name: 'My Blueprint (copy)' };
    let selectCallCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        // call 1: source lookup; call 2: fetch clone after insert
        return makeChain(selectCallCount === 1 ? [stubBlueprint] : [clonedBlueprint]);
      }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'POST', url: `/blueprints/${BLUEPRINT_ID}/clone` });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('My Blueprint (copy)');
  });

  it('returns 404 when source blueprint does not exist', async () => {
    const db = buildDb([]);
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'POST', url: `/blueprints/${BLUEPRINT_ID}/clone` });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /blueprints/:id/publish and /unpublish ──────────────────────────
// TODO (006-blueprint-unit-tests-schema-migration-debt): Rewrite tests against
// the new PublishBlueprintSchema (expectedCurrentRevisionId) and revision-based
// lifecycle.

describe.skip('POST /blueprints/:id/publish and /unpublish', () => {
  it('publish returns 200 with visibility=public', async () => {
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => makeChain([stubBlueprint])),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'POST', url: `/blueprints/${BLUEPRINT_ID}/publish` });
    expect(res.statusCode).toBe(200);
    expect(res.json().visibility).toBe('public');
  });

  it('unpublish returns 200 with visibility=private', async () => {
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => makeChain([{ ...stubBlueprint, visibility: 'public' }])),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'POST', url: `/blueprints/${BLUEPRINT_ID}/unpublish` });
    expect(res.statusCode).toBe(200);
    expect(res.json().visibility).toBe('private');
  });

  it('publish returns 404 for blueprint not owned by the user', async () => {
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => makeChain([])),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({ method: 'POST', url: `/blueprints/${BLUEPRINT_ID}/publish` });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /bots with blueprintId ─────────────────────────────────────────
// TODO (006-blueprint-unit-tests-schema-migration-debt): Rewrite tests against
// the new blueprint schema (no configData/configSnapshot, revision-based payload).

describe.skip('POST /bots with blueprintId', () => {
  const mockRedis = {
    xadd: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('ioredis').Redis;

  it('creates bot from blueprint and stores configSnapshot', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    let capturedBotValues: Record<string, unknown> | null = null;
    let selectCallCount = 0;
    const db = {
      // Blueprint lookup outside transaction
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // Blueprint lookup: return stubBlueprint
          return makeChain([{ id: BLUEPRINT_ID, configData: stubBlueprint.configData }]);
        }
        // Final select to fetch inserted bot
        return makeChain([{
          id: 'new-bot',
          userId: TEST_USER_ID,
          blueprintId: BLUEPRINT_ID,
          configSnapshot: stubBlueprint.configData,
          config: stubBlueprint.configData,
          status: 'stopped',
        }]);
      }),
      transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          execute: vi.fn().mockResolvedValue({ rows: [] }),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ id: 'tb-1', userId: TEST_USER_ID, provider: 'hyperliquid', label: 'Test', status: 'active', resolvedVenueAccountId: 'va-1' }]),
            }),
          }),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
              capturedBotValues = vals;
              return Promise.resolve(undefined);
            }),
          }),
        };
        return callback(tx);
      }),
    } as unknown as Database;

    const { PlansConfigSchema } = await import('@herobids/domain');
    const plansConfig = PlansConfigSchema.parse({});

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.decorateRequest('userPlanId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = TEST_USER_ID;
      request.userPlanId = 'free';
    });
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, plansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'tb-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        blueprintId: BLUEPRINT_ID,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(capturedBotValues?.['blueprintId']).toBe(BLUEPRINT_ID);
    expect(capturedBotValues?.['configSnapshot']).toBeDefined();
    // Deprecation header should NOT be set when using blueprintId
    expect(res.headers['deprecation']).toBeUndefined();
  });

  it('returns 404 when referenced blueprint does not exist', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    const db = {
      // Blueprint lookup returns nothing
      select: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;

    const { PlansConfigSchema } = await import('@herobids/domain');
    const plansConfig = PlansConfigSchema.parse({});

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.decorateRequest('userPlanId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = TEST_USER_ID;
      request.userPlanId = 'free';
    });
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, plansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'tb-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        blueprintId: 'bp-nonexistent',
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/blueprint/i);
  });

  it('sets Deprecation header when using legacy inline config', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{ id: 'new-bot', userId: TEST_USER_ID, status: 'stopped' }])),
      transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          execute: vi.fn().mockResolvedValue({ rows: [] }),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ id: 'tb-1', userId: TEST_USER_ID, provider: 'hyperliquid', label: 'Test', status: 'active', resolvedVenueAccountId: 'va-1' }]) }),
          }),
          insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
        };
        return callback(tx);
      }),
    } as unknown as Database;

    const { PlansConfigSchema } = await import('@herobids/domain');
    const plansConfig = PlansConfigSchema.parse({});

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.decorateRequest('userPlanId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = TEST_USER_ID;
      request.userPlanId = 'free';
    });
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, plansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'tb-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: { strategy: { type: 'momentum', decisionMode: 'mechanical' }, symbol: 'BTC-PERP' },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.headers['deprecation']).toBe('true');
  });

  it('returns 400 when configOverrides is supplied without blueprintId', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const db = {} as unknown as Database;

    const { PlansConfigSchema } = await import('@herobids/domain');
    const plansConfig = PlansConfigSchema.parse({});

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.decorateRequest('userPlanId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = TEST_USER_ID;
      request.userPlanId = 'free';
    });
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, plansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'tb-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: { strategy: { type: 'momentum' } },
        configOverrides: { strategy: { lookbackPeriod: 21 } },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('returns 404 (not 500) when blueprint is deleted between lookup and insert (FK race)', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    const { PlansConfigSchema } = await import('@herobids/domain');
    const plansConfig = PlansConfigSchema.parse({});

    const db = {
      // Blueprint lookup returns the blueprint (it exists at pre-transaction check time).
      select: vi.fn().mockImplementation(() =>
        makeChain([{ id: BLUEPRINT_ID, configData: stubBlueprint.configData }]),
      ),
      transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          execute: vi.fn().mockResolvedValue({ rows: [] }),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ id: 'tb-1', userId: TEST_USER_ID, provider: 'hyperliquid', label: 'Test', status: 'active', resolvedVenueAccountId: 'va-1' }]) }),
          }),
          insert: vi.fn().mockReturnValue({
            // Simulate the FK violation thrown when blueprint is deleted concurrently.
            values: vi.fn().mockRejectedValue(Object.assign(new Error('FK violation'), { code: '23503' })),
          }),
        };
        return callback(tx);
      }),
    } as unknown as Database;

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.decorateRequest('userPlanId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = TEST_USER_ID;
      request.userPlanId = 'free';
    });
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, plansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'tb-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        blueprintId: BLUEPRINT_ID,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/blueprint/i);
  });
});
