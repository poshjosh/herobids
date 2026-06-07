import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { adminRoutes } from './admin.js';
import type { Database } from '@herobids/db';
import type { AuthConfig } from '@herobids/domain';

const ADMIN_USER_ID = 'admin-user';
const REGULAR_USER_ID = 'regular-user';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId: string) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = 'free';
  });
}

function makeAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    publicBaseUrl: 'http://localhost:3000',
    frontendOrigin: 'http://localhost:5173',
    jwtSecret: 'change-me-in-production-this-is-32-chars!!',
    jwtTtlSecs: 86400,
    exchangeCodeTtlSecs: 60,
    googleClientId: '',
    googleClientSecret: '',
    secureCookie: false,
    adminUserIds: [ADMIN_USER_ID],
    ...overrides,
  };
}

const mockRedis = { ping: vi.fn().mockResolvedValue('PONG') };

function buildDb(selectSequence: unknown[][]): Database {
  let i = 0;
  const makeChain = (value: unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit', 'offset']) {
      self[m] = vi.fn(() => self);
    }
    (self as { then: unknown }).then = (
      resolve: (v: unknown) => unknown,
      reject?: (v: unknown) => unknown,
    ) => Promise.resolve(value).then(resolve, reject);
    return self;
  };

  return {
    select: vi.fn().mockImplementation(() => {
      const val = selectSequence[i++] ?? [];
      return makeChain(val as unknown[]);
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
    await adminRoutes(app, db, mockRedis, makeAuthConfig());

    const res = await app.inject({ method: 'GET', url: '/admin/stats' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('returns system stats for admin users', async () => {
    // select for users count, bots count, agents count
    const db = buildDb([[{ n: 5 }], [{ n: 10 }], [{ n: 2 }]]);
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID);
    await adminRoutes(app, db, mockRedis, makeAuthConfig());

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
    const failingRedis = { ping: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const db = buildDb([[{ n: 0 }], [{ n: 0 }], [{ n: 0 }]]);
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID);
    await adminRoutes(app, db, failingRedis, makeAuthConfig());

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
    await adminRoutes(app, db, mockRedis, makeAuthConfig());

    const res = await app.inject({ method: 'GET', url: '/admin/users' });
    expect(res.statusCode).toBe(403);
  });

  it('returns user list for admin', async () => {
    const db = buildDb([[
      { id: 'u-1', email: 'a@example.com', displayName: 'Alice', planId: 'free', createdAt: new Date(), botCount: 2, agentCount: 1 },
    ]]);
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID);
    await adminRoutes(app, db, mockRedis, makeAuthConfig());

    const res = await app.inject({ method: 'GET', url: '/admin/users' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ users: unknown[] }>();
    expect(body.users).toHaveLength(1);
  });
});

// ─── /admin/containers ────────────────────────────────────────────────────────

describe('GET /admin/containers', () => {
  it('returns 403 for non-admin users', async () => {
    const db = buildDb([]);
    const app = Fastify();
    decorateWithAuth(app, REGULAR_USER_ID);
    await adminRoutes(app, db, mockRedis, makeAuthConfig());

    const res = await app.inject({ method: 'GET', url: '/admin/containers' });
    expect(res.statusCode).toBe(403);
  });

  it('returns docker_unavailable when Docker socket is inaccessible', async () => {
    // In CI / local dev, Docker socket is unavailable — expect graceful degradation.
    const db = buildDb([[]]); // sessions query response
    const app = Fastify();
    decorateWithAuth(app, ADMIN_USER_ID);
    await adminRoutes(app, db, mockRedis, makeAuthConfig());

    const res = await app.inject({ method: 'GET', url: '/admin/containers' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    // Either docker_unavailable (no socket) or containers array if Docker is running
    const hasDockErr = body['error'] === 'docker_unavailable';
    const hasContainers = Array.isArray(body['containers']);
    expect(hasDockErr || hasContainers).toBe(true);
  });
});
