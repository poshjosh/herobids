import { z } from 'zod';
import { err, ok, type ChatInboundAdapter, type ChatWebhookRequest, type InboundChatMessage } from '@herobids/domain';

const TelegramWebhookUpdateSchema = z.object({
  message: z.object({
    chat: z.object({ id: z.union([z.string(), z.number().int()]).transform(String) }),
    message_id: z.number().int().optional(),
    text: z.string().optional(),
    caption: z.string().optional(),
    document: z.object({
      file_id: z.string(),
      file_name: z.string().optional(),
      mime_type: z.string().optional(),
      file_size: z.number().int().optional(),
    }).optional(),
    reply_to_message: z.object({ message_id: z.number().int() }).optional(),
  }).optional(),
});

export class TelegramInboundChannel implements ChatInboundAdapter {
  readonly provider = 'telegram' as const;

  constructor(private readonly webhookSecret: string) {}

  verify(request: ChatWebhookRequest) {
    const token = request.headers['x-telegram-bot-api-secret-token'];
    return token && token === this.webhookSecret
      ? ok(undefined)
      : err({ code: 'chat.unauthorized', message: 'Invalid Telegram webhook token' });
  }

  parse(request: ChatWebhookRequest) {
    const parsed = TelegramWebhookUpdateSchema.safeParse(request.body);
    if (!parsed.success) return ok([]);
    const message = parsed.data.message;
    if (!message) return ok([]);

    const inbound: InboundChatMessage = {
      provider: 'telegram',
      from: { provider: 'telegram', address: message.chat.id as InboundChatMessage['from']['address'] },
      ...(message.text !== undefined ? { text: message.text } : {}),
      ...(message.caption !== undefined ? { caption: message.caption } : {}),
      ...(message.message_id !== undefined ? { providerMessageId: String(message.message_id) } : {}),
      ...(message.reply_to_message ? { inReplyToProviderMessageId: String(message.reply_to_message.message_id) } : {}),
      ...(message.document ? { document: {
        id: message.document.file_id,
        filename: message.document.file_name,
        mimeType: message.document.mime_type,
        size: message.document.file_size,
      } } : {}),
      receivedAt: new Date(),
    };
    return ok([inbound]);
  }
}