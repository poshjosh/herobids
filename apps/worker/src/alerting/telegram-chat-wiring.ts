import {
  resolveTelegramChatConfig,
  type AlertsConfig,
  type AppConfig,
  type ResolvedTelegramChatConfig,
} from '@herobids/domain';

/**
 * Telegram transport settings come from messaging.chat.telegram.* (legacy alerts.telegram.*
 * is the fallback). The alert dispatcher still reads its token from alerts.telegram, so it
 * receives an alerts config carrying the resolved values.
 */
export function resolveWorkerTelegramChat(config: Pick<AppConfig, 'alerts' | 'messaging'>): {
  telegram: ResolvedTelegramChatConfig;
  alerts: AlertsConfig;
} {
  const telegram = resolveTelegramChatConfig(config);
  return {
    telegram,
    alerts: {
      ...config.alerts,
      telegram: {
        ...config.alerts.telegram,
        botToken: telegram.botToken,
        webhookSecret: telegram.webhookSecret,
        webhookUrl: telegram.webhookUrl,
      },
    },
  };
}
