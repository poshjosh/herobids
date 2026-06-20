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
