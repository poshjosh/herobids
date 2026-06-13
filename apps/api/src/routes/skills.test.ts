import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { Database } from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import { skillsRoutes } from './skills.js';

const TEST_USER_ID = 'user-1';

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
  const values = vi.fn().mockImplementation(() => ({ onConflictDoUpdate, onConflictDoNothing }));
  return vi.fn().mockReturnValue({ values });
}

function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy', 'limit', 'innerJoin']) {
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
        maxPortfolios: 3,
        maxVenueAccounts: 5,
        maxCredentials: 5,
        maxTradingInstances: 5,
        maxConcurrentBacktests: 3,
        maxAgents: 5,
        liveEnabled: false,
        skills: {
          autoPublishCreatedSkills: true,
          canKeepSkillsPrivate: false,
          canChargeForSkills: false,
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
});

describe('skillsRoutes (normalized contract)', () => {
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
});
