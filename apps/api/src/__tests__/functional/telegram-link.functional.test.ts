/**
 * Functional tests for Telegram deep-link connect: POST /auth/me/telegram/link and the
 * `/start link_<token>` branch of the webhook, plus regression for `/start <agent>` and bare `/start`.
 *
 * Requires DATABASE_URL and REDIS_URL (skipped otherwise). Tables are truncated before each test.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql, eq, and } from 'drizzle-orm';
import { createDatabase, users, agents, chatAddresses, chatSuppressions, lockChatAddress } from '@herobids/db';
import { UnifiedAgentConfigSchema } from '@herobids/domain';
import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';
import { authRoutes } from '../../routes/auth.js';
import { telegramWebhookHandler } from '../../routes/agent-interactivity.js';
import { SKIP, DB_URL, REDIS_URL, parseRedisUrl, makeAuthConfig } from './helpers.js';

const BOT_USERNAME = 'OpenAIdomTestBot';
const BOT_TOKEN = 'telegram-link-test-bot-token';
const WEBHOOK_SECRET = 'telegram-link-test-webhook-secret';
const TELEGRAM_API_BASE = 'https://api.telegram.org';
const EXPIRED_TEXT = 'This link has expired. Generate a new one in the web app.';
const ALREADY_CONNECTED_TEXT = 'This Telegram account is already connected to another OpenAIdom account.';
const CONNECTED_TEXT = 'Connected ✅';

// ── Telegram Bot API mock ─────────────────────────────────────────────────

const realFetch = globalThis.fetch;
let sentMessages: Array<{ chatId: string; text: string }> = [];

function installTelegramMock() {
  sentMessages = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as Request).url;
    if (url.startsWith(TELEGRAM_API_BASE)) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { chat_id?: number | string; text?: string };
      sentMessages.push({ chatId: String(body.chat_id), text: body.text ?? '' });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
}

function uninstallTelegramMock() {
  globalThis.fetch = realFetch;
}

/** Webhook processing runs after the 200 is sent, so wait for the expected reply to land. */
async function waitForReply(chatId: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = sentMessages.filter((message) => message.chatId === chatId).at(-1);
    if (reply) return reply.text;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no reply sent to chat ${chatId}`);
}

/** Waits until `count` replies have landed in the chat, then returns their texts in order. */
async function waitForReplies(chatId: string, count: number, timeoutMs = 5000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const replies = sentMessages.filter((message) => message.chatId === chatId).map((message) => message.text);
    if (replies.length >= count) return replies;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fewer than ${count} replies sent to chat ${chatId}`);
}

/** Gives async processing time to finish, for assertions that nothing happened. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500));
}

// ── Harness ───────────────────────────────────────────────────────────────

let db: Database;
let redis: Redis;
let app: FastifyInstance;

/** Builds the auth and webhook routes. `x-test-user-id` stands in for the auth plugin. */
async function buildApp(botUsername: string | undefined): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  instance.decorateRequest('userId', '');
  instance.addHook('onRequest', async (request) => {
    const testUserId = request.headers['x-test-user-id'];
    if (typeof testUserId === 'string') request.userId = testUserId;
  });
  await authRoutes(instance, makeAuthConfig(), db, redis, 'free', undefined, undefined, false, botUsername);
  await telegramWebhookHandler(instance, db, redis, {
    botToken: BOT_TOKEN,
    webhookSecret: WEBHOOK_SECRET,
    webhookUrl: undefined,
  });
  await instance.ready();
  return instance;
}

async function seedUser(label: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    email: `${label}-${id.slice(0, 8)}@t.local`,
    displayName: label,
    username: `tglink_${label}_${id.slice(0, 8)}`,
    aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
  });
  return id;
}

async function requestLink(userId: string) {
  return app.inject({ method: 'POST', url: '/auth/me/telegram/link', headers: { 'x-test-user-id': userId } });
}

async function issueToken(userId: string): Promise<string> {
  const res = await requestLink(userId);
  if (res.statusCode !== 200) throw new Error(`link request failed with ${res.statusCode}`);
  const url = new URL((res.json() as { url: string }).url);
  return (url.searchParams.get('start') ?? '').replace(/^link_/, '');
}

async function sendStart(chatId: string, text: string, chatType = 'private') {
  return app.inject({
    method: 'POST',
    url: '/telegram/webhook',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    payload: {
      update_id: Math.floor(Math.random() * 1_000_000_000),
      message: { message_id: Math.floor(Math.random() * 1_000_000_000), chat: { id: Number(chatId), type: chatType }, text },
    },
  });
}

async function suppressionCount(chatId: string): Promise<number> {
  const rows = await db.select({ address: chatSuppressions.address }).from(chatSuppressions)
    .where(and(eq(chatSuppressions.provider, 'telegram'), eq(chatSuppressions.address, chatId)));
  return rows.length;
}

async function seedStoppedAgent(userId: string, name: string): Promise<void> {
  await db.insert(agents).values({
    id: crypto.randomUUID(),
    userId,
    name,
    prompt: 'Test goal',
    status: 'stopped',
    unifiedConfig: UnifiedAgentConfigSchema.parse({ capabilityMode: 'intelligence' }),
    style: 'balanced',
  });
}

async function userTelegramRows(userId: string) {
  return db.select({ address: chatAddresses.address, agentId: chatAddresses.agentId, status: chatAddresses.status })
    .from(chatAddresses)
    .where(and(eq(chatAddresses.userId, userId), eq(chatAddresses.provider, 'telegram')));
}

/** Number of link-consume lock requests queued behind a held chat lock (advisory namespace 75). */
async function waitForChatLockWaiters(count: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db.execute(sql`SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND classid = 75 AND NOT granted`);
    if (Number(row?.waiting) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fewer than ${count} requests waiting on the chat lock`);
}

async function userPreferredLocale(userId: string): Promise<string | null> {
  const [row] = await db.select({ preferredLocale: users.preferredLocale }).from(users).where(eq(users.id, userId));
  return row?.preferredLocale ?? null;
}

async function seedBoundUser(label: string, chatId: string): Promise<string> {
  const userId = await seedUser(label);
  await db.insert(chatAddresses).values({
    id: crypto.randomUUID(),
    userId,
    agentId: null,
    provider: 'telegram',
    address: chatId,
    status: 'active',
  });
  return userId;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)('Telegram deep-link connect — functional', () => {
  beforeAll(async () => {
    if (SKIP) return;
    db = createDatabase(DB_URL);
    const { Redis: RedisCtor } = await import('ioredis');
    redis = new RedisCtor(parseRedisUrl(REDIS_URL));
  });

  afterAll(async () => {
    if (SKIP) return;
    redis.disconnect();
  });

  beforeEach(async () => {
    installTelegramMock();
    await db.execute(sql`TRUNCATE users, agents, chat_addresses, chat_suppressions CASCADE`);
    app = await buildApp(BOT_USERNAME);
  });

  afterEach(async () => {
    uninstallTelegramMock();
    await app.close();
  });

  describe('POST /auth/me/telegram/link', () => {
    it('returns 401 when the request is not authenticated', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/me/telegram/link' });

      expect(res.statusCode).toBe(401);
    });

    it('returns 503 when the bot username is not configured', async () => {
      const unconfigured = await buildApp(undefined);
      const userId = await seedUser('unconfigured');

      const res = await unconfigured.inject({
        method: 'POST',
        url: '/auth/me/telegram/link',
        headers: { 'x-test-user-id': userId },
      });
      await unconfigured.close();

      expect(res.statusCode).toBe(503);
    });

    it('returns a t.me link carrying a single-use token and an expiry about 10 minutes away', async () => {
      const userId = await seedUser('linker');
      const before = Date.now();

      const res = await requestLink(userId);

      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json() as { url: string; expiresAt: string };
      const url = new URL(body.url);
      expect(`${url.origin}${url.pathname}`).toBe(`https://t.me/${BOT_USERNAME}`);
      expect(url.searchParams.get('start')).toMatch(/^link_[A-Za-z0-9_-]+$/);
      const expiresInMs = Date.parse(body.expiresAt) - before;
      expect(expiresInMs).toBeGreaterThan(590_000);
      expect(expiresInMs).toBeLessThanOrEqual(610_000);
    });

    it('returns 429 once the user has requested five links in the window', async () => {
      const userId = await seedUser('spammer');
      for (let i = 0; i < 5; i += 1) {
        expect((await requestLink(userId)).statusCode).toBe(200);
      }

      const res = await requestLink(userId);

      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ error: 'auth.telegram_link.rate_limited' });
    });
  });

  describe('/start link_<token> webhook branch', () => {
    it('connects the chat to the user who issued the link', async () => {
      const chatId = '910001';
      const userId = await seedUser('connector');
      const token = await issueToken(userId);

      await sendStart(chatId, `/start link_${token}`);

      expect(await waitForReply(chatId)).toBe(CONNECTED_TEXT);
      expect(await userTelegramRows(userId)).toEqual([{ address: chatId, agentId: null, status: 'active' }]);
    });

    it('replies that the link has expired for an unknown token', async () => {
      const chatId = '910002';

      await sendStart(chatId, '/start link_not-a-real-token');

      expect(await waitForReply(chatId)).toBe(EXPIRED_TEXT);
    });

    it('rejects a replayed link as expired and keeps the first connection', async () => {
      const chatId = '910003';
      const userId = await seedUser('replayer');
      const token = await issueToken(userId);
      await sendStart(chatId, `/start link_${token}`);
      await waitForReply(chatId);

      await sendStart(chatId, `/start link_${token}`);

      await settle();
      expect(sentMessages.filter((message) => message.chatId === chatId).map((message) => message.text))
        .toEqual([CONNECTED_TEXT, EXPIRED_TEXT]);
      expect(await userTelegramRows(userId)).toEqual([{ address: chatId, agentId: null, status: 'active' }]);
    });

    it('rejects a chat already connected to another user and leaves that binding unchanged', async () => {
      const chatId = '910004';
      const ownerId = await seedBoundUser('owner', chatId);
      const otherUserId = await seedUser('other');
      const token = await issueToken(otherUserId);

      await sendStart(chatId, `/start link_${token}`);

      expect(await waitForReply(chatId)).toBe(ALREADY_CONNECTED_TEXT);
      expect(await userTelegramRows(otherUserId)).toEqual([]);
      expect(await userTelegramRows(ownerId)).toEqual([{ address: chatId, agentId: null, status: 'active' }]);
    });

    it('replaces the address when a user links a different chat', async () => {
      const oldChatId = '910005';
      const newChatId = '910006';
      const userId = await seedBoundUser('relinker', oldChatId);
      const token = await issueToken(userId);

      await sendStart(newChatId, `/start link_${token}`);

      expect(await waitForReply(newChatId)).toBe(CONNECTED_TEXT);
      expect(await userTelegramRows(userId)).toEqual([{ address: newChatId, agentId: null, status: 'active' }]);
    });

    it('treats linking the chat the user already has as success and keeps one row', async () => {
      const chatId = '910007';
      const userId = await seedBoundUser('samechat', chatId);
      const token = await issueToken(userId);

      await sendStart(chatId, `/start link_${token}`);

      expect(await waitForReply(chatId)).toBe(CONNECTED_TEXT);
      expect(await userTelegramRows(userId)).toEqual([{ address: chatId, agentId: null, status: 'active' }]);
    });

    it('reconnects a suppressed chat when the link is valid and lifts the suppression', async () => {
      const chatId = '910008';
      await db.insert(chatSuppressions).values({ provider: 'telegram', address: chatId, status: 'revoked' });
      const userId = await seedUser('reconnector');
      const token = await issueToken(userId);

      await sendStart(chatId, `/start link_${token}`);

      expect(await waitForReply(chatId)).toBe(CONNECTED_TEXT);
      expect(await userTelegramRows(userId)).toEqual([{ address: chatId, agentId: null, status: 'active' }]);
      expect(await suppressionCount(chatId)).toBe(0);
    });

    it('stays silent for a suppressed chat when the link is invalid and keeps the suppression', async () => {
      const chatId = '910010';
      await db.insert(chatSuppressions).values({ provider: 'telegram', address: chatId, status: 'revoked' });

      await sendStart(chatId, '/start link_not-a-real-token');

      await settle();
      expect(sentMessages.filter((message) => message.chatId === chatId)).toEqual([]);
      expect(await suppressionCount(chatId)).toBe(1);
    });

    it('stays silent for a suppressed chat when a valid link belongs to another user, and leaves that user unbound', async () => {
      const chatId = '910013';
      await seedBoundUser('suppressedowner', chatId);
      await db.insert(chatSuppressions).values({ provider: 'telegram', address: chatId, status: 'revoked' });
      const otherUserId = await seedUser('suppressedother');
      const token = await issueToken(otherUserId);

      await sendStart(chatId, `/start link_${token}`);

      await settle();
      expect(sentMessages.filter((message) => message.chatId === chatId)).toEqual([]);
      expect(await suppressionCount(chatId)).toBe(1);
      expect(await userTelegramRows(otherUserId)).toEqual([]);
    });

    it('rejects a link sent from a group chat without consuming it, so a private retry still works', async () => {
      const chatId = '910011';
      const userId = await seedUser('groupper');
      const token = await issueToken(userId);

      await sendStart(chatId, `/start link_${token}`, 'group');

      expect(await waitForReplies(chatId, 1)).toEqual(['Connect Telegram from a private chat with the bot.']);
      expect(await userTelegramRows(userId)).toEqual([]);

      await sendStart(chatId, `/start link_${token}`, 'private');

      expect(await waitForReplies(chatId, 2)).toEqual(['Connect Telegram from a private chat with the bot.', CONNECTED_TEXT]);
      expect(await userTelegramRows(userId)).toEqual([{ address: chatId, agentId: null, status: 'active' }]);
    });

    it('binds a chat to exactly one of two users who link it at the same time', async () => {
      const chatId = '910012';
      const firstUserId = await seedUser('racer1');
      const secondUserId = await seedUser('racer2');
      const firstToken = await issueToken(firstUserId);
      const secondToken = await issueToken(secondUserId);

      // Hold the chat's lock in another transaction. Both link attempts must queue behind it, which is proven by
      // two lock requests waiting in pg_locks, before any reply can be sent. Releasing the lock then starts the race.
      let releaseLock!: () => void;
      const lockReleased = new Promise<void>((resolve) => { releaseLock = resolve; });
      let lockHeld!: () => void;
      const lockAcquired = new Promise<void>((resolve) => { lockHeld = resolve; });
      const holder = db.transaction(async (tx) => {
        await lockChatAddress(tx, 'telegram', chatId);
        lockHeld();
        await lockReleased;
      });
      await lockAcquired;

      await Promise.all([
        sendStart(chatId, `/start link_${firstToken}`),
        sendStart(chatId, `/start link_${secondToken}`),
      ]);
      await waitForChatLockWaiters(2);
      expect(sentMessages.filter((message) => message.chatId === chatId)).toEqual([]);

      releaseLock();
      await holder;

      const replies = await waitForReplies(chatId, 2);
      expect([...replies].sort()).toEqual([ALREADY_CONNECTED_TEXT, CONNECTED_TEXT].sort());
      const winners = [
        ...(await userTelegramRows(firstUserId)),
        ...(await userTelegramRows(secondUserId)),
      ].filter((row) => row.address === chatId && row.status === 'active');
      expect(winners).toHaveLength(1);
    });

    it('does not treat a bare link_ prefix as a link and falls through to /start <agent>', async () => {
      const chatId = '910009';

      await sendStart(chatId, '/start link_');

      expect(await waitForReply(chatId)).toBe('Please bind your Telegram account first. Use /start to begin.');
    });
  });

  describe('PATCH /auth/me chatAddresses', () => {
    async function patchChatAddresses(userId: string, chatAddresses: unknown[], extra: Record<string, unknown> = {}) {
      return app.inject({
        method: 'PATCH',
        url: '/auth/me',
        headers: { 'x-test-user-id': userId },
        payload: { chatAddresses, ...extra },
      });
    }

    it('returns 409 and writes nothing when the named chat belongs to another user', async () => {
      const chatId = '930001';
      const ownerId = await seedBoundUser('patchowner', chatId);
      const otherUserId = await seedUser('patchother');

      const res = await patchChatAddresses(otherUserId, [{ provider: 'telegram', address: chatId }], { preferredLocale: 'ar' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'chat_address.in_use', message: ALREADY_CONNECTED_TEXT });
      expect(await userTelegramRows(otherUserId)).toEqual([]);
      expect(await userTelegramRows(ownerId)).toEqual([{ address: chatId, agentId: null, status: 'active' }]);
      expect(await userPreferredLocale(otherUserId)).toBeNull();
    });

    it('connects a chat that no other user owns', async () => {
      const chatId = '930002';
      const userId = await seedUser('patchconnect');

      const res = await patchChatAddresses(userId, [{ provider: 'telegram', address: chatId }]);

      expect(res.statusCode).toBe(200);
      expect(await userTelegramRows(userId)).toEqual([{ address: chatId, agentId: null, status: 'active' }]);
    });

    it('clears the user-level Telegram address when the address is null (Disconnect)', async () => {
      const chatId = '930003';
      const userId = await seedBoundUser('patchdisconnect', chatId);

      const res = await patchChatAddresses(userId, [{ provider: 'telegram', address: null }]);

      expect(res.statusCode).toBe(200);
      expect(await userTelegramRows(userId)).toEqual([]);
    });
  });

  describe('regression: /start <agent> and bare /start', () => {
    it('bare /start on an unbound chat returns the onboarding help with the chat id', async () => {
      const chatId = '920001';

      await sendStart(chatId, '/start');

      const text = await waitForReply(chatId);
      expect(text).toContain(`Your chat ID: ${chatId}`);
      expect(text).toContain('Available commands');
    });

    it('bare /start on a bound chat returns the onboarding help and does not start an agent', async () => {
      const chatId = '920002';
      const userId = await seedBoundUser('bareowner', chatId);
      await seedStoppedAgent(userId, 'Trader');

      await sendStart(chatId, '/start');

      expect(await waitForReply(chatId)).toContain('Available commands');
      const [row] = await db.select({ status: agents.status }).from(agents).where(eq(agents.userId, userId));
      expect(row?.status).toBe('stopped');
    });

    it('/start <agent> still starts a stopped agent for a bound chat', async () => {
      const chatId = '920003';
      const userId = await seedBoundUser('startowner', chatId);
      await seedStoppedAgent(userId, 'Trader');

      await sendStart(chatId, '/start Trader');

      expect(await waitForReply(chatId)).toBe('Started Trader.');
      const [row] = await db.select({ status: agents.status }).from(agents).where(eq(agents.userId, userId));
      expect(row?.status).toBe('starting');
    });

    it('/start <agent> from an unbound chat still asks the user to bind first', async () => {
      const chatId = '920004';

      await sendStart(chatId, '/start Trader');

      expect(await waitForReply(chatId)).toBe('Please bind your Telegram account first. Use /start to begin.');
    });
  });
});
