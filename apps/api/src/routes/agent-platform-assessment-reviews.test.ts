import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../agents/trading-profile-reconciliation-adapter.js', () => ({
  loadActiveTradingProfileConnections: vi.fn().mockResolvedValue([]),
}));

import { loadActiveTradingProfileConnections } from '../agents/trading-profile-reconciliation-adapter.js';

const TEST_USER_ID = 'user-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.decorateRequest('isAdmin', false);
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = 'free';
    request.isAdmin = false;
  });
}

/**
 * Create a drizzle-like query result that is both thenable (await) and has a
 * `.limit()` method. This handles both chain shapes used by the route:
 *   db.select().from().where()           → await the where result
 *   db.select().from().where().limit(1)  → call .limit() then await
 */
function makeQueryResult(rows: unknown[]) {
  const result = Promise.resolve(rows) as Promise<unknown[]> & { limit: () => Promise<unknown[]> };
  result.limit = () => Promise.resolve(rows.slice(0, 1));
  return result;
}

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockRedis = {
  xadd: vi.fn().mockResolvedValue(undefined),
};

const mockClient = {
  invoke: vi.fn(),
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('POST /agents/:id/platform-assessment/reviews — capability mode gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.invoke.mockResolvedValue({
      kind: 'success',
      requestId: 'r1',
      correlationId: 'c1',
      payload: { data: { results: [] } },
    });
  });

  it('returns 403 capability_mode_unsupported for non-hybrid agent', async () => {
    const agentRow = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'active',
      unifiedConfig: {
        capabilityMode: 'intelligence',
        platformAssessment: { enabled: true },
      },
    };

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(makeQueryResult([agentRow])),
        }),
      }),
    };

    const app = Fastify();
    decorateWithAuth(app);

    const { platformAssessmentReviewRoutes } = await import('./agent-platform-assessment-reviews.js');
    await platformAssessmentReviewRoutes(app, db as any, mockRedis as any, {
      tradingBackendClient: mockClient as any,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/agents/agent-1/platform-assessment/reviews',
      payload: { symbols: ['BTC'], venueFamily: 'hyperliquid' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: 'capability_mode_unsupported',
      message: 'Strategy review is only available for hybrid agents',
    });
    expect(mockClient.invoke).not.toHaveBeenCalled();
  });

  it('calls traderton assess_strategy_preset for a hybrid agent with a running session', async () => {
    const agentRow = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'active',
      unifiedConfig: {
        capabilityMode: 'hybrid',
        platformAssessment: { enabled: true },
      },
    };

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn()
            .mockReturnValueOnce(makeQueryResult([agentRow]))
            .mockReturnValueOnce(makeQueryResult([{ id: 'session-1' }])),
        }),
      }),
    };

    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue([
      { connectionId: 'conn-1', venueAccountId: 'va-1', active: true, ready: true, isDefault: true },
    ]);

    const app = Fastify();
    decorateWithAuth(app);

    const { platformAssessmentReviewRoutes } = await import('./agent-platform-assessment-reviews.js');
    await platformAssessmentReviewRoutes(app, db as any, mockRedis as any, {
      tradingBackendClient: mockClient as any,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/agents/agent-1/platform-assessment/reviews',
      payload: { symbols: ['BTC'], venueFamily: 'hyperliquid' },
    });

    expect(res.statusCode).toBe(202);
    expect(mockClient.invoke).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'assess_strategy_preset',
      subject: { ownerId: TEST_USER_ID, actor: { type: 'agent', id: 'agent-1' } },
      payload: expect.objectContaining({ venueAccountId: 'va-1' }),
    }));
  });

  it('returns 409 no_active_session when the agent has no running session', async () => {
    const agentRow = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'active',
      unifiedConfig: {
        capabilityMode: 'hybrid',
        platformAssessment: { enabled: true },
      },
    };

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn()
            .mockReturnValueOnce(makeQueryResult([agentRow]))
            .mockReturnValueOnce(makeQueryResult([])),
        }),
      }),
    };

    const app = Fastify();
    decorateWithAuth(app);

    const { platformAssessmentReviewRoutes } = await import('./agent-platform-assessment-reviews.js');
    await platformAssessmentReviewRoutes(app, db as any, mockRedis as any, {
      tradingBackendClient: mockClient as any,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/agents/agent-1/platform-assessment/reviews',
      payload: { symbols: ['BTC'], venueFamily: 'hyperliquid' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'no_active_session' });
  });
});

describe('GET /agents/:id/platform-assessment/reviews/eligibility — capability mode reason', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports canTrigger: false with capability-mode reason for non-hybrid agent', async () => {
    const agentRow = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'active',
      unifiedConfig: {
        capabilityMode: 'intelligence',
        platformAssessment: { enabled: true },
      },
    };

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(makeQueryResult([agentRow])),
        }),
      }),
    };

    const app = Fastify();
    decorateWithAuth(app);

    const { platformAssessmentReviewRoutes } = await import('./agent-platform-assessment-reviews.js');
    await platformAssessmentReviewRoutes(app, db as any, mockRedis as any, {
      tradingBackendClient: mockClient as any,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/agents/agent-1/platform-assessment/reviews/eligibility',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.canTrigger).toBe(false);
    expect(body.reason).toContain('Strategy review is only available for hybrid agents');
  });

  it('omits capability-mode reason for hybrid agent', async () => {
    const agentRow = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'active',
      unifiedConfig: {
        capabilityMode: 'hybrid',
        platformAssessment: { enabled: true },
      },
    };

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn()
            .mockReturnValueOnce(makeQueryResult([agentRow]))
            .mockReturnValueOnce(makeQueryResult([{ id: 'session-1' }])),
        }),
      }),
    };

    const app = Fastify();
    decorateWithAuth(app);

    const { platformAssessmentReviewRoutes } = await import('./agent-platform-assessment-reviews.js');
    await platformAssessmentReviewRoutes(app, db as any, mockRedis as any, {
      tradingBackendClient: mockClient as any,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/agents/agent-1/platform-assessment/reviews/eligibility',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.canTrigger).toBe(true);
    if (body.reason) {
      expect(body.reason).not.toContain('only available for hybrid agents');
    }
  });
});

describe('GET /agents/:id/platform-assessment/reviews/results — data-only reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the agent strategy-change history from traderton', async () => {
    mockClient.invoke.mockResolvedValue({
      kind: 'success',
      requestId: 'r1',
      correlationId: 'c1',
      payload: {
        data: {
          changes: [
            {
              id: 'c1',
              ownerId: TEST_USER_ID,
              actorId: 'agent-1',
              fromStrategy: { presetKey: 'momentum' },
              toStrategy: { presetKey: 'range' },
              artifactId: 'a1',
              reason: 'Range fits the choppy regime',
              state: 'applied',
              createdAt: '2026-10-10T00:00:00.000Z',
              appliedAt: '2026-10-10T00:00:00.000Z',
            },
          ],
        },
      },
    });

    const agentRow = {
      id: 'agent-1',
      userId: TEST_USER_ID,
    };

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(makeQueryResult([agentRow])),
        }),
      }),
    };

    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue([
      { connectionId: 'conn-1', venueAccountId: 'va-1', active: true, ready: true, isDefault: true },
    ]);

    const app = Fastify();
    decorateWithAuth(app);

    const { platformAssessmentReviewRoutes } = await import('./agent-platform-assessment-reviews.js');
    await platformAssessmentReviewRoutes(app, db as any, mockRedis as any, {
      tradingBackendClient: mockClient as any,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/agents/agent-1/platform-assessment/reviews/results',
    });

    expect(res.statusCode).toBe(200);
    expect(mockClient.invoke).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'list_agent_strategy_changes',
      payload: expect.objectContaining({ venueAccountId: 'va-1' }),
    }));
    const body = res.json();
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0].reason).toBe('Range fits the choppy regime');
  });
});
