import { describe, expect, it, vi } from 'vitest';
import { ChatDelivery } from './chat-delivery.js';
import { TelegramChannel } from './telegram-channel.js';
import type { TelegramClient } from './telegram-client.js';

const ACTIVE_ADDRESS = { provider: 'telegram', address: '123' } as const;

describe('chat delivery', () => {
  it('uses the effective legacy address and retains Telegram reply markup and message ID', async () => {
    const agentRepo = { getEffectiveChatAddress: vi.fn().mockResolvedValue(ACTIVE_ADDRESS), isChatAddressSuppressed: vi.fn().mockResolvedValue(false) };
    const sendText = vi.fn().mockResolvedValue({ ok: true, data: { messageId: 42 } });
    const client = { sendText } as unknown as TelegramClient;
    const delivery = new ChatDelivery(agentRepo, { get: () => new TelegramChannel(client) });

    const result = await delivery.send('agent-1', { body: '<b>Hello</b>', replyRequested: true });
    expect(result).toEqual({ ok: true, data: { providerMessageId: '42', address: { provider: 'telegram', address: '123' } } });
    expect(sendText).toHaveBeenCalledWith('123', '<b>Hello</b>', { force_reply: true, selective: true });
  });

  it('renders agent messages as escaped Telegram HTML inside the channel', async () => {
    const agentRepo = { getEffectiveChatAddress: vi.fn().mockResolvedValue(ACTIVE_ADDRESS), isChatAddressSuppressed: vi.fn().mockResolvedValue(false) };
    const sendText = vi.fn().mockResolvedValue({ ok: true, data: { messageId: 42 } });
    const client = { sendText } as unknown as TelegramClient;
    const delivery = new ChatDelivery(agentRepo, { get: () => new TelegramChannel(client) });

    await delivery.send('agent-1', { agentName: 'A&B', subject: '<Subject>', body: 'hello <user>', replyRequested: true });
    expect(sendText).toHaveBeenCalledWith(
      '123', '💬 <b>[A&amp;B]</b>\n<b>&lt;Subject&gt;</b>\nhello &lt;user&gt;',
      { force_reply: true, selective: true },
    );
  });

  it('distinguishes an unbound address from an unconfigured channel', async () => {
    const agentRepo = { getEffectiveChatAddress: vi.fn().mockResolvedValue(null), isChatAddressSuppressed: vi.fn().mockResolvedValue(false) };
    const delivery = new ChatDelivery(agentRepo, { get: () => undefined });
    expect(await delivery.send('agent-1', { body: 'Hello' })).toMatchObject({ ok: false, error: { code: 'chat.no_address' } });
    vi.mocked(agentRepo.getEffectiveChatAddress).mockResolvedValue(ACTIVE_ADDRESS);
    expect(await delivery.send('agent-1', { body: 'Hello' })).toMatchObject({ ok: false, error: { code: 'chat.not_configured' } });
  });

  it('sends to an active neutral address without consulting legacy data', async () => {
    const agentRepo = { getEffectiveChatAddress: vi.fn().mockResolvedValue(ACTIVE_ADDRESS), isChatAddressSuppressed: vi.fn().mockResolvedValue(false) };
    const sendText = vi.fn().mockResolvedValue({ ok: true, data: { messageId: 7 } });
    const delivery = new ChatDelivery(agentRepo, { get: () => new TelegramChannel({ sendText } as unknown as TelegramClient) });

    expect(await delivery.send('agent-1', { body: 'Hello' })).toEqual({
      ok: true, data: { providerMessageId: '7', address: ACTIVE_ADDRESS },
    });
    expect(agentRepo.getEffectiveChatAddress).toHaveBeenCalledWith('agent-1', 'telegram');
    expect(agentRepo.isChatAddressSuppressed).toHaveBeenCalledWith('telegram', '123');
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('does not send and reports suppression when another user revoked the same address', async () => {
    const agentRepo = { getEffectiveChatAddress: vi.fn().mockResolvedValue(ACTIVE_ADDRESS), isChatAddressSuppressed: vi.fn().mockResolvedValue(true) };
    const sendText = vi.fn();
    const delivery = new ChatDelivery(agentRepo, { get: () => new TelegramChannel({ sendText } as unknown as TelegramClient) });

    expect(await delivery.send('agent-1', { body: 'Hello' })).toEqual({
      ok: false, error: { code: 'chat.address_suppressed', message: 'address_suppressed' },
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it('does not send when the owner own row is pending_optin', async () => {
    const agentRepo = { getEffectiveChatAddress: vi.fn().mockResolvedValue(null), isChatAddressSuppressed: vi.fn().mockResolvedValue(true) };
    const sendText = vi.fn();
    const delivery = new ChatDelivery(agentRepo, { get: () => new TelegramChannel({ sendText } as unknown as TelegramClient) });

    expect(await delivery.send('agent-1', { body: 'Hello' })).toMatchObject({ ok: false, error: { code: 'chat.no_address' } });
    expect(agentRepo.isChatAddressSuppressed).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('still sends with legacy-only data when no suppression applies to the address', async () => {
    const agentRepo = { getEffectiveChatAddress: vi.fn().mockResolvedValue(ACTIVE_ADDRESS), isChatAddressSuppressed: vi.fn().mockResolvedValue(false) };
    const sendText = vi.fn().mockResolvedValue({ ok: true, data: { messageId: 9 } });
    const delivery = new ChatDelivery(agentRepo, { get: () => new TelegramChannel({ sendText } as unknown as TelegramClient) });

    expect(await delivery.send('agent-1', { body: 'Hello' })).toMatchObject({ ok: true, data: { address: ACTIVE_ADDRESS } });
    expect(sendText).toHaveBeenCalledWith('123', 'Hello', undefined);
  });

  it('reports a lookup failure when the suppression check throws and does not send', async () => {
    const agentRepo = {
      getEffectiveChatAddress: vi.fn().mockResolvedValue(ACTIVE_ADDRESS),
      isChatAddressSuppressed: vi.fn().mockRejectedValue(new Error('db down')),
    };
    const sendText = vi.fn();
    const delivery = new ChatDelivery(agentRepo, { get: () => new TelegramChannel({ sendText } as unknown as TelegramClient) });

    expect(await delivery.send('agent-1', { body: 'Hello' })).toEqual({
      ok: false, error: { code: 'chat.address_lookup_failed', message: 'db down' },
    });
    expect(sendText).not.toHaveBeenCalled();
  });
});
