import type { AppConfig } from './schema.js';

export interface ResolvedTelegramChatConfig {
  botToken: string;
  webhookSecret: string;
  webhookUrl: string | undefined;
  botUsername?: string;
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

const TELEGRAM_BOT_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/;

/**
 * Telegram bot usernames are 5–32 letters, digits or underscores and end in "bot". An invalid value resolves to
 * undefined, which makes the link endpoint return 503. The value itself is never logged.
 */
function resolveTelegramBotUsername(value: string | undefined): string | undefined {
  const username = nonBlank(value)?.trim().replace(/^@/, '');
  if (!username || !TELEGRAM_BOT_USERNAME_PATTERN.test(username) || !/bot$/i.test(username)) return undefined;
  return username;
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
    botUsername: resolveTelegramBotUsername(chat.botUsername),
  };
}
