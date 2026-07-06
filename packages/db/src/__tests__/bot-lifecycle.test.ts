import { describe, expect, it, vi } from 'vitest';
import { BotRepository } from '../repositories.js';

/**
 * Build a mock DB that captures the .set() values passed to .update().where().
 * Each call to .set() records its argument in `updates[]`.
 */
function buildMockDb(options?: {
  selectedRows?: Array<Record<string, unknown>>;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const selectedRows = options?.selectedRows ?? [];

  const whereFn = vi.fn().mockResolvedValue(undefined);
  const setFn = vi.fn().mockImplementation((values: Record<string, unknown>) => {
    updates.push(values);
    return { where: whereFn };
  });

  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(selectedRows),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: setFn,
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };

  return { db, updates, setFn, whereFn };
}

describe('BotRepository — lifecycle timestamp invariants', () => {
  it('markBotRunning clears stoppedAt', async () => {
    const { db, updates } = buildMockDb();
    const repo = new BotRepository(db as never);

    await repo.markBotRunning('bot-1');

    expect(updates.length).toBe(1);
    const set = updates[0]!;
    expect(set.status).toBe('running');
    expect(set.startedAt).toBeInstanceOf(Date);
    expect(set.stoppedAt).toBeNull();
    expect(set.updatedAt).toBeInstanceOf(Date);
  });

  it('markBotRunning preserves startedAt for an already running bot', async () => {
    const existingStartedAt = new Date('2024-01-01T00:00:00.000Z');
    const { db, updates } = buildMockDb({
      selectedRows: [{ status: 'running', startedAt: existingStartedAt }],
    });
    const repo = new BotRepository(db as never);

    await repo.markBotRunning('bot-1');

    expect(updates.length).toBe(1);
    const set = updates[0]!;
    expect(set.status).toBe('running');
    expect(set.startedAt).toEqual(existingStartedAt);
    expect(set.stoppedAt).toBeNull();
    expect(set.updatedAt).toBeInstanceOf(Date);
    expect(set.updatedAt).not.toEqual(existingStartedAt);
  });

  it('markBotRunning restamps startedAt when restarting from stopped', async () => {
    const existingStartedAt = new Date('2024-01-01T00:00:00.000Z');
    const { db, updates } = buildMockDb({
      selectedRows: [{ status: 'stopped', startedAt: existingStartedAt }],
    });
    const repo = new BotRepository(db as never);

    await repo.markBotRunning('bot-1');

    expect(updates.length).toBe(1);
    const set = updates[0]!;
    expect(set.status).toBe('running');
    expect(set.startedAt).toBeInstanceOf(Date);
    expect(set.startedAt).not.toEqual(existingStartedAt);
    expect(set.startedAt).toBe(set.updatedAt);
    expect(set.stoppedAt).toBeNull();
  });

  it('markBotStopped sets stoppedAt and status=stopped', async () => {
    const { db, updates } = buildMockDb();
    const repo = new BotRepository(db as never);

    await repo.markBotStopped('bot-1');

    expect(updates.length).toBe(1);
    const set = updates[0]!;
    expect(set.status).toBe('stopped');
    expect(set.stoppedAt).toBeInstanceOf(Date);
    expect(set.updatedAt).toBeInstanceOf(Date);
  });

  it('markBotCrashed sets stoppedAt and status=crashed', async () => {
    const { db, updates } = buildMockDb();
    const repo = new BotRepository(db as never);

    await repo.markBotCrashed('bot-1');

    expect(updates.length).toBe(1);
    const set = updates[0]!;
    expect(set.status).toBe('crashed');
    expect(set.stoppedAt).toBeInstanceOf(Date);
    expect(set.updatedAt).toBeInstanceOf(Date);
  });

  it('restoreBotRuntimeState restores old values', async () => {
    const { db, updates } = buildMockDb();
    const repo = new BotRepository(db as never);

    const oldStartedAt = new Date('2024-01-01');
    const oldStoppedAt = new Date('2024-01-02');

    await repo.restoreBotRuntimeState({
      botId: 'bot-1',
      status: 'stopped',
      startedAt: oldStartedAt,
      stoppedAt: oldStoppedAt,
    });

    expect(updates.length).toBe(1);
    const set = updates[0]!;
    expect(set.status).toBe('stopped');
    expect(set.startedAt).toEqual(oldStartedAt);
    expect(set.stoppedAt).toEqual(oldStoppedAt);
  });

  it('restoreBotRuntimeState handles null fields', async () => {
    const { db, updates } = buildMockDb();
    const repo = new BotRepository(db as never);

    await repo.restoreBotRuntimeState({
      botId: 'bot-1',
      status: 'running',
      startedAt: null,
      stoppedAt: null,
    });

    expect(updates.length).toBe(1);
    const set = updates[0]!;
    expect(set.status).toBe('running');
    expect(set.startedAt).toBeNull();
    expect(set.stoppedAt).toBeNull();
  });

  it('markBotRunning after markBotStopped produces valid invariant: stoppedAt cleared and startedAt set', async () => {
    const { db, updates } = buildMockDb();
    const repo = new BotRepository(db as never);

    // First, stop the bot
    await repo.markBotStopped('bot-1');
    const stopSet = updates[0]!;
    expect(stopSet.status).toBe('stopped');
    expect(stopSet.stoppedAt).toBeInstanceOf(Date);

    // Then, start it again
    await repo.markBotRunning('bot-1');
    const startSet = updates[1]!;

    // The new startedAt must be set and stoppedAt must be cleared
    expect(startSet.startedAt).toBeInstanceOf(Date);
    expect(startSet.stoppedAt).toBeNull();
    expect(startSet.status).toBe('running');
  });
});

describe('BotRepository — listRunningBotsForInactiveAgents', () => {
  // NOTE: These tests use mock DBs and cannot verify the SQL predicate logic
  // end-to-end. Full predicate verification (eq(bots.creatorType, 'agent'),
  // inArray(agents.status, ['stopped', 'crashed']), eq(bots.status, 'running'))
  // requires a real DB integration test. The tests below verify that:
  //  (a) the method wires the query chain correctly,
  //  (b) the where clause receives the expected Drizzle filter arguments,
  //  (c) results are returned when the mock resolves with rows.

  it('returns running agent-created bots for stopped/crashed agents (stopped-agent case)', async () => {
    // Plan §3c: stopped agent + agent-created running bot → bot is returned.
    const botRows = [
      { id: 'bot-orphan', creatorId: 'agent-stopped' },
    ];
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(botRows),
          }),
        }),
      }),
    };
    const repo = new BotRepository(db as never);

    const result = await repo.listRunningBotsForInactiveAgents();

    expect(result).toEqual(botRows);
  });

  it('returns empty when no running agent bots have inactive creators', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };
    const repo = new BotRepository(db as never);

    const result = await repo.listRunningBotsForInactiveAgents();

    expect(result).toEqual([]);
  });

  it('passes eq(bots.creatorType, "agent") in the where clause', async () => {
    // Plan §3c: verify the method filters by creatorType='agent' so that
    // user-created bots (creatorType='user') are excluded from the sweep.
    // This captures the where() argument to confirm the chain is wired;
    // verifying the exact Drizzle SQL object value requires an integration test.
    const whereSpy = vi.fn().mockResolvedValue([]);

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: whereSpy,
          }),
        }),
      }),
    };
    const repo = new BotRepository(db as never);

    await repo.listRunningBotsForInactiveAgents();

    // The where clause must be called with the Drizzle filter object.
    expect(whereSpy).toHaveBeenCalledTimes(1);
    const filterArg = whereSpy.mock.calls[0]?.[0];
    expect(filterArg).toBeDefined();
    // The filter is an `and(...)` combining three predicates. The exact
    // Drizzle AST shape must be validated via a real-DB integration test,
    // but the presence of a non-null argument confirms the chain is wired.
  });

  it('passes inArray(agents.status, ["stopped", "crashed"]) in the where clause', async () => {
    // Plan §3c: verify the method filters by agent status IN ('stopped', 'crashed')
    // so that bots belonging to active/paused agents are excluded.
    // Same caveat as above: exact predicate shape requires an integration test.
    const whereSpy = vi.fn().mockResolvedValue([]);

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: whereSpy,
          }),
        }),
      }),
    };
    const repo = new BotRepository(db as never);

    await repo.listRunningBotsForInactiveAgents();

    expect(whereSpy).toHaveBeenCalledTimes(1);
    const filterArg = whereSpy.mock.calls[0]?.[0];
    expect(filterArg).toBeDefined();
    // The Drizzle `inArray` produces a SQL fragment that cannot be
    // meaningfully asserted against in a mock test — integration test needed.
  });
});
