import { describe, expect, it } from 'vitest';
import { AppConfigSchema } from './schema.js';
import { resolveTelegramChatConfig } from './messaging-chat.js';

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

describe('resolveTelegramChatConfig', () => {
  it('reads legacy alerts.telegram keys when messaging.chat is absent', () => {
    const config = parseWith({
      alerts: {
        telegram: {
          botToken: 'legacy-token',
          webhookSecret: 'legacy-secret',
          webhookUrl: 'https://example.com/telegram/webhook',
        },
      },
    });

    expect(resolveTelegramChatConfig(config)).toEqual({
      botToken: 'legacy-token',
      webhookSecret: 'legacy-secret',
      webhookUrl: 'https://example.com/telegram/webhook',
    });
  });

  it('reads messaging.chat.telegram keys when alerts.telegram is absent', () => {
    const config = parseWith({
      messaging: {
        chat: {
          telegram: {
            botToken: 'new-token',
            webhookSecret: 'new-secret',
            webhookUrl: 'https://example.com/messaging/telegram',
          },
        },
      },
    });

    expect(resolveTelegramChatConfig(config)).toEqual({
      botToken: 'new-token',
      webhookSecret: 'new-secret',
      webhookUrl: 'https://example.com/messaging/telegram',
    });
  });

  it('prefers messaging.chat.telegram over alerts.telegram when both are set', () => {
    const config = parseWith({
      alerts: {
        telegram: {
          botToken: 'legacy-token',
          webhookSecret: 'legacy-secret',
          webhookUrl: 'https://legacy.example.com/telegram/webhook',
        },
      },
      messaging: {
        chat: {
          telegram: {
            botToken: 'new-token',
            webhookSecret: 'new-secret',
            webhookUrl: 'https://new.example.com/messaging/telegram',
          },
        },
      },
    });

    expect(resolveTelegramChatConfig(config)).toEqual({
      botToken: 'new-token',
      webhookSecret: 'new-secret',
      webhookUrl: 'https://new.example.com/messaging/telegram',
    });
  });

  it('falls back per key when the new key is blank', () => {
    const config = parseWith({
      alerts: { telegram: { botToken: 'legacy-token', webhookSecret: 'legacy-secret' } },
      messaging: { chat: { telegram: { botToken: '   ', webhookSecret: 'new-secret' } } },
    });

    expect(resolveTelegramChatConfig(config)).toEqual({
      botToken: 'legacy-token',
      webhookSecret: 'new-secret',
      webhookUrl: undefined,
    });
  });

  it('returns blank credentials and no webhook URL when neither key is set', () => {
    const config = parseWith({});

    expect(resolveTelegramChatConfig(config)).toEqual({
      botToken: '',
      webhookSecret: '',
      webhookUrl: undefined,
    });
  });
});

describe('messaging.chat.telegram schema', () => {
  it('rejects a webhookUrl that is not a valid URL', () => {
    expect(() => parseWith({
      messaging: { chat: { telegram: { webhookUrl: 'not a url' } } },
    })).toThrow();
  });

  it('defaults the typing refresh to 4s and the typing window to the 180s LLM timeout', () => {
    const telegram = parseWith({}).messaging.chat.telegram;

    expect(telegram.typingRefreshIntervalMs).toBe(4000);
    expect(telegram.typingMaxWindowMs).toBe(180000);
  });

  it('rejects a non-positive typing refresh interval or window', () => {
    expect(() => parseWith({ messaging: { chat: { telegram: { typingRefreshIntervalMs: 0 } } } })).toThrow();
    expect(() => parseWith({ messaging: { chat: { telegram: { typingMaxWindowMs: -1 } } } })).toThrow();
  });

  it('rejects a typing refresh interval below the 1s floor', () => {
    expect(() => parseWith({ messaging: { chat: { telegram: { typingRefreshIntervalMs: 999 } } } })).toThrow();
    expect(parseWith({ messaging: { chat: { telegram: { typingRefreshIntervalMs: 1000 } } } }).messaging.chat.telegram.typingRefreshIntervalMs).toBe(1000);
  });

  it('rejects a typing refresh interval above the 9s ceiling', () => {
    expect(() => parseWith({ messaging: { chat: { telegram: { typingRefreshIntervalMs: 9001 } } } })).toThrow();
    expect(parseWith({ messaging: { chat: { telegram: { typingRefreshIntervalMs: 9000 } } } }).messaging.chat.telegram.typingRefreshIntervalMs).toBe(9000);
  });
});
