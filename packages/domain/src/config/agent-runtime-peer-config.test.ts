import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { PEER_MESSAGE_SAFETY_MAX_CHARS } from '../agent-protocol.js';
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

const DEFAULT_PEER = { rateLimitPerMinute: 10, messageMaxChars: 4000, switchCacheMs: 2000, switchReadRetries: 2, switchRetryBackoffMs: 250 };

describe('agentRuntime.peer schema (DEC-42)', () => {
  it('defaults to 10 peer messages per minute, a 4000 character message and a 2 s switch cache with 2 retries', () => {
    expect(parseWithPeer()).toEqual(DEFAULT_PEER);
  });

  it('accepts operator overrides', () => {
    expect(parseWithPeer({ rateLimitPerMinute: 3, messageMaxChars: 500, switchCacheMs: 0, switchReadRetries: 0, switchRetryBackoffMs: 10 }))
      .toEqual({ rateLimitPerMinute: 3, messageMaxChars: 500, switchCacheMs: 0, switchReadRetries: 0, switchRetryBackoffMs: 10 });
  });

  it.each([
    ['a zero rate limit', { rateLimitPerMinute: 0 }],
    ['a fractional rate limit', { rateLimitPerMinute: 1.5 }],
    ['a zero message length', { messageMaxChars: 0 }],
    ['a message length above the protocol safety cap', { messageMaxChars: PEER_MESSAGE_SAFETY_MAX_CHARS + 1 }],
    ['a negative switch cache', { switchCacheMs: -1 }],
    ['a switch cache above 30 s', { switchCacheMs: 30_001 }],
    ['more than 5 switch read retries', { switchReadRetries: 6 }],
    ['a fractional switch read retry count', { switchReadRetries: 1.5 }],
    ['a retry backoff above 5 s', { switchRetryBackoffMs: 5_001 }],
  ])('rejects %s', (_label, peer) => {
    expect(() => parseWithPeer(peer)).toThrow();
  });

  it('accepts a message length at the protocol safety cap', () => {
    expect(parseWithPeer({ messageMaxChars: PEER_MESSAGE_SAFETY_MAX_CHARS }).messageMaxChars).toBe(PEER_MESSAGE_SAFETY_MAX_CHARS);
  });

  it('is set in config/default.yaml to the schema default', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const yaml = parse(readFileSync(resolve(here, '../../../../config/default.yaml'), 'utf8')) as { agentRuntime: { peer: unknown } };

    expect(yaml.agentRuntime.peer).toEqual(DEFAULT_PEER);
  });
});
