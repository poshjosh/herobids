/**
 * Functional tests: Execution mode immutability and Go Live clone flow.
 *
 * Requires DATABASE_URL and REDIS_URL.  Skipped otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SKIP, buildApp, truncateAll, registerUser } from './helpers.js';
import { users } from '@herobids/db';
import { eq } from 'drizzle-orm';

describe.skipIf(SKIP)('Execution Mode Immutability & Go Live', () => {
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

  /** Create an agent in paper mode with trading skill. */
  async function createPaperAgent(name = 'Paper Agent', prompt = 'Trade BTC.') {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents',
      headers: authHeader(),
      payload: {
        name,
        prompt,
        skillIds: ['trading'],
        executionDefaults: { mode: 'paper' },
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string; name: string; status: string }>();
  }

  /** Create a Hyperliquid connection and return its ID. */
  async function createConnection(label = 'hl-go-live-test') {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      headers: authHeader(),
      payload: {
        provider: 'hyperliquid',
        label,
        secrets: {
          apiKey: 'test-key',
          secret: 'test-secret',
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        capability: 'trading',
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ connection: { id: string } }>().connection.id;
  }

  /** Grant a connection to an agent via PATCH. */
  async function grantConnection(agentId: string, connectionId: string) {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/agents/${agentId}`,
      headers: authHeader(),
      payload: { connectionIds: [connectionId] },
    });
    expect(res.statusCode).toBe(200);
    return res;
  }

  /** Promote current test user to admin so plan checks (liveEnabled) are bypassed. */
  async function promoteToAdmin() {
    const meRes = await ctx.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader(),
    });
    const userId = meRes.json<{ id: string }>().id;
    await ctx.db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
  }

  /** Get agent by ID. */
  async function getAgent(agentId: string) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    return res.json<Record<string, unknown>>();
  }

  // ─── 1. Complete mode immutability + Go Live flow ─────────────────────────

  describe('complete mode immutability + Go Live flow', () => {
    it('rejects mode change via PATCH, rejects via PUT, clones via go-live, and preserves source', async () => {
      // 1. Create agent in paper mode
      const agent = await createPaperAgent();
      expect((await ctx.getProfile(agent.id))?.executionDefaults?.mode).toBe('paper');

      // 2. Attempt to change mode to live via PATCH → 400
      const patchRes = await ctx.app.inject({
        method: 'PATCH',
        url: `/agents/${agent.id}`,
        headers: authHeader(),
        payload: { executionDefaults: { mode: 'live' } },
      });
      expect(patchRes.statusCode).toBe(400);
      const patchBody = patchRes.json<{ error: string; details: Array<{ message: string }> }>();
      expect(patchBody.error).toBe('validation_error');
      expect(patchBody.details[0]!.message).toMatch(/cannot be changed/i);

      // 3. Attempt to change mode to live via PUT → 400
      const putRes = await ctx.app.inject({
        method: 'PUT',
        url: `/agents/${agent.id}`,
        headers: authHeader(),
        payload: { name: agent.name, prompt: 'Trade BTC.', executionMode: 'live' },
      });
      expect(putRes.statusCode).toBe(400);
      const putBody = putRes.json<{ error: string; details: Array<{ message: string }> }>();
      expect(putBody.error).toBe('validation_error');
      expect(putBody.details[0]!.message).toMatch(/cannot be changed/i);

      // 4. Set up for go-live: grant connection + promote to admin (plan bypass)
      const connectionId = await createConnection();
      await grantConnection(agent.id, connectionId);
      await promoteToAdmin();

      // 5. Call POST /agents/:id/go-live → 201
      const goLiveRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${agent.id}/go-live`,
        headers: authHeader(),
      });
      expect(goLiveRes.statusCode).toBe(201);
      const liveAgent = goLiveRes.json<Record<string, unknown>>();

      // 6. Verify source agent still in shadow mode (auto-upgraded from paper on connection grant) and unchanged by go-live
      expect((await ctx.getProfile(agent.id))?.executionDefaults?.mode).toBe('shadow');
      // Agent was auto-upgraded paper→shadow when connection was granted, which is expected

      // 7. Verify new agent in live mode, stopped, same config
      expect((await ctx.getProfile(liveAgent.id as string))?.executionDefaults?.mode).toBe('live');
      expect(liveAgent.status).toBe('stopped');
      expect(liveAgent.id).not.toBe(agent.id);
      expect(liveAgent.name).toBe(`${agent.name} (Live)`);

      // 8. Attempt to change the new live agent's mode to paper via PATCH → 400
      const livePatchRes = await ctx.app.inject({
        method: 'PATCH',
        url: `/agents/${liveAgent.id}`,
        headers: authHeader(),
        payload: { executionDefaults: { mode: 'paper' } },
      });
      expect(livePatchRes.statusCode).toBe(400);
      const livePatchBody = livePatchRes.json<{ error: string; details: Array<{ message: string }> }>();
      expect(livePatchBody.details[0]!.message).toMatch(/cannot be changed/i);

      // 9. Attempt to change the new live agent's mode to shadow via PUT → 400
      const livePutRes = await ctx.app.inject({
        method: 'PUT',
        url: `/agents/${liveAgent.id}`,
        headers: authHeader(),
        payload: { name: liveAgent.name as string, prompt: 'Trade BTC.', executionMode: 'shadow' },
      });
      expect(livePutRes.statusCode).toBe(400);
    });

    it('preserves authored unifiedConfig fields in the cloned live agent', async () => {
      const agent = await createPaperAgent('Config Agent', 'Trade with strategy.');
      const connectionId = await createConnection('hl-config-test');
      await grantConnection(agent.id, connectionId);
      await promoteToAdmin();

      const goLiveRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${agent.id}/go-live`,
        headers: authHeader(),
      });
      expect(goLiveRes.statusCode).toBe(201);
      const liveAgent = goLiveRes.json<Record<string, unknown>>();

      // Verify the cloned agent has live mode and stopped status
      expect((await ctx.getProfile(liveAgent.id as string))?.executionDefaults?.mode).toBe('live');
      expect(liveAgent.status).toBe('stopped');

      // Verify source-originated fields are present on the live clone
      const liveDetail = await getAgent(liveAgent.id as string);
      expect(liveDetail.prompt).toBe('Trade with strategy.');

      // Verify no stale blueprint attribution
      expect(liveDetail.blueprintId).toBeNull();
      expect(liveDetail.blueprintRevisionId).toBeNull();
    });
  });

  // ─── 2. Paper↔shadow auto-transition regression ──────────────────────────

  describe('paper↔shadow auto-transition regression', () => {
    it('auto-transitions paper→shadow on connection grant and back on revoke', async () => {
      // 1. Create agent in paper mode with no connections
      const agent = await createPaperAgent('Auto Transition Agent');
      expect((await ctx.getProfile(agent.id))?.executionDefaults?.mode).toBe('paper');

      // 2. Grant a connection → verify resolves to shadow
      const connectionId = await createConnection('hl-auto-transition');
      const grantRes = await ctx.app.inject({
        method: 'PATCH',
        url: `/agents/${agent.id}`,
        headers: authHeader(),
        payload: { connectionIds: [connectionId] },
      });
      expect(grantRes.statusCode).toBe(200);

      expect((await ctx.getProfile(agent.id))?.executionDefaults?.mode).toBe('shadow');

      // 3. Revoke connection (empty connectionIds) → verify resolves back to paper
      const revokeRes = await ctx.app.inject({
        method: 'PATCH',
        url: `/agents/${agent.id}`,
        headers: authHeader(),
        payload: { connectionIds: [] },
      });
      expect(revokeRes.statusCode).toBe(200);

      expect((await ctx.getProfile(agent.id))?.executionDefaults?.mode).toBe('paper');
    });

    it('allows explicit paper→shadow and shadow→paper transitions via PATCH', async () => {
      // Create agent in paper mode with a connection (so shadow is reachable)
      const agent = await createPaperAgent('Explicit Transition Agent');
      const connectionId = await createConnection('hl-explicit-transition');
      await grantConnection(agent.id, connectionId);

      // Agent auto-upgraded to shadow on connection grant
      expect((await ctx.getProfile(agent.id))?.executionDefaults?.mode).toBe('shadow');

      // Explicit shadow→paper via PATCH (test↔test is allowed)
      const toPaperRes = await ctx.app.inject({
        method: 'PATCH',
        url: `/agents/${agent.id}`,
        headers: authHeader(),
        payload: { executionDefaults: { mode: 'paper' } },
      });
      expect(toPaperRes.statusCode).toBe(200);

      expect((await ctx.getProfile(agent.id))?.executionDefaults?.mode).toBe('paper');

      // Explicit paper→shadow via PATCH (test↔test is allowed)
      const toShadowRes = await ctx.app.inject({
        method: 'PATCH',
        url: `/agents/${agent.id}`,
        headers: authHeader(),
        payload: { executionDefaults: { mode: 'shadow' } },
      });
      expect(toShadowRes.statusCode).toBe(200);

      expect((await ctx.getProfile(agent.id))?.executionDefaults?.mode).toBe('shadow');
    });
  });

  // ─── 3. Go Live validation cases ─────────────────────────────────────────

  describe('Go Live validation cases', () => {
    it('rejects when source agent is already live', async () => {
      // Create agent and set up for live
      const agent = await createPaperAgent('Already Live Source');
      const connectionId = await createConnection('hl-already-live');
      await grantConnection(agent.id, connectionId);
      await promoteToAdmin();

      // Go Live to create a live agent
      const goLiveRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${agent.id}/go-live`,
        headers: authHeader(),
      });
      expect(goLiveRes.statusCode).toBe(201);
      const liveAgent = goLiveRes.json<{ id: string }>();

      // Attempt Go Live on the already-live agent → 400
      const rejectRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${liveAgent.id}/go-live`,
        headers: authHeader(),
      });
      expect(rejectRes.statusCode).toBe(400);
      expect(rejectRes.json<{ message: string }>().message).toMatch(/already.*live/i);
    });

    it('rejects when no active connections', async () => {
      const agent = await createPaperAgent('No Connections Agent');
      await promoteToAdmin();

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${agent.id}/go-live`,
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toMatch(/connection/i);
    });

    it('rejects when plan does not allow live (non-admin)', async () => {
      // Default test plan has liveEnabled: false
      const agent = await createPaperAgent('Plan Check Agent');
      const connectionId = await createConnection('hl-plan-check');
      await grantConnection(agent.id, connectionId);

      // Do NOT promote to admin — plan check should block
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${agent.id}/go-live`,
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string }>().error).toMatch(/plan/i);
    });

    it('returns 404 when agent not found', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/agents/00000000-0000-0000-0000-000000000000/go-live',
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ─── 4. Go Live field preservation ────────────────────────────────────────

  describe('Go Live field preservation', () => {
    it('new agent has correct mode, status, and name', async () => {
      const agent = await createPaperAgent('Field Check Agent', 'Monitor SOL.');
      const connectionId = await createConnection('hl-field-check');
      await grantConnection(agent.id, connectionId);
      await promoteToAdmin();

      const goLiveRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${agent.id}/go-live`,
        headers: authHeader(),
      });
      expect(goLiveRes.statusCode).toBe(201);
      const liveAgent = goLiveRes.json<Record<string, unknown>>();

      expect((await ctx.getProfile(liveAgent.id as string))?.executionDefaults?.mode).toBe('live');
      expect(liveAgent.status).toBe('stopped');
      expect(liveAgent.name).toBe('Field Check Agent (Live)');
    });

    it('new agent does NOT have source blueprintId or blueprintRevisionId', async () => {
      const agent = await createPaperAgent('Blueprint Check Agent');
      const connectionId = await createConnection('hl-blueprint-check');
      await grantConnection(agent.id, connectionId);
      await promoteToAdmin();

      const goLiveRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${agent.id}/go-live`,
        headers: authHeader(),
      });
      expect(goLiveRes.statusCode).toBe(201);
      const liveAgent = goLiveRes.json<Record<string, unknown>>();

      expect(liveAgent.blueprintId).toBeNull();
      expect(liveAgent.blueprintRevisionId).toBeNull();
    });

    it('custom name override works', async () => {
      const agent = await createPaperAgent('Name Override Agent');
      const connectionId = await createConnection('hl-name-override');
      await grantConnection(agent.id, connectionId);
      await promoteToAdmin();

      const goLiveRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${agent.id}/go-live`,
        headers: authHeader(),
        payload: { name: 'My Custom Live Agent' },
      });
      expect(goLiveRes.statusCode).toBe(201);
      const liveAgent = goLiveRes.json<{ name: string }>();
      expect(liveAgent.name).toBe('My Custom Live Agent');
    });

    it('preserves strategy and risk config from source', async () => {
      // Create agent with explicit risk and capital config
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: {
          name: 'Risk Config Agent',
          prompt: 'Trade carefully.',
          skillIds: ['trading'],
          executionDefaults: { mode: 'paper' },
          capital: '1000.00',
          style: 'careful',
        },
      });
      expect(createRes.statusCode).toBe(201);
      const agent = createRes.json<{ id: string; style: string | null }>();
      const agentId = agent.id;

      const connectionId = await createConnection('hl-risk-config');
      await grantConnection(agentId, connectionId);
      await promoteToAdmin();

      const goLiveRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${agentId}/go-live`,
        headers: authHeader(),
      });
      expect(goLiveRes.statusCode).toBe(201);
      const liveAgent = goLiveRes.json<Record<string, unknown>>();
      const liveAgentId = liveAgent.id as string;

      expect((await ctx.getProfile(liveAgentId))?.executionDefaults?.mode).toBe('live');
      // Capital is normalized through the blueprint Decimal path (trailing zeros
      // dropped), so assert the numeric value rather than the exact string.
      expect(Number((await ctx.getProfile(liveAgentId))?.capital)).toBe(1000);
      expect(liveAgent.style).toBe('careful');
    });
  });
});
