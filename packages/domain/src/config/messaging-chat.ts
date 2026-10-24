import type { AppConfig } from './schema.js';

export interface ResolvedTelegramChatConfig {
  botToken: string;
  webhookSecret: string;
  webhookUrl: string | undefined;
}

function firstNonBlank(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== '');
}

/**
 * messaging.chat.telegram.* wins when set; otherwise the legacy alerts.telegram.*
 * value is used (dual-read alias, 060); otherwise the schema default.
 */
export function resolveTelegramChatConfig(
  config: Pick<AppConfig, 'alerts' | 'messaging'>,
): ResolvedTelegramChatConfig {
  const chat = config.messaging.chat.telegram;
  const legacy = config.alerts.telegram;
  return {
    botToken: firstNonBlank(chat.botToken, legacy.botToken) ?? '',
    webhookSecret: firstNonBlank(chat.webhookSecret, legacy.webhookSecret) ?? '',
    webhookUrl: firstNonBlank(chat.webhookUrl, legacy.webhookUrl),
  };
}
