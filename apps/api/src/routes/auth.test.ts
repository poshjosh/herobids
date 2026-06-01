import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import * as jose from 'jose';
import type { AuthConfig } from '@herobids/domain';

// --- helpers ---

const TEST_JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
const TEST_USER_ID = 'user-1';

function makeAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    publicBaseUrl: 'http://localhost:3000',
    jwtSecret: TEST_JWT_SECRET,
    jwtTtlSecs: 86_400,
    googleClientId: 'google-client-id',
    googleClientSecret: 'google-client-secret',
    secureCookie: false,
    ...overrides,
  };
}

/** Decorate Fastify app with a fake authenticated userId and planId (simulates auth plugin) */
function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID, planId = 'free') {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = planId;
  });
}

/** Create a signed JWT for test requests */
async function makeToken(userId: string, sessionId: string, secret = TEST_JWT_SECRET): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new jose.SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setJti(sessionId)
    .setIssuedAt()
    .setExpirationTime('1d')
    .sign(key);
}

// --- tests ---

describe('auth routes', () => {
  describe('GET /auth/me', () => {
    it('returns 401 when userId is not set (no auth)', async () => {
      const { authRoutes } = await import('./auth.js');
      const db = {
        select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }) }),
      };
      const app = Fastify();
      // Don't decorate — userId stays empty
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database);

      const res = await app.inject({ method: 'GET', url: '/auth/me' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when user is not in DB', async () => {
      const { authRoutes } = await import('./auth.js');
      const db = {
        select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }) }),
      };
      const app = Fastify();
      decorateWithAuth(app);
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database);

      const res = await app.inject({ method: 'GET', url: '/auth/me' });
      expect(res.statusCode).toBe(404);
    });

    it('returns user profile when authenticated', async () => {
      const { authRoutes } = await import('./auth.js');
      const mockUser = {
        id: 'user-1',
        displayName: 'Test User',
        email: 'test@example.com',
        avatarUrl: null,
        planId: 'free',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      };
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([mockUser]),
            }),
          }),
        }),
      };
      const app = Fastify();
      decorateWithAuth(app, 'user-1', 'free');
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database);

      const res = await app.inject({ method: 'GET', url: '/auth/me' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe('user-1');
      expect(body.email).toBe('test@example.com');
      expect(body.planId).toBe('free');
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes session and returns ok', async () => {
      const { authRoutes } = await import('./auth.js');
      const updateWhere = vi.fn().mockResolvedValue([]);
      const db = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: updateWhere }),
        }),
        select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }) }),
      };

      const app = Fastify();
      decorateWithAuth(app, 'user-1');
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database);

      const token = await makeToken('user-1', 'session-1');
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(updateWhere).toHaveBeenCalled();
    });

    it('returns 401 when userId is not set (no auth)', async () => {
      const { authRoutes } = await import('./auth.js');
      const db = {
        update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
        select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }) }),
      };

      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database);

      const res = await app.inject({ method: 'POST', url: '/auth/logout' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /auth/google', () => {
    it('redirects to Google OAuth consent screen', async () => {
      const { authRoutes } = await import('./auth.js');
      const db = { select: vi.fn() };
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database);

      const res = await app.inject({ method: 'GET', url: '/auth/google' });
      expect([301, 302, 307, 308]).toContain(res.statusCode);
      expect(res.headers['location']).toContain('accounts.google.com');
    });
  });

  describe('auth plugin — public route exemption', () => {
    it('allows GET /auth/google without token', async () => {
      const { authPlugin } = await import('../plugins/auth.js');
      const { authRoutes } = await import('./auth.js');

      const db = { select: vi.fn() };
      const app = Fastify();
      await authPlugin(app, { config: makeAuthConfig(), db: db as unknown as import('@herobids/db').Database });
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database);

      const res = await app.inject({ method: 'GET', url: '/auth/google' });
      // Should redirect, not 401
      expect([301, 302, 307, 308]).toContain(res.statusCode);
    });

    it('returns 401 when accessing protected route without token', async () => {
      const { authPlugin } = await import('../plugins/auth.js');

      const db = { select: vi.fn() };
      const app = Fastify();
      await authPlugin(app, { config: makeAuthConfig(), db: db as unknown as import('@herobids/db').Database });

      // Register a dummy protected route
      app.get('/protected', async () => ({ ok: true }));

      const res = await app.inject({ method: 'GET', url: '/protected' });
      expect(res.statusCode).toBe(401);
    });
  });
});
