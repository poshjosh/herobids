import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { adminRoutes } from './admin.js';
import type { Database } from '@herobids/db';

const ADMIN_USER_ID = 'admin-user';
const REGULAR_USER_ID = 'regular-user';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId: string, isAdmin = false) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.decorateRequest('isAdmin', false);
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = 'free';
    request.isAdmin = isAdmin;
  });
}

const mockRedis = {
  ping: vi.fn().mockResolvedValue('PONG'),
  get: vi.fn().mockResolvedValue(null),
  hgetall: vi.fn().mockResolvedValue({}),
};

function makeThenable<T>(value: T): Promise<T> & { then: Promise<T>['then'] } {
  const promise = Promise.resolve(value);
  return promise as Promise<T> & { then: Promise<T>['then'] };
}

function buildDb(options: { selectSequence?: unknown[][]; updateSequence?: unknown[][] } | unknown[][] = {}): Database {
  const normalized = Array.isArray(options) ? { selectSequence: options, updateSequence: [] } : options;
  const { selectSequence = [], updateSequence = [] } = normalized;
  let i = 0;
  let j = 0;
  const makeChain = (value: unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit', 'offset', 'innerJoin', 'leftJoin', 'groupBy']) {
      self[m] = vi.fn(() => self);
    }
    (self as { then: unknown }).then = (
      resolve: (v: unknown) => unknown,
      reject?: (v: unknown) => unknown,
    ) => Promise.resolve(value).then(resolve, reject);
    return self;
  };

  const makeUpdateChain = (value: unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const m of ['set', 'where']) {
      self[m] = vi.fn(() => self);
    }
    self.returning = vi.fn(() => makeThenable(value));
    return self;
  };

  return {
    select: vi.fn().mockImplementation(() => {
      const val = selectSequence[i++] ?? [];
      return makeChain(val as unknown[]);
    }),
    update: vi.fn().mockImplementation(() => {
      const val = updateSequence[j++] ?? [];
      return makeUpdateChain(val as unknown[]);
    }),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as Database;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── /admin/stats ─────────────────────────────────────────────────────────────

describe('GET /admin/stats', () => {
  it('returns 403 for non-admin users', async () => {
    const db = buildDb([]);
    const app = Fastify();
    decorateWithAuth(app, REGULAR_USER_ID);
    await adminRoutes(app, db, mockRedis);

    const res = await app.inject({ method: 'GET', url: '/admin/stats' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('returns system stats for admin users', async () => {
    // select for users count, bots count, agents count
    const db = buildDb([[{ n: 5 }], [{ n: 10 }], [{ n: 2 }]]);
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID, true);
    await adminRoutes(app, db, mockRedis);

    const res = await app.inject({ method: 'GET', url: '/admin/stats' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['postgres']).toBe('ok');
    expect(body['redis']).toBe('ok');
    expect(body['memory']).toBeDefined();
    expect(body['counts']).toMatchObject({ users: 5, bots: 10, agents: 2 });
    expect(body['version']).toBeDefined();
  });

  it('reports redis as error when ping fails', async () => {
    const failingRedis = { ping: vi.fn().mockRejectedValue(new Error('connection refused')), get: vi.fn().mockResolvedValue(null), hgetall: vi.fn().mockResolvedValue({}) };
    const db = buildDb([[{ n: 0 }], [{ n: 0 }], [{ n: 0 }]]);
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID, true);
    await adminRoutes(app, db, failingRedis);

    const res = await app.inject({ method: 'GET', url: '/admin/stats' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['redis']).toBe('error');
  });
});

// ─── /admin/users ─────────────────────────────────────────────────────────────

describe('GET /admin/users', () => {
  it('returns 403 for non-admin users', async () => {
    const db = buildDb([]);
    const app = Fastify();
    decorateWithAuth(app, REGULAR_USER_ID);
    await adminRoutes(app, db, mockRedis);

    const res = await app.inject({ method: 'GET', url: '/admin/users' });
    expect(res.statusCode).toBe(403);
  });

  it('returns user list for admin', async () => {
    const db = buildDb([
      [
        { id: 'u-1', email: 'a@example.com', displayName: 'Alice', planId: 'free', createdAt: new Date(), botCount: 2, agentCount: 1 },
      ],
      [{ total: 1 }],
    ]);
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID, true);
    await adminRoutes(app, db, mockRedis);

    const res = await app.inject({ method: 'GET', url: '/admin/users' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ users: unknown[]; total: number; limit: number; offset: number }>();
    expect(body.users).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(0);
  });
});

// ─── /admin/containers ────────────────────────────────────────────────────────

describe('GET /admin/containers', () => {
  it('returns 403 for non-admin users', async () => {
    const db = buildDb([]);
    const app = Fastify();
    decorateWithAuth(app, REGULAR_USER_ID);
    await adminRoutes(app, db, mockRedis);

    const res = await app.inject({ method: 'GET', url: '/admin/containers' });
    expect(res.statusCode).toBe(403);
  });

  it('returns docker_unavailable when Docker socket is inaccessible', async () => {
    // In CI / local dev, Docker socket is unavailable — expect graceful degradation.
    const db = buildDb([[]]); // sessions query response
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID, true);
    await adminRoutes(app, db, mockRedis);

    const res = await app.inject({ method: 'GET', url: '/admin/containers' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    // Either docker_unavailable (no socket) or containers array if Docker is running
    const hasDockErr = body['error'] === 'docker_unavailable';
    const hasContainers = Array.isArray(body['containers']);
    expect(hasDockErr || hasContainers).toBe(true);
  });
});

describe('admin user mutations', () => {
  it('promotes an existing user to admin', async () => {
    const db = buildDb({ updateSequence: [[{ id: 'u-2', email: 'user@example.com', isAdmin: true }]] });
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID, true);
    await adminRoutes(app, db, mockRedis);

    const res = await app.inject({ method: 'POST', url: '/admin/users/u-2/promote' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { id: 'u-2', email: 'user@example.com', isAdmin: true } });
  });

  it('returns 404 when promoting a missing user', async () => {
    const db = buildDb({ updateSequence: [[]] });
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID, true);
    await adminRoutes(app, db, mockRedis);

    const res = await app.inject({ method: 'POST', url: '/admin/users/missing/promote' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });

  it('revokes admin for another user', async () => {
    const db = buildDb({ updateSequence: [[{ id: 'u-2', email: 'user@example.com', isAdmin: false }]] });
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID, true);
    await adminRoutes(app, db, mockRedis);

    const res = await app.inject({ method: 'DELETE', url: '/admin/users/u-2/admin' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { id: 'u-2', email: 'user@example.com', isAdmin: false } });
  });

  it('rejects self-demotion', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID, true);
    await adminRoutes(app, db, mockRedis);

    const res = await app.inject({ method: 'DELETE', url: '/admin/users/admin-user/admin' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
  });
});

// ─── /admin/billing/webhooks ──────────────────────────────────────────────────

describe('GET /admin/billing/webhooks', () => {
  it('returns 403 for non-admin users', async () => {
    const db = buildDb([]);
    const app = Fastify();
    decorateWithAuth(app, REGULAR_USER_ID);
    await adminRoutes(app, db, mockRedis);

    const res = await app.inject({ method: 'GET', url: '/admin/billing/webhooks' });
    expect(res.statusCode).toBe(403);
  });

  it('returns failed webhook list for admin', async () => {
    const db = buildDb([
      [
        {
          id: 'evt_abc',
          eventType: 'customer.subscription.updated',
          status: 'failed',
          error: 'Stripe signature mismatch',
          processedAt: new Date('2026-06-01T12:00:00Z'),
        },
      ],
      [{ total: 1 }],
    ]);
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID, true);
    await adminRoutes(app, db, mockRedis);

    const res = await app.inject({ method: 'GET', url: '/admin/billing/webhooks' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ webhooks: unknown[]; total: number; limit: number; offset: number }>();
    expect(body.webhooks).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(0);
  });
});

// ─── /admin/market-data/overview ─────────────────────────────────────────────

describe('GET /admin/market-data/overview', () => {
  it('returns 403 for non-admin users', async () => {
    const db = buildDb([]);
    const app = Fastify();
    decorateWithAuth(app, REGULAR_USER_ID);
    await adminRoutes(app, db, mockRedis);

    const res = await app.inject({ method: 'GET', url: '/admin/market-data/overview' });
    expect(res.statusCode).toBe(403);
  });

  it('returns null discovery and empty regimes when Redis has no data', async () => {
    const db = buildDb([]);
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID, true);
    await adminRoutes(app, db, mockRedis);

    const res = await app.inject({ method: 'GET', url: '/admin/market-data/overview' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['discovery']).toBeNull();
    expect(body['lastError']).toBeNull();
    expect(body['regimeSnapshots']).toBeDefined();
  });

  it('returns discovery meta and regime snapshots when Redis has data', async () => {
    const discoveryMeta = {
      snapshotId: 'snap-1',
      capturedAt: new Date().toISOString(),
      nextPollDueAt: new Date().toISOString(),
      tokenCount: 10,
      networks: ['solana'],
      pollIntervalMs: 30000,
      sourceStats: {},
    };
    const regimeSnapshot = {
      benchmarkSymbol: 'BTC',
      evaluatedAt: new Date().toISOString(),
      freshness: { state: 'fresh', ageMs: 0 },
      pass: true,
      reasons: [],
    };
    const coordinatorConfig = { benchmarkSymbols: ['BTC'], networks: ['solana'] };
    const customRedis = {
      ping: vi.fn().mockResolvedValue('PONG'),
      get: vi.fn().mockImplementation((key: string) => {
        if (key === 'market-intel:discovery:meta') return Promise.resolve(JSON.stringify(discoveryMeta));
        if (key === 'market-intel:regime:BTC') return Promise.resolve(JSON.stringify(regimeSnapshot));
        if (key === 'market-intel:coordinator-config') return Promise.resolve(JSON.stringify(coordinatorConfig));
        return Promise.resolve(null);
      }),
      hgetall: vi.fn().mockResolvedValue({}),
    };

    const db = buildDb([]);
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID, true);
    await adminRoutes(app, db, customRedis);

    const res = await app.inject({ method: 'GET', url: '/admin/market-data/overview' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['discovery']).toMatchObject({ snapshotId: 'snap-1' });
    expect((body['regimeSnapshots'] as Record<string, unknown>)['BTC']).toMatchObject({ pass: true });
  });
});

// ─── /admin/market-data/providers ────────────────────────────────────────────

describe('GET /admin/market-data/providers', () => {
  it('returns 403 for non-admin users', async () => {
    const db = buildDb([]);
    const app = Fastify();
    decorateWithAuth(app, REGULAR_USER_ID);
    await adminRoutes(app, db, mockRedis);

    const res = await app.inject({ method: 'GET', url: '/admin/market-data/providers' });
    expect(res.statusCode).toBe(403);
  });

  it('returns provider list with default config when no marketDataConfig provided', async () => {
    const db = buildDb([]);
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID, true);
    await adminRoutes(app, db, mockRedis);

    const res = await app.inject({ method: 'GET', url: '/admin/market-data/providers' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ providers: Array<{ name: string }> }>();
    expect(body.providers.length).toBeGreaterThan(0);
    expect(body.providers.some((p) => p.name === 'dexscreener')).toBe(true);
    expect(body.providers.some((p) => p.name === 'binance')).toBe(true);
  });

  it('reads per-class counters from the Redis hash representation', async () => {
    const db = buildDb([]);
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID, true);
    const redisWithCounters = {
      ping: vi.fn().mockResolvedValue('PONG'),
      get: vi.fn().mockResolvedValue(null),
      hgetall: vi.fn().mockResolvedValue({
        'binance:regime:success': '3',
        'binance:regime:freshnessModeCached': '2',
        'binance:regime:lastSuccessAt': '2026-06-13T12:00:00.000Z',
      }),
    };
    await adminRoutes(app, db, redisWithCounters);

    const res = await app.inject({ method: 'GET', url: '/admin/market-data/providers' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ providers: Array<{ name: string; requestClasses: Array<{ requestClass: string; counters: Record<string, unknown> }> }> }>();
    const binance = body.providers.find((provider) => provider.name === 'binance');
    expect(binance?.requestClasses[0]?.requestClass).toBe('regime');
    expect(binance?.requestClasses[0]?.counters).toMatchObject({
      success: 3,
      freshnessModeCached: 2,
      lastSuccessAt: '2026-06-13T12:00:00.000Z',
    });
  });

  it('falls back to the legacy JSON counter payload when the v2 hash is empty', async () => {
    const db = buildDb([]);
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID, true);
    const legacyCounters = {
      'binance:regime': {
        success: 4,
        rateLimitThrottleCount: 1,
      },
    };
    const redisWithLegacyCounters = {
      ping: vi.fn().mockResolvedValue('PONG'),
      get: vi.fn().mockResolvedValue(JSON.stringify(legacyCounters)),
      hgetall: vi.fn().mockResolvedValue({}),
    };
    await adminRoutes(app, db, redisWithLegacyCounters);

    const res = await app.inject({ method: 'GET', url: '/admin/market-data/providers' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ providers: Array<{ name: string; requestClasses: Array<{ requestClass: string; counters: Record<string, unknown> }> }> }>();
    const binance = body.providers.find((provider) => provider.name === 'binance');
    expect(binance?.requestClasses[0]?.counters).toMatchObject({
      success: 4,
      rateLimitThrottleCount: 1,
    });
  });
});

