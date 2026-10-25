/**
 * Functional tests: the owner's view of agent-to-agent threads and the stop switch (A2A-B).
 *
 * Requires DATABASE_URL and REDIS_URL. Skipped otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { ConversationRepository, users } from '@herobids/db';
import { ConversationService, userAgentConversationId } from '@herobids/domain';
import { SKIP, buildApp, truncateAll, registerUser } from './helpers.js';

interface ThreadList {
  threads: Array<{ kind: string; peerAgentId: string; peerAgentName: string | null; lastMessageAt: string | null }>;
}
interface ThreadPage {
  kind: string;
  peerAgentId: string;
  peerAgentName: string;
  messages: Array<{ id: string; senderType: string; senderId: string | null; channel: string; body: string; deliveryStatus: string; refusalReason: string | null }>;
  nextCursor: string | null;
}

describe.skipIf(SKIP)('Peer threads and stop switch (functional)', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  let otherToken: string;
  let clock: number;

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
    otherToken = await registerUser(ctx.app, ctx.db, 'other@functional.test', 'testpassword123', 'Other User');
    clock = Date.parse('2026-10-25T10:00:00.000Z');
  });

  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

  async function createAgent(name: string, t = token): Promise<string> {
    const res = await ctx.app.inject({ method: 'POST', url: '/agents', headers: auth(t), payload: { name, prompt: 'Do work.', skillIds: [] } });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function userIdOf(t = token): Promise<string> {
    const res = await ctx.app.inject({ method: 'GET', url: '/auth/me', headers: auth(t) });
    return res.json<{ id: string }>().id;
  }

  const conversations = () => new ConversationService({
    store: new ConversationRepository(ctx.db), limits: { userMessageMaxChars: 4000, threadDefaultPageSize: 50, threadMaxPageSize: 200, staleQueuedAfterSeconds: 60 },
    newId: () => crypto.randomUUID(), now: () => new Date(++clock),
  });

  async function peerMessage(ownerUserId: string, from: string, to: string, body: string, extra: { refused?: string } = {}) {
    const recorded = await conversations().recordPeerMessage({
      ownerUserId, fromAgentId: from, toAgentId: to, body,
      ...(extra.refused ? { deliveryStatus: 'refused' as const, deliveryDetail: extra.refused } : {}),
    });
    expect(recorded.ok).toBe(true);
  }

  describe('GET /agents/:id/peer-threads', () => {
    it('lists the agent\'s threads, newest first, marked agent-to-agent and with the peer\'s name', async () => {
      const owner = await userIdOf();
      const [a1, a2, a3, a4] = [await createAgent('Momo'), await createAgent('Kofi'), await createAgent('Dozer'), await createAgent('Zuri')];
      await peerMessage(owner, a1, a2, 'first');
      await peerMessage(owner, a3, a1, 'second');
      await peerMessage(owner, a1, a4, 'third');
      await peerMessage(owner, a2, a1, 'back to the first thread');

      const res = await ctx.app.inject({ method: 'GET', url: `/agents/${a1}/peer-threads`, headers: auth() });

      expect(res.statusCode).toBe(200);
      const body = res.json<ThreadList>();
      expect(body.threads.map((t) => [t.peerAgentId, t.peerAgentName, t.kind])).toEqual([
        [a2, 'Kofi', 'agent_agent'], [a4, 'Zuri', 'agent_agent'], [a3, 'Dozer', 'agent_agent'],
      ]);
      expect(body.threads.every((t) => t.lastMessageAt !== null)).toBe(true);
    });

    it('answers an empty list for an agent without peer threads, and does not list its user thread', async () => {
      const a1 = await createAgent('Momo');
      await ctx.app.inject({ method: 'POST', url: `/agents/${a1}/message`, headers: auth(), payload: { message: 'hi' } });

      const res = await ctx.app.inject({ method: 'GET', url: `/agents/${a1}/peer-threads`, headers: auth() });

      expect(res.statusCode).toBe(200);
      expect(res.json<ThreadList>().threads).toEqual([]);
    });

    it('answers 404 for another user\'s agent and 401 without a token', async () => {
      const foreign = await createAgent('Ama', otherToken);

      expect((await ctx.app.inject({ method: 'GET', url: `/agents/${foreign}/peer-threads`, headers: auth() })).statusCode).toBe(404);
      expect((await ctx.app.inject({ method: 'GET', url: `/agents/${foreign}/peer-threads` })).statusCode).toBe(401);
    });

    it('rejects an invalid limit', async () => {
      const a1 = await createAgent('Momo');

      const res = await ctx.app.inject({ method: 'GET', url: `/agents/${a1}/peer-threads?limit=0`, headers: auth() });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /agents/:id/peer-threads/:peerAgentId', () => {
    it('shows a peer message in the owner\'s thread view, from either agent, oldest first, as sent by the agent', async () => {
      const owner = await userIdOf();
      const [a1, a2] = [await createAgent('Momo'), await createAgent('Kofi')];
      await peerMessage(owner, a1, a2, 'hello Kofi');
      await peerMessage(owner, a2, a1, 'hello Momo');

      const fromOne = await ctx.app.inject({ method: 'GET', url: `/agents/${a1}/peer-threads/${a2}`, headers: auth() });
      const fromTwo = await ctx.app.inject({ method: 'GET', url: `/agents/${a2}/peer-threads/${a1}`, headers: auth() });

      expect(fromOne.statusCode).toBe(200);
      const page = fromOne.json<ThreadPage>();
      expect(page).toMatchObject({ kind: 'agent_agent', peerAgentId: a2, peerAgentName: 'Kofi', nextCursor: null });
      expect(page.messages.map((m) => [m.senderType, m.senderId, m.channel, m.body])).toEqual([
        ['agent', a1, 'internal', 'hello Kofi'], ['agent', a2, 'internal', 'hello Momo'],
      ]);
      expect(fromTwo.json<ThreadPage>().messages.map((m) => m.body)).toEqual(['hello Kofi', 'hello Momo']);
    });

    it('shows a refused message with its reason', async () => {
      const owner = await userIdOf();
      const [a1, a2] = [await createAgent('Momo'), await createAgent('Kofi')];
      await peerMessage(owner, a1, a2, 'sent');
      await peerMessage(owner, a1, a2, 'blocked', { refused: 'peer.rate_limited' });

      const res = await ctx.app.inject({ method: 'GET', url: `/agents/${a1}/peer-threads/${a2}`, headers: auth() });

      expect(res.json<ThreadPage>().messages.map((m) => [m.body, m.deliveryStatus, m.refusalReason])).toEqual([
        ['sent', 'queued', null], ['blocked', 'refused', 'peer.rate_limited'],
      ]);
    });

    it('pages with the opaque cursor', async () => {
      const owner = await userIdOf();
      const [a1, a2] = [await createAgent('Momo'), await createAgent('Kofi')];
      for (const body of ['m1', 'm2', 'm3', 'm4', 'm5']) await peerMessage(owner, a1, a2, body);

      const page = (await ctx.app.inject({ method: 'GET', url: `/agents/${a1}/peer-threads/${a2}?limit=3`, headers: auth() })).json<ThreadPage>();
      const older = (await ctx.app.inject({ method: 'GET', url: `/agents/${a1}/peer-threads/${a2}?limit=3&before=${page.nextCursor}`, headers: auth() })).json<ThreadPage>();

      expect(page.messages.map((m) => m.body)).toEqual(['m3', 'm4', 'm5']);
      expect(older.messages.map((m) => m.body)).toEqual(['m1', 'm2']);
      expect(older.nextCursor).toBeNull();
    });

    it('keeps the peer thread out of the agent\'s own conversation with its user', async () => {
      const owner = await userIdOf();
      const [a1, a2] = [await createAgent('Momo'), await createAgent('Kofi')];
      await peerMessage(owner, a1, a2, 'peer only');

      const res = await ctx.app.inject({ method: 'GET', url: `/agents/${a1}/conversation`, headers: auth() });

      expect(res.json<{ messages: unknown[] }>().messages).toEqual([]);
      expect(await ctx.db.execute(sql`SELECT 1 FROM conversations WHERE id = ${userAgentConversationId(a1)}`)).toHaveLength(0);
    });

    it('answers 404 for another user\'s agent as the peer, as the agent, for the same agent twice, and for a malformed cursor 400', async () => {
      const owner = await userIdOf();
      const [a1, a2] = [await createAgent('Momo'), await createAgent('Kofi')];
      const foreign = await createAgent('Ama', otherToken);
      await peerMessage(owner, a1, a2, 'private');

      expect((await ctx.app.inject({ method: 'GET', url: `/agents/${a1}/peer-threads/${foreign}`, headers: auth() })).statusCode).toBe(404);
      expect((await ctx.app.inject({ method: 'GET', url: `/agents/${foreign}/peer-threads/${a1}`, headers: auth() })).statusCode).toBe(404);
      expect((await ctx.app.inject({ method: 'GET', url: `/agents/${a1}/peer-threads/${a1}`, headers: auth() })).statusCode).toBe(404);
      expect((await ctx.app.inject({ method: 'GET', url: `/agents/${a1}/peer-threads/${a2}?before=garbage`, headers: auth() })).statusCode).toBe(400);
    });

    it('does not show one user\'s thread to another user', async () => {
      const owner = await userIdOf();
      const [a1, a2] = [await createAgent('Momo'), await createAgent('Kofi')];
      await peerMessage(owner, a1, a2, 'private');

      const res = await ctx.app.inject({ method: 'GET', url: `/agents/${a1}/peer-threads/${a2}`, headers: auth(otherToken) });

      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('private');
    });
  });

  describe('stop switch on /auth/me (DEC-48, DEC-49)', () => {
    const me = async (t = token) => (await ctx.app.inject({ method: 'GET', url: '/auth/me', headers: auth(t) })).json<{ peerMessagingPaused: boolean }>();
    const patch = (payload: unknown, t = token) => ctx.app.inject({ method: 'PATCH', url: '/auth/me', headers: auth(t), payload: payload as Record<string, unknown> });

    it('is off by default and shown on GET', async () => {
      expect((await me()).peerMessagingPaused).toBe(false);
    });

    it('turns on and off, returns the new value, and stores it on the user', async () => {
      const on = await patch({ peerMessagingPaused: true });
      const [row] = await ctx.db.select({ paused: users.peerMessagingPaused }).from(users).where(eq(users.id, await userIdOf()));

      expect(on.statusCode).toBe(200);
      expect(on.json<{ peerMessagingPaused: boolean }>().peerMessagingPaused).toBe(true);
      expect(row?.paused).toBe(true);
      expect((await me()).peerMessagingPaused).toBe(true);

      const off = await patch({ peerMessagingPaused: false });
      expect(off.json<{ peerMessagingPaused: boolean }>().peerMessagingPaused).toBe(false);
      expect((await me()).peerMessagingPaused).toBe(false);
    });

    it.each([
      ['a string', 'true'],
      ['a number', 1],
      ['null', null],
      ['an object', { value: true }],
    ])('refuses %s and leaves the switch as it was', async (_label, value) => {
      await patch({ peerMessagingPaused: true });

      const res = await patch({ peerMessagingPaused: value });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } | string }>()).toBeDefined();
      expect(res.body).toContain('auth.profile.invalid_peer_messaging_paused');
      expect((await me()).peerMessagingPaused).toBe(true);
    });

    it('is left alone by a patch that does not mention it', async () => {
      await patch({ peerMessagingPaused: true });

      const res = await patch({ preferredLocale: 'en' });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ peerMessagingPaused: boolean }>().peerMessagingPaused).toBe(true);
    });

    it('does not touch another user\'s switch', async () => {
      await patch({ peerMessagingPaused: true });

      expect((await me(otherToken)).peerMessagingPaused).toBe(false);
    });

    it('requires a login', async () => {
      const res = await ctx.app.inject({ method: 'PATCH', url: '/auth/me', payload: { peerMessagingPaused: true } });

      expect(res.statusCode).toBe(401);
    });
  });
});
