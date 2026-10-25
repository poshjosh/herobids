import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
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

function parseWithPeer(peer?: Record<string, unknown>) {
  return AppConfigSchema.parse({
    ...baseConfig,
    agentRuntime: { ...baseConfig.agentRuntime, ...(peer ? { peer } : {}) },
  }).agentRuntime.peer;
}

describe('agentRuntime.peer schema (DEC-42)', () => {
  it('defaults to 10 peer messages per minute and a 4000 character message', () => {
    expect(parseWithPeer()).toEqual({ rateLimitPerMinute: 10, messageMaxChars: 4000 });
  });

  it('accepts operator overrides', () => {
    expect(parseWithPeer({ rateLimitPerMinute: 3, messageMaxChars: 500 })).toEqual({ rateLimitPerMinute: 3, messageMaxChars: 500 });
  });

  it.each([
    ['a zero rate limit', { rateLimitPerMinute: 0 }],
    ['a fractional rate limit', { rateLimitPerMinute: 1.5 }],
    ['a zero message length', { messageMaxChars: 0 }],
  ])('rejects %s', (_label, peer) => {
    expect(() => parseWithPeer(peer)).toThrow();
  });

  it('is set in config/default.yaml to the schema default', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const yaml = parse(readFileSync(resolve(here, '../../../../config/default.yaml'), 'utf8')) as { agentRuntime: { peer: unknown } };

    expect(yaml.agentRuntime.peer).toEqual({ rateLimitPerMinute: 10, messageMaxChars: 4000 });
  });
});
