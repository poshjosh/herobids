import crypto from 'node:crypto';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify from 'fastify';
import * as jose from 'jose';
import type { AuthConfig } from '@herobids/domain';

// --- helpers ---

const TEST_JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
const TEST_USER_ID = 'user-1';

function makeAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    publicBaseUrl: 'http://localhost:3000',
    frontendOrigin: 'http://localhost:5173',
    jwtSecret: TEST_JWT_SECRET,
    jwtTtlSecs: 86_400,
    exchangeCodeTtlSecs: 60,
    googleClientId: 'google-client-id',
    googleClientSecret: 'google-client-secret',
    secureCookie: false,
    loginLinkTtlSecs: 600,
    loginLinkResendCooldownSecs: 60,
    loginLinkMaxSendsPerWindow: 5,
    loginLinkWindowSecs: 3600,
    loginLinkMaxSendsPerIpWindow: 10,
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

    it('returns notificationPreferences as null when not set', async () => {
      const { authRoutes } = await import('./auth.js');
      const mockUser = {
        id: 'user-1',
        displayName: 'Test User',
        email: 'test@example.com',
        avatarUrl: null,
        planId: 'free',
        isAdmin: false,
        preferredLocale: null,
        telegramChatId: null,
        notificationPreferences: null,
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
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database, {} as any);

      const res = await app.inject({ method: 'GET', url: '/auth/me' });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ notificationPreferences: unknown }>().notificationPreferences).toBeNull();
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

    it('normalizes whitespace-padded telegramChatId on PATCH', async () => {
      const { authRoutes } = await import('./auth.js');
      const updatedUser = {
        id: 'user-1',
        displayName: 'Test User',
        email: 'test@example.com',
        avatarUrl: null,
        planId: 'free',
        preferredLocale: null,
        telegramChatId: '123456',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
      };
      const updateWhere = vi.fn().mockResolvedValue(undefined);
      const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
      const db = {
        update: vi.fn().mockReturnValue({ set: updateSet }),
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
        payload: { telegramChatId: ' 123456 ' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ telegramChatId: string | null }>().telegramChatId).toBe('123456');
    });

    it('normalizes blank telegramChatId to null on PATCH', async () => {
      const { authRoutes } = await import('./auth.js');
      const updatedUser = {
        id: 'user-1',
        displayName: 'Test User',
        email: 'test@example.com',
        avatarUrl: null,
        planId: 'free',
        preferredLocale: null,
        telegramChatId: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
      };
      const updateWhere = vi.fn().mockResolvedValue(undefined);
      const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
      const db = {
        update: vi.fn().mockReturnValue({ set: updateSet }),
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
        payload: { telegramChatId: '   ' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ telegramChatId: string | null }>().telegramChatId).toBeNull();
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

    it('saves notificationPreferences when PATCH includes sendMessage.email.enabled: true', async () => {
      const { authRoutes } = await import('./auth.js');
      const storedPrefs = {
        sendMessage: { email: { enabled: true, source: 'explicit_update', enabledAt: '2026-07-10T00:00:00.000Z' } },
      };
      const updatedUser = {
        id: 'user-1',
        displayName: 'Test User',
        email: 'test@example.com',
        avatarUrl: null,
        planId: 'free',
        isAdmin: false,
        preferredLocale: null,
        telegramChatId: null,
        notificationPreferences: storedPrefs,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-07-10'),
      };
      // First select: current prefs lookup (notificationPreferences null → first enable)
      // Second select: return updated user
      let selectCallCount = 0;
      const db = {
        update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockImplementation(() => {
                selectCallCount++;
                // First call: current prefs lookup returns null prefs
                if (selectCallCount === 1) return Promise.resolve([{ notificationPreferences: null }]);
                // Second call: post-update fetch returns updated user
                return Promise.resolve([updatedUser]);
              }),
            }),
          }),
        })),
      };
      const app = Fastify();
      decorateWithAuth(app, 'user-1', 'free');
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database, {} as any);

      const res = await app.inject({
        method: 'PATCH',
        url: '/auth/me',
        payload: { notificationPreferences: { sendMessage: { email: { enabled: true } } } },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ notificationPreferences: typeof storedPrefs }>();
      expect(body.notificationPreferences?.sendMessage?.email?.enabled).toBe(true);
      expect(body.notificationPreferences?.sendMessage?.email?.source).toBe('explicit_update');
    });

    it('clears notificationPreferences to null when PATCH sends null', async () => {
      const { authRoutes } = await import('./auth.js');
      const updatedUser = {
        id: 'user-1',
        displayName: 'Test User',
        email: 'test@example.com',
        avatarUrl: null,
        planId: 'free',
        isAdmin: false,
        preferredLocale: null,
        telegramChatId: null,
        notificationPreferences: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-07-10'),
      };
      const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      const db = {
        update: vi.fn().mockReturnValue({ set: setMock }),
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
        payload: { notificationPreferences: null },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ notificationPreferences: unknown }>().notificationPreferences).toBeNull();
      // Verify null was passed to the update
      const setArgs = setMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(setArgs?.['notificationPreferences']).toBeNull();
    });

    it('returns 400 when notificationPreferences payload is invalid', async () => {
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
        payload: { notificationPreferences: { sendMessage: { email: { enabled: 'not-a-boolean' } } } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('auth.profile.invalid_notification_preferences');
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

  describe('OAuth user creation (username)', () => {
    function makeRedisMock() {
      return {
        set: vi.fn().mockResolvedValue('OK'),
        getdel: vi.fn().mockResolvedValue(null),
        incr: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(1),
      };
    }

    beforeEach(() => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fetch call'));
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('generates username for OAuth first-time user', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      redis.set = vi.fn().mockResolvedValue('OK');

      // Mock Google token exchange and userinfo endpoints
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      fetchMock
        .mockResolvedValueOnce(Response.json({
          access_token: 'test-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }))
        .mockResolvedValueOnce(Response.json({
          sub: 'google-123',
          email: 'oauthuser@gmail.com',
          email_verified: true,
          name: 'OAuth User',
          picture: 'https://example.com/pic.jpg',
        }));

      // Generate valid OAuth state
      const nonce = 'test-nonce-for-oauth';
      const sig = crypto.createHmac('sha256', TEST_JWT_SECRET).update(nonce).digest('base64url');
      const state = `${nonce}.${sig}`;

      let capturedUsername: string | undefined;
      let capturedDisplayName: string | undefined;

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]), // username available
            }),
          }),
        }),
        transaction: vi.fn().mockImplementation(async (cb: any) => {
          let selectCallCount = 0;
          const tx = {
            insert: vi.fn().mockImplementation(() => ({
              values: vi.fn().mockImplementation((vals: any) => {
                if (vals.username) capturedUsername = vals.username;
                if (vals.displayName) capturedDisplayName = vals.displayName;
                // Support chaining .onConflictDoNothing() after .values()
                return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
              }),
              onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
            })),
            select: vi.fn().mockImplementation(() => ({
              from: vi.fn().mockImplementation(() => ({
                where: vi.fn().mockImplementation(() => ({
                  limit: vi.fn().mockImplementation(() => {
                    selectCallCount++;
                    // 1st: oauthIdentities lookup → empty (new OAuth user)
                    // 2nd: users by email → found
                    // 3rd: re-read oauthIdentity → found
                    if (selectCallCount === 1) return Promise.resolve([]);
                    if (selectCallCount === 2) return Promise.resolve([{ id: 'new-oauth-user-id' }]);
                    return Promise.resolve([{ userId: 'new-oauth-user-id' }]);
                  }),
                })),
              })),
            })),
          };
          return cb(tx);
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };

      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as any, redis as any);

      const res = await app.inject({
        method: 'GET',
        url: `/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
        headers: { cookie: `oauth_state=${state}` },
      });

      expect(res.statusCode).toBe(302);
      expect(capturedUsername).toBeDefined();
      expect(capturedUsername).toMatch(/^oauthuser/);
      expect(capturedDisplayName).toBeDefined();
    });

    it('initializes humanized displayName from generated username', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      redis.set = vi.fn().mockResolvedValue('OK');

      const fetchMock = vi.spyOn(globalThis, 'fetch');
      fetchMock
        .mockResolvedValueOnce(Response.json({
          access_token: 'test-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }))
        .mockResolvedValueOnce(Response.json({
          sub: 'google-456',
          email: 'john_doe@gmail.com',
          email_verified: true,
          name: 'John Doe',
        }));

      const nonce = 'test-nonce-for-oauth-2';
      const sig = crypto.createHmac('sha256', TEST_JWT_SECRET).update(nonce).digest('base64url');
      const state = `${nonce}.${sig}`;

      let capturedDisplayName: string | undefined;

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        transaction: vi.fn().mockImplementation(async (cb: any) => {
          let selectCallCount = 0;
          const tx = {
            insert: vi.fn().mockImplementation(() => ({
              values: vi.fn().mockImplementation((vals: any) => {
                if (vals.displayName) capturedDisplayName = vals.displayName;
                return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
              }),
              onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
            })),
            select: vi.fn().mockImplementation(() => ({
              from: vi.fn().mockImplementation(() => ({
                where: vi.fn().mockImplementation(() => ({
                  limit: vi.fn().mockImplementation(() => {
                    selectCallCount++;
                    if (selectCallCount === 1) return Promise.resolve([]);
                    if (selectCallCount === 2) return Promise.resolve([{ id: 'new-oauth-user-id-2' }]);
                    return Promise.resolve([{ userId: 'new-oauth-user-id-2' }]);
                  }),
                })),
              })),
            })),
          };
          return cb(tx);
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };

      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as any, redis as any);

      const res = await app.inject({
        method: 'GET',
        url: `/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
        headers: { cookie: `oauth_state=${state}` },
      });

      expect(res.statusCode).toBe(302);
      // Email 'john_doe@gmail.com' → deriveBaseUsername → 'john_doe' → humanize → 'John Doe'
      expect(capturedDisplayName).toBe('John Doe');
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

  describe('POST /auth/send-login-link', () => {
    function makeRedisMock() {
      return {
        set: vi.fn().mockResolvedValue('OK'),
        getdel: vi.fn().mockResolvedValue(null),
        incr: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(1),
        ttl: vi.fn().mockResolvedValue(-2),  // no cooldown key by default
      };
    }

    it('returns 400 for invalid email', async () => {
      const { authRoutes } = await import('./auth.js');
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), {} as any, makeRedisMock() as any);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/send-login-link',
        payload: { email: 'not-an-email' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('auth.send_login_link.invalid_email');
    });

    it('returns 200 with ok when login link is sent', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      // Provide a mock authMailer to exercise the full token-creation path
      const authMailer = { sendLoginLink: vi.fn().mockResolvedValue(undefined) };
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), {} as any, redis as any, 'free', undefined, authMailer as any);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/send-login-link',
        payload: { email: 'user@example.com' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ ok: boolean }>().ok).toBe(true);
      expect(redis.set).toHaveBeenCalled();
      expect(authMailer.sendLoginLink).toHaveBeenCalled();
    });

    it('returns generic success even when no mailer is configured', async () => {
      const { authRoutes } = await import('./auth.js');
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      // No authMailer passed — email delivery is disabled, but the response is still generic
      await authRoutes(app, makeAuthConfig(), {} as any, makeRedisMock() as any);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/send-login-link',
        payload: { email: 'user@example.com' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ ok: boolean }>().ok).toBe(true);
    });

    it('returns 429 when resend cooldown is active', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      redis.ttl = vi.fn().mockResolvedValue(42); // 42s remaining on cooldown
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), {} as any, redis as any);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/send-login-link',
        payload: { email: 'user@example.com' },
      });

      expect(res.statusCode).toBe(429);
      expect(res.json<{ error: string }>().error).toBe('auth.send_login_link.rate_limited');
    });

    it('passes cooldown check when ttl returns 0 (exact expiry boundary)', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      redis.ttl = vi.fn().mockResolvedValue(0); // key exists but just expired
      const authMailer = { sendLoginLink: vi.fn().mockResolvedValue(undefined) };
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), {} as any, redis as any, 'free', undefined, authMailer as any);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/send-login-link',
        payload: { email: 'user@example.com' },
      });

      // Cooldown should not block — ttl of 0 means already expired
      expect(res.statusCode).toBe(200);
    });

    it('sets cooldown key after successful mailer send', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      const authMailer = { sendLoginLink: vi.fn().mockResolvedValue(undefined) };
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      const config = makeAuthConfig();
      await authRoutes(app, config, {} as any, redis as any, 'free', undefined, authMailer as any);

      await app.inject({
        method: 'POST',
        url: '/auth/send-login-link',
        payload: { email: 'user@example.com' },
      });

      // Token set + cooldown set = 2 calls
      expect(redis.set).toHaveBeenCalledTimes(2);
      const cooldownCall = redis.set.mock.calls[1];
      expect(cooldownCall?.[0]).toContain('auth:login-link:cooldown:');
      expect(cooldownCall?.[1]).toBe('1');
      expect(cooldownCall?.[2]).toBe('EX');
      expect(cooldownCall?.[3]).toBe(config.loginLinkResendCooldownSecs);
    });

    it('sets cooldown key when no mailer is configured (dev mode)', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), {} as any, redis as any);

      await app.inject({
        method: 'POST',
        url: '/auth/send-login-link',
        payload: { email: 'user@example.com' },
      });

      expect(redis.set).toHaveBeenCalledTimes(2);
      const cooldownCall = redis.set.mock.calls[1];
      expect(cooldownCall?.[0]).toContain('auth:login-link:cooldown:');
    });

    it('does not set cooldown key when email send fails', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      const authMailer = { sendLoginLink: vi.fn().mockResolvedValue({ code: 'send_failed', message: 'Failed' }) };
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), {} as any, redis as any, 'free', undefined, authMailer as any);

      await app.inject({
        method: 'POST',
        url: '/auth/send-login-link',
        payload: { email: 'user@example.com' },
      });

      // Only the token set, no cooldown key
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.set.mock.calls[0]?.[0]).not.toContain('cooldown');
    });

    it('passes loginLinkTtlSecs to sendLoginLink', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      const authMailer = { sendLoginLink: vi.fn().mockResolvedValue(undefined) };
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      const config = makeAuthConfig();
      await authRoutes(app, config, {} as any, redis as any, 'free', undefined, authMailer as any);

      await app.inject({
        method: 'POST',
        url: '/auth/send-login-link',
        payload: { email: 'user@example.com' },
      });

      expect(authMailer.sendLoginLink).toHaveBeenCalledWith(
        'user@example.com',
        expect.any(String),
        config.loginLinkTtlSecs,
      );
    });

    // ── Username validation ────────────────────────────────────────────────

    it('returns 400 when username is too short', async () => {
      const { authRoutes } = await import('./auth.js');
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), {} as any, makeRedisMock() as any);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/send-login-link',
        payload: { email: 'user@example.com', username: 'ab' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('auth.send_login_link.invalid_username');
    });

    it('returns 400 when username contains invalid characters', async () => {
      const { authRoutes } = await import('./auth.js');
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), {} as any, makeRedisMock() as any);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/send-login-link',
        payload: { email: 'user@example.com', username: 'Invalid!User' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('auth.send_login_link.invalid_username');
    });

    it('returns 400 when username is too long', async () => {
      const { authRoutes } = await import('./auth.js');
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), {} as any, makeRedisMock() as any);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/send-login-link',
        payload: { email: 'user@example.com', username: 'a'.repeat(31) },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('auth.send_login_link.invalid_username');
    });

    it('returns 409 when username is already taken', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'existing-user' }]),
            }),
          }),
        }),
      };
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as unknown as import('@herobids/db').Database, redis as any);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/send-login-link',
        payload: { email: 'new@example.com', username: 'existing_user' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toBe('auth.send_login_link.username_taken');
    });

    it('stores username in Redis token when provided', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]), // username available
            }),
          }),
        }),
      };
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as any, redis as any);

      await app.inject({
        method: 'POST',
        url: '/auth/send-login-link',
        payload: { email: 'user@example.com', username: 'new_user' },
      });

      const tokenSetCall = redis.set.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && (call[0] as string).startsWith('auth:login-link:token:'),
      );
      expect(tokenSetCall).toBeDefined();
      const payload = JSON.parse(tokenSetCall[1]);
      expect(payload.username).toBe('new_user');
    });

    it('passes when username is blank (falls back to generated)', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), {} as any, redis as any);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/send-login-link',
        payload: { email: 'user@example.com', username: '' },
      });

      expect(res.statusCode).toBe(200);
      // Token should NOT contain username
      const tokenSetCall = redis.set.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && (call[0] as string).startsWith('auth:login-link:token:'),
      );
      expect(tokenSetCall).toBeDefined();
      const payload = JSON.parse(tokenSetCall[1]);
      expect(payload.username).toBeUndefined();
    });
  });

  describe('GET /auth/login-link/callback', () => {
    it('returns 400 when token is missing', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = {
        set: vi.fn(),
        getdel: vi.fn().mockResolvedValue(null),
        incr: vi.fn(),
        expire: vi.fn(),
      };
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), {} as any, redis as any, 'free');

      const res = await app.inject({ method: 'GET', url: '/auth/login-link/callback' });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('auth.login_link_callback.missing_token');
    });

    it('returns 400 when token is invalid or expired', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = {
        set: vi.fn(),
        getdel: vi.fn().mockResolvedValue(null), // expired/unknown token
        incr: vi.fn(),
        expire: vi.fn(),
      };
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), {} as any, redis as any, 'free');

      const res = await app.inject({
        method: 'GET',
        url: '/auth/login-link/callback?token=invalid-token',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('auth.login_link_callback.invalid_token');
    });

    it('resolves existing user and redirects with exchange code', async () => {
      const { authRoutes } = await import('./auth.js');
      const existingUserId = 'existing-user-id';
      const redis = {
        set: vi.fn().mockResolvedValue('OK'),
        getdel: vi.fn().mockResolvedValue(JSON.stringify({ email: 'existing@example.com' })),
        incr: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(1),
      };
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: existingUserId }]),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as any, redis as any);

      const res = await app.inject({
        method: 'GET',
        url: '/auth/login-link/callback?token=valid-token',
      });

      // Should redirect to the frontend callback URL with an exchange code
      expect(res.statusCode).toBe(302);
      const location = res.headers['location'] as string;
      expect(location).toContain('/auth/callback?code=');
      expect(redis.getdel).toHaveBeenCalledWith('auth:login-link:token:valid-token');
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('auth:code:'),
        expect.any(String),
        'EX',
        expect.any(Number),
      );
    });

    it('creates a new user when email does not exist yet', async () => {
      const { authRoutes } = await import('./auth.js');
      const insertedUsers: Array<Record<string, unknown>> = [];
      const redis = {
        set: vi.fn().mockResolvedValue('OK'),
        getdel: vi.fn().mockResolvedValue(JSON.stringify({ email: 'newuser@example.com' })),
        incr: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(1),
      };
      const db = {
        // First select returns no existing user (email not found)
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            insert: vi.fn().mockImplementation(() => ({
              values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
                insertedUsers.push(vals);
                return Promise.resolve(undefined);
              }),
            })),
          };
          return callback(tx);
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };
      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as any, redis as any);

      const res = await app.inject({
        method: 'GET',
        url: '/auth/login-link/callback?token=new-user-token',
      });

      expect(res.statusCode).toBe(302);
      // First insert is the user row, second is userPlans
      const userInsert = insertedUsers[0];
      expect(userInsert).toBeDefined();
      expect(userInsert!['email']).toBe('newuser@example.com');
      // Display name should be derived from the email local-part via humanizeDisplayName
      expect(userInsert!['displayName']).toBe('Newuser');
      const location = res.headers['location'] as string;
      expect(location).toContain('/auth/callback?code=');
    });
  });

  describe('GET /auth/login-link/callback (username)', () => {
    function makeRedisMock() {
      return {
        set: vi.fn().mockResolvedValue('OK'),
        getdel: vi.fn().mockResolvedValue(null),
        get: vi.fn().mockResolvedValue(null),
        incr: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(1),
      };
    }

    it('persists reserved username for first-time user', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      redis.getdel = vi.fn().mockResolvedValue(JSON.stringify({
        email: 'new@example.com',
        username: 'jane_doe',
      }));
      // Reservation maps to the token being consumed
      redis.get = vi.fn().mockResolvedValue('valid-token');

      let insertedUsername: string | undefined;
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]), // new user, username available
            }),
          }),
        }),
        transaction: vi.fn().mockImplementation(async (cb: any) => {
          await cb({
            insert: vi.fn().mockImplementation(() => ({
              values: vi.fn().mockImplementation((vals: any) => {
                // Only capture username from the users insert (not userPlans)
                if (vals.username) insertedUsername = vals.username;
                return Promise.resolve(undefined);
              }),
            })),
          });
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };

      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as any, redis as any);

      await app.inject({
        method: 'GET',
        url: '/auth/login-link/callback?token=valid-token',
      });

      expect(insertedUsername).toBe('jane_doe');
    });

    it('initializes humanized displayName from reserved username', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      redis.getdel = vi.fn().mockResolvedValue(JSON.stringify({
        email: 'new@example.com',
        username: 'jane_doe',
      }));
      // Reservation maps to the token being consumed
      redis.get = vi.fn().mockResolvedValue('valid-token');

      let insertedDisplayName: string | undefined;
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        transaction: vi.fn().mockImplementation(async (cb: any) => {
          await cb({
            insert: vi.fn().mockImplementation(() => ({
              values: vi.fn().mockImplementation((vals: any) => {
                if (vals.displayName) insertedDisplayName = vals.displayName;
                return Promise.resolve(undefined);
              }),
            })),
          });
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };

      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as any, redis as any);

      await app.inject({
        method: 'GET',
        url: '/auth/login-link/callback?token=valid-token',
      });

      expect(insertedDisplayName).toBe('Jane Doe');
    });

    it('generates username when not provided', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      redis.getdel = vi.fn().mockResolvedValue(JSON.stringify({
        email: 'newuser@example.com',
        // no username
      }));

      let capturedUsername: string | undefined;
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]), // no existing user or username conflict
            }),
          }),
        }),
        transaction: vi.fn().mockImplementation(async (cb: any) => {
          await cb({
            insert: vi.fn().mockImplementation(() => ({
              values: vi.fn().mockImplementation((vals: any) => {
                if (vals.username) capturedUsername = vals.username;
                return Promise.resolve(undefined);
              }),
            })),
          });
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };

      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as any, redis as any);

      await app.inject({
        method: 'GET',
        url: '/auth/login-link/callback?token=valid-token',
      });

      // Username should be derived from the email local-part
      expect(capturedUsername).toBeDefined();
      expect(capturedUsername).toMatch(/^newuser/);
    });

    it('ignores submitted username for existing user', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      redis.getdel = vi.fn().mockResolvedValue(JSON.stringify({
        email: 'existing@example.com',
        username: 'attempted_new_name',
      }));
      // Reservation does not matter for existing users — still need get to not throw
      redis.get = vi.fn().mockResolvedValue(null);

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'existing-user-id' }]),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };

      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as any, redis as any);

      const res = await app.inject({
        method: 'GET',
        url: '/auth/login-link/callback?token=valid-token',
      });

      // Should redirect (302) — existing user still signs in
      expect(res.statusCode).toBe(302);
      // No insert should happen since user exists
      expect(db.select).toHaveBeenCalled();
    });

    it('retries on username constraint conflict and succeeds within budget', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      // No username in payload — auto-generation path exercises the retry logic
      redis.getdel = vi.fn().mockResolvedValue(JSON.stringify({ email: 'new@example.com' }));

      let transactionCallCount = 0;
      const conflictError = Object.assign(new Error('unique constraint'), {
        code: '23505',
        constraint_name: 'users_username_key',
      });

      const db = {
        // Email lookup returns no user (new user)
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        // First transaction attempt conflicts on username; second succeeds
        transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
          transactionCallCount++;
          if (transactionCallCount === 1) throw conflictError;
          await cb({
            insert: vi.fn().mockImplementation(() => ({
              values: vi.fn().mockResolvedValue(undefined),
            })),
          });
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };

      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as any, redis as any);

      const res = await app.inject({
        method: 'GET',
        url: '/auth/login-link/callback?token=valid-token',
      });

      expect(res.statusCode).toBe(302);
      expect(transactionCallCount).toBe(2); // conflicted once, succeeded on retry
    });

    it('fails loudly when username retry budget is exhausted', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      redis.getdel = vi.fn().mockResolvedValue(JSON.stringify({ email: 'new@example.com' }));

      const conflictError = Object.assign(new Error('unique constraint'), {
        code: '23505',
        constraint_name: 'users_username_key',
      });

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        // All transaction attempts conflict
        transaction: vi.fn().mockImplementation(async () => { throw conflictError; }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };

      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as any, redis as any);

      const res = await app.inject({
        method: 'GET',
        url: '/auth/login-link/callback?token=valid-token',
      });

      // Fastify surfaces unhandled errors as 500
      expect(res.statusCode).toBe(500);
    });

    it('uses reserved username when reservation maps to current token', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      redis.getdel = vi.fn().mockResolvedValue(JSON.stringify({
        email: 'new@example.com',
        username: 'reserved_user',
      }));
      // Reservation key holds the same token as the one being consumed
      redis.get = vi.fn().mockResolvedValue('valid-token');

      let insertedUsername: string | undefined;
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
          await cb({
            insert: vi.fn().mockImplementation(() => ({
              values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
                if (vals['username']) insertedUsername = vals['username'] as string;
                return Promise.resolve(undefined);
              }),
            })),
          });
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };

      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as any, redis as any);

      await app.inject({
        method: 'GET',
        url: '/auth/login-link/callback?token=valid-token',
      });

      expect(insertedUsername).toBe('reserved_user');
    });

    it('falls back to auto-generation when reservation does not match token', async () => {
      const { authRoutes } = await import('./auth.js');
      const redis = makeRedisMock();
      redis.getdel = vi.fn().mockResolvedValue(JSON.stringify({
        email: 'new@example.com',
        username: 'claimed_by_other',
      }));
      // Reservation key holds a different token (stale or stolen reservation)
      redis.get = vi.fn().mockResolvedValue('some-other-token');

      let insertedUsername: string | undefined;
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
          await cb({
            insert: vi.fn().mockImplementation(() => ({
              values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
                if (vals['username']) insertedUsername = vals['username'] as string;
                return Promise.resolve(undefined);
              }),
            })),
          });
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };

      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as any, redis as any);

      await app.inject({
        method: 'GET',
        url: '/auth/login-link/callback?token=valid-token',
      });

      // Username should be auto-generated from email, not the stale reservation
      expect(insertedUsername).toBeDefined();
      expect(insertedUsername).not.toBe('claimed_by_other');
      expect(insertedUsername).toMatch(/^new/); // derived from email local-part
    });
  });

  describe('POST /auth/login — password_not_available', () => {
    it('returns password_not_available for a user without local_identities', async () => {
      const { authRoutes } = await import('./auth.js');
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      };
      // First call: user exists
      // Second call: no localIdentities row
      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'user-1', email: 'google-only@example.com' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        });

      const app = Fastify();
      app.decorateRequest('userId', '');
      app.decorateRequest('userPlanId', '');
      await authRoutes(app, makeAuthConfig(), db as any, {} as any);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'google-only@example.com', password: 'any-password' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: string }>().error).toBe('auth.login.password_not_available');
    });
  });
});
