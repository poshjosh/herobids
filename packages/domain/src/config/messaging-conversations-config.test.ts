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

describe('messaging.conversations schema', () => {
  it('defaults to a 4000 character user message and 50/200 thread pages', () => {
    expect(parseWith({}).messaging.conversations).toEqual({
      userMessageMaxChars: 4000,
      threadDefaultPageSize: 50,
      threadMaxPageSize: 200,
    });
  });

  it('accepts operator overrides', () => {
    const conversations = parseWith({
      messaging: { conversations: { userMessageMaxChars: 1000, threadDefaultPageSize: 10, threadMaxPageSize: 20 } },
    }).messaging.conversations;

    expect(conversations).toEqual({ userMessageMaxChars: 1000, threadDefaultPageSize: 10, threadMaxPageSize: 20 });
  });

  it('rejects a default page size above the maximum', () => {
    expect(() => parseWith({
      messaging: { conversations: { threadDefaultPageSize: 300, threadMaxPageSize: 200 } },
    })).toThrow(/threadDefaultPageSize/);
  });

  it('rejects non-positive limits', () => {
    expect(() => parseWith({ messaging: { conversations: { userMessageMaxChars: 0 } } })).toThrow();
  });
});
