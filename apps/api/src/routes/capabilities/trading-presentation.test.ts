import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { tradingCapabilityRoutes as registerTradingCapabilityRoutesImpl } from './trading.js';
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
  tradertonReadClient?: TradertonClient,
) {
  await registerTradingCapabilityRoutesImpl(
    app,
    db as never,
    undefined,
    TEST_RUNTIME_BUDGETS,
    undefined as never,
    tradertonReadClient,
    10_000,
  );
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
  unifiedConfig: { authorizationMode: 'approval_required', capabilityMode: 'hybrid' },
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const ACTIVE_ASSIGNMENT = {
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
};

const NOW_ISO = new Date('2026-02-02T10:00:00.000Z').toISOString();

/** Produce an active trading assignment row, overriding any subset of fields. */
function assignmentRow(overrides: Record<string, unknown> = {}) {
  return { ...ACTIVE_ASSIGNMENT, ...overrides };
}

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

/**
 * Build a stub Traderton read client. `invoke` is keyed by toolName; returns
 * either a success payload (single object for `get_account_summary`, arrays for
 * the evidence tools) or a forced error.
 */
function makeReadClient(input: {
  onTool?: (toolName: string, payload: unknown) => TradertonClientResult;
}) {
  const invoke = vi.fn().mockImplementation(({ toolName }: { toolName: string; payload: unknown }) => {
    if (input.onTool) {
      return Promise.resolve(input.onTool(toolName, undefined as unknown));
    }
    return Promise.resolve({
      kind: 'success',
      requestId: 'r',
      correlationId: 'c',
      payload: {},
    } as TradertonClientResult);
  });
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

/** Default success client returning a ready account summary + one of each feed item. */
function makeDefaultClient() {
  const summary = {
    ok: true,
    agentId: TEST_AGENT_ID,
    capital: '1000.00',
    capitalAvailable: true,
    executionMode: 'paper',
    positionSizeMode: 'fixed',
    fixedPositionSize: '1',
    openPositionCount: 1,
    agentDirectPositions: 1,
    botManagedPositions: 0,
    positions: [],
  };
  const positions = [
    {
      ...{ id: 'pos-neg', venueAccountId: 'va-1', actorType: 'agent', actorId: TEST_AGENT_ID, venue: 'hyperliquid', symbol: 'BTC-PERP', side: 'long', size: '1', entryPrice: '50000', realizedPnl: '-4.000000', markSource: 'last_fill', openedAt: NOW_ISO, closedAt: NOW_ISO, updatedAt: NOW_ISO },
      instrumentId: null,
      exitReason: null,
      stopLoss: null,
      takeProfit: null,
    },
  ];
  const decisions = [
    { id: 'dec-1', intent: 'go_long', instrumentId: 'BTC-USD', createdAt: NOW_ISO, status: 'approved', venueAccountId: 'va-1' },
    { id: 'dec-a', intent: 'go_short', instrumentId: 'ETH-USD', createdAt: NOW_ISO, status: 'approved', venueAccountId: 'va-a' },
  ];
  const fills = [{ id: 'fill-1', orderId: 'o-1', venueAccountId: 'va-1', actorType: 'agent', actorId: TEST_AGENT_ID, venue: 'hyperliquid', symbol: 'BTC-PERP', side: 'buy', quantity: '0.1', price: '50000', fee: '1', feeCurrency: 'USDC', realizedPnlDelta: '2.500000', filledAt: NOW_ISO, createdAt: NOW_ISO }];

  return makeReadClient({
    onTool: (toolName) => {
      const payloadMap: Record<string, unknown> = {
        get_account_summary: summary,
        get_agent_positions: { ok: true, positions },
        get_agent_decisions: { ok: true, decisions },
        get_agent_fills: { ok: true, fills },
      };
      return { kind: 'success', requestId: 'r', correlationId: 'c', payload: payloadMap[toolName] ?? {} } as TradertonClientResult;
    },
  });
}

describe('trading capability presentation', () => {
  it('returns connection: null with empty attributes/feeds when no usable connection', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], []]); // agent exists, no assignments
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/presentation` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.family).toBe('trading');
    expect(body.connection).toBeNull();
    expect(body.attributes).toEqual([]);
    expect(body.feeds).toEqual([]);
  });

  it('returns connection: null when explicit connectionId is not actively bound', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], [{ ...ACTIVE_ASSIGNMENT, connectionId: 'other-conn', grantStatus: 'revoked' }]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/presentation?connectionId=${TEST_CONNECTION_ID}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connection).toBeNull();
    expect(body.feeds).toEqual([]);
  });

  it('resolves default/newer-ready connection when two ready connections are bound', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    // Connection A is OLDER (first in the rows array) and connection B is NEWER.
    // Correct resolution sorts by grantedAt (newest wins); a naive "first ready"
    // implementation would incorrectly pick A. Array order is intentionally
    // [older, newer] to prove selection is timestamp-driven, not order-driven.
    const connectionA = assignmentRow({
      id: 'ac-a',
      connectionId: 'conn-a',
      label: 'HL connection A',
      grantedAt: new Date('2026-02-01T00:00:00.000Z'),
      resolvedVenueAccountId: 'va-a',
      providerRef: 'acct-a',
    });
    const connectionB = assignmentRow({
      id: 'ac-b',
      connectionId: 'conn-b',
      label: 'HL connection B',
      grantedAt: new Date('2026-02-15T00:00:00.000Z'),
      resolvedVenueAccountId: 'va-1',
      providerRef: 'acct-1',
    });
    const db = buildDb([[AGENT_ROW], [connectionA, connectionB]]);
    const { client } = makeDefaultClient();
    await tradingCapabilityRoutes(app, db, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/presentation` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // The surfaced connection is B (newer ready), not A (older).
    expect(body.connection).toEqual({ id: 'conn-b', label: 'HL connection B', state: 'ready' });
    expect(body.connection.id).not.toBe('conn-a');

    // The `connection` attribute also reflects B and does NOT leak A's identity.
    const attrs = body.attributes as Array<{ key: string; value: string; emphasis?: string }>;
    const byKey = Object.fromEntries(attrs.map((a) => [a.key, a]));
    expect(byKey['connection'].value).toBe('HL connection B');
    expect(byKey['connection'].value).not.toBe('HL connection A');
    expect(JSON.stringify(body)).not.toContain('HL connection A');
    expect(JSON.stringify(body)).not.toContain('conn-a');

    // Decisions feed is venue-scoped: the `va-1` decision is kept, the `va-a`
    // decision (other connection's venue) is filtered out.
    const feeds = body.feeds as Array<{ key: string; items: Array<{ id: string }> }>;
    const decisionsFeed = feeds.find((f) => f.key === 'decisions')!;
    const decisionIds = decisionsFeed.items.map((i) => i.id);
    expect(decisionIds).toContain('dec-1');
    expect(decisionIds).not.toContain('dec-a');
    expect(JSON.stringify(body)).not.toContain('dec-a');
  });

  it('maps ready connection to attributes + feeds with server-side emphasis', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], [ACTIVE_ASSIGNMENT]]);
    const { client } = makeDefaultClient();
    await tradingCapabilityRoutes(app, db, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/presentation` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.connection).toEqual({ id: TEST_CONNECTION_ID, label: 'HL connection', state: 'ready' });

    const attrs = body.attributes as Array<{ key: string; value: string; emphasis?: string }>;
    const byKey = Object.fromEntries(attrs.map((a) => [a.key, a]));
    expect(byKey['execution-mode'].value).toBe('paper');
    expect(byKey['authorization-mode'].value).toBe('approval_required');
    expect(byKey['capital'].value).toBe('1000.00');
    expect(byKey['capital'].emphasis).toBe('neutral');
    expect(byKey['connection'].value).toBe('HL connection');

    const feeds = body.feeds as Array<{ key: string; items: Array<{ id: string; emphasis?: string }> }>;
    const feedKeys = feeds.map((f) => f.key);
    expect(feedKeys).toEqual(['positions', 'decisions', 'fills']);

    // Negative realizedPnl position → 'negative' emphasis.
    const positionsFeed = feeds.find((f) => f.key === 'positions')!;
    expect(positionsFeed.items[0].id).toBe('pos-neg');
    expect(positionsFeed.items[0].emphasis).toBe('negative');

    const decisionsFeed = feeds.find((f) => f.key === 'decisions')!;
    expect(decisionsFeed.items[0].title).toBe('go long');
    expect(decisionsFeed.items[0].detail).toBe('BTC-USD');

    const fillsFeed = feeds.find((f) => f.key === 'fills')!;
    expect(fillsFeed.items[0].title).toBe('buy BTC-PERP');
    expect(fillsFeed.items[0].emphasis).toBe('positive');
  });

  it('marks capital emphasis as warning when capitalAvailable is false', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], [ACTIVE_ASSIGNMENT]]);
    const { client } = makeReadClient({
      onTool: (toolName) => {
        const summary = {
          ok: true,
          agentId: TEST_AGENT_ID,
          capital: null,
          capitalAvailable: false,
          executionMode: 'paper',
          positionSizeMode: 'fixed',
          openPositionCount: 0,
          positions: [],
        };
        const payloadMap: Record<string, unknown> = {
          get_account_summary: summary,
          get_agent_positions: { ok: true, positions: [] },
          get_agent_decisions: { ok: true, decisions: [] },
          get_agent_fills: { ok: true, fills: [] },
        };
        return { kind: 'success', requestId: 'r', correlationId: 'c', payload: payloadMap[toolName] ?? {} } as TradertonClientResult;
      },
    });
    await tradingCapabilityRoutes(app, db, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/presentation` });
    expect(res.statusCode).toBe(200);
    const attrs = res.json().attributes as Array<{ key: string; value: string; emphasis?: string }>;
    const capital = attrs.find((a) => a.key === 'capital')!;
    expect(capital.value).toBe('Not set');
    expect(capital.emphasis).toBe('warning');
  });

  it('surfaces warnings attribute with warning emphasis', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], [ACTIVE_ASSIGNMENT]]);
    const { client } = makeReadClient({
      onTool: (toolName) => {
        const summary = {
          ok: true,
          agentId: TEST_AGENT_ID,
          capital: '1000.00',
          capitalAvailable: true,
          executionMode: 'paper',
          positionSizeMode: 'fixed',
          openPositionCount: 0,
          positions: [],
          warnings: ['risk_contract_unavailable'],
        };
        const payloadMap: Record<string, unknown> = {
          get_account_summary: summary,
          get_agent_positions: { ok: true, positions: [] },
          get_agent_decisions: { ok: true, decisions: [] },
          get_agent_fills: { ok: true, fills: [] },
        };
        return { kind: 'success', requestId: 'r', correlationId: 'c', payload: payloadMap[toolName] ?? {} } as TradertonClientResult;
      },
    });
    await tradingCapabilityRoutes(app, db, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/presentation` });
    expect(res.statusCode).toBe(200);
    const attrs = res.json().attributes as Array<{ key: string; value: string; emphasis?: string }>;
    const warnings = attrs.find((a) => a.key === 'warnings')!;
    expect(warnings.value).toBe('risk_contract_unavailable');
    expect(warnings.emphasis).toBe('warning');
  });

  it('returns 404 for a non-trading family', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW]]);
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/payments/presentation` });
    expect(res.statusCode).toBe(404);
    expect(res.json<Record<string, unknown>>()['error']).toBe('capability.not_found');
  });

  it('returns 404 for an agent the requestor does not own', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[]]); // no agent row
    await tradingCapabilityRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/presentation` });
    expect(res.statusCode).toBe(404);
    expect(res.json<Record<string, unknown>>()['error']).toBe('agent.not_found');
  });

  it('returns 503 (not empty) on a boundary transport failure', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], [ACTIVE_ASSIGNMENT]]);
    const { client } = makeReadClient({
      onTool: () => ({ kind: 'transport_error', requestId: 'r', retryable: true, message: 'boom' } as TradertonClientResult),
    });
    await tradingCapabilityRoutes(app, db, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/presentation` });
    expect(res.statusCode).toBe(503);
    expect(res.json<Record<string, unknown>>()['error']).toBe('precondition.not_ready');
  });
});