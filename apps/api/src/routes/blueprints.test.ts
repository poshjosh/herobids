import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { blueprintRoutes } from './blueprints.js';
import type { Database } from '@herobids/db';
import type { AgentRiskDefaultsConfig, BlueprintExecutionCapabilityResolver, PlansConfig } from '@herobids/domain';
import { createTableAwareDb } from '../__tests__/helpers/table-aware-db-mock.js';
import { buildBlueprint, buildPublishedBlueprint, buildDraftBlueprint, buildRevision, buildRevisionSkill, buildLike, buildAgentPayload, buildBotPayload, BP_ID, REV_ID, USER_ID, OTHER_USER_ID } from '../__tests__/helpers/blueprint-fixtures.js';
import { blueprints, blueprintRevisions, blueprintRevisionSkills, blueprintLikes, blueprintForkRequests, skills, skillRevisions, bots, connections } from '@herobids/db';
import { computeInstantiateRequestHash } from '../services/blueprint-idempotency.js';

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

// ─── POST /blueprints/:id/fork ──────────────────────────────────────────

describe('POST /blueprints/:id/fork', () => {
  it('returns 201 with forked draft blueprint carrying lineage', async () => {
    const sourceBp = buildPublishedBlueprint({ authorId: TEST_USER_ID });
    const sourceRev = buildRevision({ blueprintId: BP_ID, createdByUserId: TEST_USER_ID });
    const forkBpCreated = buildDraftBlueprint({
      id: 'fork-bp-id',
      sourceBlueprintId: BP_ID,
      sourceBlueprintRevisionId: REV_ID,
      authorId: TEST_USER_ID,
      name: 'Test Blueprint (fork)',
    });
    const forkRevCreated = buildRevision({
      id: 'fork-rev-id',
      blueprintId: 'fork-bp-id',
      version: 1,
    });

    const dbMock = createTableAwareDb();
    // resolveTargetRevision: blueprints[0] → sourceBp
    // tx FOR UPDATE lock: blueprints[1] → sourceBp
    // post-tx select fork: blueprints[2] → forkBpCreated
    dbMock.setTableRows(blueprints, [[sourceBp], [sourceBp], [forkBpCreated]]);
    // resolveTargetRevision: blueprintRevisions[0] → sourceRev
    // post-tx select fork revision: blueprintRevisions[1] → forkRevCreated
    dbMock.setTableRows(blueprintRevisions, [[sourceRev], [forkRevCreated]]);
    // tx check existing fork request: empty
    dbMock.setTableRows(blueprintForkRequests, [[]]);
    // tx copy skills (getRevisionSkillRefs): empty
    // post-tx buildBlueprintDetail: empty
    dbMock.setTableRows(blueprintRevisionSkills, [[], []]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/fork`,
      headers: { 'idempotency-key': 'test-key-1' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBe('fork-bp-id');
    expect(body.lineage.sourceBlueprintId).toBe(BP_ID);
    expect(body.publicationStatus).toBe('draft');
  });

  it('returns 400 when Idempotency-Key header is missing', async () => {
    const dbMock = createTableAwareDb();
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/fork`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('blueprint.validation');
  });

  it('returns 400 when Idempotency-Key contains non-ASCII characters', async () => {
    const dbMock = createTableAwareDb();
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/fork`,
      headers: { 'idempotency-key': 'café' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('blueprint.validation');
  });

  it('returns 200 on idempotent replay with same body', async () => {
    const sourceBp = buildPublishedBlueprint({ authorId: TEST_USER_ID });
    const sourceRev = buildRevision({ blueprintId: BP_ID, createdByUserId: TEST_USER_ID });

    // Compute the expected hash matching the handler's computation
    const expectedHash = computeInstantiateRequestHash({
      operation: 'fork',
      blueprintId: BP_ID,
      revisionId: REV_ID,
      kind: 'fork',
      edits: null,
    });

    const responsePayload = {
      forkBlueprintId: 'fork-bp-id',
      sourceBlueprintId: BP_ID,
      sourceBlueprintRevisionId: REV_ID,
      createdAt: new Date().toISOString(),
    };

    const dbMock = createTableAwareDb();
    // resolveTargetRevision: blueprint + revision
    dbMock.setTableRows(blueprints, [[sourceBp]]);
    dbMock.setTableRows(blueprintRevisions, [[sourceRev]]);
    // tx check existing fork request: returns existing record with matching hash
    dbMock.setTableRows(blueprintForkRequests, [[{
      id: 'existing-fork-req-id',
      userId: TEST_USER_ID,
      idempotencyKey: 'test-key-1',
      requestHash: expectedHash,
      sourceBlueprintId: BP_ID,
      sourceBlueprintRevisionId: REV_ID,
      forkBlueprintId: 'fork-bp-id',
      responsePayload,
    }]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/fork`,
      headers: { 'idempotency-key': 'test-key-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().forkBlueprintId).toBe('fork-bp-id');
  });

  it('returns 409 on idempotency conflict with different body', async () => {
    const sourceBp = buildPublishedBlueprint({ authorId: TEST_USER_ID });
    const sourceRev = buildRevision({ blueprintId: BP_ID, createdByUserId: TEST_USER_ID });

    const dbMock = createTableAwareDb();
    // resolveTargetRevision: blueprint + revision
    dbMock.setTableRows(blueprints, [[sourceBp]]);
    dbMock.setTableRows(blueprintRevisions, [[sourceRev]]);
    // tx check existing fork request: returns record with non-matching hash
    dbMock.setTableRows(blueprintForkRequests, [[{
      id: 'existing-fork-req-id',
      userId: TEST_USER_ID,
      idempotencyKey: 'test-key-1',
      requestHash: 'different-hash',
      sourceBlueprintId: BP_ID,
      sourceBlueprintRevisionId: REV_ID,
      forkBlueprintId: 'fork-bp-id',
      responsePayload: {},
    }]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/fork`,
      headers: { 'idempotency-key': 'test-key-1' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('blueprint.idempotency_conflict');
  });

  it('returns 404 when source blueprint not found', async () => {
    const dbMock = createTableAwareDb();
    // Empty blueprints → resolveTargetRevision returns 404
    dbMock.setTableRows(blueprints, [[]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/fork`,
      headers: { 'idempotency-key': 'test-key-1' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for non-owner without marketplace entitlement', async () => {
    const sourceBp = buildPublishedBlueprint({ authorId: OTHER_USER_ID });
    const sourceRev = buildRevision({ blueprintId: BP_ID, createdByUserId: OTHER_USER_ID });

    const dbMock = createTableAwareDb();
    // resolveTargetRevision: blueprint + revision (published=public access OK)
    dbMock.setTableRows(blueprints, [[sourceBp]]);
    dbMock.setTableRows(blueprintRevisions, [[sourceRev]]);
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

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/fork`,
      headers: { 'idempotency-key': 'test-key-1' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('blueprint.forbidden');
  });

  // H1: non-owner forking a non-published source → 404
  it('returns 404 for non-owner forking a draft blueprint', async () => {
    const draftBp = buildDraftBlueprint({ authorId: OTHER_USER_ID });
    const dbMock = createTableAwareDb();
    dbMock.setTableRows(blueprints, [[draftBp]]);
    const db = dbMock.build();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/fork`,
      headers: { 'idempotency-key': 'test-key-h1' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('blueprint.not_found');
  });

  // M1: invalid fork body → 400
  it('returns 400 for invalid fork body', async () => {
    const db = createTableAwareDb().build();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/fork`,
      headers: { 'idempotency-key': 'test-key-m1' },
      payload: { edits: 'not-an-object' }, // edits must be object per schema
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  // M2: fork with edits (deep merge) → 201
  it('returns 201 with merged edits in the forked blueprint', async () => {
    const sourceBp = buildPublishedBlueprint({ authorId: TEST_USER_ID });
    const sourceRev = buildRevision({ blueprintId: BP_ID, payload: buildAgentPayload({ name: 'Original' }) });
    const forkBpCreated = buildDraftBlueprint({
      id: 'fork-bp-id-2',
      sourceBlueprintId: BP_ID,
      sourceBlueprintRevisionId: REV_ID,
      authorId: TEST_USER_ID,
      name: 'Original (fork)',
    });
    const forkRevCreated = buildRevision({
      id: 'fork-rev-id-2',
      blueprintId: 'fork-bp-id-2',
      version: 1,
      payload: buildAgentPayload({ name: 'Original', description: 'Custom forked description' }),
    });

    const dbMock = createTableAwareDb();
    // resolveTargetRevision selects, FOR UPDATE lock, post-tx fork select
    dbMock.setTableRows(blueprints, [[sourceBp], [sourceBp], [forkBpCreated]]);
    dbMock.setTableRows(blueprintRevisions, [[sourceRev], [forkRevCreated]]);
    dbMock.setTableRows(blueprintForkRequests, [[]]);
    dbMock.setTableRows(blueprintRevisionSkills, [[], []]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/fork`,
      headers: { 'idempotency-key': 'test-key-edits' },
      payload: { edits: { kind: 'agent', description: 'Custom forked description' } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe('fork-bp-id-2');
  });

  // M3: delisted/archived source → 409 LIFECYCLE_CONFLICT
  it('returns 409 for delisted source blueprint', async () => {
    const delistedBp = buildBlueprint({
      publicationStatus: 'delisted',
      delistedAt: new Date(),
      authorId: TEST_USER_ID,
    });
    const dbMock = createTableAwareDb();
    dbMock.setTableRows(blueprints, [[delistedBp]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/fork`,
      headers: { 'idempotency-key': 'test-key-m3' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('blueprint.lifecycle_conflict');
  });
});

// ─── POST /blueprints/:id/publish ─────────────────────────────────────────

describe('POST /blueprints/:id/publish', () => {
  it('returns 200 with published status for a draft blueprint', async () => {
    const draftBp = buildDraftBlueprint({ id: BP_ID, authorId: TEST_USER_ID, currentRevisionId: REV_ID });
    const revision = buildRevision({ id: REV_ID, blueprintId: BP_ID });
    const publishedBp = buildPublishedBlueprint({
      id: BP_ID,
      authorId: TEST_USER_ID,
      publishedRevisionId: REV_ID,
      currentRevisionId: REV_ID,
    });

    const dbMock = createTableAwareDb();
    // Pre-tx blueprints select (step 2) + post-tx blueprints select (step 10)
    dbMock.setTableRows(blueprints, [[draftBp], [publishedBp]]);
    // Revision select (step 7)
    dbMock.setTableRows(blueprintRevisions, [[revision]]);
    // getRevisionSkillRefs (step 8) + buildBlueprintDetail getRevisionSkillRefs (step 12)
    dbMock.setTableRows(blueprintRevisionSkills, [[], []]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/publish`,
      payload: { expectedCurrentRevisionId: REV_ID },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.publicationStatus).toBe('published');
    expect(body.publishedAt).not.toBeNull();
    expect(body.publishedRevisionId).toBe(REV_ID);
  });

  it('returns 409 when expectedCurrentRevisionId does not match', async () => {
    const draftBp = buildDraftBlueprint({ id: BP_ID, authorId: TEST_USER_ID, currentRevisionId: REV_ID });

    const dbMock = createTableAwareDb();
    // Only 1 blueprints select needed (rejects before transaction)
    dbMock.setTableRows(blueprints, [[draftBp]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/publish`,
      payload: { expectedCurrentRevisionId: 'wrong-rev-id' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('blueprint.revision_stale');
  });

  it('returns 409 for disallowed transition (archived → published)', async () => {
    const archivedBp = buildBlueprint({
      id: BP_ID,
      authorId: TEST_USER_ID,
      publicationStatus: 'archived',
      archivedAt: new Date(),
      currentRevisionId: REV_ID,
    });

    const dbMock = createTableAwareDb();
    dbMock.setTableRows(blueprints, [[archivedBp]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/publish`,
      payload: { expectedCurrentRevisionId: REV_ID },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('blueprint.lifecycle_conflict');
  });

  it('returns 400 when body is missing expectedCurrentRevisionId', async () => {
    const dbMock = createTableAwareDb();
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/publish`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('returns 403 for non-owner caller', async () => {
    const draftBp = buildDraftBlueprint({ id: BP_ID, authorId: OTHER_USER_ID, currentRevisionId: REV_ID });

    const dbMock = createTableAwareDb();
    dbMock.setTableRows(blueprints, [[draftBp]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/publish`,
      payload: { expectedCurrentRevisionId: REV_ID },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('blueprint.forbidden');
  });

  it('returns 404 for nonexistent blueprint', async () => {
    const dbMock = createTableAwareDb();
    dbMock.setTableRows(blueprints, [[]]);
    const db = dbMock.build();

    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityResolver, testPlansConfig);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${BP_ID}/publish`,
      payload: { expectedCurrentRevisionId: REV_ID },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /bots with blueprintId ─────────────────────────────────────────

describe('POST /bots with blueprintId', () => {
  const mockRedis = {
    xadd: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('ioredis').Redis;

  it('creates bot from blueprint and returns 201', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    const dbMock = createTableAwareDb();
    // First select: blueprint lookup via innerJoin — dispatches on the blueprints table.
    // Drizzle aliases blueprintRevisions.payload as configData, so the row key is "configData".
    // Use buildBotPayload() — BotConfigSchema requires risk to be an object, not null.
    dbMock.setTableRows(blueprints, [[{ id: BP_ID, configData: buildBotPayload() }]]);
    // Transaction: connection lookup for ownership verification
    dbMock.setTableRows(connections, [[{ id: 'tb-1', userId: TEST_USER_ID, provider: 'hyperliquid', label: 'Test', status: 'active', resolvedVenueAccountId: 'va-1' }]]);
    // Transaction: checkBotLimit queries bots (returns empty — no bots yet)
    // Post-tx: fetch the inserted bot
    dbMock.setTableRows(bots, [
      [],
      [{ id: 'new-bot', userId: TEST_USER_ID, blueprintId: BP_ID, status: 'stopped' }],
    ]);

    const db = dbMock.build();

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
        blueprintId: BP_ID,
      },
    });

    expect(res.statusCode).toBe(201);
    // Deprecation header should NOT be set when using blueprintId
    expect(res.headers['deprecation']).toBeUndefined();
  });

  it('returns 404 when referenced blueprint does not exist', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    const dbMock = createTableAwareDb();
    // Blueprint lookup returns nothing — dispatches on blueprints table
    dbMock.setTableRows(blueprints, [[]]);

    const db = dbMock.build();

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

    const dbMock = createTableAwareDb();
    // Transaction: connection lookup for ownership verification
    dbMock.setTableRows(connections, [[{ id: 'tb-1', userId: TEST_USER_ID, provider: 'hyperliquid', label: 'Test', status: 'active', resolvedVenueAccountId: 'va-1' }]]);
    // Transaction: checkBotLimit queries bots (returns empty — no bots yet)
    // Post-tx: fetch the inserted bot
    dbMock.setTableRows(bots, [
      [],
      [{ id: 'new-bot', userId: TEST_USER_ID, status: 'stopped' }],
    ]);

    const db = dbMock.build();

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

    const db = createTableAwareDb().build();

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

    const dbMock = createTableAwareDb();
    // Blueprint lookup (pre-tx) returns the blueprint — it exists at check time.
    // Drizzle aliases blueprintRevisions.payload as configData.
    // Use buildBotPayload() — BotConfigSchema requires risk to be an object, not null.
    dbMock.setTableRows(blueprints, [[{ id: BP_ID, configData: buildBotPayload() }]]);

    const db = dbMock.build();

    // Override transaction to simulate FK violation on insert inside the tx
    db.transaction = vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: 'tb-1', userId: TEST_USER_ID, provider: 'hyperliquid', label: 'Test', status: 'active', resolvedVenueAccountId: 'va-1' }]),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockRejectedValue(Object.assign(new Error('FK violation'), { code: '23503' })),
        }),
      };
      return callback(tx);
    });

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
        blueprintId: BP_ID,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/blueprint/i);
  });

  it('returns 400 when both blueprintId and config are supplied', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const { PlansConfigSchema } = await import('@herobids/domain');
    const plansConfig = PlansConfigSchema.parse({});

    const db = createTableAwareDb().build();

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
        blueprintId: BP_ID,
        config: { strategy: { type: 'momentum' }, symbol: 'BTC-PERP' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });
});
