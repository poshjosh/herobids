/**
 * Functional tests: Agent CRUD and lifecycle (create, list, get, start, pause, resume, stop, delete)
 *
 * Requires DATABASE_URL and REDIS_URL.  Skipped otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SKIP, buildApp, truncateAll, registerUser } from './helpers.js';
import { agentRuntimeSessions, agentArtifacts, agentOutboundMessages, marketAssessmentRequests, billingAccounts, agents, users } from '@herobids/db';
import { eq } from 'drizzle-orm';

describe.skipIf(SKIP)('Agents functional', () => {
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

  describe('POST /agents', () => {
    it('creates an agent and returns 201', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: {
          name: 'Test Agent',
          prompt: 'Watch the market and alert me when BTC drops 5%.',
          skillIds: [],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; status: string; name: string }>();
      expect(body.status).toBe('stopped');
      expect(body.name).toBe('Test Agent');
      expect(typeof body.id).toBe('string');
    });

    it('returns 400 for missing required fields', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: '' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('accepts a non-trading agent without executionDefaults', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: {
          name: 'Personal Assistant Agent',
          prompt: 'Remind me to pray at 07:45 Berlin time.',
          skillIds: ['task-management', 'web-access'],
        },
      });

      // Non-trading agents don't require executionDefaults.
      expect(res.statusCode).toBe(201);
      const body = res.json<Record<string, unknown>>();
      // executionDefaults is no longer echoed on the agent response (C1 moved
      // it into the traderton profile); a non-trading agent simply omits it.
      expect(body.executionDefaults).toBeUndefined();
    });

    it('returns 401 without auth', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        payload: { name: 'X', prompt: 'Y' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /agents', () => {
    it('returns an empty array for a new user', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/agents', headers: authHeader() });
      expect(res.statusCode).toBe(200);
      expect(res.json<unknown[]>()).toEqual([]);
    });

    it('returns only the current user\'s agents', async () => {
      // Create one agent for the primary user
      await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'My Agent', prompt: 'Do something.' },
      });

      // Create a second user with their own agent
      const otherToken = await registerUser(ctx.app, ctx.db, 'other@test.com');
      await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: { Authorization: `Bearer ${otherToken}` },
        payload: { name: 'Other Agent', prompt: 'Do something else.' },
      });

      const res = await ctx.app.inject({ method: 'GET', url: '/agents', headers: authHeader() });
      const agents = res.json<Array<{ name: string }>>();
      expect(agents.length).toBe(1);
      expect(agents[0]!.name).toBe('My Agent');
    });
  });

  describe('GET /agents/:id', () => {
    it('returns 404 for unknown agent', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/agents/nonexistent-id',
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns the agent with an activeSession field', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'Detail Agent', prompt: 'Do nothing.' },
      });
      const { id } = createRes.json<{ id: string }>();

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${id}`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: string; activeSession: unknown }>();
      expect(body.id).toBe(id);
      expect(body.activeSession).toBeNull();
    });
  });

  describe('POST /agents/:id/start', () => {
    it('transitions a stopped agent to starting', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'Start Agent', prompt: 'Trade BTC.' },
      });
      const { id } = createRes.json<{ id: string }>();

      const startRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/start`,
        headers: authHeader(),
      });

      expect(startRes.statusCode).toBe(202);
      const body = startRes.json<{ status: string; sessionId: string }>();
      expect(body.status).toBe('starting');
      expect(typeof body.sessionId).toBe('string');

      // Verify DB state
      const agentRes = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${id}`,
        headers: authHeader(),
      });
      expect(agentRes.json<{ status: string }>().status).toBe('starting');
    });

    it('returns 409 when agent is already starting', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'Double Start', prompt: 'Trade.' },
      });
      const { id } = createRes.json<{ id: string }>();

      await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/start`,
        headers: authHeader(),
      });

      const secondStart = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/start`,
        headers: authHeader(),
      });

      expect(secondStart.statusCode).toBe(409);
    });
  });

  describe('POST /agents/:id/pause and /resume', () => {
    it('pauses an active agent and resumes it', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'Pause Agent', prompt: 'Do work.' },
      });
      const { id } = createRes.json<{ id: string }>();

      // Manually set to active via DB for this test (start requires worker)
      const { agents } = await import('@herobids/db');
      const { eq } = await import('drizzle-orm');
      await ctx.db.update(agents).set({ status: 'active' }).where(eq(agents.id, id));

      const pauseRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/pause`,
        headers: authHeader(),
        payload: { reason: 'Manual pause from test' },
      });
      expect(pauseRes.statusCode).toBe(200);
      expect(pauseRes.json<{ status: string }>().status).toBe('paused');

      const resumeRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/resume`,
        headers: authHeader(),
      });
      expect(resumeRes.statusCode).toBe(200);
      expect(resumeRes.json<{ status: string }>().status).toBe('active');
    });

    it('returns 409 when trying to resume a non-paused agent', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'Resume Check', prompt: 'Do nothing.' },
      });
      const { id } = createRes.json<{ id: string }>();

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/resume`,
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('DELETE /agents/:id', () => {
    it('cascade-deletes dependent rows (sessions, artifacts, outbound messages, market assessment requests) with the agent', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'With Children', prompt: 'I have dependents.' },
      });
      expect(createRes.statusCode).toBe(201);
      const { id } = createRes.json<{ id: string }>();

      // Look up the agent's userId for seeding FK-dependent rows.
      const [agentRow] = await ctx.db.select({ userId: agents.userId }).from(agents).where(eq(agents.id, id));
      const userId = agentRow!.userId;

      // Seed one row in each cascade-target table.
      await ctx.db.insert(agentRuntimeSessions).values({
        id: 'sess-cascade-test',
        agentId: id,
        status: 'stopped',
        startedAt: new Date(),
        stoppedAt: new Date(),
      });
      await ctx.db.insert(agentArtifacts).values({
        id: 'art-cascade-test',
        agentId: id,
        sessionId: 'sess-cascade-test',
        artifactType: 'tool_trace',
        contentType: 'application/json',
        summary: 'test artifact',
        retentionClass: 'ephemeral',
      });
      await ctx.db.insert(agentOutboundMessages).values({
        id: 'msg-cascade-test',
        agentId: id,
        authoredBy: 'platform',
        body: 'cascade test message',
        deliveryStatus: 'pending',
      });

      // Seed a billing account first (required FK for market_assessment_requests).
      await ctx.db.insert(billingAccounts).values({
        id: 'ba-cascade-test',
        ownerUserId: userId,
        status: 'active',
        activePlanId: 'free',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Seed a market_assessment_requests row to verify ON DELETE CASCADE works
      // (bug 2026-08-02-002: was NO ACTION, causing FK violation on agent delete).
      await ctx.db.insert(marketAssessmentRequests).values({
        id: 'mar-cascade-test',
        agentId: id,
        userId,
        billingAccountId: 'ba-cascade-test',
        instrumentKind: 'orderbook',
        venueFamily: 'hyperliquid',
        styleTier: 'standard',
        symbol: 'BTC',
        status: 'assessment_completed',
        requestGroupKey: 'mar-cascade-test-grp',
        requestedAt: new Date(),
      });

      const deleteRes = await ctx.app.inject({
        method: 'DELETE',
        url: `/agents/${id}`,
        headers: authHeader(),
      });
      expect(deleteRes.statusCode).toBe(204);

      // Child rows must be gone — DB cascade, not application-side cleanup.
      const sessions = await ctx.db.select().from(agentRuntimeSessions).where(eq(agentRuntimeSessions.agentId, id));
      expect(sessions).toHaveLength(0);
      const artifacts = await ctx.db.select().from(agentArtifacts).where(eq(agentArtifacts.agentId, id));
      expect(artifacts).toHaveLength(0);
      const messages = await ctx.db.select().from(agentOutboundMessages).where(eq(agentOutboundMessages.agentId, id));
      expect(messages).toHaveLength(0);
      const marRows = await ctx.db.select().from(marketAssessmentRequests).where(eq(marketAssessmentRequests.agentId, id));
      expect(marRows).toHaveLength(0);
    });

    it('deletes a stopped agent and returns 204', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'Delete Me', prompt: 'Soon to be gone.' },
      });
      const { id } = createRes.json<{ id: string }>();

      const deleteRes = await ctx.app.inject({
        method: 'DELETE',
        url: `/agents/${id}`,
        headers: authHeader(),
      });
      expect(deleteRes.statusCode).toBe(204);

      // Confirm it's gone
      const getRes = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${id}`,
        headers: authHeader(),
      });
      expect(getRes.statusCode).toBe(404);
    });

    it('returns 409 when trying to delete a non-stopped agent', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'Running Agent', prompt: 'Cannot delete.' },
      });
      const { id } = createRes.json<{ id: string }>();

      // Set to starting state
      await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/start`,
        headers: authHeader(),
      });

      const deleteRes = await ctx.app.inject({
        method: 'DELETE',
        url: `/agents/${id}`,
        headers: authHeader(),
      });
      expect(deleteRes.statusCode).toBe(409);
    });
  });

  describe('notificationPolicy', () => {
    it('creates an agent with notificationPolicy and returns it in the response', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: {
          name: 'Notify Agent',
          prompt: 'Alert me always.',
          skillIds: [],
          notificationPolicy: {
            sendMessage: { email: { enabled: true, source: 'explicit_update' } },
          },
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; notificationPolicy: unknown }>();
      expect(typeof body.id).toBe('string');
      // Server writes enabledAt — verify the stored policy round-trips
      const getRes = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${body.id}`,
        headers: authHeader(),
      });
      expect(getRes.statusCode).toBe(200);
      const agent = getRes.json<{ notificationPolicy: { sendMessage?: { email?: { enabled: boolean; enabledAt?: string } } } | null }>();
      expect(agent.notificationPolicy?.sendMessage?.email?.enabled).toBe(true);
      expect(typeof agent.notificationPolicy?.sendMessage?.email?.enabledAt).toBe('string');
    });

    it('updates notificationPolicy via PATCH and preserves enabledAt on re-save', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: {
          name: 'Notify PATCH Agent',
          prompt: 'Alert me.',
          notificationPolicy: {
            sendMessage: { email: { enabled: true, source: 'explicit_update' } },
          },
        },
      });
      const { id } = createRes.json<{ id: string }>();

      // Read the initial enabledAt
      const firstGet = await ctx.app.inject({ method: 'GET', url: `/agents/${id}`, headers: authHeader() });
      const first = firstGet.json<{ notificationPolicy: { sendMessage?: { email?: { enabled: boolean; enabledAt?: string } } } | null }>();
      const firstEnabledAt = first.notificationPolicy?.sendMessage?.email?.enabledAt;
      expect(typeof firstEnabledAt).toBe('string');

      // PATCH with email still enabled — enabledAt must not change
      const patchRes = await ctx.app.inject({
        method: 'PATCH',
        url: `/agents/${id}`,
        headers: authHeader(),
        payload: {
          notificationPolicy: {
            sendMessage: { email: { enabled: true, source: 'explicit_update' } },
          },
        },
      });
      expect(patchRes.statusCode).toBe(200);

      const secondGet = await ctx.app.inject({ method: 'GET', url: `/agents/${id}`, headers: authHeader() });
      const second = secondGet.json<{ notificationPolicy: { sendMessage?: { email?: { enabled: boolean; enabledAt?: string } } } | null }>();
      expect(second.notificationPolicy?.sendMessage?.email?.enabledAt).toBe(firstEnabledAt);
    });

    it('disabling email in notificationPolicy clears the stored email block', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: {
          name: 'Notify Disable Agent',
          prompt: 'Alert me.',
          notificationPolicy: {
            sendMessage: { email: { enabled: true, source: 'explicit_update' } },
          },
        },
      });
      const { id } = createRes.json<{ id: string }>();

      const patchRes = await ctx.app.inject({
        method: 'PATCH',
        url: `/agents/${id}`,
        headers: authHeader(),
        payload: {
          notificationPolicy: {
            sendMessage: { email: { enabled: false, source: 'explicit_update' } },
          },
        },
      });
      expect(patchRes.statusCode).toBe(200);

      const getRes = await ctx.app.inject({ method: 'GET', url: `/agents/${id}`, headers: authHeader() });
      const agent = getRes.json<{ notificationPolicy: { sendMessage?: { email?: { enabled: boolean; source?: string; enabledAt?: string } } } | null }>();
      expect(agent.notificationPolicy?.sendMessage?.email?.enabled).toBe(false);
      expect(agent.notificationPolicy?.sendMessage?.email?.source).toBe('explicit_update');
      expect(agent.notificationPolicy?.sendMessage?.email?.enabledAt).toBeUndefined();
    });
  });

  describe('execution mode lifecycle', () => {
    it('resolves paper mode to shadow after granting a connection (venue-backed simulation upgrade)', async () => {
      // 1. Create agent with paper mode + venue hint, no connections
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: {
          name: 'Paper Mode Agent',
          prompt: 'Trade BTC.',
          skillIds: ['trading'],
          executionDefaults: { mode: 'paper' },
          executionVenue: 'hyperliquid',
        },
      });
      expect(createRes.statusCode).toBe(201);
      const agent = createRes.json<{ id: string }>();
      expect((await ctx.getProfile(agent.id))?.executionDefaults?.mode).toBe('paper');

      const agentId = agent.id;

      // 2. Create a Hyperliquid connection
      const linkRes = await ctx.app.inject({
        method: 'POST',
        url: '/setup/provider-link',
        headers: authHeader(),
        payload: {
          provider: 'hyperliquid',
          label: 'hl-functional-test',
          secrets: {
            apiKey: 'test-key',
            secret: 'test-secret',
            walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
          capability: 'trading',
        },
      });
      expect(linkRes.statusCode).toBe(201);
      const connectionId = linkRes.json<{ connection: { id: string } }>().connection.id;

      // 3. Grant the connection to the agent
      const patchRes = await ctx.app.inject({
        method: 'PATCH',
        url: `/agents/${agentId}`,
        headers: authHeader(),
        payload: { connectionIds: [connectionId] },
      });
      expect(patchRes.statusCode).toBe(200);

      // 4. Verify the stored mode is now shadow (venue-backed simulation)
      const getRes = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${agentId}`,
        headers: authHeader(),
      });
      expect(getRes.statusCode).toBe(200);
      expect((await ctx.getProfile(agentId))?.executionDefaults?.mode).toBe('shadow');
    });

    it('transitions from paper to live via go-live without mode leak', async () => {
      // 1. Create agent in paper mode (no venue)
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: {
          name: 'Paper To Live Agent',
          prompt: 'Trade SOL.',
          skillIds: ['trading'],
          executionDefaults: { mode: 'paper' },
        },
      });
      expect(createRes.statusCode).toBe(201);
      const agent = createRes.json<{ id: string }>();
      expect((await ctx.getProfile(agent.id))?.executionDefaults?.mode).toBe('paper');
      const agentId = agent.id;

      // 2. Create a Hyperliquid connection
      const linkRes = await ctx.app.inject({
        method: 'POST',
        url: '/setup/provider-link',
        headers: authHeader(),
        payload: {
          provider: 'hyperliquid',
          label: 'hl-live-test',
          secrets: {
            apiKey: 'test-key',
            secret: 'test-secret',
            walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          },
          capability: 'trading',
        },
      });
      expect(linkRes.statusCode).toBe(201);
      const connectionId = linkRes.json<{ connection: { id: string } }>().connection.id;

      // 3. Grant the connection to the source agent
      const grantRes = await ctx.app.inject({
        method: 'PATCH',
        url: `/agents/${agentId}`,
        headers: authHeader(),
        payload: { connectionIds: [connectionId] },
      });
      expect(grantRes.statusCode).toBe(200);

      // 4. Go live — promote to admin (plan bypass) and clone source agent as a new live agent
      const meRes = await ctx.app.inject({ method: 'GET', url: '/auth/me', headers: authHeader() });
      await ctx.db.update(users).set({ isAdmin: true }).where(eq(users.id, meRes.json<{ id: string }>().id));

      const goLiveRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${agentId}/go-live`,
        headers: authHeader(),
      });
      expect(goLiveRes.statusCode).toBe(201);
      const liveAgent = goLiveRes.json<{ id: string }>();
      expect((await ctx.getProfile(liveAgent.id))?.executionDefaults?.mode).toBe('live');
      const liveAgentId = liveAgent.id;
      expect(liveAgentId).not.toBe(agentId);

      // 5. Verify the source agent is still in paper/shadow mode (unchanged)
      const sourceRes = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${agentId}`,
        headers: authHeader(),
      });
      expect(sourceRes.statusCode).toBe(200);
      expect(['paper', 'shadow']).toContain((await ctx.getProfile(agentId))?.executionDefaults?.mode);

      // 6. Verify the new live agent is stored correctly
      const getRes = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${liveAgentId}`,
        headers: authHeader(),
      });
      expect(getRes.statusCode).toBe(200);
      expect((await ctx.getProfile(liveAgentId))?.executionDefaults?.mode).toBe('live');

      // 7. Start the live agent — live mode with a connection must be allowed
      const startRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${liveAgentId}/start`,
        headers: authHeader(),
      });
      expect(startRes.statusCode).toBe(202);
      expect(startRes.json<{ status: string }>().status).toBe('starting');
    });
  });

  // ─── Lifecycle service refactor: route-level regression tests ───────────

  describe('POST /agents/:id/stop', () => {
    it('transitions an active agent to stopped', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'Stop Me Agent', prompt: 'Do work.' },
      });
      const { id } = createRes.json<{ id: string }>();

      // Start first so it's not stopped
      await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/start`,
        headers: authHeader(),
      });

      const stopRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/stop`,
        headers: authHeader(),
      });
      expect(stopRes.statusCode).toBe(200);
      expect(stopRes.json<{ status: string }>().status).toBe('stopped');

      // Verify DB state
      const agentRes = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${id}`,
        headers: authHeader(),
      });
      expect(agentRes.json<{ status: string }>().status).toBe('stopped');
    });

    it('is idempotent — stopping an already-stopped agent returns 200', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'Already Stopped', prompt: 'Idle.' },
      });
      const { id } = createRes.json<{ id: string }>();

      // Agent is created stopped — stop again
      const stopRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/stop`,
        headers: authHeader(),
      });
      expect(stopRes.statusCode).toBe(200);
      expect(stopRes.json<{ status: string }>().status).toBe('stopped');
    });

    it('transitions a paused agent to stopped', async () => {
      const { agents } = await import('@herobids/db');
      const { eq } = await import('drizzle-orm');

      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'Paused Stop', prompt: 'Do work.' },
      });
      const { id } = createRes.json<{ id: string }>();

      // Set to active then pause
      await ctx.db.update(agents).set({ status: 'active' }).where(eq(agents.id, id));
      await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/pause`,
        headers: authHeader(),
      });

      const stopRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/stop`,
        headers: authHeader(),
      });
      expect(stopRes.statusCode).toBe(200);
      expect(stopRes.json<{ status: string }>().status).toBe('stopped');
    });

    it('transitions a starting agent to stopped', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'Starting Stop', prompt: 'Do work.' },
      });
      const { id } = createRes.json<{ id: string }>();

      // Start the agent
      await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/start`,
        headers: authHeader(),
      });

      const stopRes = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/stop`,
        headers: authHeader(),
      });
      expect(stopRes.statusCode).toBe(200);
      expect(stopRes.json<{ status: string }>().status).toBe('stopped');
    });
  });

  describe('ownership enforcement', () => {
    it('cannot start another user\'s agent', async () => {
      // Create agent as primary user
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'My Agent', prompt: 'Mine.' },
      });
      const { id } = createRes.json<{ id: string }>();

      // Register a second user
      const otherToken = await registerUser(ctx.app, ctx.db, 'other@test.com');

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/start`,
        headers: { Authorization: `Bearer ${otherToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('cannot pause another user\'s agent', async () => {
      const { agents } = await import('@herobids/db');
      const { eq } = await import('drizzle-orm');

      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'My Paused Agent', prompt: 'Mine.' },
      });
      const { id } = createRes.json<{ id: string }>();

      await ctx.db.update(agents).set({ status: 'active' }).where(eq(agents.id, id));

      const otherToken = await registerUser(ctx.app, ctx.db, 'other2@test.com');
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/pause`,
        headers: { Authorization: `Bearer ${otherToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('cannot resume another user\'s agent', async () => {
      const { agents } = await import('@herobids/db');
      const { eq } = await import('drizzle-orm');

      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'My Resume Agent', prompt: 'Mine.' },
      });
      const { id } = createRes.json<{ id: string }>();

      await ctx.db.update(agents).set({ status: 'paused' }).where(eq(agents.id, id));

      const otherToken = await registerUser(ctx.app, ctx.db, 'other3@test.com');
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/resume`,
        headers: { Authorization: `Bearer ${otherToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('cannot stop another user\'s agent', async () => {
      const { agents } = await import('@herobids/db');
      const { eq } = await import('drizzle-orm');

      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'My Stop Agent', prompt: 'Mine.' },
      });
      const { id } = createRes.json<{ id: string }>();

      await ctx.db.update(agents).set({ status: 'active' }).where(eq(agents.id, id));

      const otherToken = await registerUser(ctx.app, ctx.db, 'other4@test.com');
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/stop`,
        headers: { Authorization: `Bearer ${otherToken}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
