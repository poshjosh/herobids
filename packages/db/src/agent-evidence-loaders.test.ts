import { describe, it, expect, vi } from 'vitest';
import { loadAgentRuntimeSessions } from './agent-evidence-loaders.js';
import type { Database } from './index.js';

const TEST_AGENT_ID = 'agent-1';
const now = new Date('2026-01-15T10:00:00Z');

const sampleSession = {
  id: 'sess-1',
  agentId: TEST_AGENT_ID,
  status: 'stopped' as const,
  lastHeartbeatAt: now,
  cpuPct: null,
  memoryBytes: null,
  startedAt: now,
  stoppedAt: now,
};

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Build a mock Database that returns the given sequence of arrays for each `select()` call.
 * Each call to `select()` consumes the next item in the sequence.
 */
function buildDb(selectSequence: unknown[][]): Database {
  let i = 0;

  const makeChain = (value: unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit', 'offset']) {
      self[m] = vi.fn(() => self);
    }
    (self as { then: unknown }).then = (
      resolve: (v: unknown) => unknown,
      reject?: (v: unknown) => unknown,
    ) => Promise.resolve(value).then(resolve, reject);
    return self;
  };

  return {
    select: vi.fn().mockImplementation(() => {
      const val = selectSequence[i++] ?? [];
      return makeChain(val as unknown[]);
    }),
  } as unknown as Database;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('loadAgentRuntimeSessions', () => {
  it('returns sessions for the agent', async () => {
    const db = buildDb([[sampleSession]]);
    const sessions = await loadAgentRuntimeSessions(db, TEST_AGENT_ID);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.agentId).toBe(TEST_AGENT_ID);
  });

  it('returns empty array when agent has no sessions', async () => {
    const db = buildDb([[]]);
    const sessions = await loadAgentRuntimeSessions(db, TEST_AGENT_ID);
    expect(sessions).toEqual([]);
  });

  it('respects from/to time filters', async () => {
    const from = new Date('2026-01-15T09:00:00Z');
    const db = buildDb([[sampleSession]]);
    const sessions = await loadAgentRuntimeSessions(db, TEST_AGENT_ID, { from });
    expect(sessions).toHaveLength(1);
  });
});
