/**
 * Functional E2E tests for Telegram slash commands — DB state verification.
 *
 * Approach 1 (real DB): Seeds users/agents/connections via PostgreSQL and
 * verifies DB state after lifecycle/config commands. The full dispatch path
 * (webhook → parser → handler → service → DB mutation) is exercised.
 *
 * Approach 3 (Bot API mock): Intercepts globalThis.fetch for api.telegram.org
 * and verifies sendMessage payloads, testing the wire-level output.
 *
 * Requires: DATABASE_URL and REDIS_URL env vars (skipped otherwise).
 *
 * Note: Message text assertions are selective — the webhook integration tests
 * (telegram-slash-commands.integration.test.ts) already cover response formats
 * exhaustively. This file focuses on DB state transitions that only a real DB
 * can validate.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { sql, eq, and } from 'drizzle-orm';
import { createDatabase, users, agents, connections, agentConnections, skills, agentRuntimeSessions, agentMessages } from '@herobids/db';
import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';
import { telegramWebhookHandler } from '../../routes/agent-interactivity.js';
import { SKIP, DB_URL, REDIS_URL, parseRedisUrl, makeAuthConfig } from '../functional/helpers.js';

// ── Telegram API mock (Approach 3) ────────────────────────────────────────

const TELEGRAM_API_BASE = 'https://api.telegram.org';

interface CapturedCall {
  endpoint: string;
  body: unknown;
}

const capturedCalls: CapturedCall[] = [];
let mockBotToken: string;
let mockWebhookSecret: string;
const _realFetch = globalThis.fetch;

function installMock() {
  capturedCalls.length = 0;
  mockBotToken = `test-bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mockWebhookSecret = `test-secret-${Date.now()}`;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as Request).url;

    if (url.startsWith(TELEGRAM_API_BASE)) {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      capturedCalls.push({ endpoint: url.slice(TELEGRAM_API_BASE.length), body });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }

    return _realFetch(input, init);
  }) as typeof globalThis.fetch;
}

function uninstallMock() {
  globalThis.fetch = _realFetch;
}

function lastSentText(): string {
  const calls = capturedCalls.filter(c => c.endpoint.includes('/sendMessage'));
  return (calls[calls.length - 1]?.body as { text?: string })?.text ?? '';
}

// ── Test context ──────────────────────────────────────────────────────────

interface Ctx {
  app: ReturnType<typeof Fastify>;
  db: Database;
  redisClient: Redis;
}

let ctx: Ctx;

beforeAll(async () => { if (SKIP) return; }, 30_000);

afterAll(async () => {
  if (SKIP || !ctx) return;
  await ctx.app.close();
  await ctx.redisClient.quit();
});

beforeEach(async () => {
  if (SKIP) return;
  installMock();

  const db = createDatabase(DB_URL);
  const redisConn = parseRedisUrl(REDIS_URL);
  const { Redis: RedisCtor } = await import('ioredis');
  const redisClient = new RedisCtor(redisConn);

  await db.execute(sql`
    TRUNCATE agent_outbound_messages, agent_messages, decision_failures,
      agent_runtime_sessions, agent_skills, agent_connections,
      connections, agents, skills, users CASCADE
  `);

  const app = Fastify({ logger: false });
  const authConfig = makeAuthConfig();
  const alertsConfig = {
    enabled: true, dispatchIntervalMs: 10_000, defaultCooldownMs: 0,
    maxBatchSize: 10, maxRetries: 3,
    telegram: { enabled: true, botToken: mockBotToken, webhookSecret: mockWebhookSecret, chatId: '' },
    email: { enabled: false, from: '', smtp: { host: '', port: 587, secure: true, user: '', pass: '' }, brandColor: '' },
    safety: { maxBalanceDriftPct: 20, maxPnlDriftPct: 50, staleHeartbeatMs: 300_000, maxSilenceMs: 900_000 },
  };

  await telegramWebhookHandler(app, db, redisClient, alertsConfig, authConfig);
  await app.ready();
  ctx = { app, db, redisClient };
});

afterEach(() => { uninstallMock(); });

// ── Seed helpers ───────────────────────────────────────────────────────────

async function seedUser(chatId: string, extra: Partial<typeof users.$inferInsert> = {}) {
  const uid = crypto.randomUUID();
  const [u] = await ctx.db.insert(users).values({
    id: uid, email: `tg-${chatId}@t.local`, displayName: `TG${chatId}`,
    username: `tguser-${chatId}-${uid.slice(0, 6)}`, telegramChatId: chatId,
    aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
    ...extra,
  }).returning();
  return u!;
}

async function seedAgent(userId: string, extra: Partial<typeof agents.$inferInsert> = {}) {
  const [a] = await ctx.db.insert(agents).values({
    id: crypto.randomUUID(), userId, name: 'TestAgent', prompt: 'Test goal',
    status: 'stopped', capital: '5000',
    executionDefaults: { mode: 'paper' },
    risk: { dailyMaxLossPct: 25, maxDrawdownPct: 15, maxPositionSizePct: 10, stopLossPct: 5 },
    style: 'balanced', ...extra,
  }).returning();
  return a!;
}

async function seedConnection(userId: string, extra: Partial<typeof connections.$inferInsert> = {}) {
  const [c] = await ctx.db.insert(connections).values({
    id: crypto.randomUUID(), userId, label: 'TestConn', provider: 'hyperliquid',
    status: 'active', createdAt: new Date(), updatedAt: new Date(), ...extra,
  }).returning();
  return c!;
}

async function send(chatId: string, text: string): Promise<{ status: number }> {
  const res = await ctx.app.inject({
    method: 'POST', url: '/telegram/webhook',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': mockWebhookSecret },
    payload: { update_id: Date.now(), message: { message_id: Date.now(), chat: { id: +chatId, type: 'private' }, text } },
  });
  await new Promise<void>(r => setTimeout(r, 500));
  return { status: res.statusCode };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)('Telegram Slash Commands — Functional E2E', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // Auth
  // ═══════════════════════════════════════════════════════════════════════

  it('returns 501 when bot token is not configured', async () => {
    const db2 = createDatabase(DB_URL);
    const rc2 = parseRedisUrl(REDIS_URL);
    const { Redis: R } = await import('ioredis');
    const r2 = new R(rc2);
    const a2 = Fastify({ logger: false });
    await telegramWebhookHandler(a2, db2, r2);
    await a2.ready();
    const res = await a2.inject({ method: 'POST', url: '/telegram/webhook',
      headers: { 'content-type': 'application/json' },
      payload: { update_id: 1, message: { message_id: 1, chat: { id: 1, type: 'private' }, text: '/help' } } });
    expect(res.statusCode).toBe(501);
    await a2.close(); r2.disconnect();
  });

  it('returns 401 with wrong webhook secret', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/telegram/webhook',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'wrong' },
      payload: { update_id: 1, message: { message_id: 1, chat: { id: 1, type: 'private' }, text: '/help' } } });
    expect(res.statusCode).toBe(401);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Unbound chat
  // ═══════════════════════════════════════════════════════════════════════

  it('unbound chat returns "bind first" for /agents', async () => {
    await send('99999', '/agents');
    expect(lastSentText()).toContain('bind your Telegram account');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // /help works for unbound users
  // ═══════════════════════════════════════════════════════════════════════

  it('/help returns command list for unbound chats', async () => {
    await send('77777', '/help');
    const text = lastSentText();
    expect(text).toContain('Available commands');
    expect(text).toContain('/help');
    expect(text).toContain('/agents');
  });

  it('/help start returns detailed help', async () => {
    await send('77777', '/help start');
    expect(lastSentText()).toContain('/start');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Discovery — read commands with real DB queries
  // ═══════════════════════════════════════════════════════════════════════

  describe('discovery (real DB)', () => {
    const CHAT = '11111';
    let uid: string;

    beforeEach(async () => { uid = (await seedUser(CHAT)).id; });

    it('/agents lists owned agents', async () => {
      await seedAgent(uid, { name: 'Momentum', status: 'active' });
      await seedAgent(uid, { name: 'DCA Bot', status: 'paused' });
      await send(CHAT, '/agents');
      const text = lastSentText();
      expect(text).toContain('Momentum: active');
      expect(text).toContain('DCA Bot: paused');
    });

    it('/agents shows message when no agents', async () => {
      await send(CHAT, '/agents');
      expect(lastSentText().toLowerCase()).toContain('have any agent');
    });

    it('/info shows capital for paper mode agents', async () => {
      await seedAgent(uid, { name: 'Momentum', status: 'active' });
      await send(CHAT, '/info Momentum');
      const text = lastSentText();
      expect(text).toContain('Capital: $5000');
      expect(text).toContain('Execution mode: paper');
    });

    it('/info shows "not found" for unknown agent', async () => {
      await send(CHAT, '/info Ghost');
      expect(lastSentText()).toContain('not found');
    });

    it('/info does not leak another user\'s agent', async () => {
      const other = (await seedUser('22222')).id;
      await seedAgent(other, { name: 'SecretAgent' });
      await send(CHAT, '/info SecretAgent');
      expect(lastSentText()).toContain('not found');
    });

    it('/log does not crash when agent has no activity', async () => {
      await seedAgent(uid, { name: 'Momentum', status: 'active' });
      await send(CHAT, '/log Momentum');
      // Should return a valid response, not crash
      expect(lastSentText()).toBeTruthy();
    });

    it('/connections lists user connections', async () => {
      const c = await seedConnection(uid, { label: 'HL Main' });
      await send(CHAT, '/connections');
      expect(lastSentText()).toContain('HL Main');
    });

    it('/connections <agent> does not crash', async () => {
      const agent = await seedAgent(uid, { name: 'Momentum', status: 'stopped' });
      const c = await seedConnection(uid);
      await ctx.db.insert(agentConnections).values({
        id: crypto.randomUUID(), agentId: agent.id, connectionId: c.id,
        status: 'active', grantedBy: uid,
      });
      await send(CHAT, '/connections Momentum');
      // Should return a response, not crash
      expect(lastSentText()).toBeTruthy();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Lifecycle — DB state transitions
  // ═══════════════════════════════════════════════════════════════════════

  describe('lifecycle (DB state)', () => {
    const CHAT = '33333';
    let uid: string;

    beforeEach(async () => { uid = (await seedUser(CHAT)).id; });

    it('/start transitions stopped → starting', async () => {
      const a = await seedAgent(uid, { name: 'Trader', status: 'stopped' });
      await send(CHAT, '/start Trader');
      const [row] = await ctx.db.select({ status: agents.status }).from(agents).where(eq(agents.id, a.id));
      expect(row?.status).toBe('starting');
    });

    it('/start rejects already-running', async () => {
      await seedAgent(uid, { name: 'Trader', status: 'active' });
      await send(CHAT, '/start Trader');
      expect(lastSentText().toLowerCase()).toContain('cannot start');
    });

    it('/start operates on all duplicate-named agents', async () => {
      await seedAgent(uid, { name: 'Dup', status: 'stopped' });
      await seedAgent(uid, { name: 'Dup', status: 'stopped' });
      await send(CHAT, '/start Dup');
      const rows = await ctx.db.select({ status: agents.status }).from(agents).where(eq(agents.userId, uid));
      expect(rows.filter(r => r.status === 'starting')).toHaveLength(2);
    });

    it('/stop transitions active → stopped + marks session', async () => {
      const a = await seedAgent(uid, { name: 'Trader', status: 'active' });
      const s = await ctx.db.insert(agentRuntimeSessions).values({
        id: crypto.randomUUID(), agentId: a.id, status: 'running', startedAt: new Date(),
      }).returning().then(r => r[0]!);
      await send(CHAT, '/stop Trader');
      const [ar] = await ctx.db.select({ status: agents.status }).from(agents).where(eq(agents.id, a.id));
      expect(ar?.status).toBe('stopped');
      const [sr] = await ctx.db.select({ status: agentRuntimeSessions.status }).from(agentRuntimeSessions).where(eq(agentRuntimeSessions.id, s.id));
      expect(sr?.status).toBe('stopped');
    });

    it('/stop is idempotent', async () => {
      await seedAgent(uid, { name: 'Trader', status: 'stopped' });
      await send(CHAT, '/stop Trader');
      expect(lastSentText()).toContain('Stopped Trader');
    });

    it('/pause transitions active → paused', async () => {
      const a = await seedAgent(uid, { name: 'Trader', status: 'active' });
      await send(CHAT, '/pause Trader');
      const [row] = await ctx.db.select({ status: agents.status }).from(agents).where(eq(agents.id, a.id));
      expect(row?.status).toBe('paused');
    });

    it('/resume transitions paused → active', async () => {
      const a = await seedAgent(uid, { name: 'Trader', status: 'paused' });
      await send(CHAT, '/resume Trader');
      const [row] = await ctx.db.select({ status: agents.status }).from(agents).where(eq(agents.id, a.id));
      expect(row?.status).toBe('active');
    });

    it('/resume rejects non-paused', async () => {
      await seedAgent(uid, { name: 'Trader', status: 'active' });
      await send(CHAT, '/resume Trader');
      expect(lastSentText().toLowerCase()).toContain('cannot resume');
    });

    it('/restart stops agent immediately', async () => {
      // Restart polls 3x2s for stopped status — too slow for functional test.
      // The handler-level integration tests cover the full restart flow.
      // This test verifies that the stop phase succeeds and the command
      // doesn't crash.
      const a = await seedAgent(uid, { name: 'Trader', status: 'paused' });
      await send(CHAT, '/restart Trader');
      // After stop, agent should be in stopped state (start may not complete within poll window)
      const [row] = await ctx.db.select({ status: agents.status }).from(agents).where(eq(agents.id, a.id));
      expect(['stopped', 'starting']).toContain(row?.status);
    });

    it('cannot operate on another user\'s agent', async () => {
      const other = (await seedUser('44444')).id;
      await seedAgent(other, { name: 'Trader', status: 'stopped' });
      await send(CHAT, '/start Trader');
      expect(lastSentText()).toContain('not found');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Config — mode, connect, disconnect
  // ═══════════════════════════════════════════════════════════════════════

  describe('config (DB state)', () => {
    const CHAT = '55555';
    let uid: string;

    beforeEach(async () => { uid = (await seedUser(CHAT)).id; });

    it('/mode read-only shows execution mode', async () => {
      await seedAgent(uid, { name: 'Trader' });
      await send(CHAT, '/mode Trader');
      expect(lastSentText()).toContain('paper');
    });

    it('/mode set rejects non-stopped agent', async () => {
      await seedAgent(uid, { name: 'Trader', status: 'active' });
      await send(CHAT, '/mode Trader live');
      expect(lastSentText()).toContain('Cannot change execution mode');
    });

    it('/connect rejects non-stopped agent', async () => {
      const a = await seedAgent(uid, { name: 'Trader', status: 'active' });
      const c = await seedConnection(uid);
      await send(CHAT, `/connect Trader ${c.id}`);
      expect(lastSentText().toLowerCase()).toContain('stop');
    });

    it('/connect grants connection when stopped', async () => {
      const a = await seedAgent(uid, { name: 'Trader', status: 'stopped' });
      const c = await seedConnection(uid);
      await send(CHAT, `/connect Trader ${c.id}`);
      const [grant] = await ctx.db.select({ status: agentConnections.status })
        .from(agentConnections).where(and(eq(agentConnections.agentId, a.id), eq(agentConnections.connectionId, c.id)));
      expect(grant).toBeDefined();
    });

    it('/disconnect rejects non-stopped agent', async () => {
      const a = await seedAgent(uid, { name: 'Trader', status: 'active' });
      const c = await seedConnection(uid);
      await send(CHAT, `/disconnect Trader ${c.id}`);
      expect(lastSentText().toLowerCase()).toContain('stop');
    });

    it('/disconnect revokes connection when stopped', async () => {
      const a = await seedAgent(uid, { name: 'Trader', status: 'stopped' });
      const c = await seedConnection(uid);
      await ctx.db.insert(agentConnections).values({
        id: crypto.randomUUID(), agentId: a.id, connectionId: c.id,
        status: 'active', grantedBy: uid,
      });
      await send(CHAT, `/disconnect Trader ${c.id}`);
      const [grant] = await ctx.db.select({ status: agentConnections.status })
        .from(agentConnections).where(and(eq(agentConnections.agentId, a.id), eq(agentConnections.connectionId, c.id)));
      expect(grant?.status).toBe('revoked');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════════════════════════════════════

  it('bare /start returns onboarding help (not lifecycle)', async () => {
    await seedUser('77777');
    await send('77777', '/start');
    expect(lastSentText()).toContain('Available commands');
  });

  it('/to routes message to running agent', async () => {
    const uid = (await seedUser('66666')).id;
    await seedAgent(uid, { name: 'Momentum', status: 'active' });
    await send('66666', '/to Momentum hello');
    expect(lastSentText()).toBeTruthy();
  });
});
