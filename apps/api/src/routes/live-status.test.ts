import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { liveStatusRoutes } from './live-status.js';

/**
 * Route-level tests for live-status endpoints.
 * Uses a mock Database that intercepts Drizzle queries and PgJournal/Repo methods.
 */

const TEST_USER_ID = 'user-1';

/** Decorate Fastify app with a fake authenticated userId and planId (simulates auth plugin) */
function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = 'free';
  });
}

// --- Mock wiring ---

// We mock the @herobids/db module so that PgJournal, repos, and tradingInstances
// are test-controllable without a real Postgres connection.

vi.mock('@herobids/db', () => {
  const tradingInstances = { id: 'trading_instances.id', userId: 'trading_instances.user_id' };
  const bots = { id: 'bots.id', userId: 'bots.user_id' };
  return {
    PgJournal: vi.fn(),
    ReconciliationEventRepository: vi.fn(),
    OrderRepository: vi.fn(),
    FillRepository: vi.fn(),
    tradingInstances,
    bots,
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => ({ _eq: val })),
  and: vi.fn((...args) => ({ _and: args })),
}));

// Pull the mocked constructors so we can configure return values per test
import { PgJournal, ReconciliationEventRepository, OrderRepository, FillRepository } from '@herobids/db';

interface MockInstance {
  id: string;
  status: string;
  config: Record<string, unknown>;
  startedAt: Date | null;
}

let mockInstance: MockInstance | null = null;
let mockJournal: { queryByTypes: ReturnType<typeof vi.fn> };
let mockReconRepo: { getByInstance: ReturnType<typeof vi.fn> };
let mockOrderRepo: { getOpenByInstance: ReturnType<typeof vi.fn> };
let mockFillRepo: { getRecentByInstance: ReturnType<typeof vi.fn> };

function buildApp() {
  const app = Fastify();
  decorateWithAuth(app);

  // Mock db.select().from().where() chain
  const db = {
    select: () => ({
      from: () => ({
        where: () => (mockInstance ? [mockInstance] : []),
      }),
    }),
  } as any;

  // Configure mock constructors to return our controllable mocks
  mockJournal = { queryByTypes: vi.fn().mockResolvedValue([]) };
  mockReconRepo = { getByInstance: vi.fn().mockResolvedValue([]) };
  mockOrderRepo = { getOpenByInstance: vi.fn().mockResolvedValue([]) };
  mockFillRepo = { getRecentByInstance: vi.fn().mockResolvedValue([]) };

  (PgJournal as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockJournal);
  (ReconciliationEventRepository as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockReconRepo);
  (OrderRepository as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockOrderRepo);
  (FillRepository as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockFillRepo);

  return { app, db };
}

describe('GET /instances/:id/live-status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstance = null;
  });

  it('returns 404 for unknown instance', async () => {
    const { app, db } = buildApp();
    await liveStatusRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/instances/unknown-id/live-status' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('returns expected fields for a running live instance', async () => {
    mockInstance = {
      id: 'inst-1',
      status: 'running',
      config: { execution: { mode: 'live' } },
      startedAt: new Date('2026-05-28T10:00:00Z'),
    };

    const { app, db } = buildApp();
    await liveStatusRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/instances/inst-1/live-status' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.tradingInstanceId).toBe('inst-1');
    expect(body.executionMode).toBe('live');
    expect(body.status).toBe('running');
    expect(body.startedAt).toBe('2026-05-28T10:00:00.000Z');
    expect(body.lastReconciliation).toBeNull();
    expect(body.openOrders).toEqual([]);
    expect(body.recentFills).toEqual([]);
    expect(body.slippageAlerts).toEqual([]);
    expect(body.recentLiveEvents).toEqual([]);
  });

  it('defaults executionMode to paper when not set', async () => {
    mockInstance = {
      id: 'inst-2',
      status: 'stopped',
      config: {},
      startedAt: null,
    };

    const { app, db } = buildApp();
    await liveStatusRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/instances/inst-2/live-status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().executionMode).toBe('paper');
  });

  it('returns 400 for invalid since parameter', async () => {
    mockInstance = { id: 'inst-1', status: 'running', config: {}, startedAt: null };

    const { app, db } = buildApp();
    await liveStatusRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/instances/inst-1/live-status?since=not-a-date' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('passes since and limit to journal queries', async () => {
    mockInstance = { id: 'inst-1', status: 'running', config: { execution: { mode: 'live' } }, startedAt: null };

    const { app, db } = buildApp();
    await liveStatusRoutes(app, db);

    await app.inject({ method: 'GET', url: '/instances/inst-1/live-status?since=2026-05-28T00:00:00Z&limit=5' });

    // Verify journal was called with the parsed since/limit
    expect(mockJournal.queryByTypes).toHaveBeenCalledWith(expect.objectContaining({
      tradingInstanceId: 'inst-1',
      types: ['live.slippage_alert'],
      since: new Date('2026-05-28T00:00:00Z'),
      limit: 5,
    }));
  });
});

describe('GET /instances/:id/live-readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstance = null;
  });

  it('returns 404 for unknown instance', async () => {
    const { app, db } = buildApp();
    await liveStatusRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/instances/unknown/live-readiness' });
    expect(res.statusCode).toBe(404);
  });

  it('returns blocked for non-running instance regardless of journal events', async () => {
    mockInstance = { id: 'inst-1', status: 'stopped', config: { execution: { mode: 'live' } }, startedAt: null };

    const { app, db } = buildApp();
    // Return an armed event — should still be blocked because status != running
    mockJournal.queryByTypes
      .mockResolvedValueOnce([]) // blocked query
      .mockResolvedValueOnce([{ id: 'e1', type: 'instance.live_armed', payload: {}, createdAt: new Date() }]); // armed query
    await liveStatusRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/instances/inst-1/live-readiness' });
    expect(res.statusCode).toBe(200);
    expect(res.json().readinessState).toBe('blocked');
  });

  it('returns armed when last armed event is newer than last blocked', async () => {
    mockInstance = { id: 'inst-1', status: 'running', config: { execution: { mode: 'live' } }, startedAt: null };

    const { app, db } = buildApp();
    const blockedAt = new Date('2026-05-28T09:00:00Z');
    const armedAt = new Date('2026-05-28T10:00:00Z');
    mockJournal.queryByTypes
      .mockResolvedValueOnce([{ id: 'e1', type: 'instance.live_blocked', payload: { reason: 'test', code: 'test.code' }, createdAt: blockedAt }])
      .mockResolvedValueOnce([{ id: 'e2', type: 'instance.live_armed', payload: { venue: 'hyperliquid' }, createdAt: armedAt }]);
    await liveStatusRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/instances/inst-1/live-readiness' });
    const body = res.json();
    expect(body.readinessState).toBe('armed');
    expect(body.lastArmed.timestamp).toBe('2026-05-28T10:00:00.000Z');
    expect(body.lastBlocked.reason).toBe('test');
    expect(body.lastBlocked.code).toBe('test.code');
  });

  it('returns blocked when last blocked event is newer than last armed', async () => {
    mockInstance = { id: 'inst-1', status: 'running', config: { execution: { mode: 'live' } }, startedAt: null };

    const { app, db } = buildApp();
    const armedAt = new Date('2026-05-28T09:00:00Z');
    const blockedAt = new Date('2026-05-28T10:00:00Z');
    mockJournal.queryByTypes
      .mockResolvedValueOnce([{ id: 'e1', type: 'instance.live_blocked', payload: { reason: 'cred missing', code: 'credential.missing' }, createdAt: blockedAt }])
      .mockResolvedValueOnce([{ id: 'e2', type: 'instance.live_armed', payload: {}, createdAt: armedAt }]);
    await liveStatusRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/instances/inst-1/live-readiness' });
    expect(res.json().readinessState).toBe('blocked');
  });

  it('returns unknown when running instance has no armed or blocked events', async () => {
    mockInstance = { id: 'inst-1', status: 'running', config: { execution: { mode: 'live' } }, startedAt: null };

    const { app, db } = buildApp();
    mockJournal.queryByTypes
      .mockResolvedValueOnce([]) // no blocked
      .mockResolvedValueOnce([]); // no armed
    await liveStatusRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/instances/inst-1/live-readiness' });
    expect(res.json().readinessState).toBe('unknown');
  });

  it('returns crashed status with blocked readiness', async () => {
    mockInstance = { id: 'inst-1', status: 'crashed', config: { execution: { mode: 'live' } }, startedAt: null };

    const { app, db } = buildApp();
    await liveStatusRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/instances/inst-1/live-readiness' });
    const body = res.json();
    expect(body.status).toBe('crashed');
    expect(body.readinessState).toBe('blocked');
  });
});
