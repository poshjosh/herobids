import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import * as jose from 'jose';
import { sql } from 'drizzle-orm';
import { createDatabase, users, sessions } from '@herobids/db';
import { eq } from 'drizzle-orm';
import type { AuthConfig } from '@herobids/domain';
import { authPlugin, createSessionToken } from './auth.js';

const SKIP = !process.env['DATABASE_URL'];

const TEST_JWT_SECRET = 'test-secret-for-integration-tests-32ch!!';
const TEST_JWT_TTL = 3600; // 1 hour

function makeAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    publicBaseUrl: 'http://localhost:3000',
    frontendOrigin: 'http://localhost:5173',
    jwtSecret: TEST_JWT_SECRET,
    jwtTtlSecs: TEST_JWT_TTL,
    exchangeCodeTtlSecs: 60,
    googleClientId: 'test-client-id',
    googleClientSecret: 'test-client-secret',
    secureCookie: false,
    loginLinkTtlSecs: 600,
    loginLinkResendCooldownSecs: 60,
    loginLinkMaxSendsPerWindow: 5,
    loginLinkWindowSecs: 3600,
    loginLinkMaxSendsPerIpWindow: 10,
    ...overrides,
  };
}

describe.skipIf(SKIP)('authPlugin JWT verification (integration)', () => {
  let db: ReturnType<typeof createDatabase>;
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    db = createDatabase(process.env['DATABASE_URL']!);

    app = Fastify({ logger: false });
    await authPlugin(app, { config: makeAuthConfig(), db });
    app.get('/protected', async (req) => ({ userId: req.userId, planId: req.userPlanId }));
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Delete in FK-safe order: sessions depend on users
    await db.execute(sql`TRUNCATE sessions, oauth_identities, user_plans, users CASCADE`);
  });

  async function seedUser(id = 'u-integ-1', planId = 'free') {
    const email = `${id}@integration-test.local`;
    const username = email.split('@')[0]!.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    const displayName = username
      .split('_')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
    await db.insert(users).values({
      id,
      username,
      displayName,
      email,
      planId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  async function seedSession(
    userId: string,
    opts: { revokedAt?: Date; expiresAt?: Date } = {},
  ) {
    const id = crypto.randomUUID();
    await db.insert(sessions).values({
      id,
      userId,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000),
      revokedAt: opts.revokedAt ?? null,
      createdAt: new Date(),
    });
    return id;
  }

  it('valid JWT with active session → 200 with correct userId and planId', async () => {
    const userId = await seedUser('u-valid', 'pro');
    const sessionId = await seedSession(userId);
    const token = await createSessionToken(makeAuthConfig(), userId, sessionId);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { userId: string; planId: string };
    expect(body.userId).toBe(userId);
    expect(body.planId).toBe('pro');
  });

  it('valid JWT but session is revoked → 401', async () => {
    const userId = await seedUser('u-revoked');
    const sessionId = await seedSession(userId, { revokedAt: new Date() });
    const token = await createSessionToken(makeAuthConfig(), userId, sessionId);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('valid JWT but session is expired → 401', async () => {
    const userId = await seedUser('u-expired');
    const sessionId = await seedSession(userId, { expiresAt: new Date(Date.now() - 1000) });
    const token = await createSessionToken(makeAuthConfig(), userId, sessionId);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('valid JWT but session row does not exist in DB → 401', async () => {
    const userId = await seedUser('u-no-session');
    // Seed user but NOT the session — token references a non-existent session
    const phantomSessionId = crypto.randomUUID();
    const token = await createSessionToken(makeAuthConfig(), userId, phantomSessionId);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('no Authorization header → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
  });

  it('malformed Bearer token → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: 'Bearer this-is-not-a-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('OPTIONS request bypasses auth (CORS preflight)', async () => {
    // OPTIONS is exempted by isPublicRoute — must not return 401
    const res = await app.inject({ method: 'OPTIONS', url: '/protected' });
    expect(res.statusCode).not.toBe(401);
  });

  it('GET /events bypasses header auth so the WebSocket handler can validate ?token itself', async () => {
    const res = await app.inject({ method: 'GET', url: '/events?token=test' });
    expect(res.statusCode).not.toBe(401);
  });

  it('expired JWT signature is rejected before hitting the DB', async () => {
    const userId = await seedUser('u-expired-jwt');
    const sessionId = await seedSession(userId);

    // Sign a token that expired 1 second ago using the jose library directly
    const secret = new TextEncoder().encode(TEST_JWT_SECRET);
    const expiredToken = await new jose.SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setJti(sessionId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 10)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 5)
      .sign(secret);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${expiredToken}` },
    });

    expect(res.statusCode).toBe(401);
  });
});
