import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { Redis as RedisClient } from 'ioredis';
import { TelegramInboundChannel } from './telegram-channel.js';
import { ChatInboundRouter } from './chat-inbound-router.js';

const adapter = new TelegramInboundChannel('secret');
const headers = { 'x-telegram-bot-api-secret-token': 'secret' };

/** A conversation service stub that records every message under a sequential id. */
function makeConversations(overrides: { recordUserMessage?: ReturnType<typeof vi.fn> } = {}) {
  let n = 0;
  return {
    recordUserMessage: overrides.recordUserMessage ?? vi.fn(async () => ({ ok: true, data: { message: { id: `row-${++n}` }, created: true } })),
    markDelivery: vi.fn(async () => ({ ok: true, data: {} })),
  };
}

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

  it('keeps colliding reply IDs and addresses isolated by provider, and refuses a provider with no conversation channel', async () => {
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
    const conversations = makeConversations();

    await router.dispatch(telegramMessage, undefined, { redis, conversations: conversations as never, resolveReply, listAgents, sendText });
    await router.dispatch(whatsappMessage, undefined, { redis, conversations: conversations as never, resolveReply, listAgents, sendText });

    expect(resolveReply).toHaveBeenNthCalledWith(1, '41', { provider: 'telegram', address: '123' });
    expect(resolveReply).toHaveBeenNthCalledWith(2, '41', { provider: 'whatsapp', address: '123' });
    expect(listAgents).not.toHaveBeenCalled();
    expect(redis.xadd).toHaveBeenCalledWith('agent:outbound:agent-telegram', 'MAXLEN', '~', expect.any(Number), '*', 'envelope', expect.stringContaining('"initiatorId":"owner-1"'));
    expect(redis.xadd).not.toHaveBeenCalledWith('agent:outbound:agent-whatsapp', expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything());
    expect(conversations.recordUserMessage).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenNthCalledWith(1, { provider: 'telegram', address: '123' }, 'Delivered to Ada.');
    expect(sendText).toHaveBeenNthCalledWith(2, { provider: 'whatsapp', address: '123' }, 'Could not deliver your message to Bea. Please try again.');
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

  function dependencies(overrides: { listAgents?: () => Promise<unknown>; resolveReply?: () => Promise<unknown>; conversations?: ReturnType<typeof makeConversations> } = {}) {
    const redis = new RedisClient({ lazyConnect: true });
    const xadd = vi.spyOn(redis, 'xadd').mockResolvedValue('1-1');
    const sendText = vi.fn().mockResolvedValue(undefined);
    const startTyping = vi.fn();
    const conversations = overrides.conversations ?? makeConversations();
    return {
      xadd,
      sendText,
      startTyping,
      conversations,
      deps: {
        redis,
        conversations: conversations as never,
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

  it('records the user message on the telegram channel, publishes it under the row id, then marks it sent', async () => {
    const order: string[] = [];
    const conversations = makeConversations();
    conversations.recordUserMessage.mockImplementation(async () => { order.push('recorded'); return { ok: true, data: { message: { id: 'row-1' }, created: true } }; });
    conversations.markDelivery.mockImplementation(async () => { order.push('marked'); return { ok: true, data: {} }; });
    const { xadd, deps } = dependencies({ conversations });
    xadd.mockImplementation((async () => { order.push('published'); return '1-1'; }) as never);

    await new ChatInboundRouter().dispatch(messageWithText('hello'), 'owner-1', deps);

    expect(conversations.recordUserMessage).toHaveBeenCalledWith({ ownerUserId: 'owner-1', agentId: 'agent-1', channel: 'telegram', body: 'hello' });
    expect(xadd).toHaveBeenCalledWith('agent:outbound:agent-1', 'MAXLEN', '~', expect.any(Number), '*', 'envelope', expect.stringContaining('"messageId":"row-1"'));
    expect(conversations.markDelivery).toHaveBeenCalledWith({ messageId: 'row-1', status: 'sent' });
    expect(order).toEqual(['recorded', 'published', 'marked']);
  });

  it('records a reply under the agent owner and publishes it to the resolved agent', async () => {
    const { xadd, conversations, deps } = dependencies({ resolveReply: async () => runningAgent });

    await new ChatInboundRouter().dispatch(messageWithText('thanks', 41), undefined, deps);

    expect(conversations.recordUserMessage).toHaveBeenCalledWith({ ownerUserId: 'owner-1', agentId: 'agent-1', channel: 'telegram', body: 'thanks' });
    expect(xadd).toHaveBeenCalledTimes(1);
  });

  it('records one row per targeted agent', async () => {
    const second = { agentId: 'agent-2', agentName: 'Bea', status: 'running' };
    const { xadd, conversations, deps } = dependencies({ listAgents: async () => [runningAgent, second] });

    await new ChatInboundRouter().dispatch(messageWithText('/to all hello'), 'owner-1', deps);

    expect(conversations.recordUserMessage.mock.calls.map(([input]) => (input as { agentId: string }).agentId)).toEqual(['agent-1', 'agent-2']);
    expect(xadd).toHaveBeenCalledTimes(2);
  });

  it('does not publish or confirm, and tells the user, when the message cannot be recorded', async () => {
    const conversations = makeConversations({
      recordUserMessage: vi.fn(async () => ({ ok: false, error: { code: 'conversation.store_failed', message: 'down' } })),
    });
    const { xadd, sendText, startTyping, deps } = dependencies({ conversations });

    await new ChatInboundRouter().dispatch(messageWithText('hello'), 'owner-1', deps);

    expect(xadd).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith({ provider: 'telegram', address: '123' }, 'Could not deliver your message to Ada. Please try again.');
    expect(startTyping).not.toHaveBeenCalled();
  });

  it('tells the user the limit when the message is too long, and does not publish', async () => {
    const conversations = makeConversations({
      recordUserMessage: vi.fn(async () => ({ ok: false, error: { code: 'conversation.body_too_long', message: 'body_too_long', context: { maxChars: 4000 } } })),
    });
    const { xadd, sendText, deps } = dependencies({ conversations });

    await new ChatInboundRouter().dispatch(messageWithText('hello'), 'owner-1', deps);

    expect(xadd).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith({ provider: 'telegram', address: '123' }, expect.stringContaining('4000 characters'));
  });

  it('marks the row failed and tells the user when the publish fails', async () => {
    const { xadd, sendText, startTyping, conversations, deps } = dependencies();
    xadd.mockRejectedValue(new Error('redis down'));

    await new ChatInboundRouter().dispatch(messageWithText('hello'), 'owner-1', deps);

    expect(conversations.markDelivery).toHaveBeenCalledWith({ messageId: 'row-1', status: 'failed', detail: 'publish_failed' });
    expect(sendText).toHaveBeenCalledWith({ provider: 'telegram', address: '123' }, 'Could not deliver your message to Ada. Please try again.');
    expect(startTyping).not.toHaveBeenCalled();
  });

  it('still confirms when the sent mark fails, retries it a bounded number of times, and logs at error', async () => {
    const { sendText, conversations, deps } = dependencies();
    const log = { warn: vi.fn(), error: vi.fn() };
    conversations.markDelivery.mockResolvedValue({ ok: false, error: { code: 'conversation.store_failed', message: 'down' } } as never);

    await new ChatInboundRouter().dispatch(messageWithText('hello'), 'owner-1', { ...deps, log });

    expect(conversations.markDelivery).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'row-1', code: 'conversation.store_failed', attempts: 3 }), expect.any(String));
    expect(sendText).toHaveBeenCalledWith({ provider: 'telegram', address: '123' }, 'Delivered to Ada.');
  });

  it('stops retrying the sent mark once it succeeds, without logging an error', async () => {
    const { conversations, deps } = dependencies();
    const log = { warn: vi.fn(), error: vi.fn() };
    conversations.markDelivery
      .mockResolvedValueOnce({ ok: false, error: { code: 'conversation.store_failed', message: 'down' } } as never)
      .mockResolvedValueOnce({ ok: true, data: {} } as never);

    await new ChatInboundRouter().dispatch(messageWithText('hello'), 'owner-1', { ...deps, log });

    expect(conversations.markDelivery).toHaveBeenCalledTimes(2);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('retries the sent mark when the store throws', async () => {
    const { conversations, deps } = dependencies();
    const log = { warn: vi.fn(), error: vi.fn() };
    conversations.markDelivery.mockRejectedValue(new Error('boom'));

    await new ChatInboundRouter().dispatch(messageWithText('hello'), 'owner-1', { ...deps, log });

    expect(conversations.markDelivery).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'Error' }), expect.any(String));
  });
});

describe('ChatInboundRouter redelivery', () => {
  const runningAgent = { agentId: 'agent-1', agentName: 'Ada', status: 'running' };

  function messageWithId(text: string, providerMessageId: number) {
    const parsed = adapter.parse({ headers, body: { message: { message_id: providerMessageId, chat: { id: 123 }, text } } });
    if (!parsed.ok) throw new Error('Unexpected parse failure');
    return parsed.data[0]!;
  }

  function setup(existing?: { created: false; deliveryStatus: string }, agents = [runningAgent]) {
    const redis = new RedisClient({ lazyConnect: true });
    const xadd = vi.spyOn(redis, 'xadd').mockResolvedValue('1-1');
    const sendText = vi.fn().mockResolvedValue(undefined);
    const recordUserMessage = vi.fn(async (input: { id?: string }) => ({
      ok: true,
      data: { message: { id: input.id ?? 'random', deliveryStatus: existing?.deliveryStatus ?? 'queued' }, created: existing ? false : true },
    }));
    const conversations = { recordUserMessage, markDelivery: vi.fn(async () => ({ ok: true, data: {} })) };
    const log = { warn: vi.fn(), error: vi.fn() };
    const deps = { redis, conversations: conversations as never, log, resolveReply: vi.fn(async () => null), listAgents: vi.fn(async () => agents), sendText };
    return { xadd, sendText, recordUserMessage, conversations, log, deps };
  }

  const recordedIds = (recordUserMessage: ReturnType<typeof setup>['recordUserMessage']) =>
    recordUserMessage.mock.calls.map(([input]) => input.id);

  it('derives the same row id for a redelivered provider message and a different one per agent, chat and message', async () => {
    const first = setup();
    await new ChatInboundRouter().dispatch(messageWithId('hello', 7), 'owner-1', first.deps);
    await new ChatInboundRouter().dispatch(messageWithId('hello', 7), 'owner-1', first.deps);
    await new ChatInboundRouter().dispatch(messageWithId('hello', 8), 'owner-1', first.deps);
    const [a, b, c] = recordedIds(first.recordUserMessage);
    expect(a).toMatch(/^chat-inbound-[0-9a-f]{40}$/);
    expect(b).toBe(a);
    expect(c).not.toBe(a);

    const other = setup(undefined, [{ ...runningAgent, agentId: 'agent-2', agentName: 'Bea' }]);
    await new ChatInboundRouter().dispatch(messageWithId('hello', 7), 'owner-1', other.deps);
    expect(recordedIds(other.recordUserMessage)[0]).not.toBe(a);
  });

  it('gives each targeted agent its own row id for one provider message', async () => {
    const { recordUserMessage, deps } = setup(undefined, [runningAgent, { agentId: 'agent-2', agentName: 'Bea', status: 'running' }]);
    await new ChatInboundRouter().dispatch(messageWithId('/to all hello', 7), 'owner-1', deps);
    const ids = recordedIds(recordUserMessage);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('does not publish again for a replay whose row is already sent, and still confirms', async () => {
    const { xadd, sendText, conversations, deps } = setup({ created: false, deliveryStatus: 'sent' });
    await new ChatInboundRouter().dispatch(messageWithId('hello', 7), 'owner-1', deps);
    expect(xadd).not.toHaveBeenCalled();
    expect(conversations.markDelivery).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith({ provider: 'telegram', address: '123' }, 'Delivered to Ada.');
  });

  it('publishes a replay whose row is still queued, under the same row id', async () => {
    const { xadd, recordUserMessage, conversations, deps } = setup({ created: false, deliveryStatus: 'queued' });
    await new ChatInboundRouter().dispatch(messageWithId('hello', 7), 'owner-1', deps);
    const [id] = recordedIds(recordUserMessage);
    expect(xadd).toHaveBeenCalledWith('agent:outbound:agent-1', 'MAXLEN', '~', expect.any(Number), '*', 'envelope', expect.stringContaining(`"messageId":"${id}"`));
    expect(conversations.markDelivery).toHaveBeenCalledWith({ messageId: id, status: 'sent' });
  });

  it('does not retry a replay whose row already ended as failed, and tells the user', async () => {
    const { xadd, sendText, deps } = setup({ created: false, deliveryStatus: 'failed' });
    await new ChatInboundRouter().dispatch(messageWithId('hello', 7), 'owner-1', deps);
    expect(xadd).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith({ provider: 'telegram', address: '123' }, 'Could not deliver your message to Ada. Please try again.');
  });

  it('omits the row id when the provider gave no message id', async () => {
    const { recordUserMessage, deps } = setup();
    const parsed = adapter.parse({ headers, body: { message: { chat: { id: 123 }, text: 'hello' } } });
    if (!parsed.ok) throw new Error('Unexpected parse failure');
    await new ChatInboundRouter().dispatch(parsed.data[0]!, 'owner-1', deps);
    expect(recordUserMessage.mock.calls[0]?.[0]).not.toHaveProperty('id');
  });
});
