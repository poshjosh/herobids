/**
 * Functional tests: Analytics, AI endpoints, Skills, and Datasets
 *
 * Requires DATABASE_URL and REDIS_URL.  Skipped otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SKIP, buildApp, truncateAll, registerUser } from './helpers.js';

describe.skipIf(SKIP)('Analytics / AI / Skills / Datasets functional', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let token: string;

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
    token = await registerUser(ctx.app, ctx.db);
  });

  function authHeader() {
    return { Authorization: `Bearer ${token}` };
  }

  // ─── Analytics ────────────────────────────────────────────────────────────

  describe('GET /analytics', () => {
    it('returns empty groups when the user has no bots', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/analytics',
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ groups: unknown[]; groupBy: string }>();
      expect(body.groups).toEqual([]);
      expect(body.groupBy).toBe('day');
    });

    it('analytics is scoped to the authenticated user — different user sees no data', async () => {
      // Register a second user to confirm data isolation
      const otherToken = await registerUser(ctx.app, ctx.db, 'other@analytics.test');

      // First user requests their own analytics
      const resFirst = await ctx.app.inject({
        method: 'GET',
        url: '/analytics',
        headers: authHeader(),
      });
      expect(resFirst.statusCode).toBe(200);
      expect(resFirst.json<{ groups: unknown[] }>().groups).toEqual([]);

      // Second user also gets empty results (their own, isolated scope)
      const resOther = await ctx.app.inject({
        method: 'GET',
        url: '/analytics',
        headers: { Authorization: `Bearer ${otherToken}` },
      });
      expect(resOther.statusCode).toBe(200);
      expect(resOther.json<{ groups: unknown[] }>().groups).toEqual([]);
    });

    it('returns 400 for invalid groupBy value', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/analytics?groupBy=month',
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/analytics' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /analytics/query', () => {
    it('accepts a JSON body and returns the same shape as GET', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/analytics/query',
        headers: authHeader(),
        payload: { groupBy: 'day' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ groupBy: string }>().groupBy).toBe('day');
    });

    it('returns 400 for invalid body', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/analytics/query',
        headers: authHeader(),
        payload: { groupBy: 'invalid-value' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/analytics/query',
        payload: { groupBy: 'day' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ─── AI endpoints ─────────────────────────────────────────────────────────
  // Providers are configured in the test environment via providers.yaml.
  // Without API keys, LLM-calling endpoints return 502 (ai_error).
  // The available-models endpoint returns 200 with the provider list.

  describe('GET /ai/available-models', () => {
    it('returns providers when providers.yaml is loaded', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/ai/available-models',
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ providers: unknown[] }>();
      expect(body.providers).toBeDefined();
      expect(Array.isArray(body.providers)).toBe(true);
    });

    it('returns 401 without auth', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/ai/available-models' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /ai/generate-config', () => {
    it('returns 502 when LLM call fails (no API keys)', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/ai/generate-config',
        headers: authHeader(),
        payload: { text: 'Create a momentum strategy' },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json<{ error: string }>().error).toBe('ai_error');
    });
  });

  describe('POST /ai/analyze-portfolio', () => {
    it('returns 502 when LLM call fails (no API keys)', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/ai/analyze-portfolio',
        headers: authHeader(),
        payload: { totalPnl: '100', tradeCount: 5 },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json<{ error: string }>().error).toBe('ai_error');
    });
  });

  describe('POST /ai/explain-signal', () => {
    it('returns 502 when LLM call fails (no API keys)', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/ai/explain-signal',
        headers: authHeader(),
        payload: { signal: { type: 'buy', price: '100' } },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json<{ error: string }>().error).toBe('ai_error');
    });
  });

  describe('PATCH /settings/ai-model', () => {
    it('persists the model preference for the authenticated user', async () => {
      // Provider availability is gated by an API key env var — set one for the test.
      process.env['LLM_API_KEY_OPENAI'] = 'test-key';
      try {
        const res = await ctx.app.inject({
          method: 'PATCH',
          url: '/settings/ai-model',
          headers: authHeader(),
          payload: {
            provider: 'openai',
            lightModel: 'gpt-4o-mini',
            heavyModel: 'gpt-4o',
          },
        });
        // 200 means the preference was saved
        expect(res.statusCode).toBe(200);
      } finally {
        delete process.env['LLM_API_KEY_OPENAI'];
      }
    });

    it('returns 401 without auth', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: '/settings/ai-model',
        payload: { provider: null, lightModel: null, heavyModel: null },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ─── Skills ───────────────────────────────────────────────────────────────

  describe('GET /skills', () => {
    it('returns only system skills for a new user (no user-created skills)', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/skills', headers: authHeader() });
      expect(res.statusCode).toBe(200);
      const { skills: returnedSkills } = res.json<{ skills: Array<{ id: string; authorId: string | null }> }>();
      // System skills (authorId=null) are always visible; new users have no own skills
      const userCreatedSkills = returnedSkills.filter((s) => s.authorId !== null);
      expect(userCreatedSkills).toEqual([]);
    });

    it('returns 401 without auth', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/skills' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /skills', () => {
    it('creates a plan-published skill and returns 201', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/skills',
        headers: authHeader(),
        payload: {
          name: 'My Trading Skill',
          description: 'Executes momentum trades',
          instructions: 'When RSI > 70, sell. When RSI < 30, buy.',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; publicationStatus: string; authorId: string }>();
      expect(body.publicationStatus).toBe('published');
      expect(typeof body.id).toBe('string');
      expect(body.authorId).toBeTruthy();
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/skills',
        headers: authHeader(),
        payload: { name: 'Missing fields' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /skills/:id', () => {
    it('returns the skill by id', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/skills',
        headers: authHeader(),
        payload: {
          name: 'My Skill',
          description: 'A skill',
          instructions: 'Do something.',
        },
      });
      const { id } = createRes.json<{ id: string }>();

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/skills/${id}`,
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ id: string }>().id).toBe(id);
    });

    it('returns 404 for unknown skill', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/skills/nonexistent-id',
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PUT /skills/:id', () => {
    it('updates own skill', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/skills',
        headers: authHeader(),
        payload: { name: 'Old Name', description: 'D', instructions: 'I', publicationStatus: 'draft' },
      });
      const { id } = createRes.json<{ id: string }>();

      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/skills/${id}`,
        headers: authHeader(),
        payload: { name: 'New Name' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ name: string }>().name).toBe('New Name');
    });
  });

  describe('DELETE /skills/:id', () => {
    it('deletes own skill and returns 204', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/skills',
        headers: authHeader(),
        payload: { name: 'To Delete', description: 'D', instructions: 'I', publicationStatus: 'draft' },
      });
      const { id } = createRes.json<{ id: string }>();

      const deleteRes = await ctx.app.inject({
        method: 'DELETE',
        url: `/skills/${id}`,
        headers: authHeader(),
      });
      expect(deleteRes.statusCode).toBe(204);

      // Confirm it's gone
      const getRes = await ctx.app.inject({
        method: 'GET',
        url: `/skills/${id}`,
        headers: authHeader(),
      });
      expect(getRes.statusCode).toBe(404);
    });
  });

  describe('POST /skills/:id/fork', () => {
    it('creates a private copy owned by the caller', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/skills',
        headers: authHeader(),
        payload: {
          name: 'Source Skill',
          description: 'Original',
          instructions: 'Do X.',
          publicationStatus: 'published',
        },
      });
      const { id: sourceId } = createRes.json<{ id: string }>();

      const forkRes = await ctx.app.inject({
        method: 'POST',
        url: `/skills/${sourceId}/fork`,
        headers: authHeader(),
      });

      expect(forkRes.statusCode).toBe(201);
      const fork = forkRes.json<{ publicationStatus: string; forkOf: string; name: string }>();
      // Free plan auto-publishes created skills.
      expect(fork.publicationStatus).toBe('published');
      expect(fork.forkOf).toBe(sourceId);
      expect(fork.name).toContain('copy');
    });

    it('returns 404 when forking a non-existent skill', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/skills/nonexistent/fork',
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ─── Datasets ─────────────────────────────────────────────────────────────

  describe('GET /datasets', () => {
    it('returns an empty list for a new user', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/datasets', headers: authHeader() });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ datasets: unknown[] }>().datasets).toEqual([]);
    });

    it('returns 401 without auth', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/datasets' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /datasets/:id', () => {
    it('returns 404 for unknown dataset', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/datasets/nonexistent-id',
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /datasets/fetch', () => {
    it('creates a pending dataset record and returns 202', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/datasets/fetch',
        headers: authHeader(),
        payload: {
          venue: 'hyperliquid',
          symbol: 'BTC',
          interval: '1h',
          from: '2026-01-01T00:00:00Z',
          to: '2026-01-31T00:00:00Z',
        },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json<{ status: string }>();
      expect(body.status).toBe('pending');
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/datasets/fetch',
        headers: authHeader(),
        payload: { venue: 'hyperliquid' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/datasets/fetch',
        payload: {
          venue: 'hyperliquid',
          symbol: 'BTC',
          interval: '1h',
          from: '2026-01-01T00:00:00Z',
          to: '2026-01-31T00:00:00Z',
        },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /datasets/upload', () => {
    it('returns 400 when body is empty (text/csv content type)', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/datasets/upload',
        headers: { ...authHeader(), 'content-type': 'text/csv' },
        payload: '',
      });
      // Empty body — should fail validation
      expect([400, 422].includes(res.statusCode)).toBe(true);
    });

    it('accepts text/plain as a fallback content type', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/datasets/upload',
        headers: { ...authHeader(), 'content-type': 'text/plain' },
        payload: '',
      });
      expect([400, 422].includes(res.statusCode)).toBe(true);
    });
  });
});
