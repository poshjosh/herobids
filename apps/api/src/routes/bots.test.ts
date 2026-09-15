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
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig(), client);

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
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig(), client);

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
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig(), client);

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
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig(), client);

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
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig(), client);

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
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig(), client);

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
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig(), client);

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
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, makePlansConfig(), client);

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

/**
 * Boundary-only reads + lifecycle/config writes (ruling 1 + Wave A1/A2).
 *
 * The `bots` table is no longer read/written by these routes: reads route over
 * the owner-scoped boundary tools and the DELETE/PATCH writes are authoritative
 * on the boundary. When the boundary is ABSENT the routes fail closed with a
 * typed 503 precondition.not_ready (no local-table fallback). These tests stub
 * the boundary client instead of the local db.
 */
describe('bot read + lifecycle routes route over the boundary (no local bots table)', () => {
  const mockRedis = {
    xadd: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('ioredis').Redis;

  // A db mock that throws if any `.select().from()` is attempted — proves the
  // routes never touch the local `bots` table on these paths.
  function makeNoTableDb() {
    return {
      select: vi.fn(() => {
        throw new Error('local table access is not allowed on boundary-routed paths');
      }),
      update: vi.fn(() => {
        throw new Error('local bots update is not allowed');
      }),
      delete: vi.fn(() => {
        throw new Error('local bots delete is not allowed');
      }),
    } as unknown as import('@herobids/db').Database;
  }

  // PATCH no longer reads connections.provider locally — the venue type is
  // derived from the boundary-supplied config.venue — so the no-table db mock
  // above suffices for PATCH too.

  const mockQueue = {
    add: vi.fn().mockResolvedValue(undefined),
    getJobs: vi.fn().mockResolvedValue([]),
  } as unknown as import('bullmq').Queue;

  /**
   * A boundary client whose invoke dispatches a scripted result per toolName,
   * defaulting to a generic success. Records calls for assertions.
   */
  function makeToolClient(perTool: Partial<Record<string, TradertonClientResult>> = {}) {
    const invoke = vi.fn(async (arg: { toolName: string }) => {
      return perTool[arg.toolName] ?? { kind: 'success', requestId: 'r', correlationId: 'c', payload: {} };
    });
    return { client: { invoke } as unknown as TradertonClient, invoke };
  }

  const statusPayload = (overrides: Record<string, unknown> = {}) => ({
    kind: 'success' as const,
    requestId: 'r',
    correlationId: 'c',
    payload: {
      ok: true,
      id: 'bot-1',
      status: 'stopped',
      config: { venue: 'hyperliquid', symbol: 'BTC-PERP', execution: { mode: 'paper' } },
      creatorType: 'user',
      creatorId: TEST_USER_ID,
      ...overrides,
    },
  });

  async function buildApp(client?: TradertonClient, planId = 'free') {
    const { botRoutes } = await import('./bots.js');
    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, planId);
    await botRoutes(app, mockQueue, makeNoTableDb(), mockRedis, makePlansConfig(), client);
    return app;
  }

  // ── GET /bots ──────────────────────────────────────────────────────────
  it('GET /bots lists via list_owner_bots and never reads the local table', async () => {
    const { client, invoke } = makeToolClient({
      list_owner_bots: { kind: 'success', requestId: 'r', correlationId: 'c', payload: { bots: [{ id: 'bot-1' }] } },
    });
    const app = await buildApp(client);
    const res = await app.inject({ method: 'GET', url: '/bots' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ bots: unknown[] }>().bots).toEqual([{ id: 'bot-1' }]);
    expect(invoke.mock.calls[0]![0].toolName).toBe('list_owner_bots');
  });

  it('GET /bots returns 503 when the boundary is absent (no local fallback)', async () => {
    const app = await buildApp(undefined);
    const res = await app.inject({ method: 'GET', url: '/bots' });
    expect(res.statusCode).toBe(503);
  });

  // ── GET /bots/:id ────────────────────────────────────────────────────────
  it('GET /bots/:id maps boundary not_found to 404', async () => {
    const { client } = makeToolClient({
      get_owner_bot_status: { kind: 'failure', code: 'not_found.resource', message: 'nope', retryable: false, requestId: 'r' } as unknown as TradertonClientResult,
    });
    const app = await buildApp(client);
    const res = await app.inject({ method: 'GET', url: '/bots/bot-1' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /bots/:id returns 503 when the boundary is absent', async () => {
    const app = await buildApp(undefined);
    const res = await app.inject({ method: 'GET', url: '/bots/bot-1' });
    expect(res.statusCode).toBe(503);
  });

  // ── GET /bots/:id/costs|sessions|events|journal|journal/summary ────────────
  it('GET read aggregations return 503 when the boundary is absent', async () => {
    const app = await buildApp(undefined);
    for (const url of [
      '/bots/bot-1/costs',
      '/bots/bot-1/sessions',
      '/bots/bot-1/events',
      '/bots/bot-1/journal',
      '/bots/bot-1/journal/summary',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(503);
    }
  });

  it('GET /bots/:id/costs passes the boundary payload through', async () => {
    const { client } = makeToolClient({
      get_owner_bot_costs: { kind: 'success', requestId: 'r', correlationId: 'c', payload: { feesByCurrency: { USDC: '1.5' } } },
    });
    const app = await buildApp(client);
    const res = await app.inject({ method: 'GET', url: '/bots/bot-1/costs' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ feesByCurrency: Record<string, string> }>().feesByCurrency).toEqual({ USDC: '1.5' });
  });

  // ── PATCH /bots/:id/config ────────────────────────────────────────────────
  it('PATCH /bots/:id/config reads status via get_owner_bot_status then always calls adjust_bot_config (even when stopped)', async () => {
    const { client, invoke } = makeToolClient({
      get_owner_bot_status: statusPayload({ status: 'stopped' }),
    });
    const app = await buildApp(client);
    const res = await app.inject({
      method: 'PATCH',
      url: '/bots/bot-1/config',
      payload: { config: { venue: 'hyperliquid', symbol: 'BTC-PERP', execution: { mode: 'paper' } } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('updated');
    const tools = invoke.mock.calls.map((c) => c[0].toolName);
    expect(tools).toContain('get_owner_bot_status');
    // The write is unconditional now — adjust runs for a STOPPED bot too.
    expect(tools).toContain('adjust_bot_config');
  });

  it('PATCH /bots/:id/config maps boundary not_found to 404', async () => {
    const { client } = makeToolClient({
      get_owner_bot_status: { kind: 'failure', code: 'not_found.resource', message: 'nope', retryable: false, requestId: 'r' } as unknown as TradertonClientResult,
    });
    const app = await buildApp(client);
    const res = await app.inject({
      method: 'PATCH',
      url: '/bots/bot-1/config',
      payload: { config: { execution: { mode: 'paper' } } },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH /bots/:id/config returns 503 when the boundary is absent', async () => {
    const app = await buildApp(undefined);
    const res = await app.inject({
      method: 'PATCH',
      url: '/bots/bot-1/config',
      payload: { config: { execution: { mode: 'paper' } } },
    });
    expect(res.statusCode).toBe(503);
  });

  it('PATCH /bots/:id/config notifies the agent via xadd when an agent-created bot changes execution mode', async () => {
    const xadd = vi.fn().mockResolvedValue(undefined);
    const redis = { xadd } as unknown as import('ioredis').Redis;
    const { client } = makeToolClient({
      get_owner_bot_status: statusPayload({
        status: 'running',
        creatorType: 'agent',
        creatorId: 'agent-9',
        config: { venue: 'hyperliquid', symbol: 'BTC-PERP', execution: { mode: 'paper' } },
      }),
    });
    const { botRoutes } = await import('./bots.js');
    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID, 'pro');
    await botRoutes(app, mockQueue, makeNoTableDb(), redis, makePlansConfig(), client);
    const res = await app.inject({
      method: 'PATCH',
      url: '/bots/bot-1/config',
      payload: { config: { venue: 'hyperliquid', symbol: 'BTC-PERP', execution: { mode: 'live' } } },
    });
    expect(res.statusCode).toBe(200);
    expect(xadd).toHaveBeenCalledTimes(1);
    const streamKey = xadd.mock.calls[0]![0];
    expect(streamKey).toBe('agent:inbound:agent-9');
  });

  // ── DELETE /bots/:id ──────────────────────────────────────────────────────
  it('DELETE /bots/:id routes over the boundary and performs no local delete', async () => {
    const { client, invoke } = makeToolClient({
      get_owner_bot_status: statusPayload({ status: 'stopped' }),
      delete_bot: { kind: 'success', requestId: 'r', correlationId: 'c', payload: {} },
    });
    const app = await buildApp(client);
    const res = await app.inject({ method: 'DELETE', url: '/bots/bot-1' });
    expect(res.statusCode).toBe(204);
    const tools = invoke.mock.calls.map((c) => c[0].toolName);
    expect(tools).toContain('delete_bot');
  });

  it('DELETE /bots/:id returns 409 for a running bot', async () => {
    const { client } = makeToolClient({
      get_owner_bot_status: statusPayload({ status: 'running' }),
    });
    const app = await buildApp(client);
    const res = await app.inject({ method: 'DELETE', url: '/bots/bot-1' });
    expect(res.statusCode).toBe(409);
  });

  it('DELETE /bots/:id returns 503 when the boundary is absent', async () => {
    const app = await buildApp(undefined);
    const res = await app.inject({ method: 'DELETE', url: '/bots/bot-1' });
    expect(res.statusCode).toBe(503);
  });

  // ── POST /bots/:id/blueprints ─────────────────────────────────────────────
  it('POST /bots/:id/blueprints reads the bot config via get_owner_bot_status and 404s on boundary not_found', async () => {
    const { client } = makeToolClient({
      get_owner_bot_status: { kind: 'failure', code: 'not_found.resource', message: 'nope', retryable: false, requestId: 'r' } as unknown as TradertonClientResult,
    });
    const app = await buildApp(client);
    const res = await app.inject({ method: 'POST', url: '/bots/bot-1/blueprints', payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ message: string }>().message).toBe('Bot not found');
  });

  it('POST /bots/:id/blueprints returns 503 when the boundary is absent', async () => {
    const app = await buildApp(undefined);
    const res = await app.inject({ method: 'POST', url: '/bots/bot-1/blueprints', payload: {} });
    expect(res.statusCode).toBe(503);
  });
});
