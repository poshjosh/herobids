import type { ChatAddress, ChatChannel, ChatOutboundBody } from '@herobids/domain';
import { forceReply, type TelegramClient } from './telegram-client.js';

export class TelegramChannel implements ChatChannel {
  readonly provider = 'telegram' as const;
  readonly capabilities = { richText: true, maxBodyChars: 3800, nativeReplyThreading: true };

  constructor(private readonly client: TelegramClient) {}

  async sendText(to: ChatAddress, body: ChatOutboundBody) {
    const text = body.agentName
      ? `💬 <b>[${escapeHtml(body.agentName)}]</b>\n${body.subject ? `<b>${escapeHtml(body.subject)}</b>\n` : ''}${escapeHtml(body.body)}`
      : body.body;
    const result = await this.client.sendText(to.address, text, body.replyRequested ? forceReply() : undefined);
    if (!result.ok) return result;
    return { ok: true as const, data: { providerMessageId: String(result.data.messageId) } };
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}