/**
 * Functional tests for the Telegram side of the two-way agent chat (CH2W P3), against a real database and Redis.
 *
 * Inbound Telegram text is recorded in the agent's conversation before it is published; a reply is routed through
 * the conversation message it points at; /log reads the conversation; an opted-out chat gets no reply at all.
 *
 * Requires DATABASE_URL and REDIS_URL (skipped otherwise).
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { sql, eq } from 'drizzle-orm';
import {
  createDatabase,
  setChatAddress,
  users,
  agents,
  chatSuppressions,
  conversationMessages,
  conversationParticipants,
  conversations,
} from '@herobids/db';
import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';
import { userAgentConversationId } from '@herobids/domain';
import { telegramWebhookHandler } from '../../routes/agent-interactivity.js';
import { SKIP, DB_URL, REDIS_URL, parseRedisUrl } from '../functional/helpers.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const realFetch = globalThis.fetch;
const sent: string[] = [];
let botToken: string;
let webhookSecret: string;

function installMock() {
  sent.length = 0;
  botToken = `test-bot-${crypto.randomUUID()}`;
  webhookSecret = `test-secret-${crypto.randomUUID()}`;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.startsWith(TELEGRAM_API_BASE)) {
      sent.push((JSON.parse(String(init?.body ?? '{}')) as { text?: string }).text ?? '');
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
}

interface Ctx {
  app: ReturnType<typeof Fastify>;
  db: Database;
  redis: Redis;
}
let ctx: Ctx;

beforeEach(async () => {
  if (SKIP) return;
  installMock();
  const db = createDatabase(DB_URL);
  const { Redis: RedisCtor } = await import('ioredis');
  const redis = new RedisCtor(parseRedisUrl(REDIS_URL));
  await db.execute(sql`TRUNCATE conversations, agents, users, chat_addresses, chat_suppressions CASCADE`);
  const app = Fastify({ logger: false });
  await telegramWebhookHandler(app, db, redis, { botToken, webhookSecret, webhookUrl: undefined });
  await app.ready();
  ctx = { app, db, redis };
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (SKIP || !ctx) return;
  await ctx.app.close();
  await ctx.redis.quit();
});

afterAll(() => { globalThis.fetch = realFetch; });

async function seedUserWithChat(chatId: string) {
  const id = crypto.randomUUID();
  await ctx.db.insert(users).values({
    id, email: `tg-${chatId}@t.local`, displayName: `TG${chatId}`, username: `tg-${chatId}-${id.slice(0, 6)}`,
  });
  await setChatAddress(ctx.db, { userId: id, agentId: null }, 'telegram', chatId);
  return id;
}

async function seedAgent(userId: string, name: string, status = 'running') {
  const id = crypto.randomUUID();
  await ctx.db.insert(agents).values({ id, userId, name, prompt: 'p', status, style: 'balanced' });
  return id;
}

async function post(chatId: string, text: string, replyTo?: number) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/telegram/webhook',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': webhookSecret },
    payload: {
      update_id: Date.now(),
      message: { message_id: Date.now(), chat: { id: Number(chatId), type: 'private' }, text, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) },
    },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 400));
  return res;
}

/** A message the agent sent to the user's Telegram chat, as the broker records it once Telegram returned `providerMessageId`. */
async function seedAgentTelegramMessage(userId: string, agentId: string, providerMessageId: string) {
  const conversationId = userAgentConversationId(agentId);
  await ctx.db.insert(conversations).values({ id: conversationId, kind: 'user_agent', ownerUserId: userId }).onConflictDoNothing();
  await ctx.db.insert(conversationParticipants).values([
    { conversationId, participantType: 'user', participantId: userId },
    { conversationId, participantType: 'agent', participantId: agentId },
  ]).onConflictDoNothing();
  await ctx.db.insert(conversationMessages).values({
    id: crypto.randomUUID(), conversationId, senderType: 'agent', senderId: agentId, channel: 'telegram',
    body: 'Which pair?', deliveryStatus: 'sent', providerMessageId,
  });
}

const rowsOf = (agentId: string) => ctx.db.select().from(conversationMessages)
  .where(eq(conversationMessages.conversationId, userAgentConversationId(agentId)));

describe.skipIf(SKIP)('Telegram two-way chat — functional', () => {
  it('records a plain message in the agent thread on the telegram channel and publishes it under the row id', async () => {
    const userId = await seedUserWithChat('7001');
    const agentId = await seedAgent(userId, 'Solo');

    const res = await post('7001', 'check ETH too');

    expect(res.statusCode).toBe(200);
    const [row] = await rowsOf(agentId);
    expect(row).toMatchObject({ senderType: 'user', senderId: userId, channel: 'telegram', body: 'check ETH too', deliveryStatus: 'sent' });
    const entries = await ctx.redis.xrange(`agent:outbound:${agentId}`, '-', '+');
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]![1][1]!)).toMatchObject({ messageId: row?.id, type: 'user.message', payload: { message: 'check ETH too' } });
    expect(sent.some((text) => text.includes('Delivered to Solo.'))).toBe(true);
    await ctx.redis.del(`agent:outbound:${agentId}`);
  });

  it('routes a reply to the agent whose message it points at, through the provider message index', async () => {
    const userId = await seedUserWithChat('7002');
    const asked = await seedAgent(userId, 'Asker');
    const other = await seedAgent(userId, 'Other');
    await seedAgentTelegramMessage(userId, asked, '5150');

    await post('7002', 'BTC please', 5150);

    const [row] = await rowsOf(asked);
    expect(row).toBeDefined();
    expect((await rowsOf(asked)).filter((message) => message.senderType === 'user')).toHaveLength(1);
    expect(await rowsOf(other)).toHaveLength(0);
    expect(sent.some((text) => text.includes('Delivered to Asker.'))).toBe(true);
    await ctx.redis.del(`agent:outbound:${asked}`);
  });

  it('answers a reply to an unknown message with the not-found text and records nothing', async () => {
    const userId = await seedUserWithChat('7003');
    const agentId = await seedAgent(userId, 'Solo');

    await post('7003', 'hello?', 9999);

    expect(await rowsOf(agentId)).toHaveLength(0);
    expect(sent.some((text) => text.includes("couldn't find which agent"))).toBe(true);
  });

  it('shows the thread, with who wrote each message, in /log', async () => {
    const userId = await seedUserWithChat('7004');
    const agentId = await seedAgent(userId, 'Logger');
    await seedAgentTelegramMessage(userId, agentId, '1');
    await post('7004', 'BTC please', 1);

    await post('7004', '/log Logger');

    const log = sent[sent.length - 1] ?? '';
    expect(log).toContain('Logger — recent activity:');
    expect(log).toContain('AGENT: Which pair?');
    expect(log).toContain('YOU: BTC please');
    await ctx.redis.del(`agent:outbound:${agentId}`);
  });

  it('gives an opted-out chat no reply and records nothing, even for /help and replies', async () => {
    const userId = await seedUserWithChat('7005');
    const agentId = await seedAgent(userId, 'Quiet');
    await seedAgentTelegramMessage(userId, agentId, '42');
    await ctx.db.insert(chatSuppressions).values({ provider: 'telegram', address: '7005', status: 'revoked' });
    const before = (await rowsOf(agentId)).length;

    await post('7005', '/help');
    await post('7005', 'still there?', 42);
    await post('7005', 'plain text');

    expect(sent).toEqual([]);
    expect(await rowsOf(agentId)).toHaveLength(before);
    expect(await ctx.redis.exists(`agent:outbound:${agentId}`)).toBe(0);
  });
});
