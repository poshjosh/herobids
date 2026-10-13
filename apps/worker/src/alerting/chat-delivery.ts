import { err, type ChatChannelRegistry, type ChatOutboundBody, type ChatSendResult, type Result, type DomainError, type ChatAddress } from '@herobids/domain';
import type { AgentRepository } from '@herobids/db';

export interface ChatDeliveryResult extends ChatSendResult {
  address: ChatAddress;
}

export class ChatDelivery {
  constructor(
    private readonly agentRepo: AgentRepository,
    private readonly channels: ChatChannelRegistry,
  ) {}

  async send(agentId: string, body: ChatOutboundBody): Promise<Result<ChatDeliveryResult, DomainError>> {
    let chatId: string | null;
    try {
      chatId = await this.agentRepo.getEffectiveTelegramChatId(agentId);
    } catch (error) {
      return err({ code: 'chat.address_lookup_failed', message: error instanceof Error ? error.message : String(error) });
    }
    if (!chatId) return err({ code: 'chat.no_address', message: 'no_telegram_chat_id' });
    const channel = this.channels.get('telegram');
    if (!channel) return err({ code: 'chat.not_configured', message: 'telegram_not_configured' });

    const address: ChatAddress = { provider: 'telegram', address: chatId as ChatAddress['address'] };
    const result = await channel.sendText(address, body);
    if (!result.ok) return result;
    return { ok: true, data: { ...result.data, address } };
  }
}