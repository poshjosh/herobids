import type { AppConfig } from './schema.js';

export interface ResolvedTelegramChatConfig {
  botToken: string;
  webhookSecret: string;
  webhookUrl: string | undefined;
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/** Telegram transport settings, read from messaging.chat.telegram.* only. */
export function resolveTelegramChatConfig(
  config: Pick<AppConfig, 'messaging'>,
): ResolvedTelegramChatConfig {
  const chat = config.messaging.chat.telegram;
  return {
    botToken: nonBlank(chat.botToken) ?? '',
    webhookSecret: nonBlank(chat.webhookSecret) ?? '',
    webhookUrl: nonBlank(chat.webhookUrl),
  };
}
