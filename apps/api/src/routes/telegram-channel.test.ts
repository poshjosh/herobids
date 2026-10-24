import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { Redis as RedisClient } from 'ioredis';
import { TelegramInboundChannel } from './telegram-channel.js';
import { ChatInboundRouter } from './chat-inbound-router.js';

const adapter = new TelegramInboundChannel('secret');
const headers = { 'x-telegram-bot-api-secret-token': 'secret' };

describe('Telegram inbound channel', () => {
  it('rejects an invalid webhook token', () => {
    expect(adapter.verify({ headers: {}, body: {} }).ok).toBe(false);
    expect(adapter.verify({ headers, body: {} }).ok).toBe(true);
  });

  it('accepts the correct webhook secret', () => {
    expect(adapter.verify({ headers, body: {} }).ok).toBe(true);
  });

  it('rejects a wrong webhook secret of equal length', () => {
    expect(adapter.verify({ headers: { 'x-telegram-bot-api-secret-token': 'secrex' }, body: {} }).ok).toBe(false);
  });

  it('rejects a wrong webhook secret of different length', () => {
    expect(adapter.verify({ headers: { 'x-telegram-bot-api-secret-token': 'secret-longer' }, body: {} }).ok).toBe(false);
    expect(adapter.verify({ headers: { 'x-telegram-bot-api-secret-token': 'sec' }, body: {} }).ok).toBe(false);
  });

  it('rejects every request when the configured webhook secret is empty', () => {
    const emptyAdapter = new TelegramInboundChannel('');
    expect(emptyAdapter.verify({ headers: { 'x-telegram-bot-api-secret-token': '' }, body: {} }).ok).toBe(false);
    expect(emptyAdapter.verify({ headers: { 'x-telegram-bot-api-secret-token': 'anything' }, body: {} }).ok).toBe(false);
  });

  it('rejects an empty webhook secret header', () => {
    expect(adapter.verify({ headers: { 'x-telegram-bot-api-secret-token': '' }, body: {} }).ok).toBe(false);
  });

  it('rejects a repeated webhook secret header sent as an array', () => {
    expect(adapter.verify({ headers: { 'x-telegram-bot-api-secret-token': ['secret', 'secret'] }, body: {} }).ok).toBe(false);
  });

  it('rejects a missing webhook secret header', () => {
    expect(adapter.verify({ headers: {}, body: {} })).toEqual({
      ok: false,
      error: { code: 'chat.unauthorized', message: 'Invalid Telegram webhook token' },
    });
  });

  it('normalizes chat IDs, replies, and documents without changing the webhook payload', () => {
    const result = adapter.parse({ headers, body: {
      message: {
        chat: { id: 123 }, message_id: 42, text: ' /to Ada hello ',
        reply_to_message: { message_id: 41 },
        document: { file_id: 'file-1', file_name: 'report.txt' },
      },
    } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]).toMatchObject({
      provider: 'telegram', from: { provider: 'telegram', address: '123' },
      providerMessageId: '42', inReplyToProviderMessageId: '41',
      document: { id: 'file-1', filename: 'report.txt' },
    });
  });

  it('preserves slash, reply, target, and plain-text precedence', () => {
    const router = new ChatInboundRouter();
    const parsed = adapter.parse({ headers, body: {
      message: { chat: { id: 123 }, text: '/help', reply_to_message: { message_id: 41 } },
    } });
    if (!parsed.ok) throw new Error('Unexpected parse failure');
    const message = parsed.data[0]!;
    expect(router.route(message).kind).toBe('slash');
    expect(router.route({ ...message, text: '/to Ada hello' }).kind).toBe('reply');
    expect(router.route({ ...message, inReplyToProviderMessageId: undefined, text: '/to Ada hello' }).kind).toBe('target');
    expect(router.route({ ...message, inReplyToProviderMessageId: undefined, text: 'hello' }).kind).toBe('plain');
  });

  it('keeps colliding reply IDs and addresses isolated by provider', async () => {
    const router = new ChatInboundRouter();
    const parsed = adapter.parse({ headers, body: { message: { chat: { id: 123 }, text: 'hello', reply_to_message: { message_id: 41 } } } });
    if (!parsed.ok) throw new Error('Unexpected parse failure');
    const telegramMessage = parsed.data[0]!;
    const whatsappMessage = { ...telegramMessage, provider: 'whatsapp' as const, from: { ...telegramMessage.from, provider: 'whatsapp' as const } };
    const redis = { xadd: vi.fn().mockResolvedValue('1-1') } as unknown as Redis;
    const resolveReply = vi.fn().mockImplementation(async (_messageId: string, address: typeof telegramMessage.from) => ({
      agentId: address.provider === 'telegram' ? 'agent-telegram' : 'agent-whatsapp',
      agentName: address.provider === 'telegram' ? 'Ada' : 'Bea',
      status: 'running', userId: 'owner-1',
    }));
    const listAgents = vi.fn();
    const sendText = vi.fn().mockResolvedValue(undefined);

    await router.dispatch(telegramMessage, undefined, { redis, resolveReply, listAgents, sendText });
    await router.dispatch(whatsappMessage, undefined, { redis, resolveReply, listAgents, sendText });

    expect(resolveReply).toHaveBeenNthCalledWith(1, '41', { provider: 'telegram', address: '123' });
    expect(resolveReply).toHaveBeenNthCalledWith(2, '41', { provider: 'whatsapp', address: '123' });
    expect(listAgents).not.toHaveBeenCalled();
    expect(redis.xadd).toHaveBeenCalledWith('agent:outbound:agent-telegram', 'MAXLEN', '~', expect.any(Number), '*', 'envelope', expect.stringContaining('"initiatorId":"owner-1"'));
    expect(redis.xadd).toHaveBeenCalledWith('agent:outbound:agent-whatsapp', 'MAXLEN', '~', expect.any(Number), '*', 'envelope', expect.stringContaining('"initiatorId":"owner-1"'));
    expect(sendText).toHaveBeenNthCalledWith(1, { provider: 'telegram', address: '123' }, 'Delivered to Ada.');
    expect(sendText).toHaveBeenNthCalledWith(2, { provider: 'whatsapp', address: '123' }, 'Delivered to Bea.');
  });
});

describe('ChatInboundRouter typing', () => {
  const runningAgent = { agentId: 'agent-1', agentName: 'Ada', status: 'running', userId: 'owner-1' };

  function messageWithText(text: string, inReplyTo?: number) {
    const parsed = adapter.parse({ headers, body: {
      message: { chat: { id: 123 }, text, ...(inReplyTo ? { reply_to_message: { message_id: inReplyTo } } : {}) },
    } });
    if (!parsed.ok) throw new Error('Unexpected parse failure');
    return parsed.data[0]!;
  }

  function dependencies(overrides: { listAgents?: () => Promise<unknown>; resolveReply?: () => Promise<unknown> } = {}) {
    const redis = new RedisClient({ lazyConnect: true });
    const xadd = vi.spyOn(redis, 'xadd').mockResolvedValue('1-1');
    const sendText = vi.fn().mockResolvedValue(undefined);
    const startTyping = vi.fn();
    return {
      xadd,
      sendText,
      startTyping,
      deps: {
        redis,
        resolveReply: vi.fn(overrides.resolveReply ?? (async () => null)),
        listAgents: vi.fn(overrides.listAgents ?? (async () => [runningAgent])),
        sendText,
        startTyping,
      },
    };
  }

  it('starts typing after the acknowledgement when a plain message reaches the only running agent', async () => {
    const { xadd, sendText, startTyping, deps } = dependencies();

    await new ChatInboundRouter().dispatch(messageWithText('hello'), 'owner-1', deps);

    expect(xadd).toHaveBeenCalledTimes(1);
    expect(startTyping).toHaveBeenCalledWith({ provider: 'telegram', address: '123' });
    expect(startTyping.mock.invocationCallOrder[0]).toBeGreaterThan(sendText.mock.invocationCallOrder[0]!);
  });

  it('starts typing for a targeted agent after the delivery confirmation', async () => {
    const { sendText, startTyping, deps } = dependencies();

    await new ChatInboundRouter().dispatch(messageWithText('/to Ada hello'), 'owner-1', deps);

    expect(startTyping).toHaveBeenCalledTimes(1);
    expect(startTyping.mock.invocationCallOrder[0]).toBeGreaterThan(sendText.mock.invocationCallOrder[0]!);
  });

  it('starts typing for a reply that is delivered to its agent', async () => {
    const { startTyping, deps } = dependencies({ resolveReply: async () => runningAgent });

    await new ChatInboundRouter().dispatch(messageWithText('hello', 41), undefined, deps);

    expect(startTyping).toHaveBeenCalledWith({ provider: 'telegram', address: '123' });
  });

  it('does not start typing when the only target agent is stopped', async () => {
    const { xadd, startTyping, deps } = dependencies({ listAgents: async () => [{ ...runningAgent, status: 'stopped' }] });

    await new ChatInboundRouter().dispatch(messageWithText('/to Ada hello'), 'owner-1', deps);

    expect(xadd).not.toHaveBeenCalled();
    expect(startTyping).not.toHaveBeenCalled();
  });
});