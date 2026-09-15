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
  handleLog,
  truncateForTelegram,
} from './telegram-command-handlers.js';
import type { TradertonClient, TradertonClientResult } from '@herobids/domain/traderton';

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

// ─── handleLog ───────────────────────────────────────────────────────────
//
// handleLog merges LOCAL platform rows (agent_messages + agent_outbound_messages
// via db.execute) with the decision-failures leg fetched over the Traderton read
// boundary, re-sorts newest-first, keeps the first 10 (splice), then renders the
// 5 most-recent oldest-first. The boundary leg is best-effort: an absent client
// or a boundary failure DEGRADES to platform-only output (never errors/503s).

/**
 * Build a minimal db for handleLog:
 *  - `select().from().where().limit(3)` resolves resolveAgentByName → single agent (found)
 *  - `execute(sql`...`)` resolves the platform LogRow[] (agent_messages + outbound)
 */
function makeLogDb(agent: Record<string, unknown>, platformRows: unknown[]) {
  const execute = vi.fn().mockResolvedValue(platformRows);
  const db = {
    select: vi.fn(() => makeChain([agent])),
    execute,
  } as unknown as Database;
  return { db, execute };
}

/**
 * Smallest TradertonClient stub. `loadAgentEvidence` → `boundary.invoke` →
 * `client.invoke({ toolName, payload, subject, deadlineMs })` and expects a
 * TradertonClientResult. A `success` payload with a `failures` array feeds the
 * merge; a `transport_error` exercises the DEGRADE leg.
 */
function makeFailuresClient(result: TradertonClientResult): { client: TradertonClient; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn().mockResolvedValue(result);
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

function successFailures(failures: unknown[]): TradertonClientResult {
  return { kind: 'success', requestId: 'r', correlationId: 'c', payload: { failures } };
}

describe('handleLog', () => {
  const AGENT = { id: 'agent-1', userId: 'user-1', name: 'Momentum', status: 'active' };

  it('merges boundary failures with platform rows, re-sorts newest-first, and renders 5 oldest-first', async () => {
    // Two platform message rows (older) + one boundary failure that is NEWER than
    // both — proves merge + re-sort places the failure last (most recent) in the
    // descending list, hence first in the reversed 5-most-recent render.
    const platformRows = [
      { source: 'msg', raw_type: 'agent.decision.go_long', subject: null, body_text: null, failure_msg: null, created_at: new Date('2026-01-01T10:00:00.000Z') },
      { source: 'msg', raw_type: 'user.message', subject: null, body_text: null, failure_msg: null, created_at: new Date('2026-01-01T10:05:00.000Z') },
    ];
    const { db } = makeLogDb(AGENT, platformRows);
    const { client, invoke } = makeFailuresClient(successFailures([
      { failureCode: 'risk.exceeded', failureMessage: 'position cap breached', failedAt: '2026-01-01T10:10:00.000Z' },
    ]));

    const result = await handleLog(db, 'user-1', ['Momentum'], client);

    // Boundary invoked with the agent-scoped tool + payload the handler passes.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0]).toEqual(expect.objectContaining({
      toolName: 'get_agent_decision_failures',
      payload: { limit: 10 },
      subject: { ownerId: 'user-1', actor: { type: 'agent', id: 'agent-1' } },
    }));

    // Descending merged order: failure(10:10) → user(10:05) → decision(10:00).
    // slice(0,5).reverse() → oldest-first: decision, user, failure.
    expect(result).toBe([
      'Momentum — recent activity:',
      '[10:00] DECISION',
      '[10:05] USER',
      '[10:10] ERR: risk.exceeded — position cap breached',
    ].join('\n'));
  });

  it('truncates a failure message longer than 60 chars in the ERR line', async () => {
    const longMsg = 'x'.repeat(80);
    const { db } = makeLogDb(AGENT, []);
    const { client } = makeFailuresClient(successFailures([
      { failureCode: 'venue.timeout', failureMessage: longMsg, failedAt: '2026-01-01T12:00:00.000Z' },
    ]));

    const result = await handleLog(db, 'user-1', ['Momentum'], client);

    // truncate(str, 60) → first 57 chars + '...'
    const expectedMsg = 'x'.repeat(57) + '...';
    expect(result).toBe([
      'Momentum — recent activity:',
      `[12:00] ERR: venue.timeout — ${expectedMsg}`,
    ].join('\n'));
  });

  it('keeps only 10 rows after splice when the merged set exceeds 10, then shows 5', async () => {
    // 8 platform rows (older) + 6 boundary failures (newer) = 14 merged.
    // After sort desc + splice(10), the 6 newest failures + the 4 newest platform
    // rows survive; the 4 oldest platform rows are dropped. The render shows the
    // 5 most recent (all failures) oldest-first.
    const platformRows = Array.from({ length: 8 }, (_, i) => ({
      source: 'msg' as const,
      raw_type: 'system.heartbeat',
      subject: null,
      body_text: null,
      failure_msg: null,
      // 09:00 .. 09:07
      created_at: new Date(`2026-01-01T09:0${i}:00.000Z`),
    }));
    const failures = Array.from({ length: 6 }, (_, i) => ({
      failureCode: `err.${i}`,
      failureMessage: `msg ${i}`,
      // 11:00 .. 11:05 (all newer than every platform row)
      failedAt: `2026-01-01T11:0${i}:00.000Z`,
    }));
    const { db } = makeLogDb(AGENT, platformRows);
    const { client } = makeFailuresClient(successFailures(failures));

    const result = await handleLog(db, 'user-1', ['Momentum'], client);

    // 5 most-recent = failures 11:05,11:04,11:03,11:02,11:01 → reversed oldest-first.
    expect(result).toBe([
      'Momentum — recent activity:',
      '[11:01] ERR: err.1 — msg 1',
      '[11:02] ERR: err.2 — msg 2',
      '[11:03] ERR: err.3 — msg 3',
      '[11:04] ERR: err.4 — msg 4',
      '[11:05] ERR: err.5 — msg 5',
    ].join('\n'));
  });

  it('degrades to platform-only output when no boundary client is supplied', async () => {
    const platformRows = [
      { source: 'msg', raw_type: 'agent.decision.go_flat', subject: null, body_text: null, failure_msg: null, created_at: new Date('2026-01-01T08:00:00.000Z') },
      { source: 'outbound', raw_type: 'agent', subject: 'Rebalanced portfolio', body_text: null, failure_msg: null, created_at: new Date('2026-01-01T08:01:00.000Z') },
    ];
    const { db } = makeLogDb(AGENT, platformRows);

    // No tradertonReadClient → the failure leg is simply omitted, no throw/503.
    const result = await handleLog(db, 'user-1', ['Momentum']);

    expect(result).toBe([
      'Momentum — recent activity:',
      '[08:00] DECISION',
      '[08:01] AGENT: Rebalanced portfolio',
    ].join('\n'));
  });

  it('degrades to platform-only output when the boundary read fails (no error/503)', async () => {
    const platformRows = [
      { source: 'msg', raw_type: 'agent.decision.go_long', subject: null, body_text: null, failure_msg: null, created_at: new Date('2026-01-01T08:00:00.000Z') },
    ];
    const { db } = makeLogDb(AGENT, platformRows);
    // transport_error → loadAgentEvidence returns { ok: false } → failure leg skipped.
    const { client } = makeFailuresClient({ kind: 'transport_error', requestId: 'r', message: 'boundary down', retryable: true });

    const result = await handleLog(db, 'user-1', ['Momentum'], client);

    expect(result).toBe([
      'Momentum — recent activity:',
      '[08:00] DECISION',
    ].join('\n'));
  });
});
