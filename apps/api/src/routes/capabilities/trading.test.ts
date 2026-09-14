import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { capabilityRoutes as registerCapabilityRoutesImpl } from './index.js';
import { tradingCapabilityRoutes as registerTradingCapabilityRoutesImpl } from './trading.js';
import { agentConnectionAudit as agentConnectionAuditTable } from '@herobids/db';
import type { TradertonClient, TradertonClientResult } from '@herobids/domain/traderton';

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

async function tradingCapabilityRoutes(
  app: ReturnType<typeof Fastify>,
  db: unknown,
  redisClient?: unknown,
  tradertonReadClient?: TradertonClient,
) {
  await registerTradingCapabilityRoutesImpl(
    app,
    db as never,
    undefined,
    TEST_RUNTIME_BUDGETS,
    redisClient as never,
    tradertonReadClient,
    10_000,
  );
}

/** Which agent-scoped read tool an invocation targets. */
type ReadToolPayloads = {
  get_agent_fills?: unknown[];
  get_agent_journal_events?: unknown[];
  get_agent_positions?: unknown[];
};

/**
 * Build a stub Traderton read client whose `invoke` returns a success payload
 * with the given rows per tool (keyed by the tool's array field). Mirrors the
 * seam mock used in exports.test.ts.
 */
function makeReadClient(payloads: ReadToolPayloads): {
  client: TradertonClient;
  invoke: ReturnType<typeof vi.fn>;
} {
  const keyFor: Record<string, string> = {
    get_agent_fills: 'fills',
    get_agent_journal_events: 'events',
    get_agent_positions: 'positions',
  };
  const invoke = vi.fn().mockImplementation((input: { toolName: string }) => {
    const key = keyFor[input.toolName];
    const rows = (payloads as Record<string, unknown[] | undefined>)[input.toolName] ?? [];
    const result: TradertonClientResult = {
      kind: 'success',
      requestId: 'r',
      correlationId: 'c',
      payload: key ? { [key]: rows } : {},
    };
    return Promise.resolve(result);
  });
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

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
  inArray: vi.fn((col, vals) => ({ _inArray: vals })),
  notInArray: vi.fn((col, vals) => ({ _notInArray: vals })),
  isNull: vi.fn((col) => ({ _isNull: col })),
  sum: vi.fn((col) => ({ _sum: col })),
  count: vi.fn((col) => ({ _count: col })),
  sql: vi.fn().mockImplementation((strings: TemplateStringsArray) => ({ _sql: strings.join('') })),
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

// Boundary payloads arrive as JSON, so date columns are ISO strings (the seam
// rehydrates them to Date). These ISO fixtures mirror the DB row shapes.
const NOW_ISO = new Date('2026-02-02T10:00:00.000Z').toISOString();

const POSITION_ISO = {
  id: 'pos-iso',
  venueAccountId: 'va-1',
  actorType: 'agent',
  actorId: TEST_AGENT_ID,
  venue: 'hyperliquid',
  symbol: 'BTC-PERP',
  side: 'long',
  size: '1',
  entryPrice: '50000',
  realizedPnl: '0',
  markSource: 'last_fill',
  openedAt: NOW_ISO,
  closedAt: null as string | null,
  updatedAt: NOW_ISO,
};

const FILL_ISO = {
  id: 'fill-iso',
  orderId: 'order-iso',
  venueAccountId: 'va-1',
  actorType: 'agent',
  actorId: TEST_AGENT_ID,
  venueRefId: 'ref-iso',
  venue: 'hyperliquid',
  symbol: 'BTC-PERP',
  side: 'buy',
  quantity: '0.1',
  price: '50000',
  fee: '1.00',
  feeCurrency: 'USDC',
  filledAt: NOW_ISO,
  createdAt: NOW_ISO,
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
      id: TEST_CONNECTION_ID,
      userId: TEST_USER_ID,
      credentialId: null,
      provider: 'hyperliquid',
      label: 'HL connection',
      providerRef: 'acct-1',
      profile: { venue: 'hyperliquid' },
      status: 'active',
      resolvedVenueAccountId: 'va-1',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    }]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/capabilities/trading/connections' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.family).toBe('trading');
    expect(body.connections[0].connectionId).toBe(TEST_CONNECTION_ID);
    expect(body.connections[0].provider).toBe('hyperliquid');
    expect(body.connections[0].providerRef).toBe('acct-1');
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
        id: 'ac-1',
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
        capabilities: ['trading'],
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

  it('keeps historical trading state available after a grant is revoked', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    // Only the agent-owner lookup hits the DB; positions come over the boundary.
    const db = buildDb([[AGENT_ROW]]);
    const { client, invoke } = makeReadClient({
      get_agent_positions: [
        { ...POSITION_ISO, id: 'pos-closed', realizedPnl: '12.500000', closedAt: NOW_ISO },
        { ...POSITION_ISO, id: 'pos-open', realizedPnl: '0', closedAt: null },
      ],
    });
    await tradingCapabilityRoutes(app, db, undefined, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/state` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPnl).toBe('12.500000');
    expect(body.openPositionCount).toBe(1);

    // The boundary was invoked with get_agent_positions bound to the requesting
    // user's subject (per-request agent subject).
    const arg = invoke.mock.calls[0]![0] as { toolName: string; subject: unknown };
    expect(arg.toolName).toBe('get_agent_positions');
    expect(arg.subject).toEqual({ ownerId: TEST_USER_ID, actor: { type: 'agent', id: TEST_AGENT_ID } });
  });

  it('reports zeroed trading state when the agent has no positions', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW]]);
    const { client } = makeReadClient({ get_agent_positions: [] });
    await tradingCapabilityRoutes(app, db, undefined, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/state` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPnl).toBe('0');
    expect(body.openPositionCount).toBe(0);
  });

  it('returns 503 for trading state when the read boundary is unconfigured', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW]]);
    await tradingCapabilityRoutes(app, db); // no read client

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/state` });
    expect(res.statusCode).toBe(503);
    expect(res.json<Record<string, unknown>>()['error']).toBe('precondition.not_ready');
  });

  it('includes direct agent positions in trading state', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW]]);
    const { client } = makeReadClient({
      get_agent_positions: [
        { ...POSITION_ISO, id: 'pos-1', realizedPnl: '3.250000', closedAt: null },
      ],
    });
    await tradingCapabilityRoutes(app, db, undefined, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/state` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPnl).toBe('3.250000');
    expect(body.openPositionCount).toBe(1);
  });

  it('includes direct agent activity from the read boundary', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const filledAtIso = new Date('2026-02-02T10:00:00.000Z').toISOString();
    const createdAtIso = new Date('2026-02-02T10:01:00.000Z').toISOString();
    const db = buildDb([[AGENT_ROW]]);
    const { client, invoke } = makeReadClient({
      get_agent_fills: [{
        ...FILL_ISO,
        id: 'fill-1',
        symbol: 'BTC',
        side: 'buy',
        quantity: '0.01',
        price: '100000',
        fee: '1',
        feeCurrency: 'USDC',
        venueRefId: null,
        filledAt: filledAtIso,
        createdAt: filledAtIso,
      }],
      get_agent_journal_events: [{
        id: 'evt-1',
        actorType: 'agent',
        actorId: TEST_AGENT_ID,
        type: 'decision.created',
        payload: { instrumentId: 'BTC' },
        createdAt: createdAtIso,
      }],
    });
    await tradingCapabilityRoutes(app, db, undefined, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/activity` });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ type: string; id: string }> }>();
    // Event createdAt is later than fill filledAt → event sorts first.
    expect(body.items.map((item) => item.id)).toEqual(['evt-1', 'fill-1']);
    expect(body.items.map((item) => item.type)).toEqual(['event', 'fill']);

    const toolNames = invoke.mock.calls.map((c) => (c[0] as { toolName: string }).toolName);
    expect(toolNames).toContain('get_agent_fills');
    expect(toolNames).toContain('get_agent_journal_events');
  });

  it('returns empty activity when the agent has no fills or events', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW]]);
    const { client } = makeReadClient({ get_agent_fills: [], get_agent_journal_events: [] });
    await tradingCapabilityRoutes(app, db, undefined, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/activity` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it('aggregates trading outcomes from boundary fills and positions', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW]]);
    const { client } = makeReadClient({
      get_agent_fills: [
        { ...FILL_ISO, id: 'f1', fee: '2.40', feeCurrency: 'USDC' },
        { ...FILL_ISO, id: 'f2', fee: '5.00', feeCurrency: 'USDC' },
      ],
      get_agent_positions: [
        { ...POSITION_ISO, id: 'p1', realizedPnl: '10.000000', closedAt: NOW_ISO },
        { ...POSITION_ISO, id: 'p2', realizedPnl: '-4.000000', closedAt: NOW_ISO },
        { ...POSITION_ISO, id: 'p3', realizedPnl: '0', closedAt: null },
      ],
    });
    await tradingCapabilityRoutes(app, db, undefined, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/outcomes` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      tradeCount: number;
      totalPnl: string;
      winRate: number | null;
      feesByCurrency: Record<string, string>;
      openPositionCount: number;
    }>();
    expect(body.tradeCount).toBe(2);
    expect(body.totalPnl).toBe('6.000000');
    expect(body.feesByCurrency['USDC']).toBe('7.4');
    expect(body.openPositionCount).toBe(1);
    // 2 closed positions, 1 with positive PnL → 0.5
    expect(body.winRate).toBe(0.5);
  });

  it('returns zeroed outcomes when the agent has no trading evidence', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW]]);
    const { client } = makeReadClient({ get_agent_fills: [], get_agent_positions: [] });
    await tradingCapabilityRoutes(app, db, undefined, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/outcomes` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tradeCount).toBe(0);
    expect(body.totalPnl).toBe('0');
    expect(body.winRate).toBeNull();
    expect(body.feesByCurrency).toEqual({});
    expect(body.openPositionCount).toBe(0);
  });

  it('lists positions with an in-app reconstructed exit price', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const openedEarly = new Date('2026-02-01T00:00:00.000Z').toISOString();
    const openedLate = new Date('2026-02-03T00:00:00.000Z').toISOString();
    const closedAtIso = new Date('2026-02-04T00:00:00.000Z').toISOString();
    const fillEarly = new Date('2026-02-03T12:00:00.000Z').toISOString();
    const fillLate = new Date('2026-02-04T00:00:00.000Z').toISOString();
    const db = buildDb([[AGENT_ROW]]);
    const { client, invoke } = makeReadClient({
      get_agent_positions: [
        {
          ...POSITION_ISO,
          id: 'pos-closed',
          venueAccountId: 'va-1',
          venue: 'hyperliquid',
          symbol: 'BTC-PERP',
          actorType: 'agent',
          actorId: TEST_AGENT_ID,
          realizedPnl: '25.000000',
          openedAt: openedLate,
          closedAt: closedAtIso,
        },
        {
          ...POSITION_ISO,
          id: 'pos-open',
          venueAccountId: 'va-1',
          venue: 'hyperliquid',
          symbol: 'ETH-PERP',
          actorType: 'agent',
          actorId: TEST_AGENT_ID,
          realizedPnl: '0',
          openedAt: openedEarly,
          closedAt: null,
        },
      ],
      get_agent_fills: [
        {
          ...FILL_ISO,
          id: 'fill-early',
          venueAccountId: 'va-1',
          venue: 'hyperliquid',
          symbol: 'BTC-PERP',
          actorType: 'agent',
          actorId: TEST_AGENT_ID,
          price: '90000',
          filledAt: fillEarly,
          createdAt: fillEarly,
        },
        {
          ...FILL_ISO,
          id: 'fill-late',
          venueAccountId: 'va-1',
          venue: 'hyperliquid',
          symbol: 'BTC-PERP',
          actorType: 'agent',
          actorId: TEST_AGENT_ID,
          price: '95000',
          filledAt: fillLate,
          createdAt: fillLate,
        },
      ],
    });
    await tradingCapabilityRoutes(app, db, undefined, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/positions` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      items: Array<{ id: string; status: string; exitPrice: string | null; realizedPnl: string }>;
    }>();
    // Ordered by openedAt desc → closed (opened late) first.
    expect(body.items.map((i) => i.id)).toEqual(['pos-closed', 'pos-open']);
    // Closed position: latest matching fill (filledAt <= closedAt) is fill-late.
    expect(body.items[0]!.exitPrice).toBe('95000');
    expect(body.items[0]!.status).toBe('closed');
    expect(body.items[0]!.realizedPnl).toBe('25.000000');
    // Open position has no exit price.
    expect(body.items[1]!.exitPrice).toBeNull();
    expect(body.items[1]!.status).toBe('open');

    const toolNames = invoke.mock.calls.map((c) => (c[0] as { toolName: string }).toolName);
    expect(toolNames).toContain('get_agent_positions');
    expect(toolNames).toContain('get_agent_fills');
  });

  it('returns empty positions list when the agent has none', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW]]);
    const { client } = makeReadClient({ get_agent_positions: [], get_agent_fills: [] });
    await tradingCapabilityRoutes(app, db, undefined, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/positions` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it('returns audit entries for an agent connection', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const grantedAt = new Date('2026-06-01T00:00:00.000Z');
    const auditCreatedAt = new Date('2026-06-01T00:00:01.000Z');
    const assignmentRow = {
      id: 'ac-audit-1',
      assignmentId: 'ac-audit-1',
      grantStatus: 'active',
      grantedAt,
      revokedAt: null,
      connectionId: TEST_CONNECTION_ID,
      connectionStatus: 'active',
      providerRef: 'acct-1',
      profile: { venue: 'hyperliquid' },
      resolvedVenueAccountId: 'va-1',
      provider: 'hyperliquid',
      label: 'HL connection',
      capabilities: ['trading'],
    };
    const auditRow = {
      id: 'audit-1',
      agentConnectionId: 'ac-audit-1',
      action: 'granted',
      actorType: 'user',
      actorId: TEST_USER_ID,
      reason: 'Initial grant',
      detail: null,
      createdAt: auditCreatedAt,
    };
    const db = buildDb([
      [AGENT_ROW],
      [assignmentRow],
      [auditRow],
    ]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${TEST_AGENT_ID}/capabilities/trading/connections/${TEST_CONNECTION_ID}/audit`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ connectionId: string; audit: Array<{ action: string; reason: string }> }>();
    expect(body.connectionId).toBe(TEST_CONNECTION_ID);
    expect(body.audit).toHaveLength(1);
    expect(body.audit[0].action).toBe('granted');
    expect(body.audit[0].reason).toBe('Initial grant');
  });

  it('exposes aggregate capability readiness using connection IDs', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([
      [AGENT_ROW],
      [{
        id: 'ac-1',
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
        capabilities: ['trading'],
      }],
    ]);
    await capabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/readiness` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.capabilities[0].connectionId).toBe(TEST_CONNECTION_ID);
  });
});
