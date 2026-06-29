import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { capabilityRoutes as registerCapabilityRoutesImpl } from './index.js';
import { tradingCapabilityRoutes as registerTradingCapabilityRoutesImpl } from './trading.js';
import { agents as agentsTable, capabilityGrants as capabilityGrantsTable, bots as botsTable, fills as fillsTable, journalEvents as journalEventsTable } from '@herobids/db';

const TEST_USER_ID = 'user-1';
const TEST_AGENT_ID = 'agent-1';
const TEST_CONNECTION_ID = 'binding-1';
const TEST_RUNTIME_BUDGETS = {
  maxHistoryMessages: 20,
  maxRecentToolMessages: 6,
  maxToolResultChars: 4000,
  maxVisibleToolSchemas: 37,
  maxContextBlockChars: 4000,
};

async function tradingCapabilityRoutes(app: ReturnType<typeof Fastify>, db: unknown, redisClient?: unknown) {
  await registerTradingCapabilityRoutesImpl(app, db as never, undefined, TEST_RUNTIME_BUDGETS, redisClient as never);
}

async function capabilityRoutes(app: ReturnType<typeof Fastify>, db: unknown, redisClient?: unknown) {
  await registerCapabilityRoutesImpl(app, db as never, undefined, TEST_RUNTIME_BUDGETS, redisClient as never);
}

const DEFAULT_ACTIVE_CONNECTION = {
  id: 'binding-1',
  userId: 'user-1',
  connectionId: 'conn-1',
  provider: 'hyperliquid',
  label: 'HL binding',
  connectionRef: 'acct-1',
  status: 'active',
  connectionProfile: { venue: 'hyperliquid' },
  resolvedVenueAccountId: 'va-1',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  connection: {
    id: 'conn-1',
    userId: 'user-1',
    credentialId: null,
    provider: 'hyperliquid',
    label: 'HL connection',
    status: 'active',
    meta: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  },
};

const mockAssertConnectionOwnership = vi.fn().mockResolvedValue(DEFAULT_ACTIVE_CONNECTION);

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
  inArray: vi.fn((col, vals) => ({ _inArray: vals })),
  notInArray: vi.fn((col, vals) => ({ _notInArray: vals })),
  isNull: vi.fn((col) => ({ _isNull: col })),
  sum: vi.fn((col) => ({ _sum: col })),
  count: vi.fn((col) => ({ _count: col })),
  sql: vi.fn().mockImplementation((strings: TemplateStringsArray) => ({ _sql: strings.join('') })),
}));

vi.mock('../../grant-service.js', () => ({
  createGrant: vi.fn().mockResolvedValue('grant-1'),
  revokeGrant: vi.fn().mockResolvedValue(true),
  getConnectionAudit: vi.fn().mockResolvedValue([]),
  assertConnectionOwnership: (...args: unknown[]) => mockAssertConnectionOwnership(...args),
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
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: TEST_AGENT_ID }]) }),
      }),
    }),
  } as any;
}

describe('trading capability routes', () => {
  it('publishes the full supported trading provider catalog', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb();
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/capabilities/trading' });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ providers: string[] }>().providers).toEqual(['hyperliquid', 'jupiter', '1inch', 'bybit']);
  });

  it('publishes provider metadata for all supported trading providers', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb();
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/capabilities/trading/providers' });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ providers: Array<{ provider: string }> }>().providers.map((provider) => provider.provider)).toEqual([
      'hyperliquid',
      'jupiter',
      '1inch',
      'bybit',
    ]);
  });

  it('lists trading connections as real connection resources', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[{
      binding: {
        id: TEST_CONNECTION_ID,
        userId: TEST_USER_ID,
        connectionId: 'conn-1',
        provider: 'hyperliquid',
        label: 'HL binding',
        connectionRef: 'acct-1',
        status: 'active',
        connectionProfile: { venue: 'hyperliquid' },
        resolvedVenueAccountId: 'va-1',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      },
      connection: {
        id: 'conn-1',
        provider: 'hyperliquid',
        label: 'HL connection',
        status: 'active',
      },
    }]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/capabilities/trading/connections' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.family).toBe('trading');
    expect(body.connections[0].connectionId).toBe(TEST_CONNECTION_ID);
    expect(body.connections[0].provider).toBe('hyperliquid');
    expect(body.connections[0].connectionRef).toBe('acct-1');
    // No inserts — the endpoint is now read-only
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('returns empty connections list when no connections are provisioned', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/capabilities/trading/connections' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connections).toHaveLength(0);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('returns connection-backed readiness for an agent', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([
      [AGENT_ROW],
      [{
        grantId: 'grant-1',
        grantStatus: 'active',
        grantedAt: new Date('2026-02-01T00:00:00.000Z'),
        revokedAt: null,
        connectionId: TEST_CONNECTION_ID,
        connectionStatus: 'active',
        connectionRef: 'acct-1',
        connectionProfile: { venue: 'hyperliquid' },
        resolvedVenueAccountId: 'va-1',
        provider: 'hyperliquid',
        label: 'HL binding',
        connectionId: 'conn-1',
        connectionStatus: 'active',
      }],
    ]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/readiness` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe('ready');
    expect(body.connectionId).toBe(TEST_CONNECTION_ID);
    expect(body.effectiveReady).toBe(true);
  });

  it('binds an existing trading connection to an agent', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], []]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/bind`,
      payload: { connectionId: TEST_CONNECTION_ID },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().connectionId).toBe(TEST_CONNECTION_ID);
  });

  it('rejects connecting a trading connection that is no longer effectively ready', async () => {
    mockAssertConnectionOwnership.mockResolvedValueOnce({
      ...DEFAULT_ACTIVE_CONNECTION,
      status: 'revoked',
      connection: {
        ...DEFAULT_ACTIVE_CONNECTION.connection,
        status: 'revoked',
      },
    });

    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/bind`,
      payload: { connectionId: TEST_CONNECTION_ID },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('connection.not_ready');
  });

  it('publishes a runtime refresh envelope after binding a trading connection', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const redisClient = { xadd: vi.fn().mockResolvedValue('msg-1') };
    const db = buildDb([[AGENT_ROW], [], [AGENT_ROW]]);
    await tradingCapabilityRoutes(app, db, redisClient as any);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/bind`,
      payload: { connectionId: TEST_CONNECTION_ID },
    });

    expect(res.statusCode).toBe(201);
    expect(redisClient.xadd).toHaveBeenCalledWith(
      `agent:outbound:${TEST_AGENT_ID}`,
      '*',
      'envelope',
      expect.any(String),
    );

    const envelope = JSON.parse((redisClient.xadd as ReturnType<typeof vi.fn>).mock.calls[0][3] as string) as {
      type: string;
      payload: { reason: string; runtimeDescriptor: { budgets: { maxVisibleToolSchemas: number } } };
    };
    expect(envelope.type).toBe('agent.runtime.config_update');
    expect(envelope.payload.reason).toBe('grant_changed');
    expect(envelope.payload.runtimeDescriptor.budgets.maxVisibleToolSchemas).toBe(37);
  });

  it('allows rebinding to a new binding record on the same venue account even when positions are open', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const redisClient = { xadd: vi.fn().mockResolvedValue('msg-1') };
    mockAssertConnectionOwnership.mockResolvedValueOnce({
      ...DEFAULT_ACTIVE_CONNECTION,
      id: TEST_CONNECTION_ID,
      resolvedVenueAccountId: 'va-1',
    });
    const db = buildDb([
      [AGENT_ROW],
      [{
        grantId: 'grant-current',
        grantStatus: 'active',
        grantedAt: new Date('2026-02-01T00:00:00.000Z'),
        revokedAt: null,
        connectionId: .binding-old',
        connectionStatus: 'active',
        connectionRef: 'acct-1',
        connectionProfile: { venue: 'hyperliquid' },
        resolvedVenueAccountId: 'va-1',
        provider: 'hyperliquid',
        label: 'HL binding old',
        connectionId: 'conn-1',
        connectionStatus: 'active',
      }],
      [AGENT_ROW],
    ]);
    await tradingCapabilityRoutes(app, db, redisClient as any);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/bind`,
      payload: { connectionId: TEST_CONNECTION_ID },
    });

    expect(res.statusCode).toBe(201);
    expect(redisClient.xadd).toHaveBeenCalled();
  });

  it('keeps historical trading state available after a grant is revoked', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([
      [AGENT_ROW],
      [{
        grantId: 'grant-1',
        grantStatus: 'revoked',
        grantedAt: new Date('2026-02-01T00:00:00.000Z'),
        revokedAt: new Date('2026-03-01T00:00:00.000Z'),
        connectionId: TEST_CONNECTION_ID,
        connectionStatus: 'revoked',
        connectionRef: 'acct-1',
        connectionProfile: { venue: 'hyperliquid' },
        resolvedVenueAccountId: 'va-1',
        provider: 'hyperliquid',
        label: 'HL binding',
        connectionId: 'conn-1',
        connectionStatus: 'active',
      }],
      [{ id: 'bot-1' }],
      [{ totalPnl: '12.500000' }],
      [{ openCount: 1 }],
    ]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/state` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPnl).toBe('12.500000');
    expect(body.openPositionCount).toBe(1);
  });

  it('includes direct agent positions in trading state when no bots exist', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([
      [AGENT_ROW],
      [{
        grantId: 'grant-1',
        grantStatus: 'active',
        grantedAt: new Date('2026-02-01T00:00:00.000Z'),
        revokedAt: null,
        connectionId: TEST_CONNECTION_ID,
        connectionStatus: 'active',
        connectionRef: 'acct-1',
        connectionProfile: { venue: 'hyperliquid' },
        resolvedVenueAccountId: 'va-1',
        provider: 'hyperliquid',
        label: 'HL binding',
        connectionId: 'conn-1',
        connectionStatus: 'active',
      }],
      [],
      [{ totalPnl: '3.250000' }],
      [{ openCount: 1 }],
    ]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/state` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPnl).toBe('3.250000');
    expect(body.openPositionCount).toBe(1);
  });

  it('includes direct agent activity when no bots exist', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const filledAt = new Date('2026-02-02T10:00:00.000Z');
    const createdAt = new Date('2026-02-02T10:01:00.000Z');
    const grantRow = {
      grantId: 'grant-1',
      grantStatus: 'active',
      grantedAt: new Date('2026-02-01T00:00:00.000Z'),
      revokedAt: null,
      connectionId: TEST_CONNECTION_ID,
      connectionStatus: 'active',
      connectionRef: 'acct-1',
      connectionProfile: { venue: 'hyperliquid' },
      resolvedVenueAccountId: 'va-1',
      provider: 'hyperliquid',
      label: 'HL binding',
      connectionId: 'conn-1',
      connectionStatus: 'active',
    };
    const fillRow = {
      id: 'fill-1',
      symbol: 'BTC',
      side: 'buy',
      quantity: '0.01',
      price: '100000',
      fee: '1',
      feeCurrency: 'USDC',
      venueRefId: null,
      filledAt,
    };
    const eventRow = {
      id: 'evt-1',
      type: 'decision.created',
      payload: { instrumentId: 'BTC' },
      createdAt,
    };

    const makeChain = (result: unknown) => {
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
      ) => Promise.resolve(result).then(resolve, reject);
      return chain;
    };

    const db = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation((table: unknown) => {
          if (table === agentsTable) return makeChain([AGENT_ROW]);
          if (table === capabilityGrantsTable) return makeChain([grantRow]);
          if (table === botsTable) return makeChain([]);
          if (table === fillsTable) return makeChain([fillRow]);
          if (table === journalEventsTable) return makeChain([eventRow]);
          return makeChain([]);
        }),
      })),
      transaction: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
    } as any;
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/activity` });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ type: string; id: string }> }>();
    expect(body.items.map((item) => item.id)).toEqual(['evt-1', 'fill-1']);
    expect(body.items.map((item) => item.type)).toEqual(['event', 'fill']);
  });

  it('unbinds an active trading binding grant from an agent', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([
      [AGENT_ROW],
      [{
        grantId: 'grant-1',
        grantStatus: 'active',
        grantedAt: new Date('2026-02-01T00:00:00.000Z'),
        revokedAt: null,
        connectionId: TEST_CONNECTION_ID,
        connectionStatus: 'active',
        connectionRef: 'acct-1',
        connectionProfile: { venue: 'hyperliquid' },
        resolvedVenueAccountId: 'va-1',
        provider: 'hyperliquid',
        label: 'HL binding',
        connectionId: 'conn-1',
        connectionStatus: 'active',
      }],
      // getOpenPositionSymbols — no positions
      [],
      // getOpenOrderCount — no orders
      [{ cnt: 0 }],
    ]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/unbind`,
      payload: { connectionId: TEST_CONNECTION_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('revoked');
  });

  it('exposes aggregate capability readiness using binding IDs', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([
      [AGENT_ROW],
      [{
        grantId: 'grant-1',
        capabilityFamily: 'trading',
        grantStatus: 'active',
        grantedAt: new Date('2026-02-01T00:00:00.000Z'),
        connectionId: TEST_CONNECTION_ID,
        connectionStatus: 'active',
        connectionStatus: 'active',
      }],
    ]);
    await capabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/readiness` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.capabilities[0].connectionId).toBe(TEST_CONNECTION_ID);
  });

  it('rejects binding switch when resting orders exist on current venue account', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    mockAssertConnectionOwnership.mockResolvedValueOnce({
      ...DEFAULT_ACTIVE_CONNECTION,
      id: TEST_CONNECTION_ID,
      resolvedVenueAccountId: 'va-new',
    });
    const db = buildDb([
      [AGENT_ROW],
      // selectAgentTradingGrantRows — current binding on va-1
      [{
        grantId: 'grant-current',
        grantStatus: 'active',
        grantedAt: new Date('2026-02-01T00:00:00.000Z'),
        revokedAt: null,
        connectionId: .binding-old',
        connectionStatus: 'active',
        connectionRef: 'acct-1',
        connectionProfile: { venue: 'hyperliquid' },
        resolvedVenueAccountId: 'va-1',
        provider: 'hyperliquid',
        label: 'HL binding old',
        connectionId: 'conn-1',
        connectionStatus: 'active',
      }],
      // getOpenPositionSymbols — no positions
      [],
      // getOpenOrderCount — 2 resting orders
      [{ cnt: 2 }],
    ]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/bind`,
      payload: { connectionId: TEST_CONNECTION_ID },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe('connection.open_orders');
    expect(body.openOrderCount).toBe(2);
  });

  it('rejects unbind when resting orders exist on effective venue account', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([
      [AGENT_ROW],
      // selectAgentTradingGrantRows — grant being unbound is the effective one
      [{
        grantId: 'grant-1',
        grantStatus: 'active',
        grantedAt: new Date('2026-02-01T00:00:00.000Z'),
        revokedAt: null,
        connectionId: TEST_CONNECTION_ID,
        connectionStatus: 'active',
        connectionRef: 'acct-1',
        connectionProfile: { venue: 'hyperliquid' },
        resolvedVenueAccountId: 'va-1',
        provider: 'hyperliquid',
        label: 'HL binding',
        connectionId: 'conn-1',
        connectionStatus: 'active',
      }],
      // getOpenPositionSymbols — no positions
      [],
      // getOpenOrderCount — 3 resting orders
      [{ cnt: 3 }],
    ]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/unbind`,
      payload: { connectionId: TEST_CONNECTION_ID },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe('connection.open_orders');
    expect(body.openOrderCount).toBe(3);
  });
});
