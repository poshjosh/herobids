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
      const plansConfig = {
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
            usage: {},
          },
        },
      };
      const mockUser = {
        id: 'user-1',
        displayName: 'Test User',
        email: 'test@example.com',
        avatarUrl: null,
        planId: 'free',
        isAdmin: false,
        preferredLocale: 'ar',
        telegramChatId: null,
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
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database, {} as any, 'free', plansConfig as any);

      const res = await app.inject({ method: 'GET', url: '/auth/me' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe('user-1');
      expect(body.email).toBe('test@example.com');
      expect(body.planId).toBe('free');
      expect(body.preferredLocale).toBe('ar');
      expect(body.planEntitlements.skills.autoPublishNonDraftSkills).toBe(true);
    });
  });

  describe('PATCH /auth/me', () => {
    it('updates preferredLocale and telegramChatId when payload is valid', async () => {
      const { authRoutes } = await import('./auth.js');
      const updatedUser = {
        id: 'user-1',
        displayName: 'Test User',
        email: 'test@example.com',
        avatarUrl: null,
        planId: 'free',
        preferredLocale: 'hi',
        telegramChatId: '123456',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
      };
      const updateWhere = vi.fn().mockResolvedValue(undefined);
      const db = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: updateWhere }),
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([updatedUser]),
            }),
          }),
        }),
      };
      const app = Fastify();
      decorateWithAuth(app, 'user-1', 'free');
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database, {} as any);

      const res = await app.inject({
        method: 'PATCH',
        url: '/auth/me',
        payload: { preferredLocale: 'hi', telegramChatId: '123456' },
      });

      expect(res.statusCode).toBe(200);
      expect(updateWhere).toHaveBeenCalled();
      expect(res.json<{ preferredLocale: string | null }>().preferredLocale).toBe('hi');
    });

    it('returns a stable code when preferredLocale is invalid', async () => {
      const { authRoutes } = await import('./auth.js');
      const db = {
        update: vi.fn(),
        select: vi.fn(),
      };
      const app = Fastify();
      decorateWithAuth(app, 'user-1', 'free');
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database, {} as any);

      const res = await app.inject({
        method: 'PATCH',
        url: '/auth/me',
        payload: { preferredLocale: 'fr' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('auth.profile.invalid_preferred_locale');
      expect(res.json<{ params?: { supportedLocales?: string } }>().params?.supportedLocales).toBe('en, ar, hi');
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

  // ── POST /auth/register ────────────────────────────────────────────────────

  describe('POST /auth/register', () => {
    function buildRegisterDb(captureUserInsert?: (vals: Record<string, unknown>) => void) {
      return {
        // Duplicate email check
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]), // no existing account
            }),
          }),
        }),
        // Transaction: inserts users, localIdentities, userPlans
        transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
          let insertCount = 0;
          const tx = {
            insert: vi.fn().mockImplementation(() => ({
              values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
                insertCount++;
                if (insertCount === 1 && captureUserInsert) captureUserInsert(vals);
                return Promise.resolve(undefined);
              }),
            })),
          };
          return callback(tx);
        }),
        // issueSession: inserts a session row
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };
    }

    it('returns 201 with a token when registration succeeds', async () => {
      const { authRoutes } = await import('./auth.js');
      const db = buildRegisterDb();
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database, {} as any);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'alice@example.com', password: 'securepassword', displayName: 'Alice' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json<{ token: string }>().token).toBeTruthy();
    });

    // Regression: bug 003 — user INSERT omitted nullable preference fields,
    // causing PostgreSQL to substitute DEFAULT. Both columns lack a DEFAULT, so the
    // insert threw a constraint violation and returned HTTP 500 for every registration.
    it('includes preferredLocale: null, telegramChatId: null and aiModelConfig: null in the user INSERT', async () => {
      const { authRoutes } = await import('./auth.js');
      let capturedUserInsert: Record<string, unknown> | undefined;
      const db = buildRegisterDb((vals) => { capturedUserInsert = vals; });
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database, {} as any);

      await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'alice@example.com', password: 'securepassword', displayName: 'Alice' },
      });

      expect(capturedUserInsert).toBeDefined();
      // Both nullable columns must be explicitly set to null — not omitted —
      // so Drizzle does not emit DEFAULT in the INSERT statement.
      expect(capturedUserInsert!['preferredLocale']).toBeNull();
      expect(capturedUserInsert!['telegramChatId']).toBeNull();
      expect(capturedUserInsert!['aiModelConfig']).toBeNull();
    });

    it('returns 409 when the email is already registered', async () => {
      const { authRoutes } = await import('./auth.js');
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'existing-user' }]), // duplicate
            }),
          }),
        }),
        transaction: vi.fn(),
      };
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database, {} as any);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'existing@example.com', password: 'securepassword', displayName: 'Bob' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toBe('auth.register.email_taken');
    });

    it('returns 400 when password is shorter than 8 characters', async () => {
      const { authRoutes } = await import('./auth.js');
      const db = { select: vi.fn(), transaction: vi.fn() };
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database, {} as any);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'alice@example.com', password: 'short', displayName: 'Alice' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('auth.register.password_too_short');
      expect(res.json<{ params?: { minLength?: number } }>().params?.minLength).toBe(8);
    });
  });
});
