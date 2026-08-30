import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { Database } from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import { inferDependsOn } from '@herobids/domain';
import { skillsRoutes } from './skills.js';

const TEST_USER_ID = 'user-1';
let insertedValues: Array<Record<string, unknown>> = [];

function decorateWithAuth(app: ReturnType<typeof Fastify>, isAdmin = false) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.decorateRequest('isAdmin', false);
  app.addHook('onRequest', async (request) => {
    request.userId = TEST_USER_ID;
    request.userPlanId = 'free';
    request.isAdmin = isAdmin;
  });
}

function makeInsertMock() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockImplementation((value: Record<string, unknown>) => {
    insertedValues.push(value);
    return { onConflictDoUpdate, onConflictDoNothing };
  });
  return vi.fn().mockReturnValue({ values });
}

function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy', 'limit', 'offset', 'innerJoin', 'groupBy', '$dynamic']) {
    chain[method] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

function makeDbMock(): Database {
  const db = {
    insert: makeInsertMock(),
    select: vi.fn().mockImplementation(() => makeChain([])),
    selectDistinct: vi.fn().mockImplementation(() => makeChain([])),
    execute: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    })),
    delete: vi.fn().mockImplementation(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
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

beforeEach(() => {
  vi.clearAllMocks();
  insertedValues = [];
});

describe('skillsRoutes (normalized contract)', () => {
  it('auto-publishes non-draft skills for the free plan on create', async () => {
    const createdRow = {
      id: 'skill-created',
      authorId: TEST_USER_ID,
      publicationStatus: 'published',
      priceCents: 0,
      likeCount: 0,
      forkCount: 0,
      popularityScore: 0,
      trendingScore: 0,
      currentRevisionId: null,
      name: 'Auto Public Skill',
      description: 'desc',
      instructions: 'inst',
      requiredTools: [],
      contextRequirements: [],
      requiredGuardrails: [],
      capabilityFamilies: [],
      suggestedTickIntervalMs: 900_000,
      tags: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    let selectCalls = 0;
    const db = {
      ...makeDbMock(),
      select: vi.fn().mockImplementation(() => {
        selectCalls += 1;
        // Call 1: users query for author handle
        if (selectCalls === 1) return makeChain([{ username: 'testuser' }]);
        // Call 2: post-create skills fetch
        if (selectCalls === 2) return makeChain([createdRow]);
        return makeChain([]);
      }),
      selectDistinct: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;

    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db, makePlansConfig());
    // Reset counter after init: skillsRoutes seeds SYSTEM_SKILLS which calls
    // db.select() once per skill to check for existing revisions.
    selectCalls = 0;

    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: {
        name: 'Auto Public Skill',
        description: 'desc',
        instructions: 'inst',
        publicationStatus: 'private',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().publicationStatus).toBe('published');

    const createdInsert = insertedValues.find((value) => value['authorId'] === TEST_USER_ID && value['name'] === 'Auto Public Skill');
    expect(createdInsert).toBeDefined();
    expect(createdInsert!['publicationStatus']).toBe('published');
    expect(createdInsert!['autoPublishedByPlan']).toBe(true);
  });

  it('does not call db.select() during route initialisation (system skill sync is owned by index.ts)', async () => {
    let selectCallCount = 0;
    const trackingDb = {
      ...makeDbMock(),
      select: vi.fn().mockImplementation(() => {
        selectCallCount += 1;
        return makeChain([]);
      }),
    } as unknown as Database;

    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, trackingDb, makePlansConfig());

    // syncSystemSkills is called exclusively by apps/api/src/index.ts at startup,
    // not by skillsRoutes itself. No db.select() calls should happen during init.
    expect(selectCallCount).toBe(0);
  });

  it('rejects invalid create payloads with 400 validation_error', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, makeDbMock(), makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: { name: 'Only name set' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('blocks non-admin scope=admin listings with 403', async () => {
    const app = Fastify();
    decorateWithAuth(app, false);
    await skillsRoutes(app, makeDbMock(), makePlansConfig());

    const res = await app.inject({ method: 'GET', url: '/skills?scope=admin' });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('forbidden');
  });

  it('accepts admin scope=admin listing for admins', async () => {
    const app = Fastify();
    decorateWithAuth(app, true);
    await skillsRoutes(app, makeDbMock(), makePlansConfig());

    const res = await app.inject({ method: 'GET', url: '/skills?scope=admin' });

    expect(res.statusCode).toBe(200);
    expect(res.json().skills).toEqual([]);
    expect(res.json().totalCount).toBe(0);
    expect(res.json().page).toBe(1);
    expect(res.json().pageSize).toBe(20);
  });

  it('blocks marketplace scope when plan disallows marketplace visibility', async () => {
    const app = Fastify();
    decorateWithAuth(app, false);
    const plans = makePlansConfig();
    plans.plans['free']!.entitlements.skills.canViewMarketplaceSkills = false;
    await skillsRoutes(app, makeDbMock(), plans);

    const res = await app.inject({ method: 'GET', url: '/skills?scope=marketplace' });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('plan.skills_marketplace_hidden');
  });

  it('returns the normalized metrics payload shape expected by the web client', async () => {
    const skillRow = {
      id: 'skill-1',
      authorId: TEST_USER_ID,
      publicationStatus: 'published',
      likeCount: 5,
      forkCount: 2,
      popularityScore: 1.25,
      trendingScore: 0.5,
      updatedAt: new Date('2026-06-13T12:00:00.000Z'),
    };
    const db = {
      ...makeDbMock(),
      select: vi.fn().mockImplementation(() => makeChain([skillRow])),
      execute: vi.fn()
        .mockResolvedValueOnce([{ distinct_users_90d: 3, session_starts_90d: 7, forks_90d: 2 }])
        .mockResolvedValueOnce([{ distinct_users_30d: 2, session_starts_30d: 4, forks_30d: 1 }])
        .mockResolvedValueOnce([{ likes_90d: 5 }])
        .mockResolvedValueOnce([{ likes_30d: 3 }]),
    } as unknown as Database;

    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db, makePlansConfig());

    const res = await app.inject({ method: 'GET', url: '/skills/skill-1/metrics' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      skillId: 'skill-1',
      usage90d: 7,
      likes90d: 5,
      forks90d: 2,
      usage30d: 4,
      likes30d: 3,
      forks30d: 1,
      likeCount: 5,
      forkCount: 2,
      popularityScore: 1.25,
      trendingScore: 0.5,
      updatedAt: '2026-06-13T12:00:00.000Z',
    });
  });

  it('blocks publish when plan disallows marketplace publishing', async () => {
    const skillRow = {
      id: 'skill-1',
      authorId: TEST_USER_ID,
      publicationStatus: 'draft',
      priceCents: 0,
      currentRevisionId: null,
      publishedAt: null,
      delistedAt: null,
      archivedAt: null,
      autoPublishedByPlan: false,
      likeCount: 0,
      forkCount: 0,
      popularityScore: 0,
      trendingScore: 0,
      name: 'Skill',
      description: 'desc',
      instructions: 'inst',
      requiredTools: [],
      contextRequirements: [],
      requiredGuardrails: [],
      capabilityFamilies: [],
      suggestedTickIntervalMs: 900_000,
      tags: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = {
      ...makeDbMock(),
      select: vi.fn().mockImplementation(() => makeChain([skillRow])),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    const plans = makePlansConfig();
    plans.plans['free']!.entitlements.skills.canPublishToMarketplace = false;
    await skillsRoutes(app, db, plans);

    const res = await app.inject({ method: 'POST', url: '/skills/skill-1/publish', payload: {} });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('plan.skills_marketplace_publish_disabled');
  });

  it('blocks delist when plan disallows private skills', async () => {
    const skillRow = {
      id: 'skill-1',
      authorId: TEST_USER_ID,
      publicationStatus: 'published',
      priceCents: 0,
      currentRevisionId: null,
      publishedAt: new Date(),
      delistedAt: null,
      archivedAt: null,
      autoPublishedByPlan: false,
      likeCount: 0,
      forkCount: 0,
      popularityScore: 0,
      trendingScore: 0,
      name: 'Skill',
      description: 'desc',
      instructions: 'inst',
      requiredTools: [],
      contextRequirements: [],
      requiredGuardrails: [],
      capabilityFamilies: [],
      suggestedTickIntervalMs: 900_000,
      tags: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = {
      ...makeDbMock(),
      select: vi.fn().mockImplementation(() => makeChain([skillRow])),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    const plans = makePlansConfig();
    plans.plans['free']!.entitlements.skills.canCreatePrivateSkills = false;
    await skillsRoutes(app, db, plans);

    const res = await app.inject({ method: 'POST', url: '/skills/skill-1/delist' });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('plan.skills_private_disabled');
  });

  it('blocks likes when plan disallows marketplace likes', async () => {
    const skillRow = {
      id: 'skill-1',
      authorId: 'other-user',
      publicationStatus: 'published',
      priceCents: 0,
      currentRevisionId: null,
      publishedAt: new Date(),
      delistedAt: null,
      archivedAt: null,
      autoPublishedByPlan: false,
      likeCount: 0,
      forkCount: 0,
      popularityScore: 0,
      trendingScore: 0,
      name: 'Skill',
      description: 'desc',
      instructions: 'inst',
      requiredTools: [],
      contextRequirements: [],
      requiredGuardrails: [],
      capabilityFamilies: [],
      suggestedTickIntervalMs: 900_000,
      tags: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = {
      ...makeDbMock(),
      select: vi.fn().mockImplementation(() => makeChain([skillRow])),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    const plans = makePlansConfig();
    plans.plans['free']!.entitlements.skills.canLikeMarketplaceSkills = false;
    await skillsRoutes(app, db, plans);

    const res = await app.inject({ method: 'POST', url: '/skills/skill-1/like' });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('plan.skills_like_disabled');
  });
});

describe('GET /skills pagination', () => {
  it('returns custom page and pageSize in the response', async () => {
    const app = Fastify();
    decorateWithAuth(app, true);
    await skillsRoutes(app, makeDbMock(), makePlansConfig());

    const res = await app.inject({ method: 'GET', url: '/skills?scope=admin&page=2&pageSize=5' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(5);
    expect(body.totalCount).toBe(0);
    expect(body.skills).toEqual([]);
  });

  it('rejects page below minimum (page=0) with 400', async () => {
    const app = Fastify();
    decorateWithAuth(app, true);
    await skillsRoutes(app, makeDbMock(), makePlansConfig());

    const res = await app.inject({ method: 'GET', url: '/skills?scope=admin&page=0' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('rejects pageSize above maximum (pageSize=101) with 400', async () => {
    const app = Fastify();
    decorateWithAuth(app, true);
    await skillsRoutes(app, makeDbMock(), makePlansConfig());

    const res = await app.inject({ method: 'GET', url: '/skills?scope=admin&pageSize=101' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('rejects pageSize below minimum (pageSize=0) with 400', async () => {
    const app = Fastify();
    decorateWithAuth(app, true);
    await skillsRoutes(app, makeDbMock(), makePlansConfig());

    const res = await app.inject({ method: 'GET', url: '/skills?scope=admin&pageSize=0' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('applies LIMIT and OFFSET to the data query', async () => {
    const dataChain = makeChain([]);
    const countChain = makeChain([]);
    let selectCallCount = 0;
    const db = {
      ...makeDbMock(),
      select: vi.fn().mockImplementation(() => {
        selectCallCount += 1;
        // Call 1: count query (from Promise.all), Call 2: data rows query
        if (selectCallCount === 1) return countChain;
        return dataChain;
      }),
    } as unknown as Database;

    const app = Fastify();
    decorateWithAuth(app, true);
    await skillsRoutes(app, db, makePlansConfig());
    selectCallCount = 0;

    const res = await app.inject({ method: 'GET', url: '/skills?scope=admin&page=3&pageSize=10' });

    expect(res.statusCode).toBe(200);
    // The data chain should have .limit(10) and .offset(20) called on it
    // page=3, pageSize=10 → offset = (3-1)*10 = 20
    expect(dataChain.limit).toHaveBeenCalledWith(10);
    expect(dataChain.offset).toHaveBeenCalledWith(20);
  });

  it('accepts pageSize at the maximum boundary (pageSize=100)', async () => {
    const app = Fastify();
    decorateWithAuth(app, true);
    await skillsRoutes(app, makeDbMock(), makePlansConfig());

    const res = await app.inject({ method: 'GET', url: '/skills?scope=admin&pageSize=100' });

    expect(res.statusCode).toBe(200);
    expect(res.json().pageSize).toBe(100);
  });

  it('defaults to page=1 and pageSize=20 when not provided', async () => {
    const dataChain = makeChain([]);
    const countChain = makeChain([]);
    let selectCallCount = 0;
    const db = {
      ...makeDbMock(),
      select: vi.fn().mockImplementation(() => {
        selectCallCount += 1;
        if (selectCallCount === 1) return countChain;
        return dataChain;
      }),
    } as unknown as Database;

    const app = Fastify();
    decorateWithAuth(app, true);
    await skillsRoutes(app, db, makePlansConfig());
    selectCallCount = 0;

    const res = await app.inject({ method: 'GET', url: '/skills?scope=admin' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
    // Default: limit=20, offset=0 (page 1)
    expect(dataChain.limit).toHaveBeenCalledWith(20);
    expect(dataChain.offset).toHaveBeenCalledWith(0);
  });
});

describe('dependsOn in SkillView', () => {
  it('includes dependsOn derived from requiredTools on POST /skills', async () => {
    // create_bot is owned by 'bot-management', submit_decision by 'trading'
    const tools = ['create_bot', 'submit_decision'];

    const createdRow = {
      id: 'skill-deps-test',
      authorId: TEST_USER_ID,
      publicationStatus: 'published',
      priceCents: 0,
      likeCount: 0,
      forkCount: 0,
      forkOf: null,
      popularityScore: 0,
      trendingScore: 0,
      currentRevisionId: null,
      name: 'Depends On Test',
      description: 'Tests dependsOn',
      instructions: 'inst',
      requiredTools: tools,
      contextRequirements: [],
      requiredGuardrails: [],
      capabilityFamilies: [],
      suggestedTickIntervalMs: 900_000,
      tags: [],
      promptHint: null,
      promptTemplate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let selectCalls = 0;
    const db = {
      ...makeDbMock(),
      select: vi.fn().mockImplementation(() => {
        selectCalls += 1;
        // Call 1: users query for author handle
        if (selectCalls === 1) return makeChain([{ username: 'testuser' }]);
        // Call 2: fetch created row by id (POST handler)
        if (selectCalls === 2) return makeChain([createdRow]);
        // Remaining: revisions, viewer context, version queries → empty
        return makeChain([]);
      }),
      selectDistinct: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;

    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db, makePlansConfig());
    selectCalls = 0;

    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: {
        name: 'Depends On Test',
        description: 'Tests dependsOn',
        instructions: 'inst',
        requiredTools: tools,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.dependsOn).toBeDefined();
    expect(Array.isArray(body.dependsOn)).toBe(true);
    // The exact IDs depend on tool ownership; verify they match the domain function
    expect(body.dependsOn).toEqual(inferDependsOn(tools, body.id));
    // Sanity: tools owned by other skills produce non-empty dependsOn
    expect(body.dependsOn.length).toBeGreaterThan(0);
  });

  it('returns empty dependsOn when requiredTools is empty', async () => {
    const createdRow = {
      id: 'skill-no-deps',
      authorId: TEST_USER_ID,
      publicationStatus: 'published',
      priceCents: 0,
      likeCount: 0,
      forkCount: 0,
      forkOf: null,
      popularityScore: 0,
      trendingScore: 0,
      currentRevisionId: null,
      name: 'No Deps Skill',
      description: 'desc',
      instructions: 'inst',
      requiredTools: [],
      contextRequirements: [],
      requiredGuardrails: [],
      capabilityFamilies: [],
      suggestedTickIntervalMs: 900_000,
      tags: [],
      promptHint: null,
      promptTemplate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let selectCalls = 0;
    const db = {
      ...makeDbMock(),
      select: vi.fn().mockImplementation(() => {
        selectCalls += 1;
        // Call 1: users query for author handle
        if (selectCalls === 1) return makeChain([{ username: 'testuser' }]);
        // Call 2: fetch created row
        if (selectCalls === 2) return makeChain([createdRow]);
        return makeChain([]);
      }),
      selectDistinct: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;

    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db, makePlansConfig());
    selectCalls = 0;

    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: {
        name: 'No Deps Skill',
        description: 'desc',
        instructions: 'inst',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().dependsOn).toEqual([]);
  });

  it('uses revision requiredTools when a current revision exists', async () => {
    const revisionId = 'rev-1';
    const skillId = 'skill-with-rev';
    // Row has no requiredTools of interest
    const skillRow = {
      id: skillId,
      authorId: TEST_USER_ID,
      publicationStatus: 'published',
      priceCents: 0,
      likeCount: 0,
      forkCount: 0,
      forkOf: null,
      popularityScore: 0,
      trendingScore: 0,
      currentRevisionId: revisionId,
      name: 'Skill With Rev',
      description: 'desc',
      instructions: 'inst',
      requiredTools: [],
      contextRequirements: [],
      requiredGuardrails: [],
      capabilityFamilies: [],
      suggestedTickIntervalMs: 900_000,
      tags: [],
      promptHint: null,
      promptTemplate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Revision has tools that create dependencies
    const revisionRow = {
      id: revisionId,
      skillId,
      version: 1,
      name: 'Skill With Rev',
      description: 'desc',
      instructions: 'inst',
      promptHint: null,
      promptTemplate: null,
      requiredTools: ['create_bot'],
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

    // GET /skills/:id makes several select calls in sequence:
    //   1. fetch skill row (handler)
    //   2. fetch revision rows by ids (buildSkillViews)
    //   3. fetch entitlements (loadViewerContext)
    //   4. fetch likes (loadViewerContext)
    //   5. fetch latest version per skill (buildSkillViews)
    let selectCalls = 0;
    const db = {
      ...makeDbMock(),
      select: vi.fn().mockImplementation(() => {
        selectCalls += 1;
        // Call 1: skill row lookup
        if (selectCalls === 1) return makeChain([skillRow]);
        // Call 2: revision fetch
        if (selectCalls === 2) return makeChain([revisionRow]);
        // Call 3+: viewer context, latest version → empty
        return makeChain([]);
      }),
      selectDistinct: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;

    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db, makePlansConfig());
    selectCalls = 0;

    const res = await app.inject({
      method: 'GET',
      url: `/skills/${skillId}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // dependsOn should be derived from the REVISION's requiredTools, not the row's
    expect(body.dependsOn).toEqual(inferDependsOn(['create_bot'], skillId));
    expect(body.dependsOn).toContain('bot-management');
    // And NOT from the row's empty requiredTools
    expect(body.requiredTools).toEqual(['create_bot']);
  });

  it('falls back to row requiredTools when no current revision exists', async () => {
    const skillId = 'skill-no-rev';
    const skillRow = {
      id: skillId,
      authorId: TEST_USER_ID,
      publicationStatus: 'published',
      priceCents: 0,
      likeCount: 0,
      forkCount: 0,
      forkOf: null,
      popularityScore: 0,
      trendingScore: 0,
      currentRevisionId: null,
      name: 'Skill No Rev',
      description: 'desc',
      instructions: 'inst',
      requiredTools: ['submit_decision'],
      contextRequirements: [],
      requiredGuardrails: [],
      capabilityFamilies: [],
      suggestedTickIntervalMs: 900_000,
      tags: [],
      promptHint: null,
      promptTemplate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let selectCalls = 0;
    const db = {
      ...makeDbMock(),
      select: vi.fn().mockImplementation(() => {
        selectCalls += 1;
        if (selectCalls === 1) return makeChain([skillRow]);
        return makeChain([]);
      }),
      selectDistinct: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;

    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db, makePlansConfig());
    selectCalls = 0;

    const res = await app.inject({
      method: 'GET',
      url: `/skills/${skillId}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // No revision → dependsOn derived from the row's requiredTools
    expect(body.dependsOn).toEqual(inferDependsOn(['submit_decision'], skillId));
    expect(body.dependsOn).toContain('trading');
  });

  it('does not include self in dependsOn', async () => {
    // A skill that is actually 'bot-management' shouldn't list itself as a dependency
    const skillId = 'bot-management';
    const skillRow = {
      id: skillId,
      authorId: null, // system skill
      publicationStatus: 'published',
      priceCents: 0,
      likeCount: 0,
      forkCount: 0,
      forkOf: null,
      popularityScore: 0,
      trendingScore: 0,
      currentRevisionId: null,
      name: 'Bot Management',
      description: 'desc',
      instructions: 'inst',
      requiredTools: ['create_bot', 'list_bots', 'submit_decision'],
      contextRequirements: [],
      requiredGuardrails: [],
      capabilityFamilies: [],
      suggestedTickIntervalMs: 900_000,
      tags: [],
      promptHint: null,
      promptTemplate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let selectCalls = 0;
    const db = {
      ...makeDbMock(),
      select: vi.fn().mockImplementation(() => {
        selectCalls += 1;
        if (selectCalls === 1) return makeChain([skillRow]);
        return makeChain([]);
      }),
      selectDistinct: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;

    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db, makePlansConfig());
    selectCalls = 0;

    const res = await app.inject({
      method: 'GET',
      url: `/skills/${skillId}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Self-exclusion: bot-management should not appear in its own dependsOn
    expect(body.dependsOn).not.toContain('bot-management');
    // But trading tools (submit_decision) should still create a dependency
    expect(body.dependsOn).toContain('trading');
  });
});


// ── sourceKind filter ────────────────────────────────────────────────────
describe('GET /skills sourceKind filter', () => {
  function makeSkillRow(overrides: Partial<{
    id: string;
    slug: string;
    authorId: string | null;
    publicationStatus: string;
    priceCents: number;
    likeCount: number;
    forkCount: number;
    forkOf: string | null;
    popularityScore: number;
    trendingScore: number;
    currentRevisionId: string | null;
    name: string;
    description: string;
    instructions: string;
    promptHint: string | null;
    promptTemplate: string | null;
    requiredTools: string[];
    contextRequirements: string[];
    requiredGuardrails: string[];
    capabilityFamilies: string[];
    suggestedTickIntervalMs: number;
    tags: string[];
    createdAt: Date;
    updatedAt: Date;
  }> = {}) {
    return {
      id: overrides.id ?? 'skill-default',
      slug: overrides.slug ?? 'default/skill',
      authorId: overrides.authorId ?? null,
      publicationStatus: overrides.publicationStatus ?? 'published',
      priceCents: overrides.priceCents ?? 0,
      likeCount: overrides.likeCount ?? 0,
      forkCount: overrides.forkCount ?? 0,
      forkOf: overrides.forkOf ?? null,
      popularityScore: overrides.popularityScore ?? 0,
      trendingScore: overrides.trendingScore ?? 0,
      currentRevisionId: overrides.currentRevisionId ?? null,
      name: overrides.name ?? 'Default Skill',
      description: overrides.description ?? 'desc',
      instructions: overrides.instructions ?? 'inst',
      promptHint: overrides.promptHint ?? null,
      promptTemplate: overrides.promptTemplate ?? null,
      requiredTools: overrides.requiredTools ?? [],
      contextRequirements: overrides.contextRequirements ?? [],
      requiredGuardrails: overrides.requiredGuardrails ?? [],
      capabilityFamilies: overrides.capabilityFamilies ?? [],
      suggestedTickIntervalMs: overrides.suggestedTickIntervalMs ?? 900_000,
      tags: overrides.tags ?? [],
      createdAt: overrides.createdAt ?? new Date(),
      updatedAt: overrides.updatedAt ?? new Date(),
    };
  }
  function makeExternalProviderMock(overrides: {
    searchResult?: { results: Array<{ ref: string; skillId: string; name: string; description: string; owner: string; repo: string; installs: number; tags?: string[] }>; totalCount: number; page: number; pageSize: number };
    browseResult?: { results: Array<{ ref: string; skillId: string; name: string; description: string; owner: string; repo: string; installs: number; tags?: string[] }>; totalCount: number; page: number; pageSize: number };
    statsResult?: { totalSkills: number; totalSources: number; totalOwners: number } | null;
    searchError?: Error;
    browseError?: Error;
  } = {}) {
    return {
      search: overrides.searchError
        ? vi.fn().mockRejectedValue(overrides.searchError)
        : vi.fn().mockResolvedValue(overrides.searchResult ?? { results: [], totalCount: 0, page: 1, pageSize: 20 }),
      browse: overrides.browseError
        ? vi.fn().mockRejectedValue(overrides.browseError)
        : vi.fn().mockResolvedValue(overrides.browseResult ?? { results: [], totalCount: 0, page: 1, pageSize: 20 }),
      getStats: vi.fn().mockResolvedValue(overrides.statsResult ?? null),
    };
  }

  // ── sourceKind=system ──────────────────────────────────────────────────
  describe('sourceKind=system', () => {
    it('returns only system skills (authorId IS NULL) and skips external fetch', async () => {
      const systemSkill = makeSkillRow({
        id: 'sys-1',
        slug: 'system/trading',
        authorId: null,
        name: 'Trading',
        description: 'System trading skill',
        instructions: 'trade',
      });

      // scope=selectable issues:
      //   select call 1: entitlement rows
      //   selectDistinct call: assignment rows (separate mock)
      //   select call 2: count query
      //   select call 3: data rows query
      //   select calls 4+: buildSkillViews viewer context
      let selectCalls = 0;
      const db = {
        ...makeDbMock(),
        select: vi.fn().mockImplementation(() => {
          selectCalls += 1;
          // Call 1: entitlement rows for selectable scope
          if (selectCalls === 1) return makeChain([]);
          // Call 2: count query
          if (selectCalls === 2) return makeChain([{ total: 1 }]);
          // Call 3: data rows
          if (selectCalls === 3) return makeChain([systemSkill]);
          // Remaining: buildSkillViews internals
          return makeChain([]);
        }),
      } as unknown as Database;

      const externalProvider = makeExternalProviderMock({
        browseResult: { results: [{ ref: 'ext/repo/s1', skillId: 's1', name: 'Ext', description: 'ext', owner: 'ext', repo: 'repo', installs: 10 }], totalCount: 1, page: 1, pageSize: 20 },
      });

      const app = Fastify();
      decorateWithAuth(app);
      await skillsRoutes(app, db, makePlansConfig(), externalProvider);
      selectCalls = 0;

      const res = await app.inject({ method: 'GET', url: '/skills?scope=selectable&sourceKind=system' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalCount).toBe(1);
      // External provider should not have been called
      expect(externalProvider.browse).not.toHaveBeenCalled();
      expect(externalProvider.search).not.toHaveBeenCalled();
      // All returned skills should be system skills
      for (const skill of body.skills) {
        expect(skill.sourceKind).toBe('system');
      }
    });

    it('reflects only local totalCount when sourceKind=system', async () => {
      // scope=selectable: select call 1 = entitlements, call 2 = count, call 3 = data
      let selectCalls = 0;
      const db = {
        ...makeDbMock(),
        select: vi.fn().mockImplementation(() => {
          selectCalls += 1;
          // Call 1: entitlement rows
          if (selectCalls === 1) return makeChain([]);
          // Call 2: count query
          if (selectCalls === 2) return makeChain([{ total: 3 }]);
          // Call 3+: data rows and buildSkillViews
          return makeChain([]);
        }),
      } as unknown as Database;

      const externalProvider = makeExternalProviderMock({
        statsResult: { totalSkills: 50, totalSources: 5, totalOwners: 10 },
      });

      const app = Fastify();
      decorateWithAuth(app);
      await skillsRoutes(app, db, makePlansConfig(), externalProvider);
      selectCalls = 0;

      const res = await app.inject({ method: 'GET', url: '/skills?scope=selectable&sourceKind=system' });

      expect(res.statusCode).toBe(200);
      // totalCount should be from local DB only, not merged with external
      expect(res.json().totalCount).toBe(3);
      expect(externalProvider.getStats).not.toHaveBeenCalled();
    });
  });

  // ── sourceKind=user ────────────────────────────────────────────────────
  describe('sourceKind=user', () => {
    it('returns only user-authored skills (authorId IS NOT NULL) and skips external fetch', async () => {
      const userSkill = makeSkillRow({
        id: 'usr-1',
        slug: 'testuser/my-skill',
        authorId: TEST_USER_ID,
        name: 'My Skill',
        description: 'A user skill',
        instructions: 'do stuff',
      });

      // scope=selectable issues:
      //   select call 1: entitlement rows
      //   selectDistinct: assignment rows (separate mock)
      //   select call 2: count query
      //   select call 3: data rows query
      //   select calls 4+: buildSkillViews viewer context
      let selectCalls = 0;
      const db = {
        ...makeDbMock(),
        select: vi.fn().mockImplementation(() => {
          selectCalls += 1;
          // Call 1: entitlement rows for selectable scope
          if (selectCalls === 1) return makeChain([]);
          // Call 2: count query
          if (selectCalls === 2) return makeChain([{ total: 1 }]);
          // Call 3: data rows
          if (selectCalls === 3) return makeChain([userSkill]);
          // Remaining: buildSkillViews internals
          return makeChain([]);
        }),
      } as unknown as Database;

      const externalProvider = makeExternalProviderMock({
        browseResult: { results: [{ ref: 'ext/repo/s1', skillId: 's1', name: 'Ext', description: 'ext', owner: 'ext', repo: 'repo', installs: 10 }], totalCount: 1, page: 1, pageSize: 20 },
      });

      const app = Fastify();
      decorateWithAuth(app);
      await skillsRoutes(app, db, makePlansConfig(), externalProvider);
      selectCalls = 0;

      const res = await app.inject({ method: 'GET', url: '/skills?scope=selectable&sourceKind=user' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalCount).toBe(1);
      expect(body.skills).toHaveLength(1);
      // External provider should not have been called
      expect(externalProvider.browse).not.toHaveBeenCalled();
      expect(externalProvider.search).not.toHaveBeenCalled();
      // All returned skills should be user-authored
      for (const skill of body.skills) {
        expect(skill.sourceKind).toBe('user');
      }
    });
  });

  // ── sourceKind=external ────────────────────────────────────────────────
  describe('sourceKind=external', () => {
    it('returns empty results with totalCount 0 when no provider is configured', async () => {
      const app = Fastify();
      decorateWithAuth(app);
      // No externalSkillProvider passed (undefined)
      await skillsRoutes(app, makeDbMock(), makePlansConfig());

      const res = await app.inject({ method: 'GET', url: '/skills?sourceKind=external' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.skills).toEqual([]);
      expect(body.totalCount).toBe(0);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(20);
    });

    it('returns empty results with totalCount 0 when provider is null', async () => {
      const app = Fastify();
      decorateWithAuth(app);
      await skillsRoutes(app, makeDbMock(), makePlansConfig(), null);

      const res = await app.inject({ method: 'GET', url: '/skills?sourceKind=external' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.skills).toEqual([]);
      expect(body.totalCount).toBe(0);
    });

    it('returns external-only results from the provider', async () => {
      const extSkill = {
        ref: 'acme/tools/crypto-trader',
        skillId: 'crypto-trader',
        name: 'Crypto Trader',
        description: 'External crypto skill',
        owner: 'acme',
        repo: 'tools',
        installs: 42,
        tags: ['crypto', 'trading'],
      };
      const externalProvider = makeExternalProviderMock({
        browseResult: { results: [extSkill], totalCount: 1, page: 1, pageSize: 20 },
      });

      const app = Fastify();
      decorateWithAuth(app);
      // Pass a DB mock — it should NOT be queried for skills data
      const db = makeDbMock();
      await skillsRoutes(app, db, makePlansConfig(), externalProvider);

      const res = await app.inject({ method: 'GET', url: '/skills?sourceKind=external' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalCount).toBe(1);
      expect(body.skills).toHaveLength(1);
      expect(body.skills[0].sourceKind).toBe('external');
      expect(body.skills[0].id).toBe('ext:acme/tools/crypto-trader');
      expect(body.skills[0].name).toBe('Crypto Trader');
      expect(body.skills[0].tags).toEqual(['crypto', 'trading']);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(20);
      // Local DB select should NOT have been invoked for listing data
      expect(db.select).not.toHaveBeenCalled();
    });

    it('uses search instead of browse when q parameter is provided', async () => {
      const externalProvider = makeExternalProviderMock({
        searchResult: { results: [], totalCount: 0, page: 1, pageSize: 20 },
      });

      const app = Fastify();
      decorateWithAuth(app);
      await skillsRoutes(app, makeDbMock(), makePlansConfig(), externalProvider);

      await app.inject({ method: 'GET', url: '/skills?sourceKind=external&q=crypto' });

      expect(externalProvider.search).toHaveBeenCalledWith('crypto', { page: 1, pageSize: 20 });
      expect(externalProvider.browse).not.toHaveBeenCalled();
    });

    it('returns empty results with degradation field when provider throws', async () => {
      const externalProvider = makeExternalProviderMock({
        browseError: new Error('Connection refused'),
      });

      const app = Fastify();
      decorateWithAuth(app);
      await skillsRoutes(app, makeDbMock(), makePlansConfig(), externalProvider);

      const res = await app.inject({ method: 'GET', url: '/skills?sourceKind=external' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.skills).toEqual([]);
      expect(body.totalCount).toBe(0);
      expect(body.degradation).toBeDefined();
      expect(body.degradation.external).toBe('unavailable');
      expect(body.degradation.reason).toBe('Connection refused');
    });

    it('passes page and pageSize to the external provider', async () => {
      const externalProvider = makeExternalProviderMock();

      const app = Fastify();
      decorateWithAuth(app);
      await skillsRoutes(app, makeDbMock(), makePlansConfig(), externalProvider);

      await app.inject({ method: 'GET', url: '/skills?sourceKind=external&page=3&pageSize=10' });

      expect(externalProvider.browse).toHaveBeenCalledWith({ page: 3, pageSize: 10 });
    });

    it('flags degradation when external provider returns empty results successfully', async () => {
      const externalProvider = makeExternalProviderMock({
        browseResult: { results: [], totalCount: 0, page: 1, pageSize: 20 },
      });

      const app = Fastify();
      decorateWithAuth(app);
      await skillsRoutes(app, makeDbMock(), makePlansConfig(), externalProvider);

      const res = await app.inject({ method: 'GET', url: '/skills?sourceKind=external' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.skills).toEqual([]);
      expect(body.totalCount).toBe(0);
      expect(body.degradation).toBeDefined();
      expect(body.degradation.external).toBe('unavailable');
      expect(body.degradation.reason).toBe('external catalog returned empty');
    });

    it('returns degradation when search throws with sourceKind=external and q parameter', async () => {
      const externalProvider = makeExternalProviderMock({
        searchError: new Error('Search service timeout'),
      });

      const app = Fastify();
      decorateWithAuth(app);
      await skillsRoutes(app, makeDbMock(), makePlansConfig(), externalProvider);

      const res = await app.inject({ method: 'GET', url: '/skills?sourceKind=external&q=crypto' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.skills).toEqual([]);
      expect(body.totalCount).toBe(0);
      expect(body.degradation).toBeDefined();
      expect(body.degradation.external).toBe('unavailable');
      expect(body.degradation.reason).toBe('Search service timeout');
    });
  });

  // ── sourceKind combined with scope ─────────────────────────────────────
  describe('sourceKind combined with scope', () => {
    it('scope=selectable&sourceKind=system returns only system skills (Built-in tab use case)', async () => {
      const systemSkill = makeSkillRow({
        id: 'sys-builtin',
        slug: 'system/builtin',
        authorId: null,
        name: 'Built-in Skill',
        description: 'System builtin',
        instructions: 'builtin',
      });

      // scope=selectable: call 1 = entitlements, call 2 = count, call 3 = data
      let selectCalls = 0;
      const db = {
        ...makeDbMock(),
        select: vi.fn().mockImplementation(() => {
          selectCalls += 1;
          // Call 1: entitlement rows for selectable scope
          if (selectCalls === 1) return makeChain([]);
          // Call 2: count query
          if (selectCalls === 2) return makeChain([{ total: 1 }]);
          // Call 3: data rows
          if (selectCalls === 3) return makeChain([systemSkill]);
          // Remaining: buildSkillViews internals
          return makeChain([]);
        }),
      } as unknown as Database;

      const externalProvider = makeExternalProviderMock({
        browseResult: { results: [{ ref: 'ext/repo/s1', skillId: 's1', name: 'Ext', description: 'ext', owner: 'ext', repo: 'repo', installs: 5 }], totalCount: 1, page: 1, pageSize: 20 },
      });

      const app = Fastify();
      decorateWithAuth(app);
      await skillsRoutes(app, db, makePlansConfig(), externalProvider);
      selectCalls = 0;

      const res = await app.inject({ method: 'GET', url: '/skills?scope=selectable&sourceKind=system' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      // No external skills should be mixed in
      expect(externalProvider.browse).not.toHaveBeenCalled();
      for (const skill of body.skills) {
        expect(skill.sourceKind).toBe('system');
      }
    });

    it('scope=admin&sourceKind=system works for admin users', async () => {
      let selectCalls = 0;
      const db = {
        ...makeDbMock(),
        select: vi.fn().mockImplementation(() => {
          selectCalls += 1;
          if (selectCalls === 1) return makeChain([{ total: 0 }]);
          return makeChain([]);
        }),
      } as unknown as Database;

      const app = Fastify();
      decorateWithAuth(app, true);
      await skillsRoutes(app, db, makePlansConfig());
      selectCalls = 0;

      const res = await app.inject({ method: 'GET', url: '/skills?scope=admin&sourceKind=system' });

      expect(res.statusCode).toBe(200);
      expect(res.json().totalCount).toBe(0);
      expect(res.json().skills).toEqual([]);
    });

    it('scope=mine&sourceKind=user returns only the current user\'s skills', async () => {
      let selectCalls = 0;
      const db = {
        ...makeDbMock(),
        select: vi.fn().mockImplementation(() => {
          selectCalls += 1;
          if (selectCalls === 1) return makeChain([{ total: 0 }]);
          return makeChain([]);
        }),
      } as unknown as Database;

      const externalProvider = makeExternalProviderMock();

      const app = Fastify();
      decorateWithAuth(app);
      await skillsRoutes(app, db, makePlansConfig(), externalProvider);
      selectCalls = 0;

      const res = await app.inject({ method: 'GET', url: '/skills?scope=mine&sourceKind=user' });

      expect(res.statusCode).toBe(200);
      expect(res.json().skills).toEqual([]);
      // External should not be fetched for scope=mine
      expect(externalProvider.browse).not.toHaveBeenCalled();
    });
  });

  // ── Default behavior (no sourceKind) ───────────────────────────────────
  describe('default behavior without sourceKind', () => {
    it('merges external skills for selectable scope when no sourceKind is specified', async () => {
      let selectCalls = 0;
      const countChain = makeChain([{ total: 0 }]);
      const dataChain = makeChain([]);
      const db = {
        ...makeDbMock(),
        select: vi.fn().mockImplementation(() => {
          selectCalls += 1;
          if (selectCalls === 1) return countChain;
          if (selectCalls === 2) return dataChain;
          return makeChain([]);
        }),
      } as unknown as Database;

      const extSkill = {
        ref: 'acme/tools/helper',
        skillId: 'helper',
        name: 'Helper',
        description: 'External helper',
        owner: 'acme',
        repo: 'tools',
        installs: 5,
      };
      const externalProvider = makeExternalProviderMock({
        browseResult: { results: [extSkill], totalCount: 1, page: 1, pageSize: 20 },
      });

      const app = Fastify();
      decorateWithAuth(app);
      await skillsRoutes(app, db, makePlansConfig(), externalProvider);
      selectCalls = 0;

      const res = await app.inject({ method: 'GET', url: '/skills?scope=selectable' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      // External provider should have been called to merge results
      expect(externalProvider.browse).toHaveBeenCalled();
      // The totalCount should include external results
      expect(body.totalCount).toBe(1);
      expect(body.skills).toHaveLength(1);
      expect(body.skills[0].sourceKind).toBe('external');
    });

    it('merges external skills for marketplace scope when no sourceKind is specified', async () => {
      let selectCalls = 0;
      const db = {
        ...makeDbMock(),
        select: vi.fn().mockImplementation(() => {
          selectCalls += 1;
          if (selectCalls === 1) return makeChain([{ total: 0 }]);
          return makeChain([]);
        }),
      } as unknown as Database;

      const externalProvider = makeExternalProviderMock({
        browseResult: { results: [{ ref: 'o/r/s', skillId: 's', name: 'S', description: 'd', owner: 'o', repo: 'r', installs: 1 }], totalCount: 1, page: 1, pageSize: 20 },
      });

      const app = Fastify();
      decorateWithAuth(app);
      await skillsRoutes(app, db, makePlansConfig(), externalProvider);
      selectCalls = 0;

      const res = await app.inject({ method: 'GET', url: '/skills?scope=marketplace' });

      expect(res.statusCode).toBe(200);
      // External should be merged for marketplace scope without sourceKind
      expect(externalProvider.browse).toHaveBeenCalled();
    });

    it('does not merge external skills for admin scope even without sourceKind', async () => {
      let selectCalls = 0;
      const db = {
        ...makeDbMock(),
        select: vi.fn().mockImplementation(() => {
          selectCalls += 1;
          if (selectCalls === 1) return makeChain([{ total: 0 }]);
          return makeChain([]);
        }),
      } as unknown as Database;

      const externalProvider = makeExternalProviderMock();

      const app = Fastify();
      decorateWithAuth(app, true);
      await skillsRoutes(app, db, makePlansConfig(), externalProvider);
      selectCalls = 0;

      const res = await app.inject({ method: 'GET', url: '/skills?scope=admin' });

      expect(res.statusCode).toBe(200);
      expect(externalProvider.browse).not.toHaveBeenCalled();
      expect(externalProvider.search).not.toHaveBeenCalled();
    });

    it('does not merge external skills for mine scope even without sourceKind', async () => {
      let selectCalls = 0;
      const db = {
        ...makeDbMock(),
        select: vi.fn().mockImplementation(() => {
          selectCalls += 1;
          if (selectCalls === 1) return makeChain([{ total: 0 }]);
          return makeChain([]);
        }),
      } as unknown as Database;

      const externalProvider = makeExternalProviderMock();

      const app = Fastify();
      decorateWithAuth(app);
      await skillsRoutes(app, db, makePlansConfig(), externalProvider);
      selectCalls = 0;

      const res = await app.inject({ method: 'GET', url: '/skills?scope=mine' });

      expect(res.statusCode).toBe(200);
      expect(externalProvider.browse).not.toHaveBeenCalled();
      expect(externalProvider.search).not.toHaveBeenCalled();
    });
  });

  // ── Validation ─────────────────────────────────────────────────────────
  describe('sourceKind validation', () => {
    it('rejects invalid sourceKind values with 400', async () => {
      const app = Fastify();
      decorateWithAuth(app);
      await skillsRoutes(app, makeDbMock(), makePlansConfig());

      const res = await app.inject({ method: 'GET', url: '/skills?sourceKind=invalid' });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('validation_error');
    });
  });
});
