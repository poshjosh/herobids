/**
 * Functional tests for export routes.
 * Requires a live DATABASE_URL and REDIS_URL.
 * Automatically skipped when those env vars are absent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SKIP, buildApp, truncateAll, registerUser } from './helpers.js';
import type { createDatabase } from '@herobids/db';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ctx: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  if (SKIP) return;
  ctx = await buildApp();
});

afterAll(async () => {
  if (SKIP) return;
  await truncateAll(ctx.db);
  await ctx.redisClient.quit();
  await ctx.lifecycleQueue.close();
  await ctx.app.close();
});

beforeEach(async () => {
  if (SKIP) return;
  await truncateAll(ctx.db);
});

describe.skipIf(SKIP)('Export routes — functional', () => {
  describe('GET /export/trades', () => {
    it('returns empty CSV with headers when user has no bots', async () => {
      const token = await registerUser(ctx.app);

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/export/trades',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.body).toBe('date,side,symbol,quantity,price,pnl,fee,sessionId');
    });

    it('returns JSON empty array when user has no bots', async () => {
      const token = await registerUser(ctx.app);

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/export/trades?format=json',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.json()).toEqual([]);
    });

    it('requires authentication', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/export/trades' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /export/bundle', () => {
    it('returns a valid ZIP file', async () => {
      const token = await registerUser(ctx.app);

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/export/bundle',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/zip/);
      const buf = Buffer.from(res.rawPayload);
      // ZIP magic bytes PK\x03\x04
      expect(buf[0]).toBe(0x50);
      expect(buf[1]).toBe(0x4b);
    });
  });

  describe('GET /bots/:id/export/trades — non-existent bot', () => {
    it('returns 404 for a bot not owned by the user', async () => {
      const token = await registerUser(ctx.app);

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/bots/non-existent-bot/export/trades',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('Export rate limiting', () => {
    it('returns 429 on the 6th export request within 1 minute', async () => {
      const token = await registerUser(ctx.app, 'ratelimit@test.com');

      // Make 5 successful requests
      for (let i = 0; i < 5; i++) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: '/export/trades',
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
      }

      // 6th should be rate-limited
      const res6 = await ctx.app.inject({
        method: 'GET',
        url: '/export/trades',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res6.statusCode).toBe(429);
      expect(res6.headers['retry-after']).toBeDefined();
    });
  });

  describe('GET /agents/:id/export/config — unknown agent', () => {
    it('returns 404 for an agent not owned by the user', async () => {
      const token = await registerUser(ctx.app);

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/agents/non-existent/export/config',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
