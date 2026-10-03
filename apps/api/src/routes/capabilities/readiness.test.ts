import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { capabilityRoutes as registerCapabilityRoutesImpl } from './index.js';

const TEST_USER_ID = 'user-1';
const TEST_AGENT_ID = 'agent-1';
const TEST_CONNECTION_ID = 'conn-1';
const TEST_RUNTIME_BUDGETS = {
  maxHistoryMessages: 20,
  maxRecentToolMessages: 6,
  maxToolResultChars: 4000,
  maxVisibleToolSchemas: 37,
  maxContextBlockChars: 4000,
};

async function capabilityRoutes(app: ReturnType<typeof Fastify>, db: unknown, redisClient?: unknown) {
  await registerCapabilityRoutesImpl(app, db as never, undefined, TEST_RUNTIME_BUDGETS, redisClient as never);
}

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
  or: vi.fn((...args) => ({ _or: args })),
  asc: vi.fn((col) => ({ _asc: col })),
  desc: vi.fn((col) => ({ _desc: col })),
  inArray: vi.fn((_col, vals) => ({ _inArray: vals })),
  notInArray: vi.fn((_col, vals) => ({ _notInArray: vals })),
  isNull: vi.fn((col) => ({ _isNull: col })),
  sum: vi.fn((col) => ({ _sum: col })),
  count: vi.fn((col) => ({ _count: col })),
  sql: vi.fn().mockImplementation((strings: TemplateStringsArray) => ({ _sql: strings.join('') })),
}));

const AGENT_ROW = {
  id: TEST_AGENT_ID,
  userId: TEST_USER_ID,
  status: 'stopped',
};

/**
 * Minimal drizzle stub. Each `select()` resolves the next array in
 * `selectSequence`, independent of the WHERE/innerJoin chain used, mirroring the
 * harness in trading.test.ts.
 */
function buildDb(selectSequence: unknown[][] = []) {
  let callIdx = 0;

  const makeResultChain = () => {
    const chain: Record<string, unknown> = {};
    chain.innerJoin = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.offset = vi.fn(() => chain);
    chain.groupBy = vi.fn(() => chain);
    (chain as { then: unknown }).then = (
      resolve: (v: unknown) => unknown,
      reject?: (v: unknown) => unknown,
    ) => Promise.resolve(selectSequence[callIdx] ?? []).then((result) => {
      callIdx++;
      return resolve(result);
    }, reject);
    return chain;
  };

  const makeSelectChain = () => ({
    from: vi.fn().mockImplementation(() => makeResultChain()),
  });

  return {
    select: vi.fn().mockImplementation(() => makeSelectChain()),
  } as unknown;
}

describe('generic per-family capability readiness', () => {
  it('returns unconfigured readiness for an email agent with no connections', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    // 1) ownership lookup → agent; 2) connection assignments → none.
    const db = buildDb([[AGENT_ROW], []]);
    await capabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/email/readiness`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ family: string; state: string; effectiveReady: boolean; reasons: string[] }>();
    expect(body.family).toBe('email');
    expect(body.state).toBe('unconfigured');
    expect(body.effectiveReady).toBe(false);
    expect(body.reasons).toContain('no connections have been assigned for this capability family');
  });

  it('still serves the trading-specific readiness (literal segment not shadowed)', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    // 1) ownership lookup → agent; 2) trading assignment rows → one active HL grant.
    const db = buildDb([
      [AGENT_ROW],
      [{
        id: 'ac-1',
        assignmentId: 'ac-1',
        grantStatus: 'active',
        grantedAt: new Date('2026-02-01T00:00:00.000Z'),
        revokedAt: null,
        connectionId: TEST_CONNECTION_ID,
        connectionStatus: 'active',
        providerRef: 'acct-1',
        profile: { venue: 'hyperliquid' },
        resolvedVenueAccountId: 'va-1',
        provider: 'hyperliquid',
        label: 'HL connection',
        // Deliberately empty so this row is shadow-sensitive: the GENERIC
        // handler filters rows by `capabilities.includes('trading')` and would
        // DROP this row (→ 'unconfigured'), whereas the trading-specific handler
        // derives readiness straight from the active, venue-backed grant
        // (→ 'ready'). A 'ready' result therefore proves the literal `trading`
        // segment routed to the trading handler, not the parametric `:family`.
        capabilities: [],
      }],
    ]);
    await capabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/readiness`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ family: string; state: string; connectionId: string; effectiveReady: boolean }>();
    expect(body.family).toBe('trading');
    expect(body.state).toBe('ready');
    expect(body.connectionId).toBe(TEST_CONNECTION_ID);
    expect(body.effectiveReady).toBe(true);
  });

  it('returns 404 agent.not_found for an agent owned by a different user', async () => {
    const app = Fastify();
    decorateWithAuth(app, 'someone-else');
    // Ownership lookup finds nothing (WHERE userId mismatch) → empty result.
    const db = buildDb([[]]);
    await capabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/email/readiness`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('agent.not_found');
  });
});
