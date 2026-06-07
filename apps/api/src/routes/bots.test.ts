import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { PlansConfig } from '@herobids/domain';

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
  it('returns 403 when trading instance limit is reached', async () => {
    const { botRoutes } = await import('./bots.js');

    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

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
                  return Promise.resolve([{ id: 'binding-1', sourceVenueAccountId: 'va-1' }]);
                }
                return Promise.resolve([{ id: 'inst-1' }, { id: 'inst-2' }, { id: 'inst-3' }]);
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
        tradingBindingId: 'binding-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: validConfig,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('plan.limit_exceeded');
  });

  it('returns 201 and creates bot when under limit', async () => {
    const { botRoutes } = await import('./bots.js');

    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const createdBot = {
      id: 'new-bot-id',
      userId: TEST_USER_ID,
      venueAccountId: 'va-1',
      tradingBindingId: 'binding-1',
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
                  return Promise.resolve([{ id: 'binding-1', sourceVenueAccountId: 'va-1' }]);
                }
                return Promise.resolve([]);
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
        tradingBindingId: 'binding-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: validConfig,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.userId).toBe(TEST_USER_ID);
    expect(body.status).toBe('stopped');
    expect(body.tradingBindingId).toBe('binding-1');
  });

  it('returns 400 when both tradingBindingId and venueAccountId are provided', async () => {
    const { botRoutes } = await import('./bots.js');

    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const db = {
      transaction: vi.fn(),
    };

    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, 'free');
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        tradingBindingId: 'binding-1',
        venueAccountId: 'va-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: validConfig,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('returns 400 when a trading binding cannot supply a venue account id', async () => {
    const { botRoutes } = await import('./bots.js');

    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

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
                  return Promise.resolve([{ id: 'binding-1', sourceVenueAccountId: null }]);
                }
                return Promise.resolve([]);
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
        tradingBindingId: 'binding-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: validConfig,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('binding.missing_venue_account');
  });
});
