import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { capabilityRoutes } from './index.js';
import { tradingCapabilityRoutes } from './trading.js';
import type { CapabilityReadiness } from '@herobids/domain';

const TEST_USER_ID = 'user-1';
const TEST_AGENT_ID = 'agent-1';
const TEST_CONN_ID = 'conn-1';
const TEST_GRANT_ID = 'grant-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = 'free';
  });
}

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => ({ _eq: val })),
  and: vi.fn((...args) => ({ _and: args })),
  desc: vi.fn((col) => ({ _desc: col })),
  inArray: vi.fn((col, vals) => ({ _inArray: vals })),
  isNull: vi.fn((col) => ({ _isNull: col })),
  sum: vi.fn((col) => ({ _sum: col })),
  count: vi.fn((col) => ({ _count: col })),
  sql: vi.fn().mockImplementation((strings: TemplateStringsArray) => ({ _sql: strings.join('') })),
}));

vi.mock('../grant-service.js', () => ({
  createGrant: vi.fn().mockResolvedValue('grant-1'),
  revokeGrant: vi.fn().mockResolvedValue(true),
  getGrantAudit: vi.fn().mockResolvedValue([]),
  assertConnectionOwnership: vi.fn().mockResolvedValue({
    id: 'conn-1',
    userId: 'user-1',
    provider: 'hyperliquid',
    label: 'HL account',
    status: 'active',
    credentialId: null,
    meta: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  }),
  assertGrantOwnership: vi.fn().mockResolvedValue({
    id: 'grant-1',
    agentId: 'agent-1',
    connectionId: 'conn-1',
    capabilityFamily: 'trading',
    status: 'active',
    grantedBy: 'user-1',
    grantedAt: new Date('2026-01-01'),
    revokedAt: null,
    meta: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    connection: {
      id: 'conn-1',
      provider: 'hyperliquid',
      label: 'HL account',
      status: 'active',
    },
  }),
}));

const AGENT_ROW = {
  id: TEST_AGENT_ID,
  userId: TEST_USER_ID,
  name: 'Test Agent',
  status: 'stopped',
  skillIds: [],
  prompt: 'test',
  toolPolicy: null,
  modelPolicy: null,
  telegramChatId: null,
  executionMode: null,
  dailyTokenBudget: null,
  dailyLossLimit: null,
  maxBots: null,
  maxSlippageBps: null,
  pauseState: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const CONN_ROW = {
  id: TEST_CONN_ID,
  userId: TEST_USER_ID,
  provider: 'hyperliquid',
  label: 'HL account',
  status: 'active',
  credentialId: null,
  meta: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const GRANT_ROW = {
  id: TEST_GRANT_ID,
  agentId: TEST_AGENT_ID,
  connectionId: TEST_CONN_ID,
  capabilityFamily: 'trading',
  status: 'active',
  grantedBy: TEST_USER_ID,
  grantedAt: new Date('2026-01-01'),
  revokedAt: null,
  meta: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

// Builds a simple chainable mock DB.
// selectSequence[i] is returned for the i-th select().from().where() call.
function buildDb(selectSequence: unknown[][] = []) {
  let callIdx = 0;

  const makeSelectChain = () => ({
    from: vi.fn().mockReturnValue({
      orderBy: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          const result = selectSequence[callIdx] ?? [];
          callIdx++;
          return result;
        }),
      }),
      where: vi.fn().mockImplementation(() => {
        const result = selectSequence[callIdx] ?? [];
        callIdx++;
        return result;
      }),
      innerJoin: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            const result = selectSequence[callIdx] ?? [];
            callIdx++;
            return result;
          }),
        }),
        where: vi.fn().mockImplementation(() => {
          const result = selectSequence[callIdx] ?? [];
          callIdx++;
          return result;
        }),
      }),
    }),
  });

  const db: any = {
    select: vi.fn().mockImplementation(() => makeSelectChain()),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: TEST_AGENT_ID }]),
        }),
      }),
    }),
    transaction: vi.fn().mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    ),
  };

  return db;
}

// ─────────────────────────────────────────────────────────────────────────────
// Family-level routes
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /capabilities', () => {
  it('returns the list of available capability families', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await capabilityRoutes(app, buildDb());

    const res = await app.inject({ method: 'GET', url: '/capabilities' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.families)).toBe(true);
    const trading = body.families.find((f: { family: string }) => f.family === 'trading');
    expect(trading).toBeDefined();
    expect(trading.status).toBe('available');
  });
});

describe('GET /capabilities/trading', () => {
  it('returns trading family metadata', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await tradingCapabilityRoutes(app, buildDb());

    const res = await app.inject({ method: 'GET', url: '/capabilities/trading' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.family).toBe('trading');
    expect(Array.isArray(body.supportedActions)).toBe(true);
    expect(body.supportedActions).toContain('start');
    expect(body.supportedActions).toContain('bind');
  });
});

describe('GET /capabilities/trading/providers', () => {
  it('returns the list of trading providers', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await tradingCapabilityRoutes(app, buildDb());

    const res = await app.inject({ method: 'GET', url: '/capabilities/trading/providers' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers.map((p: { provider: string }) => p.provider)).toContain('hyperliquid');
  });
});

describe('GET /capabilities/trading/bindings', () => {
  it('returns user trading bindings', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[{ grant: GRANT_ROW, connection: { id: TEST_CONN_ID, provider: 'hyperliquid', label: 'HL account', status: 'active' } }]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/capabilities/trading/bindings' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.family).toBe('trading');
    expect(Array.isArray(body.bindings)).toBe(true);
    expect(body.bindings[0].bindingId).toBe(TEST_GRANT_ID);
    expect(body.bindings[0].connectionId).toBe(TEST_CONN_ID);
  });

  it('returns empty bindings when user has no connections', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/capabilities/trading/bindings' });

    expect(res.statusCode).toBe(200);
    expect(res.json().bindings).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent-scoped routes
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /agents/:agentId/capabilities/trading', () => {
  it('returns 404 for unknown agent', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    // first select = agent lookup (empty), second = grants (empty)
    const db = buildDb([[], []]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('agent.not_found');
  });

  it('returns top-level trading view for known agent', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    // agent lookup, then grants
    const db = buildDb([[AGENT_ROW], []]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agentId).toBe(TEST_AGENT_ID);
    expect(body.family).toBe('trading');
    expect(typeof body.effectiveReady).toBe('boolean');
  });
});

describe('GET /agents/:agentId/capabilities/trading/state', () => {
  it('returns 404 for unknown agent', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/state`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns zero state when agent has no bots', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    // agent lookup, then bots (empty)
    const db = buildDb([[AGENT_ROW], []]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/state`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agentId).toBe(TEST_AGENT_ID);
    expect(body.family).toBe('trading');
    expect(body.totalPnl).toBe('0');
    expect(body.openPositionCount).toBe(0);
  });
});

describe('GET /agents/:agentId/capabilities/trading/readiness', () => {
  it('returns unconfigured when no grants exist', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    // agent lookup, then grants (empty)
    const db = buildDb([[AGENT_ROW], []]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/readiness`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<CapabilityReadiness>();
    expect(body.state).toBe('unconfigured');
    expect(body.effectiveReady).toBe(false);
    expect(body.family).toBe('trading');
  });

  it('returns ready when an active grant on an active connection exists', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const grantRows = [{
      grantId: TEST_GRANT_ID,
      grantStatus: 'active',
      connectionId: TEST_CONN_ID,
      connectionStatus: 'active',
    }];
    const db = buildDb([[AGENT_ROW], grantRows]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/readiness`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<CapabilityReadiness>();
    expect(body.state).toBe('ready');
    expect(body.effectiveReady).toBe(true);
    expect(body.bindingId).toBe(TEST_GRANT_ID);
  });

  it('chooses the newest non-active grant deterministically', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const grantRows = [
      {
        grantId: 'grant-old',
        grantStatus: 'revoked',
        grantedAt: new Date('2026-01-01T00:00:00.000Z'),
        connectionId: TEST_CONN_ID,
        connectionStatus: 'revoked',
      },
      {
        grantId: 'grant-new',
        grantStatus: 'revoked',
        grantedAt: new Date('2026-02-01T00:00:00.000Z'),
        connectionId: TEST_CONN_ID,
        connectionStatus: 'revoked',
      },
    ];
    const db = buildDb([[AGENT_ROW], grantRows]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/readiness`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<CapabilityReadiness>();
    expect(body.state).toBe('revoked');
    expect(body.bindingId).toBe('grant-new');
  });
});

describe('GET /agents/:agentId/capabilities/trading/bindings', () => {
  it('returns 404 for unknown agent', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/bindings`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('agent.not_found');
  });

  it('returns agent trading bindings', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const grantWithConn = [{
      grant: GRANT_ROW,
      connection: { id: TEST_CONN_ID, provider: 'hyperliquid', label: 'HL', status: 'active' },
    }];
    const db = buildDb([[AGENT_ROW], grantWithConn]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/bindings`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agentId).toBe(TEST_AGENT_ID);
    expect(body.family).toBe('trading');
    expect(Array.isArray(body.bindings)).toBe(true);
  });
});

describe('GET /agents/:agentId/capabilities/trading/activity', () => {
  it('returns 404 for unknown agent', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/activity`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for invalid pagination parameters', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], []]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/activity?limit=abc&offset=-1`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('validation_error');
  });

  it('returns 400 when offset exceeds the configured window', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], []]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/activity?offset=501`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('validation_error');
  });

  it('returns empty activity when agent has no bots', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    // agent lookup, bots empty
    const db = buildDb([[AGENT_ROW], []]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/activity`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agentId).toBe(TEST_AGENT_ID);
    expect(body.family).toBe('trading');
    expect(body.items).toHaveLength(0);
  });
});

describe('GET /agents/:agentId/capabilities/trading/outcomes', () => {
  it('returns 404 for unknown agent', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/outcomes`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns zero outcomes when agent has no bots', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    // agent lookup, bots empty
    const db = buildDb([[AGENT_ROW], []]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/outcomes`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agentId).toBe(TEST_AGENT_ID);
    expect(body.family).toBe('trading');
    expect(body.tradeCount).toBe(0);
    expect(body.totalPnl).toBe('0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /agents/:agentId/capabilities/trading/actions/:action', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 for unsupported action', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/fly`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('action.unsupported');
  });

  it('returns 404 when agent does not belong to user', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/start`,
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('agent.not_found');
  });

  it('start: returns 202 starting when agent is stopped', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const stoppedAgent = { ...AGENT_ROW, status: 'stopped' };
    const db = buildDb([[stoppedAgent]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/start`,
      payload: {},
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.action).toBe('start');
    expect(body.status).toBe('starting');
    expect(body.sessionId).toBeDefined();
  });

  it('start: returns 409 when agent is already starting', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const startingAgent = { ...AGENT_ROW, status: 'starting' };
    const db = buildDb([[startingAgent]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/start`,
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('agent.not_stopped');
  });

  it('stop: returns stopped', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const runningAgent = { ...AGENT_ROW, status: 'running' };
    const db = buildDb([[runningAgent]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/stop`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.action).toBe('stop');
    expect(body.status).toBe('stopped');
  });

  it('pause: returns 400 when reason is missing', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const runningAgent = { ...AGENT_ROW, status: 'running' };
    const db = buildDb([[runningAgent]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/pause`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('pause: returns paused with reason provided', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const runningAgent = { ...AGENT_ROW, status: 'running' };
    const db = buildDb([[runningAgent]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/pause`,
      payload: { reason: 'manual pause' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.action).toBe('pause');
    expect(body.status).toBe('paused');
  });

  it('resume: returns 409 when agent is not paused', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const runningAgent = { ...AGENT_ROW, status: 'running' };
    const db = buildDb([[runningAgent]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/resume`,
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('agent.not_paused');
  });

  it('resume: returns active when agent is paused', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const pausedAgent = { ...AGENT_ROW, status: 'paused' };
    const db = buildDb([[pausedAgent]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/resume`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.action).toBe('resume');
    expect(body.status).toBe('active');
  });

  it('bind: returns 400 when connectionId is missing', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/bind`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('bind: returns 201 with bindingId on success', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    // agent lookup, then grant select after createGrant
    const db = buildDb([[AGENT_ROW], [GRANT_ROW]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/bind`,
      payload: { connectionId: TEST_CONN_ID },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.action).toBe('bind');
    expect(body.bindingId).toBe(TEST_GRANT_ID);
    expect(body.family).toBe('trading');
  });

  it('unbind: returns 400 when bindingId is missing', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/unbind`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('unbind: returns revoked on success', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/unbind`,
      payload: { bindingId: TEST_GRANT_ID },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.action).toBe('unbind');
    expect(body.status).toBe('revoked');
  });

  it('unbind: returns 404 when binding belongs to different agent', async () => {
    const { assertGrantOwnership } = await import('../grant-service.js');
    vi.mocked(assertGrantOwnership).mockResolvedValueOnce({
      id: TEST_GRANT_ID,
      agentId: 'other-agent',
      connectionId: TEST_CONN_ID,
      capabilityFamily: 'trading',
      status: 'active',
      grantedBy: TEST_USER_ID,
      grantedAt: new Date('2026-01-01'),
      revokedAt: null,
      meta: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      connection: {
        id: TEST_CONN_ID,
        provider: 'hyperliquid',
        label: 'HL',
        status: 'active',
        userId: TEST_USER_ID,
        credentialId: null,
        meta: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      },
    });

    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/unbind`,
      payload: { bindingId: TEST_GRANT_ID },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('binding.not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate readiness (capability namespace level)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /agents/:agentId/capabilities/readiness (aggregate)', () => {
  it('returns 404 for unknown agent', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[]]);
    await capabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/readiness`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('agent.not_found');
  });

  it('returns unconfigured trading when agent has no grants', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], []]);
    await capabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/readiness`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agentId).toBe(TEST_AGENT_ID);
    expect(body.capabilities).toHaveLength(1);
    expect(body.capabilities[0].family).toBe('trading');
    expect(body.capabilities[0].state).toBe('unconfigured');
  });

  it('chooses the newest non-active trading grant deterministically', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const grantRows = [
      {
        grantId: 'grant-old',
        capabilityFamily: 'trading',
        grantStatus: 'revoked',
        grantedAt: new Date('2026-01-01T00:00:00.000Z'),
        connectionStatus: 'revoked',
      },
      {
        grantId: 'grant-new',
        capabilityFamily: 'trading',
        grantStatus: 'revoked',
        grantedAt: new Date('2026-02-01T00:00:00.000Z'),
        connectionStatus: 'revoked',
      },
    ];
    const db = buildDb([[AGENT_ROW], grantRows]);
    await capabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/readiness`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'trading', bindingId: 'grant-new', state: 'revoked' }),
      ]),
    );
  });
});
