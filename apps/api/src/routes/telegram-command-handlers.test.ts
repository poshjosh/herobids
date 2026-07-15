/**
 * Unit tests for Telegram command handler helpers and focused flows.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@herobids/db';
import type { AuthConfig } from '@herobids/domain';
import type { Redis } from 'ioredis';

const { makeSetupLinkUrlMock, createAndStoreSetupLinkTokenMock } = vi.hoisted(() => ({
  makeSetupLinkUrlMock: vi.fn((token: string, publicBaseUrl: string) => `${publicBaseUrl}/auth/setup-link/callback?token=${token}`),
  createAndStoreSetupLinkTokenMock: vi.fn(async () => 'test-token'),
}));

vi.mock('../services/setup-link-token-service.js', () => ({
  makeSetupLinkUrl: makeSetupLinkUrlMock,
  createAndStoreSetupLinkToken: createAndStoreSetupLinkTokenMock,
}));

import {
  formatActivityLabel,
  handleConnectSetup,
  truncateForTelegram,
} from './telegram-command-handlers.js';

function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'offset']) {
    chain[method] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  makeSetupLinkUrlMock.mockImplementation((token: string, publicBaseUrl: string) => `${publicBaseUrl}/auth/setup-link/callback?token=${token}`);
  createAndStoreSetupLinkTokenMock.mockResolvedValue('test-token');
});

// ─── formatActivityLabel ─────────────────────────────────────────────────

describe('formatActivityLabel', () => {
  it('maps agent.decision types to DECISION', () => {
    expect(formatActivityLabel('agent.decision.go_long')).toBe('DECISION');
    expect(formatActivityLabel('agent.decision.go_flat')).toBe('DECISION');
    expect(formatActivityLabel('agent.decision')).toBe('DECISION');
  });

  it('maps user types to USER', () => {
    expect(formatActivityLabel('user.message')).toBe('USER');
    expect(formatActivityLabel('user.command')).toBe('USER');
    expect(formatActivityLabel('user')).toBe('USER');
  });

  it('maps system types to SYSTEM', () => {
    expect(formatActivityLabel('system.heartbeat')).toBe('SYSTEM');
    expect(formatActivityLabel('system.market_snapshot')).toBe('SYSTEM');
    expect(formatActivityLabel('system')).toBe('SYSTEM');
  });

  it('maps agent.message types to AGENT', () => {
    expect(formatActivityLabel('agent.message.chat')).toBe('AGENT');
    expect(formatActivityLabel('agent.message')).toBe('AGENT');
  });

  it('falls back to last segment for unknown types', () => {
    expect(formatActivityLabel('custom.event')).toBe('EVENT');
    expect(formatActivityLabel('venue.trade')).toBe('TRADE');
    expect(formatActivityLabel('unknown')).toBe('UNKNOWN');
  });

  it('handles empty string gracefully', () => {
    expect(formatActivityLabel('')).toBe('');
  });
});

// ─── truncateForTelegram ─────────────────────────────────────────────────

describe('truncateForTelegram', () => {
  it('returns text unchanged when under maxChars', () => {
    const text = 'short message';
    expect(truncateForTelegram(text)).toBe(text);
    expect(truncateForTelegram(text, 100)).toBe(text);
  });

  it('returns text unchanged when exactly at maxChars', () => {
    const text = 'a'.repeat(3800);
    expect(truncateForTelegram(text)).toBe(text);
  });

  it('truncates at the last newline before maxChars', () => {
    // Create 10 lines each ~7 characters: "Line 1", "Line 2", etc.
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join('\n');
    // With maxChars = 25, we'll truncate somewhere mid-content
    const result = truncateForTelegram(lines, 25);
    expect(result).toContain('...and');
    // Result should be shorter than the original
    expect(result.length).toBeLessThan(lines.length);
  });

  it('appends "...and more" when no newline found before maxChars', () => {
    const text = 'a'.repeat(100);
    const result = truncateForTelegram(text, 50);
    expect(result).toContain('...and more');
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('counts remaining non-empty items correctly', () => {
    const lines = ['one', 'two', '', 'three', 'four', 'five'].join('\n');
    const result = truncateForTelegram(lines, 20);
    // Should have truncated after ~first 3 items, counting 3 remaining
    expect(result).toMatch(/\.\.\.and \d+ more/);
  });

  it('handles empty text', () => {
    expect(truncateForTelegram('')).toBe('');
    expect(truncateForTelegram('', 10)).toBe('');
  });
});

describe('handleConnectSetup', () => {
  const authConfig = {
    publicBaseUrl: 'https://app.example.com',
    loginLinkTtlSecs: 600,
    loginLinkResendCooldownSecs: 60,
  } as AuthConfig;

  it('lists assignable connections and includes a setup link when active connections exist', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) {
          return makeChain([{ id: 'agent-1', userId: 'user-1', name: 'Momentum', status: 'stopped' }]);
        }
        return makeChain([
          { id: 'a2b32d6c-1111', label: '1inch', provider: '1inch', status: 'active' },
          { id: '2fec1431-2222', label: 'Hyperliquid', provider: 'hyperliquid', status: 'active' },
        ]);
      }),
    } as unknown as Database;
    const redis = {
      ttl: vi.fn().mockResolvedValue(0),
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as Redis;

    const response = await handleConnectSetup(db, redis, authConfig, 'user-1', ['Momentum']);

    expect(response).toContain('Choose a connection for Momentum:');
    expect(response).toContain('a2b32d6c... — 1inch: 1inch');
    expect(response).toContain('2fec1431... — hyperliquid: Hyperliquid');
    expect(response).toContain('Use /connect Momentum <id> or /connect Momentum "label" to pick one.');
    expect(response).toContain('Need a new connection instead? Open this setup link:');
    expect(response).toContain('https://app.example.com/auth/setup-link/callback?token=test-token');
    expect(createAndStoreSetupLinkTokenMock).toHaveBeenCalledWith(redis, 'user-1', 600);
  });

  it('falls back to the web app when setup links are unavailable', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) {
          return makeChain([{ id: 'agent-1', userId: 'user-1', name: 'Momentum', status: 'stopped' }]);
        }
        return makeChain([
          { id: 'a2b32d6c-1111', label: '1inch', provider: '1inch', status: 'active' },
        ]);
      }),
    } as unknown as Database;
    const redis = {
      ttl: vi.fn(),
      set: vi.fn(),
    } as unknown as Redis;

    const response = await handleConnectSetup(db, redis, undefined, 'user-1', ['Momentum']);

    expect(response).toContain('Choose a connection for Momentum:');
    expect(response).toContain('Need a new connection instead? Open the web app to create one.');
    expect(createAndStoreSetupLinkTokenMock).not.toHaveBeenCalled();
  });
});
