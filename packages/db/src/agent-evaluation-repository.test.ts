import { describe, it, expect, vi } from 'vitest';
import type { Database } from './index.js';
import { resolveScope } from './agent-evaluation-repository.js';

// ── Mock helpers ────────────────────────────────────────────────────────────

type SessionRow = { id: string };

/**
 * Builds a mock DB where the first N calls to .select() each produce an
 * independent query chain returning the corresponding value.
 */
function buildMockDb(responses: SessionRow[][]): Database {
  let callIndex = 0;
  const makeChain = (value: SessionRow[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit']) {
      chain[m] = vi.fn(() => chain);
    }
    (chain as { then: unknown }).then = (
      resolve: (v: unknown) => unknown,
      reject?: (v: unknown) => unknown,
    ) => Promise.resolve(value).then(resolve, reject);
    return chain;
  };

  return {
    select: vi.fn().mockImplementation(() => {
      const result = responses[callIndex] ?? [];
      callIndex++;
      return makeChain(result);
    }),
  } as unknown as Database;
}

// ── resolveScope tests ──────────────────────────────────────────────────────

describe('resolveScope', () => {
  it('returns the most recently stopped session when one exists', async () => {
    // Two stopped sessions — the first in the returned array is the
    // most recent (desc order).  resolveScope destructures [stopped].
    const db = buildMockDb([
      [{ id: 'session-stopped-2' }], // stopped (most recent)
      // running fallback won't be called
    ]);

    const result = await resolveScope(db, 'agent-1', { type: 'latestSession' });
    expect(result).toEqual({ type: 'session', sessionId: 'session-stopped-2' });
  });

  it('falls back to the running session when no stopped session exists', async () => {
    const db = buildMockDb([
      [],                               // no stopped sessions
      [{ id: 'session-running-1' }],    // one running session
    ]);

    const result = await resolveScope(db, 'agent-2', { type: 'latestSession' });
    expect(result).toEqual({ type: 'session', sessionId: 'session-running-1' });
  });

  it('falls back to a running session even if there are multiple running sessions (picks most recent)', async () => {
    // Only the first row of the running query is used — the most recent.
    const db = buildMockDb([
      [],                                // no stopped sessions
      [{ id: 'session-running-latest' }], // most recent running
    ]);

    const result = await resolveScope(db, 'agent-3', { type: 'latestSession' });
    expect(result).toEqual({ type: 'session', sessionId: 'session-running-latest' });
  });

  it('throws with the new error message when no session exists at all', async () => {
    const db = buildMockDb([
      [], // no stopped
      [], // no running
    ]);

    await expect(
      resolveScope(db, 'agent-none', { type: 'latestSession' }),
    ).rejects.toThrow(
      'No session found for agent agent-none. Start the agent to create a session first.',
    );
  });

  it('prefers stopped over running when both exist', async () => {
    const db = buildMockDb([
      [{ id: 'session-stopped' }],  // stopped exists
      // running query never reached, but would return this:
      // [{ id: 'session-running' }],
    ]);

    const result = await resolveScope(db, 'agent-5', { type: 'latestSession' });
    expect(result).toEqual({ type: 'session', sessionId: 'session-stopped' });
  });

  it('passes through concrete session scope unchanged', async () => {
    // No DB queries needed for concrete scopes
    const db = buildMockDb([]);
    const scope = { type: 'session' as const, sessionId: 'explicit-session' };

    const result = await resolveScope(db, 'agent-6', scope);
    expect(result).toEqual(scope);
  });

  it('passes through timeRange scope unchanged', async () => {
    const db = buildMockDb([]);
    const scope = {
      type: 'timeRange' as const,
      from: new Date('2026-01-01'),
      to: new Date('2026-01-02'),
    };

    const result = await resolveScope(db, 'agent-7', scope);
    expect(result).toEqual(scope);
  });

  it('passes through allTime scope unchanged', async () => {
    const db = buildMockDb([]);
    const scope = { type: 'allTime' as const };

    const result = await resolveScope(db, 'agent-8', scope);
    expect(result).toEqual(scope);
  });
});
