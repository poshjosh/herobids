/**
 * Functional tests: Agent interactivity surface
 * (message delivery, memory, prompt, PUT update, Telegram, exports)
 *
 * Requires DATABASE_URL and REDIS_URL.  Skipped otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { agents, bots, connections, fills, tradingBindings, users, venueAccounts } from '@herobids/db';
import { eq } from 'drizzle-orm';
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
  });

  // ─── GET /agents/:id/memory ───────────────────────────────────────────────

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

  // ─── GET /agents/:id/trades ───────────────────────────────────────────────

  describe('GET /agents/:id/trades', () => {
    it('returns an empty trades array when the agent has no managed bots or native fills', async () => {
      const id = await createAgent();

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${id}/trades`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ agentId: string; trades: unknown[] }>();
      expect(body.agentId).toBe(id);
      expect(Array.isArray(body.trades)).toBe(true);
      expect(body.trades).toHaveLength(0);
    });

    it('agent-native fills appear in response', async () => {
      const agentId = await createAgent();
      const venueAccountId = 'va-agent-native';
      const fillId = 'fill-agent-native';

      await ctx.db.insert(fills).values({
        id: fillId,
        orderId: 'ord-agent-native',
        venueAccountId,
        actorType: 'agent',
        actorId: agentId,
        venueRefId: 'venue-ref-1',
        venue: 'jupiter',
        symbol: 'USDC/USD',
        side: 'buy',
        quantity: '1000',
        price: '1.0',
        fee: '0.3',
        feeCurrency: 'USDC',
        filledAt: new Date('2026-06-17T10:00:00Z'),
      });

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${agentId}/trades`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ agentId: string; trades: Array<Record<string, unknown>> }>();
      expect(body.agentId).toBe(agentId);
      expect(Array.isArray(body.trades)).toBe(true);
      expect(body.trades).toHaveLength(1);
      expect(body.trades[0]!.actorType).toBe('agent');
      expect(body.trades[0]!.actorId).toBe(agentId);
    });

    it('both agent-native and bot fills appear together', async () => {
      const agentId = await createAgent();
      const botId = 'bot-test-mixed';
      const venueAccountId = 'va-bot-mixed';

      // Create a bot owned by the agent
      const [owner] = await ctx.db.select({ userId: agents.userId }).from(agents).where(eq(agents.id, agentId));

      // Insert the venue account first to satisfy the FK constraint
      await ctx.db.insert(venueAccounts).values({
        id: venueAccountId,
        userId: owner!.userId,
        venue: 'hyperliquid',
        label: 'test-va-mixed',
      });

      // Insert connection and trading binding to satisfy FK constraints
      const connectionId = 'conn-mixed';
      await ctx.db.insert(connections).values({
        id: connectionId,
        userId: owner!.userId,
        provider: 'hyperliquid',
        label: 'test-conn-mixed',
      });
      await ctx.db.insert(tradingBindings).values({
        id: 'tb-mixed',
        userId: owner!.userId,
        connectionId,
        provider: 'hyperliquid',
        label: 'test-tb-mixed',
      });

      await ctx.db.insert(bots).values({
        id: botId,
        userId: owner!.userId,
        venueAccountId,
        tradingBindingId: 'tb-mixed',
        config: { strategy: { type: 'momentum' } },
        status: 'stopped',
        creatorType: 'agent',
        creatorId: agentId,
      });

      // Insert agent-native fill
      await ctx.db.insert(fills).values({
        id: 'fill-agent-mixed',
        orderId: 'ord-agent-mixed',
        venueAccountId,
        actorType: 'agent',
        actorId: agentId,
        venueRefId: 'venue-ref-agent',
        venue: 'jupiter',
        symbol: 'USDC/USD',
        side: 'buy',
        quantity: '1000',
        price: '1.0',
        filledAt: new Date('2026-06-17T10:00:00Z'),
      });

      // Insert bot fill
      await ctx.db.insert(fills).values({
        id: 'fill-bot-mixed',
        orderId: 'ord-bot-mixed',
        venueAccountId,
        actorType: 'bot',
        actorId: botId,
        venueRefId: 'venue-ref-bot',
        venue: 'jupiter',
        symbol: 'SOL/USD',
        side: 'sell',
        quantity: '10',
        price: '150.0',
        filledAt: new Date('2026-06-17T11:00:00Z'),
      });

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${agentId}/trades`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ agentId: string; trades: Array<Record<string, unknown>> }>();
      expect(body.agentId).toBe(agentId);
      expect(Array.isArray(body.trades)).toBe(true);
      expect(body.trades).toHaveLength(2);

      const actorTypes = body.trades.map((t) => t.actorType);
      expect(actorTypes).toContain('agent');
      expect(actorTypes).toContain('bot');
    });

    it('agent with no bots — only agent-native fills', async () => {
      const agentId = await createAgent();
      const venueAccountId = 'va-agent-only';

      // Ensure no bots exist for this agent
      const existingBots = await ctx.db.select({ id: bots.id }).from(bots)
        .where(eq(bots.creatorId, agentId));
      expect(existingBots).toHaveLength(0);

      // Insert only an agent-native fill
      await ctx.db.insert(fills).values({
        id: 'fill-agent-only',
        orderId: 'ord-agent-only',
        venueAccountId,
        actorType: 'agent',
        actorId: agentId,
        venueRefId: 'venue-ref-agent-only',
        venue: 'hyperliquid',
        symbol: 'BTC/USD',
        side: 'buy',
        quantity: '0.5',
        price: '60000',
        filledAt: new Date('2026-06-17T12:00:00Z'),
      });

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/agents/${agentId}/trades`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ agentId: string; trades: Array<Record<string, unknown>> }>();
      expect(body.agentId).toBe(agentId);
      expect(Array.isArray(body.trades)).toBe(true);
      expect(body.trades).toHaveLength(1);
      expect(body.trades[0]!.actorType).toBe('agent');
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

  // ─── POST /api/telegram/webhook ──────────────────────────────────────────

  describe('POST /api/telegram/webhook', () => {
    it('returns 501 because Telegram is not configured in the test app', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/telegram/webhook',
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
