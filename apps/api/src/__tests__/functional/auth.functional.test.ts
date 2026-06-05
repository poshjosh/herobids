/**
 * Functional tests: Auth flows (register, login, /auth/me)
 *
 * These tests require DATABASE_URL and REDIS_URL pointing at real infrastructure.
 * Skipped automatically when DATABASE_URL is absent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SKIP, buildApp, truncateAll } from './helpers.js';

describe.skipIf(SKIP)('Auth functional', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ctx = await buildApp();
  }, 30_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.redisClient.quit();
    await ctx.lifecycleQueue.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.db);
  });

  describe('POST /auth/register', () => {
    it('creates a user and returns a token', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'alice@test.com', password: 'password123', displayName: 'Alice' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ token: string }>();
      expect(typeof body.token).toBe('string');
      expect(body.token.length).toBeGreaterThan(0);
    });

    it('returns 409 when registering with a duplicate email', async () => {
      await ctx.app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'alice@test.com', password: 'password123', displayName: 'Alice' },
      });

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'alice@test.com', password: 'other-password', displayName: 'Alice2' },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  describe('POST /auth/login', () => {
    it('returns a token for valid credentials', async () => {
      await ctx.app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'bob@test.com', password: 'hunter2', displayName: 'Bob' },
      });

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'bob@test.com', password: 'hunter2' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ token: string }>();
      expect(typeof body.token).toBe('string');
    });

    it('returns 401 for wrong password', async () => {
      await ctx.app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'carol@test.com', password: 'correct', displayName: 'Carol' },
      });

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'carol@test.com', password: 'wrong' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 401 for unknown email without revealing existence', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nobody@test.com', password: 'whatever' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /auth/me', () => {
    it('returns user profile when authenticated', async () => {
      const registerRes = await ctx.app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'dana@test.com', password: 'pass1234', displayName: 'Dana' },
      });
      const { token } = registerRes.json<{ token: string }>();

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ email: string; displayName: string }>();
      expect(body.email).toBe('dana@test.com');
      expect(body.displayName).toBe('Dana');
    });

    it('returns 401 without a token', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/auth/me' });
      expect(res.statusCode).toBe(401);
    });
  });
});
