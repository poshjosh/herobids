import { describe, it, expect, vi } from 'vitest';
import {
  loadAgentBotIds,
  loadAgentFills,
  loadAgentJournalEvents,
  loadAgentRuntimeSessions,
  loadAgentPositions,
} from './agent-evidence-loaders.js';
import type { Database } from './index.js';

const TEST_AGENT_ID = 'agent-1';
const TEST_BOT_ID = 'bot-1';
const now = new Date('2026-01-15T10:00:00Z');

const sampleFill = {
  id: 'fill-1',
  orderId: 'order-1',
  venueAccountId: 'va-1',
  actorType: 'bot' as const,
  actorId: TEST_BOT_ID,
  venueRefId: 'ref-1',
  venue: 'hyperliquid',
  symbol: 'BTC-PERP',
  side: 'buy' as const,
  quantity: '0.1',
  price: '50000',
  fee: '5.00',
  feeCurrency: 'USDC',
  realizedPnlDelta: null,
  filledAt: now,
  createdAt: now,
};

const sampleAgentFill = {
  ...sampleFill,
  id: 'fill-agent-1',
  actorType: 'agent' as const,
  actorId: TEST_AGENT_ID,
  symbol: 'ETH-PERP',
  side: 'sell' as const,
  quantity: '1.5',
  price: '3200',
  fee: '2.40',
};

const sampleJournalEvent = {
  id: 'ev-1',
  actorType: 'bot' as const,
  actorId: TEST_BOT_ID,
  backtestRunId: null,
  type: 'order.filled',
  payload: { orderId: 'order-1' },
  createdAt: now,
};

const sampleAgentJournalEvent = {
  ...sampleJournalEvent,
  id: 'ev-agent-1',
  actorType: 'agent' as const,
  actorId: TEST_AGENT_ID,
  type: 'decision.submitted',
};

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

const sampleAgentPosition = {
  id: 'pos-agent-1',
  venueAccountId: 'va-agent-1',
  actorType: 'agent' as const,
  actorId: TEST_AGENT_ID,
  venue: 'hyperliquid',
  symbol: 'ETH-PERP',
  side: 'short' as const,
  size: '1.5',
  entryPrice: '3200',
  realizedPnl: '-50.00',
  markSource: 'last_fill' as const,
  openedAt: now,
  closedAt: null,
  updatedAt: now,
};

const sampleBotPosition = {
  ...sampleAgentPosition,
  id: 'pos-bot-1',
  actorType: 'bot' as const,
  actorId: TEST_BOT_ID,
  symbol: 'BTC-PERP',
  side: 'long' as const,
  size: '0.1',
  entryPrice: '50000',
  realizedPnl: '100.00',
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

describe('loadAgentBotIds', () => {
  it('returns bot IDs owned by the agent', async () => {
    const db = buildDb([[{ id: TEST_BOT_ID }, { id: 'bot-2' }]]);
    const ids = await loadAgentBotIds(db, TEST_AGENT_ID);
    expect(ids).toEqual([TEST_BOT_ID, 'bot-2']);
  });

  it('returns empty array when agent has no bots', async () => {
    const db = buildDb([[]]);
    const ids = await loadAgentBotIds(db, TEST_AGENT_ID);
    expect(ids).toEqual([]);
  });
});

describe('loadAgentFills', () => {
  it('returns agent-native fills and agent-owned bot fills combined', async () => {
    // Sequence: bots lookup → agent fills → bot fills
    const db = buildDb([
      [{ id: TEST_BOT_ID }],
      [sampleAgentFill],
      [sampleFill],
    ]);
    const fills = await loadAgentFills(db, TEST_AGENT_ID);
    expect(fills).toHaveLength(2);
    expect(fills[0]?.actorType).toBe('agent');
    expect(fills[1]?.actorType).toBe('bot');
  });

  it('returns only agent-native fills when agent has no bots', async () => {
    const db = buildDb([
      [],
      [sampleAgentFill],
    ]);
    const fills = await loadAgentFills(db, TEST_AGENT_ID);
    expect(fills).toHaveLength(1);
    expect(fills[0]?.id).toBe('fill-agent-1');
  });

  it('respects from/to time filters', async () => {
    const from = new Date('2026-01-15T09:00:00Z');
    const to = new Date('2026-01-15T11:00:00Z');
    const db = buildDb([
      [],
      [sampleAgentFill],
    ]);
    const fills = await loadAgentFills(db, TEST_AGENT_ID, { from, to });
    expect(fills).toHaveLength(1);
  });
});

describe('loadAgentJournalEvents', () => {
  it('returns agent-native and bot journal events combined', async () => {
    const db = buildDb([
      [{ id: TEST_BOT_ID }],
      [sampleAgentJournalEvent],
      [sampleJournalEvent],
    ]);
    const events = await loadAgentJournalEvents(db, TEST_AGENT_ID);
    expect(events).toHaveLength(2);
    expect(events[0]?.actorType).toBe('agent');
    expect(events[1]?.actorType).toBe('bot');
  });

  it('respects from/to time filters', async () => {
    const from = new Date('2026-01-15T09:00:00Z');
    const to = new Date('2026-01-15T11:00:00Z');
    const db = buildDb([
      [],
      [sampleAgentJournalEvent],
    ]);
    const events = await loadAgentJournalEvents(db, TEST_AGENT_ID, { from, to });
    expect(events).toHaveLength(1);
  });
});

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

describe('loadAgentPositions', () => {
  it('returns agent-native and bot positions combined', async () => {
    const db = buildDb([
      [{ id: TEST_BOT_ID }],
      [sampleAgentPosition],
      [sampleBotPosition],
    ]);
    const positions = await loadAgentPositions(db, TEST_AGENT_ID);
    expect(positions).toHaveLength(2);
    expect(positions[0]?.actorType).toBe('agent');
    expect(positions[1]?.actorType).toBe('bot');
  });

  it('returns only agent-native positions when agent has no bots', async () => {
    const db = buildDb([
      [],
      [sampleAgentPosition],
    ]);
    const positions = await loadAgentPositions(db, TEST_AGENT_ID);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.id).toBe('pos-agent-1');
  });

  it('with opts.at returns only positions open at that timestamp', async () => {
    const beforeSnapshot = new Date('2026-01-14T00:00:00Z');
    const db = buildDb([
      [],
      [sampleAgentPosition], // opened at `now` (2026-01-15), closed at null
    ]);
    // Snapshot before the position opened → should be empty
    const positions = await loadAgentPositions(db, TEST_AGENT_ID, { at: beforeSnapshot });
    expect(positions).toHaveLength(0);
  });

  it('without opts.at returns all positions including closed', async () => {
    const closedPosition = {
      ...sampleAgentPosition,
      id: 'pos-closed',
      closedAt: now,
    };
    const db = buildDb([
      [],
      [sampleAgentPosition, closedPosition],
    ]);
    const positions = await loadAgentPositions(db, TEST_AGENT_ID);
    expect(positions).toHaveLength(2);
  });
});
