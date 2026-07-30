import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

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

const mockQueue = {
  add: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@herobids/db', async () => {
  const actual = await vi.importActual<typeof import('@herobids/db')>('@herobids/db');
  return {
    ...actual,
    createManualReviewRun: vi.fn().mockResolvedValue(undefined),
    getManualReviewRun: vi.fn().mockResolvedValue(null),
    hasActiveManualReviewRun: vi.fn().mockResolvedValue(false),
  };
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('POST /agents/:id/platform-assessment/reviews — capability mode gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueue.add.mockClear();
  });

  it('returns 403 capability_mode_unsupported for non-hybrid agent', async () => {
    const { createManualReviewRun, hasActiveManualReviewRun } = await import('@herobids/db');
    (hasActiveManualReviewRun as any).mockResolvedValue(false);

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
    await platformAssessmentReviewRoutes(app, mockQueue as any, db as any, {
      platformAssessorEnabled: true,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/agents/agent-1/platform-assessment/reviews',
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: 'capability_mode_unsupported',
      message: 'Strategy review is only available for hybrid agents',
    });
    expect(mockQueue.add).not.toHaveBeenCalled();
    expect(createManualReviewRun).not.toHaveBeenCalled();
  });

  it('returns 403 (capability_mode_unsupported), not 409, for non-hybrid agent even when a review is already in progress (gate ordering)', async () => {
    const { hasActiveManualReviewRun } = await import('@herobids/db');
    (hasActiveManualReviewRun as any).mockResolvedValue(true); // active review run in progress

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
    await platformAssessmentReviewRoutes(app, mockQueue as any, db as any, {
      platformAssessorEnabled: true,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/agents/agent-1/platform-assessment/reviews',
    });

    // Capability-mode gate fires BEFORE resource checks — must return 403, not 409
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: 'capability_mode_unsupported',
      message: 'Strategy review is only available for hybrid agents',
    });
  });

  it('proceeds past capability gate for hybrid agent (fails on another gate, not capability)', async () => {
    const { createManualReviewRun, hasActiveManualReviewRun } = await import('@herobids/db');
    (hasActiveManualReviewRun as any).mockResolvedValue(false);

    const agentRow = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'active',
      unifiedConfig: {
        capabilityMode: 'hybrid',
        platformAssessment: { enabled: true },
      },
    };

    // Session query returns empty (no active session)
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
    await platformAssessmentReviewRoutes(app, mockQueue as any, db as any, {
      platformAssessorEnabled: true,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/agents/agent-1/platform-assessment/reviews',
    });

    expect(res.statusCode).not.toBe(403);
    // It should fail on no_active_session (409), not capability_mode
    if (res.statusCode === 409) {
      expect(res.json()).toMatchObject({ error: 'no_active_session' });
    } else if (res.statusCode === 202) {
      expect(res.json()).toHaveProperty('requestId');
    } else {
      throw new Error(`Unexpected status code: ${res.statusCode}`);
    }
  });
});

describe('GET /agents/:id/platform-assessment/reviews/eligibility — capability mode reason', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports canTrigger: false with capability-mode reason for non-hybrid agent', async () => {
    const { hasActiveManualReviewRun } = await import('@herobids/db');
    (hasActiveManualReviewRun as any).mockResolvedValue(false);

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
    await platformAssessmentReviewRoutes(app, mockQueue as any, db as any, {
      platformAssessorEnabled: true,
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
    const { hasActiveManualReviewRun } = await import('@herobids/db');
    (hasActiveManualReviewRun as any).mockResolvedValue(false);

    const agentRow = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'active',
      unifiedConfig: {
        capabilityMode: 'hybrid',
        platformAssessment: { enabled: true },
      },
    };

    // Agent query first, then session query
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
    await platformAssessmentReviewRoutes(app, mockQueue as any, db as any, {
      platformAssessorEnabled: true,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/agents/agent-1/platform-assessment/reviews/eligibility',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.canTrigger).toBe(true);
    // For a hybrid agent, the reason (if present) MUST NOT contain the capability-mode gate message
    if (body.reason) {
      expect(body.reason).not.toContain('only available for hybrid agents');
    }
  });
});
