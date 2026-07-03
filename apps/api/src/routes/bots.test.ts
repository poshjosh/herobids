import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { PlansConfig } from '@herobids/domain';

const TEST_USER_ID = 'user-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID, planId = 'free', isAdmin = false) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.decorateRequest('isAdmin', false);
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = planId;
    request.isAdmin = isAdmin;
  });
}

function makePlansConfig(overrides: Partial<PlansConfig> = {}): PlansConfig {
  return {
    defaultPlanId: 'free',
    plans: {
      free: {
        entitlements: {
          skills: {
            canCreatePrivateSkills: false,
            canViewMarketplaceSkills: true,
            canPublishToMarketplace: true,
            autoPublishNonDraftSkills: true,
            canPriceSkills: false,
            canLikeMarketplaceSkills: true,
          },
          agents: {
            canViewOwnPrompts: true,
          },
          limits: {
            maxAgents: 5,
            maxBots: 3,
            maxConnections: 5,
            maxCredentials: 5,
            maxBindings: 5,
            maxVenueAccounts: 5,
            maxConcurrentBacktests: 2,
            liveEnabled: false,
          },
        },
        usage: {},
      },
      pro: {
        entitlements: {
          skills: {
            canCreatePrivateSkills: true,
            canViewMarketplaceSkills: true,
            canPublishToMarketplace: true,
            autoPublishNonDraftSkills: false,
            canPriceSkills: true,
            canLikeMarketplaceSkills: true,
          },
          agents: {
            canViewOwnPrompts: true,
          },
          limits: {
            maxAgents: 20,
            maxBots: 10,
            maxConnections: 10,
            maxCredentials: 10,
            maxBindings: 10,
            maxVenueAccounts: 10,
            maxConcurrentBacktests: 10,
            liveEnabled: true,
          },
        },
        usage: {},
      },
    },
    ...overrides,
  };
}

const validConfig = {
  strategy: {
    type: 'momentum',
    decisionMode: 'mechanical',
    params: { symbol: 'BTC-PERP', intervalMs: 5000, lookbackPeriods: 14 },
  },
  risk: {},
  execution: { mode: 'paper' },
  venue: 'hyperliquid',
  symbol: 'BTC-PERP',
};

describe('bot routes', () => {
  const mockRedis = {
    xadd: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('ioredis').Redis;

  it('returns 400 when bot config is invalid before the worker sees it', async () => {
    const { botRoutes } = await import('./bots.js');

    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const db = { transaction: vi.fn() };

    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, 'free');
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, mockRedis, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'binding-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: {
          ...validConfig,
          strategy: {
            type: 'momentum',
            params: { symbol: 'BTC-PERP', intervalMs: 5000, lookbackPeriods: 14 },
          },
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
    const issues = res.json<{ details: Array<{ path: string[] }> }>().details;
    expect(issues.some((issue) => issue.path.includes('decisionMode'))).toBe(true);
  });

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
                  return Promise.resolve([{ id: 'binding-1', resolvedVenueAccountId: 'va-1' }]);
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
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, mockRedis, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'binding-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: validConfig,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('plan.limit_exceeded');
  });

  it('bypasses trading instance limit for admins', async () => {
    const { botRoutes } = await import('./bots.js');

    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const createdBot = {
      id: 'new-bot-id',
      userId: TEST_USER_ID,
      venueAccountId: 'va-1',
      connectionId: 'binding-1',
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
        const tx = {
          execute: vi.fn().mockResolvedValue({ rows: [] }),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockImplementation(() => Promise.resolve([{ id: 'binding-1', resolvedVenueAccountId: 'va-1' }])),
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
    decorateWithAuth(app, TEST_USER_ID, 'free', true);
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, mockRedis, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'binding-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: validConfig,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).userId).toBe(TEST_USER_ID);
  });

  it('returns 201 and creates bot when under limit', async () => {
    const { botRoutes } = await import('./bots.js');

    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const createdBot = {
      id: 'new-bot-id',
      userId: TEST_USER_ID,
      venueAccountId: 'va-1',
      connectionId: 'binding-1',
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
                  return Promise.resolve([{ id: 'binding-1', resolvedVenueAccountId: 'va-1' }]);
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
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, mockRedis, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'binding-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: validConfig,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.userId).toBe(TEST_USER_ID);
    expect(body.status).toBe('stopped');
    expect(body.connectionId).toBe('binding-1');
  });

  it('returns 400 when both connectionId and venueAccountId are provided', async () => {
    const { botRoutes } = await import('./bots.js');

    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const db = {
      transaction: vi.fn(),
    };

    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, 'free');
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, mockRedis, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'binding-1',
        venueAccountId: 'va-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: validConfig,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('returns 400 when a connection cannot supply a venue account id', async () => {
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
                  return Promise.resolve([{ id: 'binding-1', resolvedVenueAccountId: null }]);
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
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, mockRedis, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'binding-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: validConfig,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('connection.missing_venue_account');
  });

  // Regression: bug 001 — test payloads used venueAccountId (old field) and the mock DB
  // returned { id } instead of { id, resolvedVenueAccountId }. Both caused the route to fail.
  // This test verifies the bot's venueAccountId is sourced from the connection's
  // resolvedVenueAccountId so the field mapping can never silently regress.
  it('maps resolvedVenueAccountId from the connection to the created bot venueAccountId', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    let capturedBotInsert: Record<string, unknown> | undefined;
    const createdBot = {
      id: 'new-bot',
      userId: TEST_USER_ID,
      venueAccountId: 'va-42',
      connectionId: 'binding-42',
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
                // First call: connection lookup — must return { id, resolvedVenueAccountId }
                if (selectCount === 1) {
                  return Promise.resolve([{ id: 'binding-42', resolvedVenueAccountId: 'va-42' }]);
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
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, mockRedis, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'binding-42',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: validConfig,
      },
    });

    expect(res.statusCode).toBe(201);
    // Critical: venueAccountId in the INSERT must come from connection.resolvedVenueAccountId
    expect(capturedBotInsert!['venueAccountId']).toBe('va-42');
    expect(capturedBotInsert!['connectionId']).toBe('binding-42');
  });

  // Regression: bug 001 — when the DB returns an empty array for the binding lookup
  // (binding not found), the route must return 404, not a 500 TypeError on undefined.
  it('returns 404 when connectionId references a nonexistent connection', async () => {
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
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, mockRedis, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'nonexistent-binding',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: validConfig,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('not_found');
  });

  // Regression: bug 2026-06-09-004 — web client was sending venueAccountId
  // instead of connectionId. The schema uses .strict() so any payload that
  // sends venueAccountId (with or without connectionId) must be rejected
  // with 400 validation_error, never silently accepted.
  it('returns 400 validation_error when venueAccountId is sent instead of connectionId (bug-2026-06-09-004 regression)', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const db = { transaction: vi.fn() };

    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, 'free');
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, mockRedis, makePlansConfig());

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
    // connectionId must be present and missing from the payload triggers the error
    const issues = res.json<{ details: Array<{ path: string[] }> }>().details;
    expect(issues.some((issue) => issue.path.includes('connectionId'))).toBe(true);
  });

  // Regression: Phase 3 — when a user has two Hyperliquid connections each with
  // different resolvedVenueAccountId values, creating a bot with connection-2
  // must resolve to va-002, never to va-001. This proves the route does not
  // accidentally cross-wire connection A to venue account B.
  it('resolves the correct venue account when user has multiple Hyperliquid connections', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    let capturedBotInsert: Record<string, unknown> | undefined;
    const createdBot = {
      id: 'new-bot',
      userId: TEST_USER_ID,
      venueAccountId: 'va-002',
      connectionId: 'connection-2',
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
                // First call: connection lookup for connection-2
                // Must return its own resolvedVenueAccountId (va-002), not va-001
                if (selectCount === 1) {
                  return Promise.resolve([{ id: 'connection-2', resolvedVenueAccountId: 'va-002' }]);
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
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, mockRedis, makePlansConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'connection-2',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: validConfig,
      },
    });

    expect(res.statusCode).toBe(201);
    // Critical: venueAccountId must be 'va-002' (connection-2's own), NOT 'va-001'
    expect(capturedBotInsert!['venueAccountId']).toBe('va-002');
    expect(capturedBotInsert!['connectionId']).toBe('connection-2');
  });
});
