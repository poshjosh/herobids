import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recomputeBlueprintPerformanceScore } from './blueprint-performance-scorer.js';
import type { TradertonClient, TradertonClientResult } from '@herobids/domain/traderton';

// The scorer uses drizzle ops only as opaque predicate builders — stub them so
// the query-chain mock below can ignore the arguments.
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => ({ _eq: val })),
  and: vi.fn((...args) => ({ _and: args })),
  asc: vi.fn((col) => ({ _asc: col })),
}));

// The scorer imports the `blueprints` / `agents` tables from @herobids/db only
// as drizzle table handles; the db mock ignores them, so a light stub suffices.
vi.mock('@herobids/db', () => ({
  blueprints: { id: 'blueprints.id', authorId: 'blueprints.authorId' },
  agents: { id: 'agents.id', userId: 'agents.userId', blueprintId: 'agents.blueprintId', createdAt: 'agents.createdAt' },
}));

const BLUEPRINT_ID = 'bp-1';
const AUTHOR_ID = 'user-1';
const AGENT_ID = 'agent-1';

const NOW_ISO = new Date('2026-02-02T10:00:00.000Z').toISOString();

/** ISO position fixture (boundary payloads arrive with ISO date strings). */
function positionIso(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pos',
    venueAccountId: 'va-1',
    actorType: 'agent',
    actorId: AGENT_ID,
    venue: 'hyperliquid',
    symbol: 'BTC-PERP',
    side: 'long',
    size: '1',
    entryPrice: '50000',
    realizedPnl: '0',
    markSource: 'last_fill',
    openedAt: NOW_ISO,
    closedAt: null as string | null,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

/**
 * Build a Traderton read client whose `invoke` returns a success payload with
 * the given positions for `get_agent_positions`. Mirrors the seam mock used in
 * capabilities/trading.test.ts / exports.test.ts.
 */
function makeReadClient(positions: unknown[]): {
  client: TradertonClient;
  invoke: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn().mockImplementation((input: { toolName: string }) => {
    const result: TradertonClientResult = {
      kind: 'success',
      requestId: 'r',
      correlationId: 'c',
      payload: input.toolName === 'get_agent_positions' ? { positions } : {},
    };
    return Promise.resolve(result);
  });
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

/** A read client whose `invoke` returns a terminal boundary failure. */
function makeFailingReadClient(): { client: TradertonClient; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn().mockResolvedValue({
    kind: 'failure',
    requestId: 'r',
    correlationId: 'c',
    code: 'internal.error',
    message: 'boundary blew up',
    retryable: false,
  } satisfies TradertonClientResult);
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

/**
 * Build a db mock. `selectSequence` supplies the resolved rows for each
 * `select().from()...` chain in call order (1: blueprint, 2: agent). The
 * returned `updateSet` spy captures what the blueprint UPDATE persisted.
 */
function buildDb(selectSequence: unknown[][]) {
  let callIdx = 0;
  const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

  const makeResultChain = () => {
    const chain: Record<string, unknown> = {};
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    (chain as { then: unknown }).then = (
      resolve: (v: unknown) => unknown,
      reject?: (v: unknown) => unknown,
    ) =>
      Promise.resolve(selectSequence[callIdx] ?? []).then((result) => {
        callIdx++;
        return resolve(result);
      }, reject);
    return chain;
  };

  const db = {
    select: vi.fn().mockImplementation(() => ({ from: vi.fn(() => makeResultChain()) })),
    update: vi.fn().mockImplementation(() => ({ set: updateSet })),
  };
  return { db: db as never, updateSet };
}

const agentRow = (overrides: Record<string, unknown> = {}) => ({
  id: AGENT_ID,
  userId: AUTHOR_ID,
  blueprintId: BLUEPRINT_ID,
  capital: '1000',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('recomputeBlueprintPerformanceScore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('skips the recompute (no UPDATE) when the read client is unconfigured', async () => {
    const { db, updateSet } = buildDb([[{ authorId: AUTHOR_ID }], [agentRow()]]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await recomputeBlueprintPerformanceScore(db, BLUEPRINT_ID, undefined);

    // Best-effort posture: the existing score is left untouched — no write.
    expect(updateSet).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('skips the recompute (no UPDATE) when the boundary read fails', async () => {
    const { db, updateSet } = buildDb([[{ authorId: AUTHOR_ID }], [agentRow()]]);
    const { client } = makeFailingReadClient();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await recomputeBlueprintPerformanceScore(db, BLUEPRINT_ID, client);

    expect(updateSet).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('writes performanceScore 0 when the agent has no closed positions', async () => {
    const { db, updateSet } = buildDb([[{ authorId: AUTHOR_ID }], [agentRow()]]);
    // Only an open position over the boundary → no closed positions after filter.
    const { client, invoke } = makeReadClient([positionIso({ id: 'open-1', closedAt: null })]);

    await recomputeBlueprintPerformanceScore(db, BLUEPRINT_ID, client);

    // The boundary was invoked for get_agent_positions bound to the author's
    // owner subject + the agent actor.
    const arg = invoke.mock.calls[0]![0] as { toolName: string; subject: unknown };
    expect(arg.toolName).toBe('get_agent_positions');
    expect(arg.subject).toEqual({ ownerId: AUTHOR_ID, actor: { type: 'agent', id: AGENT_ID } });

    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(updateSet.mock.calls[0]![0]).toMatchObject({ performanceScore: 0 });
  });

  it('writes performanceScore 0 when the agent resolves to no agent row', async () => {
    const { db, updateSet } = buildDb([[{ authorId: AUTHOR_ID }], []]);
    const { client } = makeReadClient([]);

    await recomputeBlueprintPerformanceScore(db, BLUEPRINT_ID, client);

    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(updateSet.mock.calls[0]![0]).toMatchObject({ performanceScore: 0 });
  });

  it('computes a mid score for a break-even winning/losing mix', async () => {
    // 2 closed positions: one win (+10), one loss (-10) → winRate 50%, pnl 0.
    const { db, updateSet } = buildDb([[{ authorId: AUTHOR_ID }], [agentRow({ capital: '1000' })]]);
    const { client } = makeReadClient([
      positionIso({ id: 'win', realizedPnl: '10.000000', closedAt: NOW_ISO }),
      positionIso({ id: 'loss', realizedPnl: '-10.000000', closedAt: NOW_ISO }),
    ]);

    await recomputeBlueprintPerformanceScore(db, BLUEPRINT_ID, client);

    // winRateScore = 0.5, pnlReturnPct = 0 → pnlScore = 0.5, riskAdjusted ≈ 0.33,
    // drawdown = 0.5. weighted = 0.5*.4 + 0.5*.2 + ~0.33*.2 + 0.5*.2 ≈ 0.467
    // → round(4.67) = 5.
    expect(updateSet).toHaveBeenCalledTimes(1);
    const written = updateSet.mock.calls[0]![0] as { performanceScore: number };
    expect(written.performanceScore).toBe(5);
  });

  it('ignores open positions when computing the score', async () => {
    // 2 wins (closed) + 1 open loss that must be excluded → winRate 100%.
    const { db, updateSet } = buildDb([[{ authorId: AUTHOR_ID }], [agentRow({ capital: '1000' })]]);
    const { client } = makeReadClient([
      positionIso({ id: 'w1', realizedPnl: '50.000000', closedAt: NOW_ISO }),
      positionIso({ id: 'w2', realizedPnl: '50.000000', closedAt: NOW_ISO }),
      positionIso({ id: 'open-loss', realizedPnl: '-999.000000', closedAt: null }),
    ]);

    await recomputeBlueprintPerformanceScore(db, BLUEPRINT_ID, client);

    expect(updateSet).toHaveBeenCalledTimes(1);
    const written = updateSet.mock.calls[0]![0] as { performanceScore: number };
    // All-winning + +10% pnl → pnlScore 1.0, winRateScore 1.0, drawdown 0.5,
    // riskAdjustedScore ≈ 0.33 (agent createdAt far in the past → large hours
    // floors the risk term). weighted ≈ 0.767 → round(7.67) = 8. The open
    // loss (-999) is excluded — a score of 8 confirms it never entered the mix.
    expect(written.performanceScore).toBe(8);
  });

  it('returns early without writing when the blueprint does not exist', async () => {
    const { db, updateSet } = buildDb([[]]);
    const { client } = makeReadClient([]);

    await recomputeBlueprintPerformanceScore(db, BLUEPRINT_ID, client);

    expect(updateSet).not.toHaveBeenCalled();
  });
});
