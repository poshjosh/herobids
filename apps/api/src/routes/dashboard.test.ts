import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { dashboardRoutes } from './dashboard.js';
import type { Database } from '@herobids/db';
import type { TradertonClient, TradertonClientResult } from '@herobids/domain/traderton';

const TEST_USER_ID = 'user-1';
const AGENT_ID = 'agent-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = TEST_USER_ID;
    request.userPlanId = 'free';
  });
}

const nowIso = '2026-01-15T10:00:00.000Z';
const earlierIso = '2026-01-15T09:00:00.000Z';

// list_owner_bots row (venueAccountId/startedAt/stoppedAt are newly added).
const bot1 = {
  id: 'bot-1',
  status: 'running',
  strategyPreset: 'momentum',
  symbol: 'ETH-USD',
  createdAt: earlierIso,
  creatorType: 'user',
  creatorId: TEST_USER_ID,
  venueAccountId: 'va-1',
  startedAt: nowIso,
  stoppedAt: null,
};

// get_venue_account single-object payload.
const va1Payload = { ok: true, venueAccountId: 'va-1', venueAccountRef: 'ref-1', venue: 'hyperliquid', label: 'Main' };

// get_owner_positions raw position rows.
const openPos = {
  id: 'pos-open',
  actorId: 'bot-1',
  actorType: 'bot',
  symbol: 'ETH-USD',
  side: 'long',
  size: '1',
  entryPrice: '3000',
  realizedPnl: '0',
  venue: 'hyperliquid',
  venueAccountId: 'va-1',
  openedAt: nowIso,
  closedAt: null,
  updatedAt: nowIso,
  markSource: null,
  exitReason: null,
};
const closedPos = {
  ...openPos,
  id: 'pos-closed',
  side: 'flat',
  realizedPnl: '25',
  closedAt: nowIso,
  exitReason: 'signal_lost',
};

// get_owner_journal event row.
const journalEvent = {
  id: 'e-1',
  actorId: 'bot-1',
  actorType: 'bot',
  type: 'order.filled',
  payload: { orderId: 'o-1' },
  createdAt: nowIso,
  backtestRunId: null,
};

// get_agent_positions rows (agent-native + agent-owned-bot, PnL folded).
const agentPos = {
  ...closedPos,
  id: 'pos-agent',
  actorId: AGENT_ID,
  actorType: 'agent',
  realizedPnl: '100',
};

type StubPayloads = {
  bots?: unknown[];
  venueAccounts?: Record<string, Record<string, unknown>>; // venueAccountId → get_venue_account payload
  positions?: unknown[];
  events?: unknown[];
  agentPositions?: unknown[];
};

/** A read client that answers each owner/agent-scoped tool from supplied payloads. */
function makeReadClient(payloads: StubPayloads): { client: TradertonClient; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn().mockImplementation((input: { toolName: string; payload: Record<string, unknown> }) => {
    let result: TradertonClientResult;
    switch (input.toolName) {
      case 'list_owner_bots':
        result = { kind: 'success', requestId: 'r', correlationId: 'c', payload: { bots: payloads.bots ?? [] } };
        break;
      case 'get_venue_account': {
        const vaId = input.payload['venueAccountId'] as string;
        const va = payloads.venueAccounts?.[vaId];
        result = va
          ? { kind: 'success', requestId: 'r', correlationId: 'c', payload: va }
          : { kind: 'failure', requestId: 'r', correlationId: 'c', code: 'validation.invalid_payload', message: 'not found', retryable: false, details: { errorCode: 'not_found.resource' } };
        break;
      }
      case 'get_owner_positions':
        result = { kind: 'success', requestId: 'r', correlationId: 'c', payload: { positions: payloads.positions ?? [] } };
        break;
      case 'get_owner_journal':
        result = { kind: 'success', requestId: 'r', correlationId: 'c', payload: { events: payloads.events ?? [] } };
        break;
      case 'get_agent_positions':
        result = { kind: 'success', requestId: 'r', correlationId: 'c', payload: { positions: payloads.agentPositions ?? [] } };
        break;
      default:
        result = { kind: 'success', requestId: 'r', correlationId: 'c', payload: {} };
    }
    return Promise.resolve(result);
  });
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

/**
 * Local db stub for the platform reads. `select()` returns a chainable that
 * resolves to the next queued response array (used by users/agents/agentMessages).
 */
function makeLocalDb(responses: unknown[][] = []): Database {
  let i = 0;
  const makeChain = (value: unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit', 'offset']) {
      chain[m] = vi.fn(() => chain);
    }
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
    return chain;
  };
  return {
    select: vi.fn().mockImplementation(() => makeChain(responses[i++] ?? [])),
  } as unknown as Database;
}

const READ_TIMEOUT_MS = 10_000;
const userRow = { id: TEST_USER_ID, displayName: 'User One', email: 'u1@example.com', avatarUrl: null, planId: 'free' };

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── GET /dashboard/overview ─────────────────────────────────────────────────

describe('GET /dashboard/overview', () => {
  it('assembles the summary from boundary reads', async () => {
    const { client } = makeReadClient({
      bots: [bot1],
      venueAccounts: { 'va-1': va1Payload },
      positions: [openPos, closedPos],
      events: [journalEvent],
      agentPositions: [agentPos],
    });
    // Local reads: users, then agents.
    const db = makeLocalDb([[userRow], [{ id: AGENT_ID }]]);
    const app = Fastify();
    decorateWithAuth(app);
    await dashboardRoutes(app, db, undefined, client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/dashboard/overview' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.user.id).toBe(TEST_USER_ID);
    expect(body.bots).toHaveLength(1);
    const bot = body.bots[0];
    expect(bot.id).toBe('bot-1');
    expect(bot.venue).toBe('hyperliquid');
    expect(bot.venueLabel).toBe('Main');
    expect(bot.symbol).toBe('ETH-USD');
    expect(bot.openPositionsCount).toBe(1); // only the open (closedAt=null) position
    expect(bot.lastActivityAt).toBe(nowIso);
    expect(bot.startedAt).toBe(nowIso);
    expect(bot.createdAt).toBe(earlierIso);

    expect(body.summary.totalBots).toBe(1);
    expect(body.summary.runningBots).toBe(1);
    expect(body.summary.totalOpenPositions).toBe(1);
    // Folded PnL: get_agent_positions returned one row with realizedPnl=100.
    expect(body.summary.outcomes.trading.totalRealizedPnl).toBe('100.000000');
  });

  it('degrades a bot with an unowned/absent venue account to empty labels', async () => {
    const { client } = makeReadClient({
      bots: [bot1],
      venueAccounts: {}, // get_venue_account → not_found
      positions: [],
      events: [],
      agentPositions: [],
    });
    const db = makeLocalDb([[userRow], []]);
    const app = Fastify();
    decorateWithAuth(app);
    await dashboardRoutes(app, db, undefined, client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/dashboard/overview' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bots[0].venue).toBe('');
    expect(body.bots[0].venueLabel).toBe('');
  });

  it('returns 503 when the boundary client is not configured', async () => {
    const db = makeLocalDb([[userRow], []]);
    const app = Fastify();
    decorateWithAuth(app);
    await dashboardRoutes(app, db, undefined); // no client

    const res = await app.inject({ method: 'GET', url: '/dashboard/overview' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toBe('precondition.not_ready');
  });
});

// ─── GET /dashboard/activity ─────────────────────────────────────────────────

describe('GET /dashboard/activity', () => {
  it('returns the normalised journal feed with hasMore', async () => {
    const events = [
      journalEvent,
      { ...journalEvent, id: 'e-2', type: 'decision.accepted', createdAt: earlierIso },
    ];
    const { client } = makeReadClient({
      bots: [bot1],
      venueAccounts: { 'va-1': va1Payload },
      events,
    });
    const db = makeLocalDb();
    const app = Fastify();
    decorateWithAuth(app);
    await dashboardRoutes(app, db, undefined, client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/dashboard/activity?limit=1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(1);
    // Newest-first: e-1 (nowIso) before e-2 (earlierIso).
    expect(body.events[0].id).toBe('e-1');
    expect(body.events[0].botId).toBe('bot-1');
    expect(body.events[0].instanceLabel).toBe('hyperliquid / Main');
    expect(body.events[0].messageKey).toBe('activity.order.filled');
    expect(body.events[0].category).toBe('execution');
    expect(body.events[0].timestamp).toBe(nowIso);
    expect(body.hasMore).toBe(true);
  });

  it('returns an empty feed when the user has no bots', async () => {
    const { client } = makeReadClient({ bots: [] });
    const db = makeLocalDb();
    const app = Fastify();
    decorateWithAuth(app);
    await dashboardRoutes(app, db, undefined, client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/dashboard/activity?limit=10' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  it('returns 503 when the boundary client is not configured', async () => {
    const db = makeLocalDb();
    const app = Fastify();
    decorateWithAuth(app);
    await dashboardRoutes(app, db, undefined); // no client

    const res = await app.inject({ method: 'GET', url: '/dashboard/activity?limit=10' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('precondition.not_ready');
  });
});

// ─── GET /dashboard/agent-activity (unchanged — platform-only) ───────────────

describe('GET /dashboard/agent-activity', () => {
  it('returns entries from platform reads without a boundary client', async () => {
    const newer = new Date('2026-06-11T12:05:00Z');
    // Platform reads: agents, then agentMessages, then agentRuntimeSessions.
    const db = makeLocalDb([
      [{ id: AGENT_ID, name: 'Agent A' }],
      [
        {
          id: 'msg-1',
          messageId: 'mid-1',
          correlationId: 'c-1',
          actorType: 'agent',
          actorId: AGENT_ID,
          agentId: AGENT_ID,
          botId: null,
          type: 'agent.send_message',
          direction: 'outbound',
          schemaVersion: 'v1',
          sequence: null,
          traceId: null,
          processingStatus: 'processed',
          errorDetail: null,
          createdAt: newer,
        },
      ],
      [],
    ]);
    const app = Fastify();
    decorateWithAuth(app);
    await dashboardRoutes(app, db); // no boundary client needed

    const res = await app.inject({ method: 'GET', url: '/dashboard/agent-activity?limit=10' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].id).toBe('msg-1');
    expect(body.entries[0].agentName).toBe('Agent A');
  });
});
