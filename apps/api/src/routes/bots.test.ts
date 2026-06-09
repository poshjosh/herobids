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

  // Regression: bug 001 — test payloads used venueAccountId (old field) and the mock DB
  // returned { id } instead of { id, sourceVenueAccountId }. Both caused the route to fail.
  // This test verifies the bot's venueAccountId is sourced from the trading binding's
  // sourceVenueAccountId so the field mapping can never silently regress.
  it('maps sourceVenueAccountId from the trading binding to the created bot venueAccountId', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    let capturedBotInsert: Record<string, unknown> | undefined;
    const createdBot = {
      id: 'new-bot',
      userId: TEST_USER_ID,
      venueAccountId: 'va-42',
      tradingBindingId: 'binding-42',
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
        let selectCount = 0;
        const tx = {
          execute: vi.fn().mockResolvedValue({ rows: [] }),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockImplementation(() => {
                selectCount++;
                // First call: trading binding lookup — must return { id, sourceVenueAccountId }
                if (selectCount === 1) {
                  return Promise.resolve([{ id: 'binding-42', sourceVenueAccountId: 'va-42' }]);
                }
                // Subsequent calls: bot limit check — no existing bots
                return Promise.resolve([]);
              }),
            }),
          }),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
              capturedBotInsert = vals;
              return Promise.resolve(undefined);
            }),
          }),
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
        tradingBindingId: 'binding-42',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: validConfig,
      },
    });

    expect(res.statusCode).toBe(201);
    // Critical: venueAccountId in the INSERT must come from binding.sourceVenueAccountId
    expect(capturedBotInsert!['venueAccountId']).toBe('va-42');
    expect(capturedBotInsert!['tradingBindingId']).toBe('binding-42');
  });

  // Regression: bug 001 — when the DB returns an empty array for the binding lookup
  // (binding not found), the route must return 404, not a 500 TypeError on undefined.
  it('returns 404 when tradingBindingId references a nonexistent trading binding', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          execute: vi.fn().mockResolvedValue({ rows: [] }),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]), // no binding found
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
        tradingBindingId: 'nonexistent-binding',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: validConfig,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('not_found');
  });

  // Regression: bug 2026-06-09-004 — web client was sending venueAccountId
  // instead of tradingBindingId. The schema uses .strict() so any payload that
  // sends venueAccountId (with or without tradingBindingId) must be rejected
  // with 400 validation_error, never silently accepted.
  it('returns 400 validation_error when venueAccountId is sent instead of tradingBindingId (bug-2026-06-09-004 regression)', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const db = { transaction: vi.fn() };

    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, 'free');
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        venueAccountId: 'va-1',   // old field — must be rejected
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: validConfig,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('validation_error');
    // tradingBindingId must be present and missing from the payload triggers the error
    const issues = res.json<{ details: Array<{ path: string[] }> }>().details;
    expect(issues.some((issue) => issue.path.includes('tradingBindingId'))).toBe(true);
  });
});
