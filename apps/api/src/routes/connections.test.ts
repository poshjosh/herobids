import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { connectionRoutes } from './connections.js';

const TEST_USER_ID = 'user-1';

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

const CONNECTION_ROW = {
  id: 'conn-1',
  userId: TEST_USER_ID,
  credentialId: null,
  provider: 'hyperliquid',
  label: 'My Hyperliquid Connection',
  status: 'active',
  meta: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

let mockDbRows: Record<string, unknown>[] = [];
let lastInserted: Record<string, unknown> | undefined;
let insertedValues: Record<string, unknown>[] = [];
let lastUpdateSet: Record<string, unknown> | undefined;

function buildMockDb(credRows: Record<string, unknown>[] = []) {
  lastInserted = undefined;
  insertedValues = [];
  lastUpdateSet = undefined;
  let selectCallCount = 0;

  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v) => {
        lastInserted = v;
        insertedValues.push(v);
        return Promise.resolve();
      }),
    }),
    select: vi.fn().mockImplementation((_cols?) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          selectCallCount++;
          // First call after insert is the re-fetch; credential check calls come first
          if (selectCallCount === 1 && credRows.length > 0) return credRows;
          if (mockDbRows.length > 0) return mockDbRows;
          if (insertedValues.length > 0) return [{ id: insertedValues[0]!['id'], ...insertedValues[0] }];
          return [];
        }),
      }),
    })),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((s) => {
        lastUpdateSet = s;
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
  } as any;
}

describe('POST /connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRows = [];
    lastInserted = undefined;
    insertedValues = [];
  });

  it('creates a connection and returns 201', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { provider: 'hyperliquid', label: 'My Connection' },
    });

    expect(res.statusCode).toBe(201);
    expect(lastInserted).toBeDefined();
    expect(lastInserted!['provider']).toBe('hyperliquid');
    expect(lastInserted!['userId']).toBe(TEST_USER_ID);
    expect(lastInserted!['status']).toBe('active');
    expect(insertedValues).toHaveLength(3);
    expect(insertedValues[0]!['provider']).toBe('hyperliquid');
    expect(insertedValues[1]!['venue']).toBe('hyperliquid');
    expect(insertedValues[2]!['provider']).toBe('hyperliquid');
    expect(insertedValues[2]!['connectionId']).toBe(insertedValues[0]!['id']);
  });

  it('returns 400 for missing required fields', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { provider: 'hyperliquid' }, // missing label
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('validation_error');
  });

  it('returns 400 when credentialId references a nonexistent credential', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    // empty credRows → credential not found
    const db = buildMockDb([]);
    await connectionRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { provider: 'hyperliquid', label: 'Test', credentialId: 'missing-cred' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('credential.not_found');
  });

  it('creates a connection with a valid credentialId', async () => {
    // Credential venue must match the connection provider
    const credRow = { id: 'cred-1', userId: TEST_USER_ID, venue: 'hyperliquid' };
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb([credRow]);
    await connectionRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { provider: 'hyperliquid', label: 'With Cred', credentialId: 'cred-1' },
    });

    expect(res.statusCode).toBe(201);
    expect(insertedValues[0]!['credentialId']).toBe('cred-1');
  });

  it('does not auto-create a trading binding for non-trading providers', async () => {
    const credRow = { id: 'cred-1', userId: TEST_USER_ID, venue: 'telegram' };
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb([credRow]);
    await connectionRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { provider: 'telegram', label: 'Telegram bot', credentialId: 'cred-1' },
    });

    expect(res.statusCode).toBe(201);
    expect(insertedValues).toHaveLength(1);
  });

  // Regression: bug 005 — functional tests called seedTradingBinding after createConnection,
  // causing a duplicate-key violation once POST /connections started auto-creating a
  // trading_bindings row. This verifies the auto-creation contract so callers must
  // query (not insert) to obtain the binding ID.
  it.each(['hyperliquid', 'jupiter', '1inch', 'bybit'] as const)(
    'auto-creates exactly one trading binding with matching connectionId for provider=%s',
    async (provider) => {
      const app = Fastify();
      decorateWithAuth(app);
      const db = buildMockDb();
      await connectionRoutes(app, db);

      const res = await app.inject({
        method: 'POST',
        url: '/connections',
        payload: { provider, label: `${provider} connection` },
      });

      expect(res.statusCode).toBe(201);
      // Three inserts: connection, companion venue account, then trading binding
      expect(insertedValues).toHaveLength(3);
      const [connInsert, venueAccountInsert, bindingInsert] = insertedValues;
      expect(venueAccountInsert!['venue']).toBe(provider);
      expect(bindingInsert!['connectionId']).toBe(connInsert!['id']);
      expect(bindingInsert!['provider']).toBe(provider);
    },
  );

  // Regression: bug 002 — e2e helpers called seedTradingBinding after createConnection
  // instead of looking up the auto-created binding. This documents the full binding
  // payload so callers know userId, status, and label are correctly inherited.
  it('auto-created trading binding carries the correct userId, status, and label', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { provider: 'hyperliquid', label: 'My HyperLiquid Connection' },
    });

    expect(res.statusCode).toBe(201);
    expect(insertedValues).toHaveLength(3);
    const [connInsert, venueAccountInsert, bindingInsert] = insertedValues;
    expect(venueAccountInsert!['userId']).toBe(TEST_USER_ID);
    expect(venueAccountInsert!['credentialId']).toBeNull();
    expect(bindingInsert!['userId']).toBe(TEST_USER_ID);
    expect(bindingInsert!['status']).toBe('active');
    expect(bindingInsert!['label']).toBe('My HyperLiquid Connection');
    expect(bindingInsert!['connectionId']).toBe(connInsert!['id']);
  });

  it('returns 400 when credential venue does not match connection provider', async () => {
    const credRow = { id: 'cred-1', userId: TEST_USER_ID, venue: 'bybit' };
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb([credRow]);
    await connectionRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { provider: 'hyperliquid', label: 'Mismatch', credentialId: 'cred-1' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('credential.provider_mismatch');
    // Must not persist a mismatched connection
    expect(lastInserted).toBeUndefined();
  });

  it('returns 400 when credential is deleted between validation and insert (FK race)', async () => {
    const credRow = { id: 'cred-1', userId: TEST_USER_ID, venue: 'hyperliquid' };
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb([credRow]);
    // Override insert to simulate a FK violation (credential deleted after validation)
    const fkError = new Error('insert or update on table "connections" violates foreign key constraint') as Error & { code: string };
    fkError.code = '23503';
    db.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockRejectedValue(fkError),
    });
    await connectionRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { provider: 'hyperliquid', label: 'Race Connection', credentialId: 'cred-1' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('credential.not_found');
  });
});

describe('GET /connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRows = [CONNECTION_ROW];
  });

  it('returns 200 with list of connections', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/connections' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ connections: unknown[] }>();
    expect(Array.isArray(body.connections)).toBe(true);
  });
});

describe('GET /connections/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRows = [CONNECTION_ROW];
  });

  it('returns 200 for an existing connection', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/connections/conn-1' });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when connection does not exist', async () => {
    mockDbRows = [];
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/connections/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('not_found');
  });
});

describe('DELETE /connections/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRows = [CONNECTION_ROW];
  });

  it('revokes an active connection and returns 204', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/connections/conn-1' });
    expect(res.statusCode).toBe(204);
    expect(lastUpdateSet!['status']).toBe('revoked');
  });

  it('returns 404 when connection does not exist', async () => {
    mockDbRows = [];
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/connections/missing' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when connection is already revoked', async () => {
    mockDbRows = [{ ...CONNECTION_ROW, status: 'revoked' }];
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildMockDb();
    await connectionRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: '/connections/conn-1' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('connection.already_revoked');
  });

  it('publishes a runtime refresh after revoking a connection with active trading grants', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const redisClient = { xadd: vi.fn().mockResolvedValue('msg-1') };
    const selectSequence: unknown[][] = [
      [{ id: CONNECTION_ROW.id, status: CONNECTION_ROW.status }],
      [{ agentId: 'agent-1' }],
      [{
        id: 'agent-1',
        prompt: 'Trade carefully',
        skillIds: [],
        toolPolicy: null,
        executionMode: 'paper',
        dailyTokenBudget: null,
        dailyLossLimit: null,
        maxBots: null,
        maxSlippageBps: null,
      }],
      [],
    ];
    let callIdx = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        const chain: Record<string, unknown> = {};
        chain.from = vi.fn().mockImplementation(() => chain);
        chain.innerJoin = vi.fn().mockImplementation(() => chain);
        chain.where = vi.fn().mockImplementation(() => Promise.resolve(selectSequence[callIdx++] ?? []));
        return chain;
      }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
    };

    await connectionRoutes(app, db, redisClient as any);

    const res = await app.inject({ method: 'DELETE', url: '/connections/conn-1' });

    expect(res.statusCode).toBe(204);
    expect(redisClient.xadd).toHaveBeenCalled();
  });
});
