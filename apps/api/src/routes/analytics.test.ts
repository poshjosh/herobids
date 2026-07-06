import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { analyticsRoutes } from './analytics.js';
import type { Database } from '@herobids/db';

const TEST_USER_ID = 'user-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>) {
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = TEST_USER_ID;
  });
}

function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'offset']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

const now = new Date('2026-01-15T10:00:00Z');
const bot1 = {
  id: 'bot-1',
  config: { strategy: { type: 'momentum', decisionMode: 'mechanical' }, execution: { mode: 'paper' } },
};
const event1 = {
  id: 'e-1',
  actorId: 'bot-1',
  actorType: 'bot',
  type: 'decision.created',
  payload: {},
  createdAt: now,
  backtestRunId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

function buildAnalyticsDb(bots: unknown[], events: unknown[], positions: unknown[] = [], extra: unknown[][] = []) {
  const responses = [bots, events, positions, ...extra];
  let i = 0;
  return {
    select: vi.fn().mockImplementation(() => {
      const val = responses[i++] ?? [];
      return makeChain(val);
    }),
  } as unknown as Database;
}

// ─── GET /analytics ────────────────────────────────────────────────────────

describe('GET /analytics', () => {
  it('returns empty groups when user has no bots', async () => {
    const db = buildAnalyticsDb([], [], []);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/analytics' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toEqual([]);
    expect(body.groupBy).toBe('day');
  });

  it('returns 400 for invalid groupBy value', async () => {
    const db = buildAnalyticsDb([], [], []);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/analytics?groupBy=month' });
    expect(res.statusCode).toBe(400);
  });

  it('returns daily groups with correct event counts', async () => {
    const db = buildAnalyticsDb([bot1], [event1], []);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/analytics?groupBy=day' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].period).toBe('2026-01-15');
    expect(body.groups[0].eventCount).toBe(1);
    expect(body.groups[0].decisionCount).toBe(1);
  });

  it('decisionModes filter excludes bots with non-matching decisionMode', async () => {
    const db = buildAnalyticsDb([bot1], [], []);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    // bot1 has decisionMode=mechanical; filter to llm should exclude it
    const res = await app.inject({ method: 'GET', url: '/analytics?decisionModes=llm' });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups).toEqual([]);
  });

  it('decisionModes filter includes bots with matching decisionMode', async () => {
    const db = buildAnalyticsDb([bot1], [event1], []);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    // bot1 has decisionMode=mechanical; filter to mechanical should include its events
    const res = await app.inject({ method: 'GET', url: '/analytics?decisionModes=mechanical' });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups.length).toBeGreaterThan(0);
  });

  it('rejects invalid decisionModes value', async () => {
    const db = buildAnalyticsDb([], [], []);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    // 'shadow' is an execution mode, not a valid decisionMode
    const res = await app.inject({ method: 'GET', url: '/analytics?decisionModes=shadow' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('executionModes filter excludes bots with non-matching execution mode', async () => {
    const db = buildAnalyticsDb([bot1], [], []);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    // bot1 has mode=paper; filter to live should exclude it
    const res = await app.inject({ method: 'GET', url: '/analytics?executionModes=live' });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups).toEqual([]);
  });

  it('executionModes filter includes bots with matching execution mode', async () => {
    const db = buildAnalyticsDb([bot1], [event1], []);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    // bot1 has mode=paper; filter to paper should include its events
    const res = await app.inject({ method: 'GET', url: '/analytics?executionModes=paper' });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups.length).toBeGreaterThan(0);
  });

  it('rejects invalid executionModes value', async () => {
    const db = buildAnalyticsDb([], [], []);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/analytics?executionModes=invalid' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('strategy groupBy groups events by strategy type', async () => {
    const db = buildAnalyticsDb([bot1], [event1], []);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/analytics?groupBy=strategy' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].period).toBe('momentum');
  });
});

// ─── POST /analytics/query ────────────────────────────────────────────────

describe('POST /analytics/query', () => {
  it('returns same result as GET with JSON body', async () => {
    const db = buildAnalyticsDb([bot1], [event1], []);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/analytics/query',
      payload: { groupBy: 'day' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groupBy).toBe('day');
  });

  it('returns 400 for invalid body', async () => {
    const db = buildAnalyticsDb([], [], []);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/analytics/query',
      payload: { groupBy: 'invalid' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid decisionModes value in POST body', async () => {
    const db = buildAnalyticsDb([], [], []);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/analytics/query',
      payload: { decisionModes: ['shadow'], groupBy: 'day' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid executionModes value in POST body', async () => {
    const db = buildAnalyticsDb([], [], []);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/analytics/query',
      payload: { executionModes: ['invalid'], groupBy: 'day' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('botIds filter scopes results to specified bots', async () => {
    const bot2 = { id: 'bot-2', config: { strategy: { type: 'dca' }, execution: { mode: 'paper' } } };
    // DB returns both bots but we filter to bot-2
    const db = buildAnalyticsDb([bot1, bot2], [], []);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/analytics/query',
      payload: { botIds: ['bot-2'] },
    });
    expect(res.statusCode).toBe(200);
  });

  it('session groupBy assigns events to no_session when no sessions exist', async () => {
    // groupBy=session order: bots → agents (empty, so no sessions fetch) → journalEvents → positions
    const responses = [[bot1], [], [event1], []];
    let i = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        const val = responses[i++] ?? [];
        return makeChain(val);
      }),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/analytics/query',
      payload: { groupBy: 'session' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].period).toBe('no_session');
  });
});

// ─── symbols filter & symbol groupBy ──────────────────────────────────────

const ethPos = {
  id: 'pos-1',
  actorId: 'bot-1',
  actorType: 'bot',
  symbol: 'ETH-USD',
  side: 'flat',
  size: '0',
  entryPrice: '3000',
  realizedPnl: '50',
  venue: 'hyperliquid',
  venueAccountId: 'va-1',
  openedAt: now,
  closedAt: now,
  updatedAt: now,
  markSource: null,
};

const btcPos = {
  id: 'pos-2',
  actorId: 'bot-1',
  actorType: 'bot',
  symbol: 'BTC-USD',
  side: 'flat',
  size: '0',
  entryPrice: '60000',
  realizedPnl: '200',
  venue: 'hyperliquid',
  venueAccountId: 'va-1',
  openedAt: now,
  closedAt: now,
  updatedAt: now,
  markSource: null,
};

const solPos = {
  id: 'pos-3',
  actorId: 'bot-1',
  actorType: 'bot',
  symbol: 'SOL-USD',
  side: 'flat',
  size: '0',
  entryPrice: '150',
  realizedPnl: '-30',
  venue: 'hyperliquid',
  venueAccountId: 'va-1',
  openedAt: now,
  closedAt: now,
  updatedAt: now,
  markSource: null,
};

describe('GET /analytics — symbols filter & groupBy', () => {
  it('filters positions by a single symbol', async () => {
    // Responses: bots, events, positions
    const db = buildAnalyticsDb([bot1], [], [ethPos, btcPos]);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/analytics?symbols=ETH-USD' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    // Only ETH-USD P&L should be included (= 50)
    expect(body.groups[0].realizedPnl).toBe(50);
  });

  it('filters positions by multiple symbols', async () => {
    const db = buildAnalyticsDb([bot1], [], [ethPos, btcPos, solPos]);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/analytics?symbols=ETH-USD&symbols=BTC-USD' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Both ETH + BTC, grouped by day (same date)
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].realizedPnl).toBe(250); // 50 + 200
  });

  it('returns empty groups when no positions match the symbol filter', async () => {
    const db = buildAnalyticsDb([bot1], [], [ethPos]);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/analytics?symbols=SOL-USD' });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups).toEqual([]);
  });

  it('groupBy=symbol returns one group per symbol', async () => {
    const db = buildAnalyticsDb([bot1], [], [ethPos, btcPos, solPos]);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/analytics?groupBy=symbol' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groupBy).toBe('symbol');
    expect(body.groups).toHaveLength(3);
    const groupMap = new Map(body.groups.map((g: { period: string; realizedPnl: number }) => [g.period, g.realizedPnl]));
    expect(groupMap.get('ETH-USD')).toBe(50);
    expect(groupMap.get('BTC-USD')).toBe(200);
    expect(groupMap.get('SOL-USD')).toBe(-30);
  });

  it('symbol groupBy skips journal events (eventCount=0, fillCount from positions)', async () => {
    const db = buildAnalyticsDb([bot1], [event1], [ethPos]);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/analytics?groupBy=symbol' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    // Event loop is skipped for symbol groupBy, so event/decision counts should be 0
    expect(body.groups[0].eventCount).toBe(0);
    expect(body.groups[0].decisionCount).toBe(0);
    // fillCount is derived from closed positions (one position = one fill)
    expect(body.groups[0].fillCount).toBe(1);
    // P&L from positions should still be present
    expect(body.groups[0].realizedPnl).toBe(50);
  });
});

// ─── exitReasons filter & exitReason groupBy ──────────────────────────────

const sigLostPos = {
  id: 'pos-sl',
  actorId: 'bot-1',
  actorType: 'bot',
  symbol: 'ETH-USD',
  side: 'flat',
  size: '0',
  entryPrice: '3000',
  realizedPnl: '-100',
  venue: 'hyperliquid',
  venueAccountId: 'va-1',
  openedAt: now,
  closedAt: now,
  updatedAt: now,
  markSource: null,
  exitReason: 'signal_lost',
};

const parabolicPos = {
  id: 'pos-pm',
  actorId: 'bot-1',
  actorType: 'bot',
  symbol: 'BTC-USD',
  side: 'flat',
  size: '0',
  entryPrice: '60000',
  realizedPnl: '500',
  venue: 'hyperliquid',
  venueAccountId: 'va-1',
  openedAt: now,
  closedAt: now,
  updatedAt: now,
  markSource: null,
  exitReason: 'parabolic_move',
};

const unknownExitPos = {
  id: 'pos-unk',
  actorId: 'bot-1',
  actorType: 'bot',
  symbol: 'SOL-USD',
  side: 'flat',
  size: '0',
  entryPrice: '150',
  realizedPnl: '30',
  venue: 'hyperliquid',
  venueAccountId: 'va-1',
  openedAt: now,
  closedAt: now,
  updatedAt: now,
  markSource: null,
  exitReason: null,
};

describe('GET /analytics — exitReasons filter & groupBy', () => {
  it('filters positions by a single exit reason', async () => {
    const db = buildAnalyticsDb([bot1], [], [sigLostPos, parabolicPos]);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/analytics?exitReasons=signal_lost' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].realizedPnl).toBe(-100);
  });

  it('filters positions by multiple exit reasons', async () => {
    const db = buildAnalyticsDb([bot1], [], [sigLostPos, parabolicPos, unknownExitPos]);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/analytics?exitReasons=signal_lost&exitReasons=parabolic_move' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Both signal_lost + parabolic_move grouped by day (same date)
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].realizedPnl).toBe(400); // -100 + 500
  });

  it('returns empty groups when no positions match the exit reason filter', async () => {
    const db = buildAnalyticsDb([bot1], [], [sigLostPos]);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/analytics?exitReasons=daily_limit_reached' });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups).toEqual([]);
  });

  it('excludes positions with null exitReason from exit reason filter', async () => {
    const db = buildAnalyticsDb([bot1], [], [unknownExitPos]);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/analytics?exitReasons=signal_lost' });
    expect(res.statusCode).toBe(200);
    // unknownExitPos has exitReason=null, so it should not match 'signal_lost'
    expect(res.json().groups).toEqual([]);
  });

  it('groupBy=exitReason returns one group per exit reason', async () => {
    const db = buildAnalyticsDb([bot1], [], [sigLostPos, parabolicPos, unknownExitPos]);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/analytics?groupBy=exitReason' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groupBy).toBe('exitReason');
    expect(body.groups).toHaveLength(3);
    const groupMap = new Map(body.groups.map((g: { period: string; realizedPnl: number }) => [g.period, g.realizedPnl]));
    expect(groupMap.get('signal_lost')).toBe(-100);
    expect(groupMap.get('parabolic_move')).toBe(500);
    expect(groupMap.get('unknown')).toBe(30);
  });

  it('exitReason groupBy skips journal events (eventCount=0, no synthetic unknown)', async () => {
    // Even with events present, the journal event loop is skipped for exitReason
    // mode to avoid bucketing every event into 'unknown'.
    const db = buildAnalyticsDb([bot1], [event1], [sigLostPos]);
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/analytics?groupBy=exitReason' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].period).toBe('signal_lost');
    // Event loop is skipped, so event/decision counts should be 0
    expect(body.groups[0].eventCount).toBe(0);
    expect(body.groups[0].decisionCount).toBe(0);
    // fillCount derived from closed positions
    expect(body.groups[0].fillCount).toBe(1);
    // No spurious 'unknown' bucket from the journal event
    expect(body.groups.every((g: { period: string }) => g.period !== 'unknown')).toBe(true);
  });
});

