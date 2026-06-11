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
  async function createAgent(token: string, name = 'Test Agent', prompt = 'Do something.'): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents',
      headers: { Authorization: `Bearer ${token}` },
      payload: { name, prompt, skillIds: [] },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  describe('GET /export/trades — agent-first aggregate export', () => {
    it('returns empty CSV with headers when user has no agents', async () => {
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

    it('returns JSON empty array when user has no agents', async () => {
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

  describe('GET /export/bundle — agent-first bundle export', () => {
    it('returns a valid ZIP file with agent exports', async () => {
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

    it('requires authentication', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/export/bundle' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('Agent-scoped export routes', () => {
    it('GET /agents/:id/export/config returns config for existing agent', async () => {
      const token = await registerUser(ctx.app);
      const agentId = await createAgent(token);

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${agentId}/export/config`,
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain(agentId);
    });

    it('GET /agents/:id/export/config returns 404 for non-existent agent', async () => {
      const token = await registerUser(ctx.app);

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/agents/non-existent/export/config',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('GET /agents/:id/export/trades returns CSV for existing agent', async () => {
      const token = await registerUser(ctx.app);
      const agentId = await createAgent(token);

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${agentId}/export/trades`,
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
    });

    it('GET /agents/:id/export/journal returns CSV for existing agent', async () => {
      const token = await registerUser(ctx.app);
      const agentId = await createAgent(token);

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${agentId}/export/journal`,
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
    });

    it('GET /agents/:id/export/costs returns CSV for existing agent', async () => {
      const token = await registerUser(ctx.app);
      const agentId = await createAgent(token);

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${agentId}/export/costs`,
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
    });
  });

  describe('Bot-scoped export routes (advanced trading surface)', () => {
    it('GET /bots/:id/export/trades returns 404 for non-existent bot', async () => {
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
});
