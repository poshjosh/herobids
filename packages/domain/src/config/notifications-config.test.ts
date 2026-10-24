import { describe, expect, it } from 'vitest';
import { AppConfigSchema } from './schema.js';

const baseConfig = {
  app: { port: 3000, logLevel: 'info' },
  database: { url: 'postgres://localhost:5432/test' },
  redis: { url: 'redis://localhost:6379' },
  execution: { defaultSlippageBps: 50 },
  risk: { globalMaxDrawdownPct: 20, maxOpenPositions: 10, maxPositionSizePct: 25 },
  agentRuntime: {
    defaultBudgets: {
      maxHistoryMessages: 20,
      maxHistoryTokens: 40_000,
      maxRecentToolMessages: 6,
      maxToolResultChars: 4_000,
      maxVisibleToolSchemas: 64,
      maxContextBlockChars: 4_000,
    },
  },
};

function parseWith(extra: Record<string, unknown>) {
  return AppConfigSchema.parse({ ...baseConfig, ...extra });
}

describe('messaging.notifications schema', () => {
  it('defaults to disabled with the agent reply and question classes and no web push', () => {
    const notifications = parseWith({}).messaging.notifications;

    expect(notifications.enabled).toBe(false);
    expect(notifications.eventClasses).toEqual(['agent.reply', 'agent.question']);
    expect(notifications.webPush).toEqual({
      enabled: false,
      vapidSubject: '',
      vapidPublicKey: '',
      vapidPrivateKey: '',
      ttlSeconds: 86400,
      urgency: 'normal',
    });
  });

  it('rejects an invalid urgency', () => {
    expect(() => parseWith({ messaging: { notifications: { webPush: { urgency: 'immediate' } } } })).toThrow();
  });

  it('accepts every documented urgency', () => {
    for (const urgency of ['very-low', 'low', 'normal', 'high']) {
      expect(parseWith({ messaging: { notifications: { webPush: { urgency } } } }).messaging.notifications.webPush.urgency).toBe(urgency);
    }
  });

  it('rejects a non-positive ttlSeconds', () => {
    expect(() => parseWith({ messaging: { notifications: { webPush: { ttlSeconds: 0 } } } })).toThrow();
    expect(() => parseWith({ messaging: { notifications: { webPush: { ttlSeconds: -5 } } } })).toThrow();
  });

  it('rejects a non-blank vapidSubject that is not a mailto: or https: URI', () => {
    expect(() => parseWith({ messaging: { notifications: { webPush: { vapidSubject: 'admin@example.com' } } } })).toThrow();
  });

  it('accepts a mailto: or https: vapidSubject', () => {
    expect(parseWith({ messaging: { notifications: { webPush: { vapidSubject: 'mailto:admin@example.com' } } } }).messaging.notifications.webPush.vapidSubject).toBe('mailto:admin@example.com');
    expect(parseWith({ messaging: { notifications: { webPush: { vapidSubject: 'https://example.com' } } } }).messaging.notifications.webPush.vapidSubject).toBe('https://example.com');
  });

  it('accepts a blank vapidSubject, which leaves web push off', () => {
    expect(parseWith({ messaging: { notifications: { webPush: { vapidSubject: '' } } } }).messaging.notifications.webPush.vapidSubject).toBe('');
    expect(parseWith({ messaging: { notifications: { webPush: { vapidSubject: '   ' } } } }).messaging.notifications.webPush.vapidSubject).toBe('   ');
  });

  it('rejects an event class that is not a known notification class', () => {
    expect(() => parseWith({ messaging: { notifications: { eventClasses: ['agent.silent'] } } })).toThrow();
  });

  it('leaves messaging.chat.telegram and alerts.telegram parsing unchanged', () => {
    const config = parseWith({
      alerts: { telegram: { botToken: 'legacy-token' } },
      messaging: { chat: { telegram: { botToken: 'new-token' } } },
    });

    expect(config.alerts.telegram.botToken).toBe('legacy-token');
    expect(config.messaging.chat.telegram.botToken).toBe('new-token');
    expect(config.messaging.chat.telegram.typingRefreshIntervalMs).toBe(4000);
  });
});
