import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { Database } from '@herobids/db';
import { skills, users } from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import { buildSkillSlug } from '@herobids/domain';
import { skillsRoutes } from './skills.js';

const TEST_USER_ID = 'user-1';
const TEST_USERNAME = 'alice';
let insertedValues: Array<Record<string, unknown>> = [];

function decorateWithAuth(app: ReturnType<typeof Fastify>) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.decorateRequest('isAdmin', false);
  app.addHook('onRequest', async (request) => {
    request.userId = TEST_USER_ID;
    request.userPlanId = 'free';
    request.isAdmin = false;
  });
}

/**
 * Build a thenable chain that resolves to `rows`.
 * Supports the drizzle fluent query methods used by skills.ts handlers.
 */
function makeChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'groupBy', '$dynamic']) {
    chain[method] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(rows).then(resolve, reject);
  return chain;
}

/**
 * Build a mock Database that routes `select().from(table)` to different row
 * arrays depending on the table reference. Falls back to empty arrays for
 * tables not specified.
 */
function makeTableRoutedDb(tableRows: Map<unknown, () => unknown[]>): Database {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn().mockImplementation((value: Record<string, unknown>) => {
    insertedValues.push(value);
    return { onConflictDoUpdate, onConflictDoNothing };
  });

  const db: Record<string, unknown> = {
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation((table: unknown) => {
        const rowsFn = tableRows.get(table);
        const rows = rowsFn ? rowsFn() : [];
        return makeChain(rows);
      }),
    }),
    selectDistinct: vi.fn().mockImplementation(() => makeChain([])),
    execute: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    })),
    delete: vi.fn().mockImplementation(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    transaction: vi.fn().mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(db),
    ),
  };

  return db as unknown as Database;
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

function makeSkillRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'skill-1',
    authorId: TEST_USER_ID,
    slug: `${TEST_USERNAME}/test-skill`,
    publicationStatus: 'published',
    priceCents: 0,
    likeCount: 0,
    forkCount: 0,
    forkOf: null,
    popularityScore: 0,
    trendingScore: 0,
    currentRevisionId: null,
    name: 'Test Skill',
    description: 'desc',
    instructions: 'inst',
    promptHint: null,
    promptTemplate: null,
    requiredTools: [],
    contextRequirements: [],
    requiredGuardrails: [],
    capabilityFamilies: [],
    suggestedTickIntervalMs: 900_000,
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedValues = [];
});

// ── POST /skills — slug computation and uniqueness ────────────────────────
describe('POST /skills slug', () => {
  it('sets slug from author username + slugified name on create', async () => {
    const expectedSlug = buildSkillSlug(TEST_USERNAME, 'My Cool Skill');
    const createdRow = makeSkillRow({
      id: 'skill-new',
      name: 'My Cool Skill',
      slug: expectedSlug,
    });

    const tableRows = new Map<unknown, () => unknown[]>();
    tableRows.set(users, () => [{ username: TEST_USERNAME }]);
    // No pre-transaction uniqueness check — constraint violation is caught on insert
    tableRows.set(skills, () => [createdRow]);

    const db = makeTableRoutedDb(tableRows);
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: {
        name: 'My Cool Skill',
        description: 'desc',
        instructions: 'inst',
      },
    });

    expect(res.statusCode).toBe(201);
    // Verify the inserted row contains the correct slug
    const skillInsert = insertedValues.find(
      (v) => v['authorId'] === TEST_USER_ID && v['name'] === 'My Cool Skill',
    );
    expect(skillInsert).toBeDefined();
    expect(skillInsert!['slug']).toBe(expectedSlug);
  });

  it('rejects duplicate slug with 409 slug_conflict', async () => {
    const duplicateSlug = buildSkillSlug(TEST_USERNAME, 'Taken Name');

    const tableRows = new Map<unknown, () => unknown[]>();
    tableRows.set(users, () => [{ username: TEST_USERNAME }]);
    tableRows.set(skills, () => []);

    const db = makeTableRoutedDb(tableRows);

    // Override insert to throw a PostgreSQL unique constraint violation (23505)
    const uniqueViolation = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    (db as unknown as Record<string, unknown>).transaction = vi.fn().mockRejectedValue(uniqueViolation);

    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: {
        name: 'Taken Name',
        description: 'desc',
        instructions: 'inst',
      },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe('slug_conflict');
    expect(body.message).toContain(duplicateSlug);
  });
});

// ── SkillView includes slug ───────────────────────────────────────────────
describe('SkillView response includes slug', () => {
  it('returns slug field in the create response', async () => {
    const expectedSlug = buildSkillSlug(TEST_USERNAME, 'Slugged Skill');
    const createdRow = makeSkillRow({
      id: 'skill-slug-view',
      name: 'Slugged Skill',
      slug: expectedSlug,
    });

    const tableRows = new Map<unknown, () => unknown[]>();
    tableRows.set(users, () => [{ username: TEST_USERNAME }]);
    // No pre-transaction uniqueness check — always return created row
    tableRows.set(skills, () => [createdRow]);

    const db = makeTableRoutedDb(tableRows);
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: {
        name: 'Slugged Skill',
        description: 'desc',
        instructions: 'inst',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.slug).toBe(expectedSlug);
    expect(typeof body.slug).toBe('string');
    expect(body.slug).toContain('/');
  });

  it('returns slug field in GET /skills/:id response', async () => {
    const expectedSlug = buildSkillSlug(TEST_USERNAME, 'My Skill');
    const skillRow = makeSkillRow({
      id: 'skill-get-slug',
      name: 'My Skill',
      slug: expectedSlug,
    });

    const tableRows = new Map<unknown, () => unknown[]>();
    tableRows.set(skills, () => [skillRow]);

    const db = makeTableRoutedDb(tableRows);
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'GET',
      url: '/skills/skill-get-slug',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().slug).toBe(expectedSlug);
  });
});

// ── PATCH /skills/:id — slug update on name change ───────────────────────
describe('PATCH /skills/:id slug', () => {
  it('updates slug when name changes', async () => {
    const originalSlug = buildSkillSlug(TEST_USERNAME, 'Old Name');
    const newSlug = buildSkillSlug(TEST_USERNAME, 'New Name');

    const existingSkill = makeSkillRow({
      id: 'skill-patch',
      name: 'Old Name',
      slug: originalSlug,
      publicationStatus: 'draft',
      currentRevisionId: 'rev-1',
    });

    const revisionRow = {
      id: 'rev-1',
      skillId: 'skill-patch',
      version: 1,
      name: 'Old Name',
      description: 'desc',
      instructions: 'inst',
      promptHint: null,
      promptTemplate: null,
      requiredTools: [],
      contextRequirements: [],
      requiredGuardrails: [],
      capabilityFamilies: [],
      suggestedTickIntervalMs: 900_000,
      tags: [],
      changeSummary: null,
      createdByUserId: TEST_USER_ID,
      publishedAt: null,
      createdAt: new Date(),
    };

    const updatedSkill = makeSkillRow({
      ...existingSkill,
      name: 'New Name',
      slug: newSlug,
    });

    let skillsSelectCount = 0;
    const tableRows = new Map<unknown, () => unknown[]>();
    tableRows.set(users, () => [{ username: TEST_USERNAME }]);
    tableRows.set(skills, () => {
      skillsSelectCount += 1;
      // Call 1: fetch skill by id + authorId (ownership check)
      // Call 2+: fetch updated row for response
      if (skillsSelectCount === 1) return [existingSkill];
      return [updatedSkill];
    });

    // Drizzle uses select().from(skillRevisions) — route to revision data.
    // Import skillRevisions to route correctly.
    const { skillRevisions } = await import('@herobids/db');
    let revSelectCount = 0;
    tableRows.set(skillRevisions, () => {
      revSelectCount += 1;
      if (revSelectCount === 1) return [revisionRow]; // current revision fetch
      return [revisionRow]; // getLatestRevisionBySkillId + subsequent queries
    });

    const db = makeTableRoutedDb(tableRows);
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'PATCH',
      url: '/skills/skill-patch',
      payload: { name: 'New Name' },
    });

    expect(res.statusCode).toBe(200);
    // The response should include the new slug
    expect(res.json().slug).toBe(newSlug);
  });

  it('rejects name change when new slug conflicts with another skill', async () => {
    const originalSlug = buildSkillSlug(TEST_USERNAME, 'Original');
    const conflictingSlug = buildSkillSlug(TEST_USERNAME, 'Conflicting');

    const existingSkill = makeSkillRow({
      id: 'skill-conflict-patch',
      name: 'Original',
      slug: originalSlug,
      publicationStatus: 'draft',
      currentRevisionId: 'rev-1',
    });

    const revisionRow = {
      id: 'rev-1',
      skillId: 'skill-conflict-patch',
      version: 1,
      name: 'Original',
      description: 'desc',
      instructions: 'inst',
      promptHint: null,
      promptTemplate: null,
      requiredTools: [],
      contextRequirements: [],
      requiredGuardrails: [],
      capabilityFamilies: [],
      suggestedTickIntervalMs: 900_000,
      tags: [],
      changeSummary: null,
      createdByUserId: TEST_USER_ID,
      publishedAt: null,
      createdAt: new Date(),
    };

    let skillsSelectCount = 0;
    const tableRows = new Map<unknown, () => unknown[]>();
    tableRows.set(users, () => [{ username: TEST_USERNAME }]);
    tableRows.set(skills, () => {
      skillsSelectCount += 1;
      if (skillsSelectCount === 1) return [existingSkill]; // ownership check
      return [existingSkill]; // subsequent queries
    });

    const { skillRevisions } = await import('@herobids/db');
    tableRows.set(skillRevisions, () => [revisionRow]);

    const db = makeTableRoutedDb(tableRows);

    // Override transaction to throw a PostgreSQL unique constraint violation (23505)
    const uniqueViolation = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const originalTransaction = db.transaction.bind(db);
    (db as unknown as Record<string, unknown>).transaction = vi.fn().mockRejectedValue(uniqueViolation);

    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'PATCH',
      url: '/skills/skill-conflict-patch',
      payload: { name: 'Conflicting' },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe('slug_conflict');
    expect(body.message).toContain(conflictingSlug);
  });

  it('does not touch slug when name is not changed', async () => {
    const existingSlug = buildSkillSlug(TEST_USERNAME, 'Stable Name');

    const existingSkill = makeSkillRow({
      id: 'skill-no-name-change',
      name: 'Stable Name',
      slug: existingSlug,
      publicationStatus: 'draft',
      currentRevisionId: 'rev-stable',
    });

    const revisionRow = {
      id: 'rev-stable',
      skillId: 'skill-no-name-change',
      version: 1,
      name: 'Stable Name',
      description: 'old desc',
      instructions: 'old inst',
      promptHint: null,
      promptTemplate: null,
      requiredTools: [],
      contextRequirements: [],
      requiredGuardrails: [],
      capabilityFamilies: [],
      suggestedTickIntervalMs: 900_000,
      tags: [],
      changeSummary: null,
      createdByUserId: TEST_USER_ID,
      publishedAt: null,
      createdAt: new Date(),
    };

    const tableRows = new Map<unknown, () => unknown[]>();
    // No users call needed — name isn't changing, so slug isn't recomputed
    tableRows.set(users, () => [{ username: TEST_USERNAME }]);
    tableRows.set(skills, () => [existingSkill]);

    const { skillRevisions } = await import('@herobids/db');
    tableRows.set(skillRevisions, () => [revisionRow]);

    const db = makeTableRoutedDb(tableRows);
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'PATCH',
      url: '/skills/skill-no-name-change',
      payload: { description: 'updated desc' },
    });

    expect(res.statusCode).toBe(200);
    // Slug should remain unchanged
    expect(res.json().slug).toBe(existingSlug);
  });
});

// ── POST /skills/:id/fork — slug on forked skill ─────────────────────────
describe('POST /skills/:id/fork slug', () => {
  it('sets slug on forked skill from author username + forked name', async () => {
    const sourceSkill = makeSkillRow({
      id: 'source-skill',
      authorId: 'other-user',
      name: 'Original Skill',
      slug: 'other/original-skill',
      publicationStatus: 'published',
      currentRevisionId: 'rev-source',
    });

    const sourceRevision = {
      id: 'rev-source',
      skillId: 'source-skill',
      version: 1,
      name: 'Original Skill',
      description: 'source desc',
      instructions: 'source inst',
      promptHint: null,
      promptTemplate: null,
      requiredTools: [],
      contextRequirements: [],
      requiredGuardrails: [],
      capabilityFamilies: [],
      suggestedTickIntervalMs: 900_000,
      tags: [],
      changeSummary: null,
      createdByUserId: 'other-user',
      publishedAt: new Date(),
      createdAt: new Date(),
    };

    const expectedForkSlug = buildSkillSlug(TEST_USERNAME, 'Original Skill (copy)');

    // The fork handler does multiple selects from skills:
    // 1. fetch source skill
    // 2. buildSkillViews for canFork check (select from skills for viewer context)
    // 3. fetch forked skill for response
    let skillsSelectCount = 0;
    const forkedRow = makeSkillRow({
      id: 'forked-skill',
      authorId: TEST_USER_ID,
      name: 'Original Skill (copy)',
      slug: expectedForkSlug,
      forkOf: 'source-skill',
    });

    const tableRows = new Map<unknown, () => unknown[]>();
    tableRows.set(users, () => [{ username: TEST_USERNAME }]);
    tableRows.set(skills, () => {
      skillsSelectCount += 1;
      // Call 1: fetch source skill by id
      if (skillsSelectCount === 1) return [sourceSkill];
      // Call 2+: fetch forked skill for response
      return [forkedRow];
    });

    const { skillRevisions } = await import('@herobids/db');
    tableRows.set(skillRevisions, () => [sourceRevision]);

    const db = makeTableRoutedDb(tableRows);
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/skills/source-skill/fork',
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.slug).toBe(expectedForkSlug);

    // Verify the inserted fork row has the correct slug
    const forkInsert = insertedValues.find(
      (v) => v['authorId'] === TEST_USER_ID && v['forkOf'] === 'source-skill',
    );
    expect(forkInsert).toBeDefined();
    expect(forkInsert!['slug']).toBe(expectedForkSlug);
  });
});
