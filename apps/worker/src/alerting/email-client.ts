import type { Result } from '@herobids/domain';

export interface EmailSendResult {
  messageId: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Provider-neutral email delivery interface.
 * Symmetric with TelegramClient.sendText() in shape and error model.
 */
export interface EmailClient {
  send(message: EmailMessage): Promise<Result<EmailSendResult, { code: string; message: string }>>;
}
