import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '../result.js';
import type { ConversationStore, RecordUserAgentMessageInput } from '../ports/conversation-store.js';
import { CONVERSATION_ERROR_CODES, userAgentConversationId, type ConversationMessage } from './conversation.js';
import { ConversationService } from './conversation-service.js';

const NOW = new Date('2026-10-25T10:00:00.000Z');
const LIMITS = { userMessageMaxChars: 10, threadDefaultPageSize: 5, threadMaxPageSize: 8 };

function storedMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'm1',
    conversationId: 'user_agent:a1',
    senderType: 'user',
    senderId: 'u1',
    channel: 'web',
    subject: null,
    body: 'hi',
    messageClass: null,
    deliveryStatus: 'queued',
    deliveryDetail: null,
    providerMessageId: null,
    createdAt: NOW,
    ...overrides,
  };
}

function setup() {
  const store = {
    recordUserAgentMessage: vi.fn(async (input: RecordUserAgentMessageInput) =>
      ok({ message: storedMessage({ ...input.message, conversationId: input.conversationId, deliveryDetail: null, providerMessageId: null }), created: true })),
    markDelivery: vi.fn(async () => ok(storedMessage({ deliveryStatus: 'sent' }))),
    listUserAgentThread: vi.fn(async () => ok([storedMessage()])),
  } satisfies ConversationStore;
  let counter = 0;
  const service = new ConversationService({
    store,
    limits: LIMITS,
    newId: () => `generated-${++counter}`,
    now: () => NOW,
  });
  return { store, service };
}

describe('ConversationService.recordUserMessage', () => {
  it('stores a queued user message in the agent conversation, owned by the sender', async () => {
    const { store, service } = setup();

    const result = await service.recordUserMessage({ ownerUserId: 'u1', agentId: 'a1', channel: 'web', body: 'hello' });

    expect(result.ok).toBe(true);
    expect(store.recordUserAgentMessage).toHaveBeenCalledWith({
      conversationId: userAgentConversationId('a1'),
      ownerUserId: 'u1',
      agentId: 'a1',
      message: {
        id: 'generated-1',
        senderType: 'user',
        senderId: 'u1',
        channel: 'web',
        subject: null,
        body: 'hello',
        messageClass: null,
        deliveryStatus: 'queued',
        createdAt: NOW,
      },
    });
  });

  it('uses the client message id as the row id', async () => {
    const { store, service } = setup();

    await service.recordUserMessage({ id: 'client-1', ownerUserId: 'u1', agentId: 'a1', channel: 'telegram', body: 'hello' });

    expect(store.recordUserAgentMessage.mock.calls[0]?.[0].message.id).toBe('client-1');
    expect(store.recordUserAgentMessage.mock.calls[0]?.[0].message.channel).toBe('telegram');
  });

  it('refuses a blank body without calling the store', async () => {
    const { store, service } = setup();

    const result = await service.recordUserMessage({ ownerUserId: 'u1', agentId: 'a1', channel: 'web', body: '   ' });

    expect(result).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.invalidMessage } });
    expect(store.recordUserAgentMessage).not.toHaveBeenCalled();
  });

  it('accepts a body at the configured limit and refuses one character more', async () => {
    const { store, service } = setup();

    const atLimit = await service.recordUserMessage({ ownerUserId: 'u1', agentId: 'a1', channel: 'web', body: 'x'.repeat(10) });
    const overLimit = await service.recordUserMessage({ ownerUserId: 'u1', agentId: 'a1', channel: 'web', body: 'x'.repeat(11) });

    expect(atLimit.ok).toBe(true);
    expect(overLimit).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.bodyTooLong, context: { maxChars: 10 } } });
    expect(store.recordUserAgentMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['blank owner', { ownerUserId: ' ' }],
    ['blank agent', { agentId: '' }],
    ['blank client id', { id: ' ' }],
  ])('refuses %s', async (_name, override) => {
    const { store, service } = setup();
    const result = await service.recordUserMessage({ ownerUserId: 'u1', agentId: 'a1', channel: 'web', body: 'hello', ...override });

    expect(result).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.invalidMessage } });
    expect(store.recordUserAgentMessage).not.toHaveBeenCalled();
  });

  it('passes a store refusal through unchanged', async () => {
    const { store, service } = setup();
    store.recordUserAgentMessage.mockResolvedValueOnce(err({ code: CONVERSATION_ERROR_CODES.ownerMismatch, message: 'owner_mismatch' }));

    const result = await service.recordUserMessage({ ownerUserId: 'u1', agentId: 'a1', channel: 'web', body: 'hello' });

    expect(result).toEqual({ ok: false, error: { code: CONVERSATION_ERROR_CODES.ownerMismatch, message: 'owner_mismatch' } });
  });

  it('does not cap agent or platform bodies by the user limit', async () => {
    const { service } = setup();
    const body = 'x'.repeat(500);

    const agent = await service.recordAgentMessage({ ownerUserId: 'u1', agentId: 'a1', channel: 'web', body });
    const platform = await service.recordPlatformMessage({ ownerUserId: 'u1', agentId: 'a1', channel: 'web', body });

    expect(agent.ok).toBe(true);
    expect(platform.ok).toBe(true);
  });
});

describe('ConversationService.recordAgentMessage', () => {
  it('authors the message as the agent and keeps subject, class and delivery status', async () => {
    const { store, service } = setup();

    await service.recordAgentMessage({
      ownerUserId: 'u1',
      agentId: 'a1',
      channel: 'telegram',
      subject: 'Update',
      body: 'done',
      messageClass: 'alert',
      deliveryStatus: 'not_applicable',
    });

    expect(store.recordUserAgentMessage.mock.calls[0]?.[0].message).toMatchObject({
      senderType: 'agent',
      senderId: 'a1',
      channel: 'telegram',
      subject: 'Update',
      messageClass: 'alert',
      deliveryStatus: 'not_applicable',
    });
  });

  it('authors a creator agent message under the creator, in the child conversation', async () => {
    const { store, service } = setup();

    await service.recordAgentMessage({ ownerUserId: 'u1', agentId: 'child', senderAgentId: 'creator', channel: 'web', body: 'start' });

    const call = store.recordUserAgentMessage.mock.calls[0]?.[0];
    expect(call?.conversationId).toBe(userAgentConversationId('child'));
    expect(call?.message.senderId).toBe('creator');
  });

  it('refuses a blank id', async () => {
    const { store, service } = setup();

    const blank = await service.markDelivery({ messageId: ' ', status: 'sent' });

    expect(blank.ok).toBe(false);
    expect(store.markDelivery).not.toHaveBeenCalled();
  });

  it.each(['sent', 'failed', 'refused'] as const)('passes a %s mark to the store with omitted fields as null', async (status) => {
    const { store, service } = setup();

    await service.markDelivery({ messageId: 'm1', status });

    expect(store.markDelivery).toHaveBeenCalledWith({ messageId: 'm1', status, detail: null, providerMessageId: null });
  });

  it.each(['queued', 'not_applicable'] as const)('refuses a mark to %s as an invalid transition', async (status) => {
    const { store, service } = setup();

    const result = await service.markDelivery({ messageId: 'm1', status });

    expect(result).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.invalidDeliveryTransition } });
    expect(store.markDelivery).not.toHaveBeenCalled();
  });

  it('refuses an unknown delivery status', async () => {
    const { store, service } = setup();

    const result = await service.markDelivery({ messageId: 'm1', status: 'delivered' as never });

    expect(result).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.invalidMessage, message: 'invalid_delivery_status' } });
    expect(store.markDelivery).not.toHaveBeenCalled();
  });
});

describe('ConversationService enum guards', () => {
  it.each(['internal', 'sms', ''])('refuses channel %j on every record method', async (channel) => {
    const { store, service } = setup();
    const base = { ownerUserId: 'u1', agentId: 'a1', body: 'hello', channel: channel as never };

    const results = [
      await service.recordUserMessage(base),
      await service.recordAgentMessage(base),
      await service.recordPlatformMessage(base),
    ];

    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.invalidMessage, message: 'invalid_channel' } });
    }
    expect(store.recordUserAgentMessage).not.toHaveBeenCalled();
  });

  it('refuses an unknown delivery status on agent and platform messages', async () => {
    const { store, service } = setup();
    const base = { ownerUserId: 'u1', agentId: 'a1', channel: 'web' as const, body: 'hello', deliveryStatus: 'delivered' as never };

    const agent = await service.recordAgentMessage(base);
    const platform = await service.recordPlatformMessage(base);

    expect(agent).toMatchObject({ ok: false, error: { message: 'invalid_delivery_status' } });
    expect(platform).toMatchObject({ ok: false, error: { message: 'invalid_delivery_status' } });
    expect(store.recordUserAgentMessage).not.toHaveBeenCalled();
  });
});

describe('ConversationService.listThread', () => {
  it('uses the default page size and the derived conversation id', async () => {
    const { store, service } = setup();

    await service.listThread({ ownerUserId: 'u1', agentId: 'a1' });

    expect(store.listUserAgentThread).toHaveBeenCalledWith({
      conversationId: userAgentConversationId('a1'),
      ownerUserId: 'u1',
      limit: 5,
      before: null,
      beforeId: null,
    });
  });

  it('clamps the limit to the configured maximum and passes the cursor', async () => {
    const { store, service } = setup();
    const before = new Date('2026-10-25T09:00:00.000Z');

    await service.listThread({ ownerUserId: 'u1', agentId: 'a1', limit: 500, before, beforeId: 'm9' });

    expect(store.listUserAgentThread).toHaveBeenCalledWith(expect.objectContaining({ limit: 8, before, beforeId: 'm9' }));
  });

  it.each([
    ['an invalid date', { before: new Date('nope'), beforeId: 'm9' }],
    ['a date without an id', { before: new Date('2026-10-25T09:00:00.000Z') }],
    ['an id without a date', { beforeId: 'm9' }],
    ['a blank id', { before: new Date('2026-10-25T09:00:00.000Z'), beforeId: ' ' }],
  ])('refuses %s as invalid_cursor', async (_label, cursor) => {
    const { store, service } = setup();

    const result = await service.listThread({ ownerUserId: 'u1', agentId: 'a1', ...cursor });

    expect(result).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.invalidCursor } });
    expect(store.listUserAgentThread).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5])('refuses limit %s', async (limit) => {
    const { store, service } = setup();

    const result = await service.listThread({ ownerUserId: 'u1', agentId: 'a1', limit });

    expect(result.ok).toBe(false);
    expect(store.listUserAgentThread).not.toHaveBeenCalled();
  });
});
