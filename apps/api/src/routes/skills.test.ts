import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { Database } from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
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
  for (const method of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'groupBy', '$dynamic']) {
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
          topUpsEnabled: false,
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
        return makeChain(selectCalls === 1 ? [createdRow] : []);
      }),
      selectDistinct: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;

    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db, makePlansConfig());

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
