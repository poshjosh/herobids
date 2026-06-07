import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { grantRoutes } from './grants.js';

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
  sql: vi.fn().mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: strings.join('') })),
}));

const AGENT_ROW = { id: TEST_AGENT_ID };
const CONN_ROW = { id: TEST_CONN_ID, userId: TEST_USER_ID, status: 'active', provider: 'hyperliquid', label: 'HL' };
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
const AUDIT_ROW = {
  id: 'audit-1',
  grantId: TEST_GRANT_ID,
  action: 'granted',
  actorType: 'user',
  actorId: TEST_USER_ID,
  reason: null,
  detail: null,
  createdAt: new Date('2026-01-01'),
};

type MockSelectReturn =
  | typeof AGENT_ROW[]
  | typeof CONN_ROW[]
  | typeof GRANT_ROW[]
  | typeof AUDIT_ROW[]
  | unknown[];

let lastInserted: Record<string, unknown> | undefined;
let lastUpdateSet: Record<string, unknown> | undefined;

function buildMockDb(scenario: {
  agents?: unknown[];
  connections?: unknown[];
  grants?: unknown[];
  auditRows?: unknown[];
} = {}) {
  lastInserted = undefined;
  lastUpdateSet = undefined;

  const {
    agents = [AGENT_ROW],
    connections = [CONN_ROW],
    grants = [GRANT_ROW],
    auditRows = [AUDIT_ROW],
  } = scenario;

  let selectCallIdx = 0;
  const selectReturns: MockSelectReturn[] = [
    agents,          // agent ownership check
    connections,     // connection ownership (assertConnectionOwnership)
  ];

  const dbMock = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v) => { lastInserted = v; return Promise.resolve(); }),
    }),
    select: vi.fn().mockImplementation((_cols?) => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          const result = selectReturns[selectCallIdx] ?? grants;
          selectCallIdx++;
          // Return an augmented array that also supports .orderBy() chaining
          const arr = result as unknown[];
          const augmented = [...arr] as unknown[] & { orderBy: ReturnType<typeof vi.fn> };
          augmented.orderBy = vi.fn().mockReturnValue(auditRows);
          return augmented;
        }),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(grants.map((g) => ({ grant: g, connection: CONN_ROW }))),
        }),
      })),
    })),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((s) => {
        lastUpdateSet = s;
        return {
          where: vi.fn().mockReturnValue({
            // Simulate one affected row (conditional update matched an active grant)
            returning: vi.fn().mockResolvedValue([{ id: TEST_GRANT_ID }]),
          }),
        };
      }),
    }),
  };

  // The transaction callback receives dbMock itself as the tx handle, so all
  // existing mock assertions (insert/update/select call counts) still work.
  (dbMock as any).transaction = vi.fn().mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMock),
  );

  return dbMock as any;
}

describe('POST /agents/:agentId/grants', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('creates a grant and returns 201', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await grantRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/grants`,
      payload: { connectionId: TEST_CONN_ID, capabilityFamily: 'trading' },
    });

    expect(res.statusCode).toBe(201);
    // An audit entry should also have been inserted (two inserts: grant + audit)
    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  it('returns 404 when agent does not belong to user', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb({ agents: [] }); // agent not found
    await grantRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/unknown-agent/grants`,
      payload: { connectionId: TEST_CONN_ID, capabilityFamily: 'trading' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('agent.not_found');
  });

  it('returns 400 when connection does not exist', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb({ connections: [] }); // connection not found
    await grantRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/grants`,
      payload: { connectionId: 'missing-conn', capabilityFamily: 'trading' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('connection.not_found');
  });

  it('returns 409 when connection is revoked', async () => {
    const revokedConn = { ...CONN_ROW, status: 'revoked' };
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb({ connections: [revokedConn] });
    await grantRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/grants`,
      payload: { connectionId: TEST_CONN_ID, capabilityFamily: 'trading' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('connection.revoked');
  });

  it('returns 400 for missing required fields', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await grantRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/grants`,
      payload: { capabilityFamily: 'trading' }, // missing connectionId
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('validation_error');
  });
});

describe('DELETE /agents/:agentId/grants/:grantId', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('revokes a grant and returns 204', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await grantRoutes(app, db);

    // After revoke route calls assertGrantOwnership, it calls revokeGrant which:
    // 1. selects grant to check current status → returns active grant
    // 2. updates grant to revoked
    // 3. inserts audit row
    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${TEST_AGENT_ID}/grants/${TEST_GRANT_ID}`,
      payload: { reason: 'No longer needed' },
    });

    expect(res.statusCode).toBe(204);
    expect(lastUpdateSet!['status']).toBe('revoked');
    // Audit entry should have been inserted
    expect(db.insert).toHaveBeenCalled();
  });

  it('returns 404 when grant does not exist', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb({ grants: [] });
    await grantRoutes(app, db);

    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${TEST_AGENT_ID}/grants/nonexistent`,
      payload: {},
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('GET /agents/:agentId/grants/:grantId/audit', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns the audit trail for a grant', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await grantRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/grants/${TEST_GRANT_ID}/audit`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ audit: unknown[] }>();
    expect(Array.isArray(body.audit)).toBe(true);
    expect(body.audit.length).toBeGreaterThan(0);
  });
});
