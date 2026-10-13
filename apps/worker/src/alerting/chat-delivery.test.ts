import { describe, expect, it, vi } from 'vitest';
import type { AgentRepository } from '@herobids/db';
import { ChatDelivery } from './chat-delivery.js';
import { TelegramChannel } from './telegram-channel.js';
import type { TelegramClient } from './telegram-client.js';

describe('chat delivery', () => {
  it('uses the effective legacy address and retains Telegram reply markup and message ID', async () => {
    const agentRepo = { getEffectiveTelegramChatId: vi.fn().mockResolvedValue('123') } as unknown as AgentRepository;
    const sendText = vi.fn().mockResolvedValue({ ok: true, data: { messageId: 42 } });
    const client = { sendText } as unknown as TelegramClient;
    const delivery = new ChatDelivery(agentRepo, { get: () => new TelegramChannel(client) });

    const result = await delivery.send('agent-1', { body: '<b>Hello</b>', replyRequested: true });
    expect(result).toEqual({ ok: true, data: { providerMessageId: '42', address: { provider: 'telegram', address: '123' } } });
    expect(sendText).toHaveBeenCalledWith('123', '<b>Hello</b>', { force_reply: true, selective: true });
  });

  it('renders agent messages as escaped Telegram HTML inside the channel', async () => {
    const agentRepo = { getEffectiveTelegramChatId: vi.fn().mockResolvedValue('123') } as unknown as AgentRepository;
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
    const agentRepo = { getEffectiveTelegramChatId: vi.fn().mockResolvedValue(null) } as unknown as AgentRepository;
    const delivery = new ChatDelivery(agentRepo, { get: () => undefined });
    expect(await delivery.send('agent-1', { body: 'Hello' })).toMatchObject({ ok: false, error: { code: 'chat.no_address' } });
    vi.mocked(agentRepo.getEffectiveTelegramChatId).mockResolvedValue('123');
    expect(await delivery.send('agent-1', { body: 'Hello' })).toMatchObject({ ok: false, error: { code: 'chat.not_configured' } });
  });
});