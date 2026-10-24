import { err, type ChatChannelRegistry, type ChatOutboundBody, type ChatSendResult, type Result, type DomainError, type ChatAddress } from '@herobids/domain';
import type { AgentRepository } from '@herobids/db';

export interface ChatDeliveryResult extends ChatSendResult {
  address: ChatAddress;
}

function lookupFailed(error: unknown): Result<never, DomainError> {
  return err({ code: 'chat.address_lookup_failed', message: error instanceof Error ? error.message : String(error) });
}

export class ChatDelivery {
  constructor(
    private readonly agentRepo: Pick<AgentRepository, 'getEffectiveChatAddress' | 'isChatAddressSuppressed'>,
    private readonly channels: ChatChannelRegistry,
  ) {}

  async send(agentId: string, body: ChatOutboundBody): Promise<Result<ChatDeliveryResult, DomainError>> {
    let address: ChatAddress | null;
    try {
      address = await this.agentRepo.getEffectiveChatAddress(agentId, 'telegram');
    } catch (error) {
      return lookupFailed(error);
    }
    if (!address) return err({ code: 'chat.no_address', message: 'no_telegram_chat_id' });
    const channel = this.channels.get('telegram');
    if (!channel) return err({ code: 'chat.not_configured', message: 'telegram_not_configured' });

    let suppressed: boolean;
    try {
      suppressed = await this.agentRepo.isChatAddressSuppressed(address.provider, address.address);
    } catch (error) {
      return lookupFailed(error);
    }
    if (suppressed) return err({ code: 'chat.address_suppressed', message: 'address_suppressed' });

    const result = await channel.sendText(address, body);
    if (!result.ok) return result;
    return { ok: true, data: { ...result.data, address } };
  }
}
