import {
  resolveTelegramChatConfig,
  type AlertsConfig,
  type AppConfig,
  type ResolvedTelegramChatConfig,
} from '@herobids/domain';

/** Alerts config for the dispatcher: the channel routing plus the bot token it sends with. */
export type AlertDispatcherConfig = Omit<AlertsConfig, 'telegram'> & {
  telegram: AlertsConfig['telegram'] & { botToken: string };
};

/**
 * Telegram transport settings come from messaging.chat.telegram.*. The alert dispatcher
 * receives the alerts config carrying the resolved bot token.
 */
export function resolveWorkerTelegramChat(config: Pick<AppConfig, 'alerts' | 'messaging'>): {
  telegram: ResolvedTelegramChatConfig;
  alerts: AlertDispatcherConfig;
} {
  const telegram = resolveTelegramChatConfig(config);
  return {
    telegram,
    alerts: {
      ...config.alerts,
      telegram: {
        ...config.alerts.telegram,
        botToken: telegram.botToken,
      },
    },
  };
}
