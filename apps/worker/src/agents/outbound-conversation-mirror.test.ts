import { beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '@herobids/domain';
import { OutboundConversationMirror, isUndeliverableChatError } from './outbound-conversation-mirror.js';

const { loggerError, loggerWarn } = vi.hoisted(() => ({ loggerError: vi.fn(), loggerWarn: vi.fn() }));
vi.mock('../logger.js', () => ({ createLogger: () => ({ error: loggerError, warn: loggerWarn, info: vi.fn(), debug: vi.fn() }) }));

beforeEach(() => {
  loggerError.mockClear();
  loggerWarn.mockClear();
});

function outboundRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'out-1',
    agentId: 'agent-1',
    authoredBy: 'agent',
    subject: 'Heads up',
    body: 'Watching ETH.',
    messageClass: 'routine',
    deliveryStatus: 'sent',
    deliveryProvider: 'telegram',
    providerMessageId: 'tg-9',
    deliveryError: null,
    ...overrides,
  };
}

function setup(row: Record<string, unknown> | null = outboundRow()) {
  const agentRepo = {
    getOutboundMessage: vi.fn(async () => row),
    getAgent: vi.fn(async () => ({ id: 'agent-1', userId: 'user-1' })),
  };
  const conversations = {
    recordAgentMessage: vi.fn(async () => ok({ message: {}, created: true })),
    recordPlatformMessage: vi.fn(async () => ok({ message: {}, created: true })),
  };
  const mirror = new OutboundConversationMirror(agentRepo as never, conversations as never);
  return { mirror, agentRepo, conversations };
}

describe('OutboundConversationMirror', () => {
  it('records a sent agent message under the same id, already sent, with the provider id, in one insert', async () => {
    const { mirror, conversations } = setup();

    await mirror.mirror('out-1');

    expect(conversations.recordAgentMessage).toHaveBeenCalledWith({
      id: 'out-1',
      ownerUserId: 'user-1',
      agentId: 'agent-1',
      channel: 'telegram',
      subject: 'Heads up',
      body: 'Watching ETH.',
      messageClass: 'routine',
      deliveryStatus: 'sent',
      providerMessageId: 'tg-9',
    });
    expect(conversations.recordPlatformMessage).not.toHaveBeenCalled();
  });

  it('records a platform message through the platform path', async () => {
    const { mirror, conversations } = setup(outboundRow({ authoredBy: 'platform', messageClass: 'alert' }));

    await mirror.mirror('out-1');

    expect(conversations.recordPlatformMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'out-1', messageClass: 'alert' }));
    expect(conversations.recordAgentMessage).not.toHaveBeenCalled();
  });

  it('records a failed delivery as failed with its error text', async () => {
    const { mirror, conversations } = setup(outboundRow({ deliveryStatus: 'failed', deliveryProvider: 'telegram', providerMessageId: null, deliveryError: 'telegram_send_failed' }));

    await mirror.mirror('out-1');

    expect(conversations.recordAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'telegram', deliveryStatus: 'failed', deliveryDetail: 'telegram_send_failed',
    }));
    expect(conversations.recordAgentMessage).toHaveBeenCalledWith(expect.not.objectContaining({ providerMessageId: expect.anything() }));
  });

  it.each([['chat.no_address'], ['chat.not_configured']])('records the %s outcome as not applicable even though the old row says failed', async (code) => {
    expect(isUndeliverableChatError(code)).toBe(true);
    const { mirror, conversations } = setup(outboundRow({ deliveryStatus: 'failed', deliveryProvider: null, providerMessageId: null, deliveryError: 'no_chat_address' }));

    await mirror.mirror('out-1', 'not_applicable');

    const recorded = conversations.recordAgentMessage.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(recorded).toMatchObject({ channel: 'web', deliveryStatus: 'not_applicable' });
    expect(recorded).not.toHaveProperty('deliveryDetail');
  });

  it('treats other chat errors as failed deliveries', () => {
    expect(isUndeliverableChatError('chat.send_failed')).toBe(false);
    expect(isUndeliverableChatError('chat.address_lookup_failed')).toBe(false);
  });

  it('records a message with no delivery attempt as not applicable', async () => {
    const { mirror, conversations } = setup(outboundRow({ deliveryStatus: 'pending', deliveryProvider: null, providerMessageId: null }));

    await mirror.mirror('out-1');

    expect(conversations.recordAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'web', deliveryStatus: 'not_applicable' }));
  });

  it('does not log an error when the message was already mirrored', async () => {
    const { mirror, conversations } = setup();
    conversations.recordAgentMessage.mockResolvedValueOnce(ok({ message: {}, created: false }));

    await mirror.mirror('out-1');

    expect(loggerError).not.toHaveBeenCalled();
  });

  it('ignores user-authored and creator-authored rows, which the web route stores itself', async () => {
    for (const authoredBy of ['user', 'agent:creator-1']) {
      const { mirror, conversations } = setup(outboundRow({ authoredBy }));

      await mirror.mirror('out-1');

      expect(conversations.recordAgentMessage).not.toHaveBeenCalled();
      expect(conversations.recordPlatformMessage).not.toHaveBeenCalled();
    }
  });

  it('does nothing when the row or the agent is gone', async () => {
    const missingRow = setup(null);
    await missingRow.mirror.mirror('out-1');
    const missingAgent = setup();
    missingAgent.agentRepo.getAgent.mockResolvedValueOnce(null as never);
    await missingAgent.mirror.mirror('out-1');

    expect(missingRow.conversations.recordAgentMessage).not.toHaveBeenCalled();
    expect(missingAgent.conversations.recordAgentMessage).not.toHaveBeenCalled();
  });

  it('never throws: a store refusal or a thrown error is swallowed and logged at error level', async () => {
    const refused = setup();
    refused.conversations.recordAgentMessage.mockResolvedValueOnce(err({ code: 'conversation.store_failed', message: 'x' }) as never);
    const thrown = setup();
    thrown.agentRepo.getOutboundMessage.mockRejectedValueOnce(new Error('db down'));

    await expect(refused.mirror.mirror('out-1')).resolves.toBeUndefined();
    await expect(thrown.mirror.mirror('out-1')).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledTimes(2);
    expect(loggerWarn).not.toHaveBeenCalled();
  });
});
