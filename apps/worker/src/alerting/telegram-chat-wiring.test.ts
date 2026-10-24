import { describe, expect, it } from 'vitest';
import { AlertsConfigSchema, MessagingConfigSchema } from '@herobids/domain';
import { resolveWorkerTelegramChat } from './telegram-chat-wiring.js';

function configWith(alertsTelegram: Record<string, unknown>, chatTelegram: Record<string, unknown>) {
  return {
    alerts: AlertsConfigSchema.parse({ telegram: alertsTelegram }),
    messaging: MessagingConfigSchema.parse({ chat: { telegram: chatTelegram } }),
  };
}

describe('resolveWorkerTelegramChat', () => {
  it('uses the bot token set only under messaging.chat.telegram for the alert dispatcher', () => {
    const wired = resolveWorkerTelegramChat(configWith({}, { botToken: 'chat-token' }));

    expect(wired.telegram.botToken).toBe('chat-token');
    expect(wired.alerts.telegram.botToken).toBe('chat-token');
  });

  it('passes the messaging.chat.telegram webhook secret and URL to the dispatcher config', () => {
    const webhookUrl = 'https://example.test/telegram/webhook';
    const wired = resolveWorkerTelegramChat(configWith({}, { webhookSecret: 'chat-secret', webhookUrl }));

    expect(wired.alerts.telegram.webhookSecret).toBe('chat-secret');
    expect(wired.alerts.telegram.webhookUrl).toBe(webhookUrl);
  });

  it('falls back to the legacy alerts.telegram bot token when messaging.chat.telegram is blank', () => {
    const wired = resolveWorkerTelegramChat(configWith({ botToken: 'legacy-token' }, { botToken: '  ' }));

    expect(wired.telegram.botToken).toBe('legacy-token');
    expect(wired.alerts.telegram.botToken).toBe('legacy-token');
  });

  it('keeps the non-token alerts settings unchanged', () => {
    const config = configWith({ botToken: 'legacy-token', channels: [] }, { botToken: 'chat-token' });
    const wired = resolveWorkerTelegramChat(config);

    expect(wired.alerts.enabled).toBe(config.alerts.enabled);
    expect(wired.alerts.telegram.channels).toEqual(config.alerts.telegram.channels);
  });
});
