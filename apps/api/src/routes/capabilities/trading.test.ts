import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { capabilityRoutes as registerCapabilityRoutesImpl } from './index.js';
import { tradingCapabilityRoutes as registerTradingCapabilityRoutesImpl } from './trading.js';

const TEST_USER_ID = 'user-1';
const TEST_AGENT_ID = 'agent-1';
const TEST_BINDING_ID = 'binding-1';
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

const DEFAULT_ACTIVE_BINDING = {
  id: 'binding-1',
  userId: 'user-1',
  connectionId: 'conn-1',
  provider: 'hyperliquid',
  label: 'HL binding',
  bindingRef: 'acct-1',
  status: 'active',
  bindingProfile: { venue: 'hyperliquid' },
  sourceVenueAccountId: 'va-1',
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

const mockAssertBindingOwnership = vi.fn().mockResolvedValue(DEFAULT_ACTIVE_BINDING);

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

vi.mock('../../grant-service.js', () => ({
  createGrant: vi.fn().mockResolvedValue('grant-1'),
  revokeGrant: vi.fn().mockResolvedValue(true),
  getBindingAudit: vi.fn().mockResolvedValue([]),
  assertBindingOwnership: (...args: unknown[]) => mockAssertBindingOwnership(...args),
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

  it('lists trading bindings as real binding resources', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[{
      binding: {
        id: TEST_BINDING_ID,
        userId: TEST_USER_ID,
        connectionId: 'conn-1',
        provider: 'hyperliquid',
        label: 'HL binding',
        bindingRef: 'acct-1',
        status: 'active',
        bindingProfile: { venue: 'hyperliquid' },
        sourceVenueAccountId: 'va-1',
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

    const res = await app.inject({ method: 'GET', url: '/capabilities/trading/bindings' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.family).toBe('trading');
    expect(body.bindings[0].bindingId).toBe(TEST_BINDING_ID);
    expect(body.bindings[0].provider).toBe('hyperliquid');
    expect(body.bindings[0].bindingRef).toBe('acct-1');
    // No inserts — the endpoint is now read-only
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('returns empty bindings list when no bindings are provisioned', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/capabilities/trading/bindings' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bindings).toHaveLength(0);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('returns binding-backed readiness for an agent', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([
      [AGENT_ROW],
      [{
        grantId: 'grant-1',
        grantStatus: 'active',
        grantedAt: new Date('2026-02-01T00:00:00.000Z'),
        revokedAt: null,
        bindingId: TEST_BINDING_ID,
        bindingStatus: 'active',
        bindingRef: 'acct-1',
        bindingProfile: { venue: 'hyperliquid' },
        sourceVenueAccountId: 'va-1',
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
    expect(body.bindingId).toBe(TEST_BINDING_ID);
    expect(body.effectiveReady).toBe(true);
  });

  it('binds an existing trading binding to an agent', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], []]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/bind`,
      payload: { bindingId: TEST_BINDING_ID },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().bindingId).toBe(TEST_BINDING_ID);
  });

  it('rejects binding a trading connection that is no longer effectively ready', async () => {
    mockAssertBindingOwnership.mockResolvedValueOnce({
      ...DEFAULT_ACTIVE_BINDING,
      status: 'revoked',
      connection: {
        ...DEFAULT_ACTIVE_BINDING.connection,
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
      payload: { bindingId: TEST_BINDING_ID },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('binding.not_ready');
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
      payload: { bindingId: TEST_BINDING_ID },
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
        bindingId: TEST_BINDING_ID,
        bindingStatus: 'revoked',
        bindingRef: 'acct-1',
        bindingProfile: { venue: 'hyperliquid' },
        sourceVenueAccountId: 'va-1',
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

  it('unbinds an active trading binding grant from an agent', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], [{
      grantId: 'grant-1',
      grantStatus: 'active',
      grantedAt: new Date('2026-02-01T00:00:00.000Z'),
      revokedAt: null,
      bindingId: TEST_BINDING_ID,
      bindingStatus: 'active',
      bindingRef: 'acct-1',
      bindingProfile: { venue: 'hyperliquid' },
      sourceVenueAccountId: 'va-1',
      provider: 'hyperliquid',
      label: 'HL binding',
      connectionId: 'conn-1',
      connectionStatus: 'active',
    }]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/actions/unbind`,
      payload: { bindingId: TEST_BINDING_ID },
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
        bindingId: TEST_BINDING_ID,
        bindingStatus: 'active',
        connectionStatus: 'active',
      }],
    ]);
    await capabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/readiness` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.capabilities[0].bindingId).toBe(TEST_BINDING_ID);
  });
});
