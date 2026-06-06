import { describe, it, expect, beforeAll, beforeEach, afterAll, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { sql, eq, count } from 'drizzle-orm';
import { createDatabase, users, oauthIdentities, sessions } from '@herobids/db';
import type { AuthConfig } from '@herobids/domain';
import { authPlugin } from '../plugins/auth.js';
import { authRoutes } from './auth.js';
import Redis from 'ioredis';

const SKIP = !process.env['DATABASE_URL'];

const TEST_JWT_SECRET = 'test-secret-for-integration-tests-32ch!!';

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
    ...overrides,
  };
}

/** Mock Google's token and userinfo endpoints */
function mockGoogle(opts: {
  tokenOk?: boolean;
  emailVerified?: boolean;
  sub?: string;
  email?: string;
} = {}) {
  const { tokenOk = true, emailVerified = true, sub = 'google-sub-1', email = 'alice@example.com' } = opts;

  vi.stubGlobal('fetch', vi.fn()
    // First fetch: token exchange endpoint
    .mockResolvedValueOnce({
      ok: tokenOk,
      status: tokenOk ? 200 : 400,
      text: vi.fn().mockResolvedValue(tokenOk ? '' : 'Bad Request'),
      json: vi.fn().mockResolvedValue(
        tokenOk
          ? { access_token: 'fake-access-token', token_type: 'Bearer', expires_in: 3600 }
          : { error: 'invalid_grant' },
      ),
    })
    // Second fetch: userinfo endpoint (only reached when token exchange succeeds)
    .mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        sub,
        email,
        email_verified: emailVerified,
        name: 'Alice',
        picture: 'https://example.com/pic.jpg',
      }),
    }),
  );
}

/** Extract the oauth_state value from a Set-Cookie header string */
function extractStateCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0]! : (setCookieHeader ?? '');
  // Header value: "oauth_state=<state>; HttpOnly; ..."
  const match = raw.match(/oauth_state=([^;]+)/);
  if (!match) throw new Error(`No oauth_state cookie found in: ${raw}`);
  return match[1]!;
}

function parseRedisUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname || 'localhost',
    port: parseInt(u.port || '6379', 10),
    ...(u.password && { password: decodeURIComponent(u.password) }),
  };
}

describe.skipIf(SKIP)('authRoutes OAuth callback (integration)', () => {
  let db: ReturnType<typeof createDatabase>;
  let app: ReturnType<typeof Fastify>;
  let redis: Redis;
  const config = makeAuthConfig();

  beforeAll(async () => {
    db = createDatabase(process.env['DATABASE_URL']!);
    const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
    redis = new Redis(parseRedisUrl(redisUrl));

    app = Fastify({ logger: false });
    await authPlugin(app, { config, db });
    await authRoutes(app, config, db, redis, 'free');
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE sessions, oauth_identities, user_plans, users CASCADE`);
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('first login creates user, oauth_identity, and session; returns a JWT', async () => {
    // Step 1: visit /auth/google to get a valid CSRF state token
    const googleRedirect = await app.inject({ method: 'GET', url: '/auth/google' });
    const state = extractStateCookie(googleRedirect.headers['set-cookie']);

    // Step 2: mock Google APIs
    mockGoogle();

    // Step 3: simulate the OAuth callback — now redirects with exchange code
    const callbackRes = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=auth-code-123&state=${encodeURIComponent(state)}`,
      headers: { cookie: `oauth_state=${state}` },
    });

    expect(callbackRes.statusCode).toBe(302);
    const location = callbackRes.headers['location'] as string;
    expect(location).toBeTruthy();
    const exchangeCode = new URL(location).searchParams.get('code')!;
    expect(exchangeCode).toBeTruthy();

    // Step 4: exchange the one-time code for the JWT
    const exchangeRes = await app.inject({
      method: 'POST',
      url: '/auth/exchange',
      payload: { code: exchangeCode },
    });

    expect(exchangeRes.statusCode).toBe(200);
    const body = JSON.parse(exchangeRes.body) as { token: string };
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.').length).toBe(3); // valid JWT shape

    // Verify DB state
    const [userRow] = await db.select().from(users).where(eq(users.email, 'alice@example.com'));
    expect(userRow).toBeDefined();
    expect(userRow!.planId).toBe('free');

    const identities = await db.select().from(oauthIdentities).where(eq(oauthIdentities.providerUserId, 'google-sub-1'));
    expect(identities).toHaveLength(1);
    expect(identities[0]!.userId).toBe(userRow!.id);

    const sessionRows = await db.select().from(sessions).where(eq(sessions.userId, userRow!.id));
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]!.revokedAt).toBeNull();
  });

  it('second login with same Google sub reuses the existing user and creates a new session', async () => {
    const login = async () => {
      const googleRedirect = await app.inject({ method: 'GET', url: '/auth/google' });
      const state = extractStateCookie(googleRedirect.headers['set-cookie']);
      mockGoogle();
      const callbackRes = await app.inject({
        method: 'GET',
        url: `/auth/google/callback?code=code&state=${encodeURIComponent(state)}`,
        headers: { cookie: `oauth_state=${state}` },
      });
      expect(callbackRes.statusCode).toBe(302);
      const location = callbackRes.headers['location'] as string;
      const exchangeCode = new URL(location).searchParams.get('code')!;
      return app.inject({
        method: 'POST',
        url: '/auth/exchange',
        payload: { code: exchangeCode },
      });
    };

    const first = await login();
    expect(first.statusCode).toBe(200);

    const second = await login();
    expect(second.statusCode).toBe(200);

    // Only one user and one identity row — re-login must not duplicate them
    const [{ value: userCount }] = await db.select({ value: count() }).from(users);
    expect(userCount).toBe(1);

    const [{ value: identityCount }] = await db.select({ value: count() }).from(oauthIdentities);
    expect(identityCount).toBe(1);

    // But two distinct session rows (one per login)
    const [{ value: sessionCount }] = await db.select({ value: count() }).from(sessions);
    expect(sessionCount).toBe(2);
  });

  it('CSRF state mismatch → 400', async () => {
    const googleRedirect = await app.inject({ method: 'GET', url: '/auth/google' });
    const realState = extractStateCookie(googleRedirect.headers['set-cookie']);

    // Use a completely different value as the query state
    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=code&state=tampered-state`,
      headers: { cookie: `oauth_state=${realState}` },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('OAuth state') });
  });

  it('missing authorization code → 400', async () => {
    const googleRedirect = await app.inject({ method: 'GET', url: '/auth/google' });
    const state = extractStateCookie(googleRedirect.headers['set-cookie']);

    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?state=${encodeURIComponent(state)}`,
      headers: { cookie: `oauth_state=${state}` },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Missing authorization code' });
  });

  it('email_verified: false → 401 (prevents account-takeover via unverified email)', async () => {
    const googleRedirect = await app.inject({ method: 'GET', url: '/auth/google' });
    const state = extractStateCookie(googleRedirect.headers['set-cookie']);

    mockGoogle({ emailVerified: false });

    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=code&state=${encodeURIComponent(state)}`,
      headers: { cookie: `oauth_state=${state}` },
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('verified') });
  });

  it('Google token exchange fails → 502', async () => {
    const googleRedirect = await app.inject({ method: 'GET', url: '/auth/google' });
    const state = extractStateCookie(googleRedirect.headers['set-cookie']);

    mockGoogle({ tokenOk: false });

    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=code&state=${encodeURIComponent(state)}`,
      headers: { cookie: `oauth_state=${state}` },
    });

    expect(res.statusCode).toBe(502);
  });
});
