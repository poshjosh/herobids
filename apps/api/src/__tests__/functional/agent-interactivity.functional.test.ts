/**
 * Functional tests: Agent interactivity surface
 * (message delivery, memory, prompt, PUT update, Telegram, exports)
 *
 * Requires DATABASE_URL and REDIS_URL.  Skipped otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { agents, conversationMessages, conversationParticipants, conversations, users } from '@herobids/db';
import { userAgentConversationId } from '@herobids/domain';
import { eq, sql } from 'drizzle-orm';
import { SKIP, buildApp, truncateAll, registerUser } from './helpers.js';

describe.skipIf(SKIP)('Agent interactivity functional', () => {
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

  /** Create an agent and return its id. */
  async function createAgent(name = 'Test Agent', prompt = 'Do work.'): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents',
      headers: authHeader(),
      payload: { name, prompt, skillIds: [] },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  // ─── PUT /agents/:id ──────────────────────────────────────────────────────

  describe('PUT /agents/:id', () => {
    it('updates a stopped agent and returns the updated document', async () => {
      const id = await createAgent();

      const res = await ctx.app.inject({
        method: 'PUT',
        url: `/agents/${id}`,
        headers: authHeader(),
        payload: { name: 'Renamed', prompt: 'New prompt text.' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ name: string }>().name).toBe('Renamed');
    });

    it('returns 409 when agent is not stopped', async () => {
      const id = await createAgent();
      // Manually set to running so PUT is rejected
      await ctx.db.update(agents).set({ status: 'running' }).where(eq(agents.id, id));

      const res = await ctx.app.inject({
        method: 'PUT',
        url: `/agents/${id}`,
        headers: authHeader(),
        payload: { name: 'Hack', prompt: 'Should fail.' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toBe('agent_not_editable');
    });

    it('returns 401 without auth', async () => {
      const id = await createAgent();
      const res = await ctx.app.inject({
        method: 'PUT',
        url: `/agents/${id}`,
        payload: { name: 'X', prompt: 'Y' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ─── POST /agents/:id/message ─────────────────────────────────────────────

  describe('POST /agents/:id/message', () => {
    it('returns 409 when agent is stopped', async () => {
      const id = await createAgent();

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/message`,
        headers: authHeader(),
        payload: { message: 'Hello' },
      });

      // Agent is stopped — message delivery must be rejected
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toBe('agent_not_running');
    });

    it('delivers a message when agent is running and writes to Redis stream', async () => {
      const id = await createAgent();
      // Manually advance to running so the message is accepted
      await ctx.db.update(agents).set({ status: 'running' }).where(eq(agents.id, id));

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/message`,
        headers: authHeader(),
        payload: { message: 'Trade BTC now!' },
      });

      expect(res.statusCode).toBe(202);
      expect(res.json<{ delivered: boolean }>().delivered).toBe(true);

      // Confirm Redis stream received the envelope
      const streamKey = `agent:outbound:${id}`;
      const length = await ctx.redisClient.xlen(streamKey);
      expect(length).toBeGreaterThanOrEqual(1);
    });

    it('returns 400 when message body is missing', async () => {
      const id = await createAgent();
      await ctx.db.update(agents).set({ status: 'running' }).where(eq(agents.id, id));

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/agents/${id}/message`,
        headers: authHeader(),
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    describe('conversation write (CH2W P2)', () => {
      const CLIENT_ID = '5d1c1c0e-2f4b-4a8e-9a53-0d3c7a6e4b21';

      afterEach(() => {
        vi.restoreAllMocks();
      });

      async function runningAgent(): Promise<string> {
        const id = await createAgent();
        await ctx.db.update(agents).set({ status: 'running' }).where(eq(agents.id, id));
        return id;
      }

      const send = (id: string, payload: Record<string, unknown>, headers = authHeader()) =>
        ctx.app.inject({ method: 'POST', url: `/agents/${id}/message`, headers, payload });

      it('stores the message before it is published, under the client message id', async () => {
        const id = await runningAgent();

        const res = await send(id, { message: 'Trade BTC now!', clientMessageId: CLIENT_ID });

        expect(res.statusCode).toBe(202);
        expect(res.json()).toMatchObject({ delivered: true, message: { id: CLIENT_ID, senderType: 'user', channel: 'web', deliveryStatus: 'sent' } });
        const rows = await ctx.db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, userAgentConversationId(id)));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: CLIENT_ID, body: 'Trade BTC now!', senderType: 'user', deliveryStatus: 'sent' });
        const [entry] = await ctx.redisClient.xrange(`agent:outbound:${id}`, '-', '+');
        expect(JSON.parse(entry![1][1]!)).toMatchObject({ messageId: CLIENT_ID, payload: { message: 'Trade BTC now!' } });
      });

      it('is idempotent on the client message id: one row, one published envelope', async () => {
        const id = await runningAgent();

        const first = await send(id, { message: 'Once', clientMessageId: CLIENT_ID });
        const second = await send(id, { message: 'Once', clientMessageId: CLIENT_ID });

        expect(first.statusCode).toBe(202);
        expect(second.statusCode).toBe(202);
        expect(second.json().message.id).toBe(CLIENT_ID);
        const rows = await ctx.db.select().from(conversationMessages).where(eq(conversationMessages.id, CLIENT_ID));
        expect(rows).toHaveLength(1);
        expect(await ctx.redisClient.xlen(`agent:outbound:${id}`)).toBe(1);
      });

      it('answers 503 when publishing fails, keeps the row as failed, and publishes on a retry of the same id', async () => {
        const id = await runningAgent();
        vi.spyOn(ctx.redisClient, 'xadd').mockRejectedValueOnce(new Error('redis unavailable') as never);

        const failed = await send(id, { message: 'Try me', clientMessageId: CLIENT_ID });

        expect(failed.statusCode).toBe(503);
        expect(failed.json()).toMatchObject({ error: 'message_delivery_unavailable', messageId: CLIENT_ID });
        const [afterFailure] = await ctx.db.select().from(conversationMessages).where(eq(conversationMessages.id, CLIENT_ID));
        expect(afterFailure).toMatchObject({ deliveryStatus: 'failed', deliveryDetail: 'publish_failed' });
        expect(await ctx.redisClient.xlen(`agent:outbound:${id}`)).toBe(0);

        const retry = await send(id, { message: 'Try me', clientMessageId: CLIENT_ID });

        expect(retry.statusCode).toBe(202);
        expect(retry.json().message).toMatchObject({ id: CLIENT_ID, deliveryStatus: 'sent' });
        expect(await ctx.redisClient.xlen(`agent:outbound:${id}`)).toBe(1);
        const rows = await ctx.db.select().from(conversationMessages).where(eq(conversationMessages.id, CLIENT_ID));
        expect(rows).toHaveLength(1);
      });

      // Leaves the row as a failed publish, then rewrites it into the state a dead process leaves: queued since `ageSeconds`.
      async function leaveQueued(id: string, ageSeconds: number): Promise<void> {
        vi.spyOn(ctx.redisClient, 'xadd').mockRejectedValueOnce(new Error('redis unavailable') as never);
        expect((await send(id, { message: 'Stuck', clientMessageId: CLIENT_ID })).statusCode).toBe(503);
        await ctx.db.execute(sql`UPDATE conversation_messages
          SET delivery_status = 'queued', delivery_detail = NULL, queued_at = now() - make_interval(secs => ${ageSeconds})
          WHERE id = ${CLIENT_ID}`);
      }

      it('does not publish a recently queued message again on a same-id repeat (its first publish may still be running)', async () => {
        const id = await runningAgent();
        await leaveQueued(id, 1);

        const repeat = await send(id, { message: 'Stuck', clientMessageId: CLIENT_ID });

        expect(repeat.statusCode).toBe(202);
        expect(repeat.json().message).toMatchObject({ id: CLIENT_ID, deliveryStatus: 'queued', stuck: false });
        expect(await ctx.redisClient.xlen(`agent:outbound:${id}`)).toBe(0);
      });

      it('re-publishes a stuck queued message on a same-id retry, once, even when retries race', async () => {
        const id = await runningAgent();
        await leaveQueued(id, 3600);
        const thread = await ctx.app.inject({ method: 'GET', url: `/agents/${id}/conversation`, headers: authHeader() });
        expect(thread.json().messages).toMatchObject([{ id: CLIENT_ID, deliveryStatus: 'queued', stuck: true }]);

        const results = await Promise.all([1, 2, 3].map(() => send(id, { message: 'Stuck', clientMessageId: CLIENT_ID })));

        expect(results.map((res) => res.statusCode)).toEqual([202, 202, 202]);
        expect(await ctx.redisClient.xlen(`agent:outbound:${id}`)).toBe(1);
        const [row] = await ctx.db.select().from(conversationMessages).where(eq(conversationMessages.id, CLIENT_ID));
        expect(row).toMatchObject({ deliveryStatus: 'sent' });
        expect(Date.now() - (row?.queuedAt.getTime() ?? 0)).toBeLessThan(60_000);
      });

      it('returns the stored row for a repeat of a delivered message after the agent has stopped, and publishes nothing', async () => {
        const id = await runningAgent();
        expect((await send(id, { message: 'Delivered', clientMessageId: CLIENT_ID })).statusCode).toBe(202);
        await ctx.db.update(agents).set({ status: 'stopped' }).where(eq(agents.id, id));

        const repeat = await send(id, { message: 'Delivered', clientMessageId: CLIENT_ID });

        expect(repeat.statusCode).toBe(202);
        expect(repeat.json().message).toMatchObject({ id: CLIENT_ID, deliveryStatus: 'sent' });
        expect(await ctx.redisClient.xlen(`agent:outbound:${id}`)).toBe(1);
      });

      it('refuses a retry of a failed message with 409 while the agent is stopped, and keeps the row failed', async () => {
        const id = await runningAgent();
        vi.spyOn(ctx.redisClient, 'xadd').mockRejectedValueOnce(new Error('redis unavailable') as never);
        expect((await send(id, { message: 'Try me', clientMessageId: CLIENT_ID })).statusCode).toBe(503);
        await ctx.db.update(agents).set({ status: 'stopped' }).where(eq(agents.id, id));

        const retry = await send(id, { message: 'Try me', clientMessageId: CLIENT_ID });

        expect(retry.statusCode).toBe(409);
        const [row] = await ctx.db.select().from(conversationMessages).where(eq(conversationMessages.id, CLIENT_ID));
        expect(row).toMatchObject({ deliveryStatus: 'failed' });
      });

      it('answers 404 for another user\'s agent and writes no conversation or envelope', async () => {
        const id = await runningAgent();
        const otherToken = await registerUser(ctx.app, ctx.db, 'other@test.com');

        const res = await send(id, { message: 'Not yours', clientMessageId: CLIENT_ID }, { Authorization: `Bearer ${otherToken}` });

        expect(res.statusCode).toBe(404);
        expect(await ctx.db.select().from(conversationMessages)).toHaveLength(0);
        expect(await ctx.db.select().from(conversations)).toHaveLength(0);
        expect(await ctx.redisClient.xlen(`agent:outbound:${id}`)).toBe(0);
      });

      it('refuses a client message id used in another user\'s conversation, without leaking that row', async () => {
        const id = await runningAgent();
        await send(id, { message: 'private text', clientMessageId: CLIENT_ID });
        const otherToken = await registerUser(ctx.app, ctx.db, 'other@test.com');
        const otherAgent = await ctx.app.inject({ method: 'POST', url: '/agents', headers: { Authorization: `Bearer ${otherToken}` }, payload: { name: 'Theirs', prompt: 'p', skillIds: [] } });
        const otherId = otherAgent.json<{ id: string }>().id;
        await ctx.db.update(agents).set({ status: 'running' }).where(eq(agents.id, otherId));

        const res = await send(otherId, { message: 'collide', clientMessageId: CLIENT_ID }, { Authorization: `Bearer ${otherToken}` });

        expect(res.statusCode).toBe(409);
        expect(res.body).not.toContain('private text');
        expect(await ctx.db.select().from(conversations).where(eq(conversations.id, userAgentConversationId(otherId)))).toHaveLength(0);
      });

      it('rejects a malformed client message id with 400 and writes nothing', async () => {
        const id = await runningAgent();

        const res = await send(id, { message: 'Hello', clientMessageId: 'x'.repeat(300) });

        expect(res.statusCode).toBe(400);
        expect(await ctx.db.select().from(conversationMessages)).toHaveLength(0);
      });
    });
  });

  // ─── GET /agents/:id/conversation ─────────────────────────────────────────

  describe('GET /agents/:id/conversation', () => {
    async function runningAgentWith(messages: number): Promise<string> {
      const id = await createAgent();
      await ctx.db.update(agents).set({ status: 'running' }).where(eq(agents.id, id));
      for (let index = 1; index <= messages; index += 1) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/agents/${id}/message`,
          headers: authHeader(),
          payload: { message: `m${index}`, clientMessageId: crypto.randomUUID() },
        });
        expect(res.statusCode).toBe(202);
      }
      return id;
    }

    it('returns the thread oldest first and pages older rows with the cursor', async () => {
      const id = await runningAgentWith(5);

      const page = await ctx.app.inject({ method: 'GET', url: `/agents/${id}/conversation?limit=3`, headers: authHeader() });
      const body = page.json<{ messages: Array<{ body: string }>; nextCursor: string | null }>();
      const older = await ctx.app.inject({ method: 'GET', url: `/agents/${id}/conversation?limit=3&before=${body.nextCursor}`, headers: authHeader() });

      expect(page.statusCode).toBe(200);
      expect(body.messages.map((message) => message.body)).toEqual(['m3', 'm4', 'm5']);
      expect(older.json<{ messages: Array<{ body: string }>; nextCursor: string | null }>()).toMatchObject({ nextCursor: null });
      expect(older.json<{ messages: Array<{ body: string }> }>().messages.map((message) => message.body)).toEqual(['m1', 'm2']);
    });

    it('returns an empty thread for an agent with no messages', async () => {
      const id = await createAgent();

      const res = await ctx.app.inject({ method: 'GET', url: `/agents/${id}/conversation`, headers: authHeader() });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ messages: [], nextCursor: null, maxMessageChars: 4000 });
    });

    it('answers 404 for another user\'s agent', async () => {
      const id = await runningAgentWith(1);
      const otherToken = await registerUser(ctx.app, ctx.db, 'other@test.com');

      const res = await ctx.app.inject({ method: 'GET', url: `/agents/${id}/conversation`, headers: { Authorization: `Bearer ${otherToken}` } });

      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('m1');
    });

    it('answers 401 without auth and 400 for a malformed cursor', async () => {
      const id = await createAgent();

      const anonymous = await ctx.app.inject({ method: 'GET', url: `/agents/${id}/conversation` });
      const badCursor = await ctx.app.inject({ method: 'GET', url: `/agents/${id}/conversation?before=nope`, headers: authHeader() });

      expect(anonymous.statusCode).toBe(401);
      expect(badCursor.statusCode).toBe(400);
    });

    it('agent deletion removes its conversation, participants and messages, and keeps other agents threads', async () => {
      const id = await runningAgentWith(2);
      const kept = await runningAgentWith(1);
      await ctx.db.update(agents).set({ status: 'stopped' }).where(eq(agents.id, id));

      const deleted = await ctx.app.inject({ method: 'DELETE', url: `/agents/${id}`, headers: authHeader() });

      expect(deleted.statusCode).toBe(204);
      expect(await ctx.db.select().from(conversations).where(eq(conversations.id, userAgentConversationId(id)))).toHaveLength(0);
      expect(await ctx.db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, userAgentConversationId(id)))).toHaveLength(0);
      expect(await ctx.db.select().from(conversationParticipants).where(eq(conversationParticipants.conversationId, userAgentConversationId(id)))).toHaveLength(0);
      expect(await ctx.db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, userAgentConversationId(kept)))).toHaveLength(1);
    });
  });

  // ─── GET /agents/:id/memory ───────────────────────────────────────────────

  describe('conversation readers (CH2W P3)', () => {
    async function seedThread(agentId: string) {
      const [owner] = await ctx.db.select({ userId: agents.userId }).from(agents).where(eq(agents.id, agentId));
      const conversationId = userAgentConversationId(agentId);
      await ctx.db.insert(conversations).values({ id: conversationId, kind: 'user_agent', ownerUserId: owner!.userId });
      await ctx.db.insert(conversationParticipants).values([
        { conversationId, participantType: 'user', participantId: owner!.userId },
        { conversationId, participantType: 'agent', participantId: agentId },
      ]);
      const base = Date.now() - 60_000;
      await ctx.db.insert(conversationMessages).values([
        { id: 'cm-user-1', conversationId, senderType: 'user', senderId: owner!.userId, channel: 'telegram', body: 'first', deliveryStatus: 'sent', createdAt: new Date(base) },
        { id: 'cm-agent-1', conversationId, senderType: 'agent', senderId: agentId, channel: 'web', subject: 'Update', body: 'reply', messageClass: 'routine', deliveryStatus: 'sent', createdAt: new Date(base + 1000) },
        { id: 'cm-user-2', conversationId, senderType: 'user', senderId: owner!.userId, channel: 'web', body: 'second', deliveryStatus: 'sent', createdAt: new Date(base + 2000) },
        { id: 'cm-platform-1', conversationId, senderType: 'platform', senderId: null, channel: 'web', subject: 'Runtime Unhealthy', body: 'alert', messageClass: 'alert', deliveryStatus: 'not_applicable', createdAt: new Date(base + 3000) },
      ]);
    }

    it('no longer serves GET /agents/:id/messages', async () => {
      const id = await createAgent();

      const res = await ctx.app.inject({ method: 'GET', url: `/agents/${id}/messages`, headers: authHeader() });

      expect(res.statusCode).toBe(404);
    });

    it('lists the agent and platform messages, not the user\'s, in the activity feed with no session', async () => {
      const id = await createAgent();
      await seedThread(id);

      const res = await ctx.app.inject({ method: 'GET', url: `/agents/${id}/activity-feed`, headers: authHeader() });

      expect(res.statusCode).toBe(200);
      const messages = res.json<{ entries: Array<{ id: string; eventType: string; title: string; sessionId: string | null; detail: Record<string, unknown> }> }>()
        .entries.filter((entry) => entry.eventType === 'message.authored');
      expect(messages.map((entry) => [entry.id, entry.title, entry.sessionId])).toEqual([
        ['msg-cm-platform-1', 'Platform message', null],
        ['msg-cm-agent-1', 'Agent message', null],
      ]);
      expect(messages[0]!.detail).toMatchObject({ authoredBy: 'platform', deliveryStatus: 'not_applicable' });
    });

    it('pages the activity feed messages by the before cursor', async () => {
      const id = await createAgent();
      await seedThread(id);
      const [platform] = await ctx.db.select({ createdAt: conversationMessages.createdAt }).from(conversationMessages).where(eq(conversationMessages.id, 'cm-platform-1'));

      const res = await ctx.app.inject({ method: 'GET', url: `/agents/${id}/activity-feed?before=${encodeURIComponent(platform!.createdAt.toISOString())}`, headers: authHeader() });

      const ids = res.json<{ entries: Array<{ id: string; eventType: string }> }>().entries.filter((entry) => entry.eventType === 'message.authored').map((entry) => entry.id);
      expect(ids).toEqual(['msg-cm-agent-1']);
    });

    it('names the newest user message, from either channel, as the conversation turn subject', async () => {
      const id = await createAgent();
      await seedThread(id);
      await ctx.db.insert(conversationMessages).values({
        id: 'cm-user-3', conversationId: userAgentConversationId(id), senderType: 'user', senderId: 'whoever', channel: 'telegram', body: 'third', deliveryStatus: 'sent', createdAt: new Date(),
      });

      const res = await ctx.app.inject({ method: 'GET', url: `/agents/${id}/conversation-turn`, headers: authHeader() });

      expect(res.statusCode).toBe(200);
      // No tick has handled the newest user message yet, so it is queued; an agent with no thread has no subject.
      expect(res.json()).toMatchObject({ message: 'queued' });
      const empty = await createAgent('Empty');
      const none = await ctx.app.inject({ method: 'GET', url: `/agents/${empty}/conversation-turn`, headers: authHeader() });
      expect(none.json().message ?? null).toBeNull();
    });
  });

  describe('GET /agents/:id/memory', () => {
    it('returns empty entries when no memory is stored', async () => {
      const id = await createAgent();

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${id}/memory`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ entries: unknown[] }>().entries).toEqual([]);
    });

    it('returns memory entries with prefix filter applied', async () => {
      const id = await createAgent();
      // Seed memory in Redis hash
      await ctx.redisClient.hset(`agent:memory:${id}`, {
        'trade:open:1': 'long BTC',
        'note:context': 'bull market',
      });

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${id}/memory?prefix=trade`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ entries: Array<{ key: string; value: string }> }>();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]!.key).toBe('trade:open:1');
      expect(body.entries[0]!.value).toBe('long BTC');
    });

    it('returns only keys when keysOnly=true', async () => {
      const id = await createAgent();
      await ctx.redisClient.hset(`agent:memory:${id}`, { 'k1': 'secret-value' });

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${id}/memory?keysOnly=true`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ entries: Array<Record<string, unknown>> }>();
      expect(body.entries[0]).toHaveProperty('key');
      expect(body.entries[0]).not.toHaveProperty('value');
    });
  });

  // ─── GET /agents/:id/prompt ───────────────────────────────────────────────

  describe('GET /agents/:id/prompt', () => {
    it('returns 404 when no compiled prompt is in Redis (agent not running)', async () => {
      const id = await createAgent();

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${id}/prompt`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: string }>().error).toBe('prompt_not_available');
    });

    it('returns the judge system prompt when it exists in Redis', async () => {
      const id = await createAgent();
      await ctx.redisClient.set(`agent:prompt:${id}`, 'You are a trading agent.');

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${id}/prompt`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ judgeSystem: string }>().judgeSystem).toBe('You are a trading agent.');
    });

    it('returns 200 with scout surface when only scout prompt exists', async () => {
      const id = await createAgent();
      await ctx.redisClient.set(`agent:prompt:scout:${id}`, 'Scout prompt only');

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${id}/prompt`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ judgeSystem: string | null; scoutSystem: string | null }>().judgeSystem).toBeNull();
      expect(res.json<{ judgeSystem: string | null; scoutSystem: string | null }>().scoutSystem).toBe('Scout prompt only');
    });

    it('returns 403 when plan does not allow prompt visibility', async () => {
      const id = await createAgent();
      const [owner] = await ctx.db
        .select({ userId: agents.userId })
        .from(agents)
        .where(eq(agents.id, id));
      expect(owner).toBeDefined();

      await ctx.db.update(users).set({ planId: 'prompt_hidden' }).where(eq(users.id, owner!.userId));

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${id}/prompt`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('plan.agents_prompt_visibility_disabled');
    });
  });

  // ─── GET /agents/telegram-bot ─────────────────────────────────────────────

  describe('GET /agents/telegram-bot', () => {
    it('returns 501 because Telegram is not configured in the test app', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/agents/telegram-bot',
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(501);
      expect(res.json<{ error: string }>().error).toBe('not_configured');
    });
  });

  // ─── POST /agents/verify-telegram ────────────────────────────────────────

  describe('POST /agents/verify-telegram', () => {
    it('returns 501 because Telegram is not configured in the test app', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/agents/verify-telegram',
        headers: authHeader(),
        payload: { chatId: '123456789' },
      });

      expect(res.statusCode).toBe(501);
      expect(res.json<{ error: string }>().error).toBe('not_configured');
    });
  });

  // ─── POST /telegram/webhook ──────────────────────────────────────────

  describe('POST /telegram/webhook', () => {
    it('returns 501 because Telegram is not configured in the test app', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        payload: { update_id: 1, message: { text: 'hi' } },
      });

      expect(res.statusCode).toBe(501);
      expect(res.json<{ error: string }>().error).toBe('not_configured');
    });
  });

  describe('GET /agents/:id/export/bundle', () => {
    it('returns a JSON bundle with required top-level keys', async () => {
      const id = await createAgent();

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${id}/export/bundle`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain('bundle');
      const body = res.json<Record<string, unknown>>();
      expect(body).toHaveProperty('agent');
      expect(body).toHaveProperty('trades');
      expect(body).toHaveProperty('journal');
      expect(body).toHaveProperty('sessions');
      expect(body).toHaveProperty('exportedAt');
    });
  });
});
