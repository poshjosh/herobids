import { describe, expect, it, vi } from 'vitest';
import { announceSessionStarted, sessionStartedText, type SessionStartedMessageDeps } from './session-started-message.js';

const logWarn = vi.hoisted(() => vi.fn());
vi.mock('./logger.js', () => ({ createLogger: () => ({ error: vi.fn(), warn: logWarn, info: vi.fn(), debug: vi.fn() }) }));

const agent = { id: 'agent-1', name: 'nimble-falcon', userId: 'user-1' };

function deps(sendResult: unknown, overrides: Partial<{ agent: unknown; recordResult: unknown }> = {}) {
  const agents = { getAgent: vi.fn().mockResolvedValue('agent' in overrides ? overrides.agent : agent) };
  const conversations = {
    recordPlatformMessage: vi.fn().mockResolvedValue(overrides.recordResult ?? { ok: true, data: { message: { id: 'msg-1' } } }),
    markDelivery: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  };
  const chatDelivery = { send: vi.fn().mockResolvedValue(sendResult) };
  return { agents, conversations, chatDelivery, all: { agents, conversations, chatDelivery } as unknown as SessionStartedMessageDeps };
}

const noAddress = { ok: false, error: { code: 'chat.no_address', message: 'no_chat_address' } };

describe('announceSessionStarted', () => {
  it('records the ready message in the web thread when the owner has no Telegram chat linked', async () => {
    logWarn.mockClear();
    const d = deps(noAddress);
    await announceSessionStarted(d.all, 'agent-1');

    expect(d.conversations.recordPlatformMessage).toHaveBeenCalledWith({
      ownerUserId: 'user-1',
      agentId: 'agent-1',
      channel: 'web',
      subject: 'Session started',
      body: sessionStartedText('nimble-falcon'),
      messageClass: 'reminder',
    });
    expect(d.conversations.markDelivery).toHaveBeenCalledWith({ messageId: 'msg-1', status: 'not_applicable', detail: 'no_chat_address' });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('records the ready message in the web thread when the Telegram bot is not configured', async () => {
    const d = deps({ ok: false, error: { code: 'chat.not_configured', message: 'telegram_not_configured' } });
    await announceSessionStarted(d.all, 'agent-1');

    expect(d.conversations.recordPlatformMessage).toHaveBeenCalledTimes(1);
    expect(d.conversations.markDelivery).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'msg-1', status: 'not_applicable' }));
  });

  it('also sends to Telegram as a reply anchor and marks the row sent when a chat is linked', async () => {
    const d = deps({ ok: true, data: { providerMessageId: 'tg-9', address: { provider: 'telegram', address: '123' } } });
    await announceSessionStarted(d.all, 'agent-1');

    expect(d.chatDelivery.send).toHaveBeenCalledWith('agent-1', { body: sessionStartedText('nimble-falcon'), replyRequested: true });
    expect(d.conversations.markDelivery).toHaveBeenCalledWith({ messageId: 'msg-1', status: 'sent', providerMessageId: 'tg-9', channel: 'telegram' });
  });

  it('marks the row failed and warns when the Telegram send itself fails', async () => {
    logWarn.mockClear();
    const d = deps({ ok: false, error: { code: 'telegram.http_error', message: 'boom' } });
    await announceSessionStarted(d.all, 'agent-1');

    expect(d.conversations.markDelivery).toHaveBeenCalledWith({ messageId: 'msg-1', status: 'failed', detail: 'boom' });
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it('does not send to Telegram when the thread record fails', async () => {
    const d = deps(noAddress, { recordResult: { ok: false, error: { code: 'conversation.store_failed', message: 'down' } } });
    await announceSessionStarted(d.all, 'agent-1');

    expect(d.chatDelivery.send).not.toHaveBeenCalled();
  });

  it('sends nothing when the agent no longer exists', async () => {
    const d = deps(noAddress, { agent: null });
    await announceSessionStarted(d.all, 'agent-1');

    expect(d.conversations.recordPlatformMessage).not.toHaveBeenCalled();
    expect(d.chatDelivery.send).not.toHaveBeenCalled();
  });
});
