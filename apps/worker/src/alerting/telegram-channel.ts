import type { ChatAddress, ChatChannel, ChatOutboundBody, ChatOutboundDocument } from '@herobids/domain';
import { err } from '@herobids/domain';
import { forceReply, TELEGRAM_CAPTION_MAX_CHARS, type TelegramClient } from './telegram-client.js';

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

  async sendDocument(to: ChatAddress, document: ChatOutboundDocument) {
    const caption = document.caption ? plainCaption(document.caption) : undefined;
    if (caption !== undefined && escapeHtml(caption).length > TELEGRAM_CAPTION_MAX_CHARS) {
      return err({ code: 'chat.caption_too_long', message: 'caption_too_long' });
    }
    const result = await this.client.sendDocument({
      chatId: to.address,
      filename: document.filename,
      mimeType: document.mimeType,
      body: document.body,
      caption,
      replyMarkup: document.caption?.replyRequested ? forceReply() : undefined,
    });
    if (!result.ok) return result;
    return { ok: true as const, data: { providerMessageId: String(result.data.messageId) } };
  }
}

function plainCaption(body: ChatOutboundBody): string {
  if (!body.agentName) return body.body;
  return `💬 [${body.agentName}]\n${body.subject ? `${body.subject}\n` : ''}${body.body}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}