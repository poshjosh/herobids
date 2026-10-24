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

describe('messaging.notifications.email schema', () => {
  it('defaults to disabled, emails only agent questions, caps at 10 a day, and is opt-in per user', () => {
    expect(parseWith({}).messaging.notifications.email).toEqual({
      enabled: false,
      eventClasses: ['agent.question'],
      maxPerUserPerDay: 10,
      userDefaultEnabled: false,
    });
  });

  it('rejects a zero or negative maxPerUserPerDay', () => {
    expect(() => parseWith({ messaging: { notifications: { email: { maxPerUserPerDay: 0 } } } })).toThrow();
    expect(() => parseWith({ messaging: { notifications: { email: { maxPerUserPerDay: -1 } } } })).toThrow();
  });

  it('rejects a non-integer maxPerUserPerDay', () => {
    expect(() => parseWith({ messaging: { notifications: { email: { maxPerUserPerDay: 2.5 } } } })).toThrow();
  });

  it('rejects an email event class that is not a known notification class', () => {
    expect(() => parseWith({ messaging: { notifications: { email: { eventClasses: ['agent.silent'] } } } })).toThrow();
  });

  it('accepts an explicit userDefaultEnabled of true', () => {
    expect(parseWith({ messaging: { notifications: { email: { userDefaultEnabled: true } } } }).messaging.notifications.email.userDefaultEnabled).toBe(true);
  });

  it('leaves alerts.email parsing unchanged', () => {
    const config = parseWith({
      alerts: { email: { provider: 'ses', fromEmail: 'alerts@example.test', ses: { region: 'eu-west-1' } } },
    });

    expect(config.alerts.email.provider).toBe('ses');
    expect(config.alerts.email.fromEmail).toBe('alerts@example.test');
    expect(config.alerts.email.ses.region).toBe('eu-west-1');
    expect(config.alerts.email.timeoutMs).toBe(10_000);
  });
});
