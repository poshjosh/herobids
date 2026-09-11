import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { PlansConfig } from '@herobids/domain';
import type { TradertonClient, TradertonClientResult } from '@herobids/domain/traderton';

const TEST_USER_ID = 'user-1';

/**
 * L3c: a stubbed TradertonClient. POST/stop/start/adjust now route bot side
 * effects over this boundary instead of a local bots-table write + lifecycle
 * queue. The stub records invoke calls so tests can assert toolName + subject +
 * payload, and returns a scripted client result.
 */
function makeTradertonClient(
  result: TradertonClientResult = { kind: 'success', requestId: 'r', correlationId: 'c', payload: { id: 'bot-1', status: 'stopped', userId: TEST_USER_ID, connectionId: 'binding-1' } },
): { client: TradertonClient; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn().mockResolvedValue(result);
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

/**
 * Build a db mock whose `select().from().where()` resolves the connection
 * ownership lookup (the only db read POST /bots still performs). `connectionRows`
 * is what the connection lookup returns ([] → 404).
 */
function makeCreateDb(connectionRows: Array<Record<string, unknown>>) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(connectionRows),
      }),
    }),
  } as unknown as import('@herobids/db').Database;
}

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

  it('forwards trading-config validation to the boundary (no client-side BotConfigSchema 400)', async () => {
    // L3c: BotConfigSchema validation MOVED behind the boundary. A config that
    // the old route rejected (missing decisionMode) is now forwarded verbatim —
    // Traderton's create_bot owns the trading-config validation. The route only
    // still runs the CreateInstanceSchema envelope check + the plan/ownership gates.
    const { botRoutes } = await import('./bots.js');

    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const db = makeCreateDb([{ id: 'binding-1', resolvedVenueAccountId: 'va-1' }]);
    const { client, invoke } = makeTradertonClient();

    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, 'free');
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig(), undefined, client);

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

    // No client-side validation_error — the create is forwarded to the boundary.
    expect(res.statusCode).toBe(201);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0].toolName).toBe('create_bot');
  });

  it('no longer enforces the maxBots limit client-side — Traderton owns the limit', async () => {
    // Previously the route rejected with plan.limit_exceeded once maxBots was
    // reached. That limit now lives behind the boundary; the route forwards
    // regardless and lets Traderton own acceptance.
    const { botRoutes } = await import('./bots.js');

    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const db = makeCreateDb([{ id: 'binding-1', resolvedVenueAccountId: 'va-1' }]);
    const { client, invoke } = makeTradertonClient();

    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, 'free');
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig(), undefined, client);

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

    // The create succeeds regardless of how many bots the user already has.
    expect(res.statusCode).toBe(201);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0].toolName).toBe('create_bot');
  });

  it('creates a bot for an admin without any client-side limit gate', async () => {
    const { botRoutes } = await import('./bots.js');

    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const db = makeCreateDb([{ id: 'binding-1', resolvedVenueAccountId: 'va-1' }]);
    const { client } = makeTradertonClient();

    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, 'free', true);
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig(), undefined, client);

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
    // The 201 body is the boundary payload verbatim.
    expect(JSON.parse(res.body).userId).toBe(TEST_USER_ID);
  });

  it('returns 201 with the boundary payload and forwards create_bot with a user subject', async () => {
    const { botRoutes } = await import('./bots.js');

    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const db = makeCreateDb([{ id: 'binding-1', resolvedVenueAccountId: 'va-1' }]);
    const { client, invoke } = makeTradertonClient({
      kind: 'success', requestId: 'r', correlationId: 'c',
      payload: { id: 'new-bot-id', status: 'stopped', userId: TEST_USER_ID, connectionId: 'binding-1' },
    });

    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, 'free');
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig(), undefined, client);

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

    // The boundary was invoked with create_bot + a platform-owned user subject.
    expect(invoke).toHaveBeenCalledTimes(1);
    const arg = invoke.mock.calls[0]![0];
    expect(arg.toolName).toBe('create_bot');
    expect(arg.subject).toEqual({ ownerId: TEST_USER_ID, actor: { type: 'user', id: TEST_USER_ID } });
    expect(arg.payload.connectionId).toBe('binding-1');
    // No local bots insert / no venueAccountId stamped into the payload.
    expect(arg.payload).not.toHaveProperty('venueAccountId');
    expect(db.transaction).toBeUndefined();
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

  it('forwards to the boundary even when the connection has no resolved venue account (Traderton resolves the account)', async () => {
    // L3c: venue-account resolution MOVED behind the boundary — Traderton resolves
    // the account from the subject. The route no longer rejects a connection with a
    // null resolvedVenueAccountId; it forwards the connectionId and lets Traderton
    // own account resolution.
    const { botRoutes } = await import('./bots.js');

    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const db = makeCreateDb([{ id: 'binding-1', resolvedVenueAccountId: null }]);
    const { client, invoke } = makeTradertonClient();

    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, 'free');
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig(), undefined, client);

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
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0].payload.connectionId).toBe('binding-1');
  });

  // L3c: the route no longer writes a bots row nor stamps a venueAccountId — it
  // forwards the connectionId to the boundary and Traderton resolves the account
  // from the subject. This proves the connectionId is forwarded and NO venue
  // account is injected client-side.
  it('forwards the connectionId to the boundary and injects no venueAccountId', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    const db = makeCreateDb([{ id: 'binding-42', resolvedVenueAccountId: 'va-42' }]);
    const { client, invoke } = makeTradertonClient({
      kind: 'success', requestId: 'r', correlationId: 'c',
      payload: { id: 'new-bot', status: 'stopped', userId: TEST_USER_ID, connectionId: 'binding-42' },
    });

    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, 'free');
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig(), undefined, client);

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
    const arg = invoke.mock.calls[0]![0];
    expect(arg.toolName).toBe('create_bot');
    expect(arg.payload.connectionId).toBe('binding-42');
    // No venueAccountId is stamped into the payload — Traderton owns resolution.
    expect(arg.payload).not.toHaveProperty('venueAccountId');
    expect(arg.subject).toEqual({ ownerId: TEST_USER_ID, actor: { type: 'user', id: TEST_USER_ID } });
  });

  // Connection-ownership is a herobids-side authz gate (KEPT). An unknown/unowned
  // connectionId must 404 BEFORE the boundary is touched.
  it('returns 404 when connectionId references a nonexistent connection — boundary NOT called', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    const db = makeCreateDb([]); // no connection found
    const { client, invoke } = makeTradertonClient();

    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, 'free');
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig(), undefined, client);

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
    expect(invoke).not.toHaveBeenCalled();
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

  // When a user has multiple connections, the route must forward the SPECIFIC
  // connectionId the caller chose (connection-2), never cross-wire to another.
  // Account resolution itself now happens behind the boundary from the subject.
  it('forwards the specific connectionId chosen by the caller (no cross-wiring)', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    const db = makeCreateDb([{ id: 'connection-2', resolvedVenueAccountId: 'va-002' }]);
    const { client, invoke } = makeTradertonClient({
      kind: 'success', requestId: 'r', correlationId: 'c',
      payload: { id: 'new-bot', status: 'stopped', userId: TEST_USER_ID, connectionId: 'connection-2' },
    });

    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, 'free');
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig(), undefined, client);

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
    const arg = invoke.mock.calls[0]![0];
    // Critical: the forwarded connectionId is connection-2 (the caller's choice).
    expect(arg.payload.connectionId).toBe('connection-2');
    expect(arg.payload).not.toHaveProperty('venueAccountId');
  });

  it('returns 503 when no trading boundary is configured (no silent local fallback)', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    const db = makeCreateDb([{ id: 'binding-1', resolvedVenueAccountId: 'va-1' }]);

    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, 'free');
    // No tradertonClient passed → the boundary is unconfigured.
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig());

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

    expect(res.statusCode).toBe(503);
  });
});
