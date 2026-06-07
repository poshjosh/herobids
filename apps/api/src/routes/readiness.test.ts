import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { readinessRoutes } from './readiness.js';
import type { CapabilityReadiness } from '@herobids/domain';

const TEST_USER_ID = 'user-1';
const TEST_AGENT_ID = 'agent-1';

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
  sql: vi.fn().mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: strings.join('') })),
}));

function buildMockDb(scenario: {
  agents?: unknown[];
  grantRows?: unknown[];
} = {}) {
  const { agents = [{ id: TEST_AGENT_ID }], grantRows = [] } = scenario;
  let callIdx = 0;
  const callReturns = [agents, grantRows];

  return {
    select: vi.fn().mockImplementation((_cols?) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          const result = callReturns[callIdx] ?? [];
          callIdx++;
          return result;
        }),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(grantRows),
        }),
      }),
    })),
  } as any;
}

describe('GET /agents/:agentId/capabilities/:family/readiness', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns unconfigured when no grants exist', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb({ grantRows: [] });
    await readinessRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/readiness`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<CapabilityReadiness>();
    expect(body.state).toBe('unconfigured');
    expect(body.effectiveReady).toBe(false);
    expect(body.agentEligibility).toBe('ineligible');
    expect(body.family).toBe('trading');
  });

  it('returns ready when an active grant on an active connection exists', async () => {
    const grantRows = [{
      grantId: 'grant-1',
      grantStatus: 'active',
      connectionId: 'conn-1',
      connectionStatus: 'active',
    }];
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb({ grantRows });
    await readinessRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/readiness`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<CapabilityReadiness>();
    expect(body.state).toBe('ready');
    expect(body.effectiveReady).toBe(true);
    expect(body.agentEligibility).toBe('eligible');
    expect(body.bindingId).toBe('grant-1');
    expect(body.reasons).toHaveLength(0);
  });

  it('returns revoked when grant is revoked', async () => {
    const grantRows = [{
      grantId: 'grant-1',
      grantStatus: 'revoked',
      connectionId: 'conn-1',
      connectionStatus: 'active',
    }];
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb({ grantRows });
    await readinessRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/readiness`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<CapabilityReadiness>();
    expect(body.state).toBe('revoked');
    expect(body.effectiveReady).toBe(false);
    expect(body.reasons.length).toBeGreaterThan(0);
  });

  it('returns revoked when underlying connection is revoked', async () => {
    const grantRows = [{
      grantId: 'grant-1',
      grantStatus: 'active',
      connectionId: 'conn-1',
      connectionStatus: 'revoked',
    }];
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb({ grantRows });
    await readinessRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/readiness`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<CapabilityReadiness>();
    expect(body.state).toBe('revoked');
    expect(body.effectiveReady).toBe(false);
  });

  it('returns 404 when agent does not belong to user', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb({ agents: [] });
    await readinessRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: '/agents/nonexistent/capabilities/trading/readiness',
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('GET /agents/:agentId/capabilities/readiness', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns aggregate readiness across all families', async () => {
    const grantRows = [
      { grantId: 'g1', capabilityFamily: 'trading', grantStatus: 'active', connectionId: 'c1', connectionStatus: 'active' },
      { grantId: 'g2', capabilityFamily: 'automation', grantStatus: 'revoked', connectionId: 'c2', connectionStatus: 'active' },
    ];
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb({ grantRows });
    await readinessRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/readiness`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ agentId: string; capabilities: CapabilityReadiness[] }>();
    expect(body.agentId).toBe(TEST_AGENT_ID);
    expect(body.capabilities).toHaveLength(2);

    const trading = body.capabilities.find((c) => c.family === 'trading');
    expect(trading?.state).toBe('ready');
    expect(trading?.effectiveReady).toBe(true);

    const automation = body.capabilities.find((c) => c.family === 'automation');
    expect(automation?.state).toBe('revoked');
    expect(automation?.effectiveReady).toBe(false);
  });
});
