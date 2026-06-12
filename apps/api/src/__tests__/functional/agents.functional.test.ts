/**
 * Functional tests: Agent CRUD and lifecycle (create, list, get, start, pause, resume, stop, delete)
 *
 * Requires DATABASE_URL and REDIS_URL.  Skipped otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SKIP, buildApp, truncateAll, registerUser } from './helpers.js';
import { agentRuntimeSessions, agentArtifacts, agentOutboundMessages } from '@herobids/db';
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
    token = await registerUser(ctx.app);
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

    it('rejects explicit execution mode for a non-trading agent', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: {
          name: 'Personal Assistant Agent',
          prompt: 'Remind me to pray at 07:45 Berlin time.',
          skillIds: ['task-management', 'web-access'],
          executionMode: 'paper',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: 'validation_error',
        details: [expect.objectContaining({ path: ['executionMode'] })],
      });
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
      const otherToken = await registerUser(ctx.app, 'other@test.com');
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
    it('cascade-deletes dependent rows (sessions, artifacts, outbound messages) with the agent', async () => {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/agents',
        headers: authHeader(),
        payload: { name: 'With Children', prompt: 'I have dependents.' },
      });
      expect(createRes.statusCode).toBe(201);
      const { id } = createRes.json<{ id: string }>();

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
});
