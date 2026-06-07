import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { PlansConfig } from '@herobids/domain';
// --- helpers ---

const TEST_USER_ID = 'user-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID, planId = 'free') {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = planId;
  });
}

function makePlansConfig(overrides: Partial<PlansConfig> = {}): PlansConfig {
  return {
    defaultPlanId: 'free',
    plans: {
      free: {
        maxPortfolios: 3,
        maxVenueAccounts: 5,
        maxCredentials: 5,
        maxTradingInstances: 3,
        maxConcurrentBacktests: 2,
        liveEnabled: false,
      },
      pro: {
        maxPortfolios: 10,
        maxVenueAccounts: 10,
        maxCredentials: 10,
        maxTradingInstances: 10,
        maxConcurrentBacktests: 10,
        liveEnabled: true,
      },
    },
    ...overrides,
  };
}

const validConfig = {
  strategy: {
    type: 'momentum',
    params: { symbol: 'BTC-PERP', intervalMs: 5000, lookbackPeriods: 14 },
  },
  risk: {},
  execution: { mode: 'paper' },
  venue: 'hyperliquid',
  symbol: 'BTC-PERP',
};

describe('bot routes', () => {
  describe('POST /bots — plan limit enforcement', () => {
    it('returns 403 when trading instance limit is reached', async () => {
      const { botRoutes } = await import('./bots.js');

      const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

      // DB mock: transaction callback receives a tx that:
      // - execute: advisory lock (resolves immediately)
      // - select call 1: venue account check → returns found
      // - select call 2 (inside checkBotLimit): returns 3 existing bots (at limit)
      const db = {
        transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
          let selectCallCount = 0;
          const tx = {
            execute: vi.fn().mockResolvedValue({ rows: [] }),
            select: vi.fn().mockReturnValue({
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockImplementation(() => {
                  selectCallCount++;
                  if (selectCallCount === 1) {
                    return Promise.resolve([{ id: 'va-1' }]); // venue account found
                  }
                  return Promise.resolve([{ id: 'inst-1' }, { id: 'inst-2' }, { id: 'inst-3' }]); // at limit
                }),
              }),
            }),
            insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
          };
          return callback(tx);
        }),
      };

      const app = Fastify();
      decorateWithAuth(app, TEST_USER_ID, 'free');
      await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, makePlansConfig());

      const res = await app.inject({
        method: 'POST',
        url: '/bots',
        payload: {
          venueAccountId: 'va-1',
          venue: 'hyperliquid',
          symbol: 'BTC-PERP',
          config: validConfig,
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('plan.limit_exceeded');
    });

    it('returns 201 and creates bot when under limit', async () => {
      const { botRoutes } = await import('./bots.js');

      const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
      const createdBot = {
        id: 'new-bot-id',
        userId: TEST_USER_ID,
        venueAccountId: 'va-1',
        config: validConfig,
        status: 'stopped',
        creatorType: 'user',
        creatorId: TEST_USER_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        stoppedAt: null,
      };

      const db = {
        transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
          let selectCallCount = 0;
          const tx = {
            execute: vi.fn().mockResolvedValue({ rows: [] }),
            select: vi.fn().mockReturnValue({
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockImplementation(() => {
                  selectCallCount++;
                  if (selectCallCount === 1) {
                    return Promise.resolve([{ id: 'va-1' }]); // venue account found
                  }
                  return Promise.resolve([]); // checkBotLimit: 0 bots, under limit
                }),
              }),
            }),
            insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
          };
          return callback(tx);
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([createdBot]),
          }),
        }),
      };

      const app = Fastify();
      decorateWithAuth(app, TEST_USER_ID, 'free');
      await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, makePlansConfig());

      const res = await app.inject({
        method: 'POST',
        url: '/bots',
        payload: {
          venueAccountId: 'va-1',
          venue: 'hyperliquid',
          symbol: 'BTC-PERP',
          config: validConfig,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.userId).toBe(TEST_USER_ID);
      expect(body.status).toBe('stopped');
    });
  });
});

describe('bot data surface stubs (012)', () => {
  const stubPaths = [
    '/bots/bot-1/costs',
    '/bots/bot-1/sessions',
    '/bots/bot-1/events',
    '/bots/bot-1/journal',
    '/bots/bot-1/journal/summary',
  ] as const;

  it.each(stubPaths.map((url) => ['GET', url] as [string, string]))(
    '%s %s returns 200 for owned bot',
    async (_method, url) => {
      const { botRoutes } = await import('./bots.js');
      const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

      // Build a fully-chainable mock that also resolves when awaited.
      // First select call is the ownership check (returns the bot); subsequent
      // calls are data queries that may chain .orderBy/.limit/.offset — return [].
      let selectCallCount = 0;
      const makeChain = (value: unknown[]) => {
        const chain: Record<string, unknown> = {};
        for (const m of ['from', 'where', 'orderBy', 'limit', 'offset', 'groupBy']) {
          chain[m] = vi.fn(() => chain);
        }
        (chain as { then: unknown }).then = (
          resolve: (v: unknown) => unknown,
          reject?: (v: unknown) => unknown,
        ) => Promise.resolve(value).then(resolve, reject);
        return chain;
      };
      const db = {
        select: vi.fn().mockImplementation(() => {
          selectCallCount++;
          return selectCallCount === 1 ? makeChain([{ id: 'bot-1' }]) : makeChain([]);
        }),
      };

      const app = Fastify();
      decorateWithAuth(app, TEST_USER_ID, 'free');
      await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database);

      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);

      // Response must contain the botId field and the correct shape key per endpoint.
      const body = res.json();
      expect(body.botId).toBe('bot-1');
      if (url.endsWith('/costs')) expect(body).toHaveProperty('feesByCurrency');
      if (url.endsWith('/sessions')) expect(body).toHaveProperty('sessions');
      if (url.endsWith('/events')) expect(body).toHaveProperty('events');
      if (url.endsWith('/journal') && !url.endsWith('/summary')) expect(body).toHaveProperty('events');
      if (url.endsWith('/summary')) { expect(body).toHaveProperty('tradeCount'); expect(body).toHaveProperty('feesByCurrency'); }
    },
  );

  it('GET /bots/:id/costs returns 404 for a bot owned by another user', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    // select returns no bot (different userId)
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
    const app = Fastify();
    decorateWithAuth(app, 'other-user', 'free');
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database);

    const res = await app.inject({ method: 'GET', url: '/bots/bot-1/costs' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /bots/:id/journal/summary returns grouped feesByCurrency', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    let selectCallCount = 0;
    const makeChain = (value: unknown[]) => {
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'orderBy', 'limit', 'offset', 'groupBy']) {
        chain[m] = vi.fn(() => chain);
      }
      (chain as { then: unknown }).then = (
        resolve: (v: unknown) => unknown,
        reject?: (v: unknown) => unknown,
      ) => Promise.resolve(value).then(resolve, reject);
      return chain;
    };
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return makeChain([{ id: 'bot-1' }]); // ownership
        if (selectCallCount === 2) return makeChain([{ tradeCount: 3 }]);  // count
        // feeRows: two currencies
        return makeChain([{ feeCurrency: 'USD', total: '1.5' }, { feeCurrency: 'SOL', total: '0.001' }]);
      }),
    };
    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, 'free');
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database);

    const res = await app.inject({ method: 'GET', url: '/bots/bot-1/journal/summary' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tradeCount).toBe(3);
    expect(body.feesByCurrency).toEqual({ USD: '1.5', SOL: '0.001' });
  });

  it.each(stubPaths.map((url) => ['GET', url] as [string, string]))(
    '%s %s returns 404 for unknown bot',
    async (_method, url) => {
      const { botRoutes } = await import('./bots.js');
      const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      };

      const app = Fastify();
      decorateWithAuth(app, TEST_USER_ID, 'free');
      await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database);

      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('not_found');
    },
  );
});
