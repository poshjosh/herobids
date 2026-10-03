import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { tradingCapabilityRoutes as registerTradingCapabilityRoutesImpl } from './trading.js';
import type { ExternalBackendClient, ExternalBackendClientResult } from '@herobids/domain/external-backend';

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
  tradertonReadClient?: ExternalBackendClient,
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
  onTool?: (toolName: string, payload: unknown) => ExternalBackendClientResult;
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
    } as ExternalBackendClientResult);
  });
  return { client: { invoke } as unknown as ExternalBackendClient, invoke };
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
    // `status: null` models a decision with no execution plan → badge "Not executed".
    { id: 'dec-1', intent: 'go_long', instrumentId: 'BTC-USD', createdAt: NOW_ISO, status: null, venueAccountId: 'va-1' },
    { id: 'dec-a', intent: 'go_short', instrumentId: 'ETH-USD', createdAt: NOW_ISO, status: 'failed', venueAccountId: 'va-a' },
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
      return { kind: 'success', requestId: 'r', correlationId: 'c', payload: payloadMap[toolName] ?? {} } as ExternalBackendClientResult;
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

    const attrs = body.attributes as Array<{ key: string; value: string; emphasis?: string; prominence?: string; labelKey?: string }>;
    const byKey = Object.fromEntries(attrs.map((a) => [a.key, a]));
    // Secondary account attributes (now inside the Details disclosure) keep their values.
    expect(byKey['execution-mode'].value).toBe('paper');
    expect(byKey['execution-mode'].prominence).toBe('secondary');
    expect(byKey['authorization-mode'].value).toBe('approval_required');
    expect(byKey['capital'].value).toBe('1000.00');
    expect(byKey['capital'].emphasis).toBe('neutral');
    expect(byKey['capital'].prominence).toBe('secondary');
    expect(byKey['connection'].value).toBe('HL connection');

    // Primary P&L summary tiles. The fixture has one closed position (realized
    // -4.00) and no open rows, so unrealized is +0.00 and the total is -4.00.
    expect(byKey['total-pnl'].prominence).toBe('primary');
    expect(byKey['total-pnl'].labelKey).toBe('capability.trading.attr.totalPnl');
    expect(byKey['total-pnl'].value).toBe('-4.00');
    expect(byKey['total-pnl'].emphasis).toBe('negative');
    expect(byKey['realized-pnl'].value).toBe('-4.00');
    expect(byKey['unrealized-pnl'].value).toBe('0.00');
    expect(byKey['winning-trades'].value).toBe('0 of 1');
    expect(byKey['winning-trades'].emphasis).toBe('neutral');

    const feeds = body.feeds as Array<{
      key: string;
      prominence?: string;
      labelKey?: string;
      columns?: Array<{ key: string }>;
      items: Array<{
        id: string;
        title: string;
        detail?: string;
        emphasis?: string;
        titleKey?: string;
        badge?: { value: string; valueKey?: string; emphasis?: string };
        cells?: Record<string, { value: string; valueKey?: string; emphasis?: string }>;
      }>;
    }>;
    const feedKeys = feeds.map((f) => f.key);
    expect(feedKeys).toEqual(['trades', 'decisions', 'fills']);

    // Trades table: the closed position renders a Closed status cell, a negative
    // P&L cell (realized -4.00), and a direction inferred from the closing fill
    // (`buy` close → the trade was short). Size is '—' for a closed row.
    const tradesFeed = feeds.find((f) => f.key === 'trades')!;
    expect(tradesFeed.prominence).toBe('primary');
    expect(tradesFeed.columns?.map((c) => c.key)).toEqual([
      'when', 'asset', 'direction', 'size', 'entryPrice', 'exitPrice', 'pnl', 'heldFor', 'status',
    ]);
    const tradeRow = tradesFeed.items[0]!;
    expect(tradeRow.id).toBe('pos-neg');
    expect(tradeRow.emphasis).toBe('negative');
    expect(tradeRow.cells!['status']!.valueKey).toBe('capability.trading.value.closed');
    expect(tradeRow.cells!['pnl']!.value).toBe('-4.00');
    expect(tradeRow.cells!['pnl']!.emphasis).toBe('negative');
    expect(tradeRow.cells!['direction']!.valueKey).toBe('capability.trading.value.short');
    expect(tradeRow.cells!['size']!.value).toBe('—');

    // Decisions stay a list; the badge carries the plan status (fixture has no
    // plan → "Not executed", neutral).
    const decisionsFeed = feeds.find((f) => f.key === 'decisions')!;
    expect(decisionsFeed.prominence).toBe('secondary');
    expect(decisionsFeed.items[0]!.title).toBe('go long');
    expect(decisionsFeed.items[0]!.titleKey).toBe('capability.trading.intent.go_long');
    expect(decisionsFeed.items[0]!.detail).toBe('BTC-USD');
    expect(decisionsFeed.items[0]!.badge!.valueKey).toBe('capability.trading.decisionStatus.none');
    expect(decisionsFeed.items[0]!.badge!.emphasis).toBe('neutral');

    // Fills table: positive realizedPnlDelta → positive emphasis on the P&L cell.
    const fillsFeed = feeds.find((f) => f.key === 'fills')!;
    expect(fillsFeed.prominence).toBe('secondary');
    expect(fillsFeed.items[0]!.title).toBe('buy BTC-PERP');
    expect(fillsFeed.items[0]!.cells!['side']!.valueKey).toBe('capability.trading.value.buy');
    expect(fillsFeed.items[0]!.cells!['pnl']!.emphasis).toBe('positive');
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
        return { kind: 'success', requestId: 'r', correlationId: 'c', payload: payloadMap[toolName] ?? {} } as ExternalBackendClientResult;
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
        return { kind: 'success', requestId: 'r', correlationId: 'c', payload: payloadMap[toolName] ?? {} } as ExternalBackendClientResult;
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
      onTool: () => ({ kind: 'transport_error', requestId: 'r', retryable: true, message: 'boom' } as ExternalBackendClientResult),
    });
    await tradingCapabilityRoutes(app, db, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/presentation` });
    expect(res.statusCode).toBe(503);
    expect(res.json<Record<string, unknown>>()['error']).toBe('precondition.not_ready');
  });

  /**
   * Build a success client whose feeds are driven by the supplied positions /
   * fills (summary stays ready, decisions empty). Lets the mark-path tests seed
   * open positions carrying `unrealizedPnl`/`markPrice`/`markedAt`.
   */
  function makeMarksClient(input: { positions: unknown[]; fills?: unknown[] }) {
    const summary = {
      ok: true,
      agentId: TEST_AGENT_ID,
      capital: '1000.00',
      capitalAvailable: true,
      executionMode: 'paper',
      positionSizeMode: 'fixed',
      openPositionCount: 1,
      positions: [],
    };
    const payloadMap: Record<string, unknown> = {
      get_account_summary: summary,
      get_agent_positions: { ok: true, positions: input.positions },
      get_agent_decisions: { ok: true, decisions: [] },
      get_agent_fills: { ok: true, fills: input.fills ?? [] },
    };
    return makeReadClient({
      onTool: (toolName) =>
        ({ kind: 'success', requestId: 'r', correlationId: 'c', payload: payloadMap[toolName] ?? {} } as ExternalBackendClientResult),
    });
  }

  /** A full open position row (closedAt null) for the `va-1` venue account. */
  function openPositionRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'pos-open',
      venueAccountId: 'va-1',
      actorType: 'agent',
      actorId: TEST_AGENT_ID,
      venue: 'hyperliquid',
      symbol: 'ETH-PERP',
      instrumentId: null,
      side: 'long',
      size: '2',
      entryPrice: '3000',
      realizedPnl: '0.000000',
      markSource: 'oracle',
      exitReason: null,
      stopLoss: null,
      takeProfit: null,
      openedAt: NOW_ISO,
      closedAt: null,
      updatedAt: NOW_ISO,
      ...overrides,
    };
  }

  it('shows signed unrealized P&L and realized+unrealized total for an open marked position', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], [ACTIVE_ASSIGNMENT]]);
    // One CLOSED position (realized -4.00) + one OPEN position carrying a mark
    // (unrealized +15.00). Total = realized(-4) + unrealized(+15) = +11.00.
    const closed = {
      id: 'pos-closed',
      venueAccountId: 'va-1',
      actorType: 'agent',
      actorId: TEST_AGENT_ID,
      venue: 'hyperliquid',
      symbol: 'BTC-PERP',
      instrumentId: null,
      side: 'flat',
      size: '0',
      entryPrice: '50000',
      realizedPnl: '-4.000000',
      markSource: 'last_fill',
      exitReason: null,
      stopLoss: null,
      takeProfit: null,
      openedAt: NOW_ISO,
      closedAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };
    const open = openPositionRow({
      unrealizedPnl: '15.000000',
      markPrice: '3100',
      markedAt: NOW_ISO,
    });
    const { client } = makeMarksClient({ positions: [closed, open] });
    await tradingCapabilityRoutes(app, db, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/presentation` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const attrs = body.attributes as Array<{ key: string; value: string; emphasis?: string; labelKey?: string }>;
    const byKey = Object.fromEntries(attrs.map((a) => [a.key, a]));
    expect(byKey['unrealized-pnl'].value).toBe('+15.00');
    expect(byKey['unrealized-pnl'].emphasis).toBe('positive');
    expect(byKey['total-pnl'].value).toBe('+11.00');
    expect(byKey['total-pnl'].emphasis).toBe('positive');
    expect(byKey['total-pnl'].labelKey).toBe('capability.trading.attr.totalPnl');

    // The open position's trade row: P&L from unrealizedPnl, Exit '—', Status
    // Open, Size from the row (not '—').
    const feeds = body.feeds as Array<{ key: string; items: Array<{ id: string; cells?: Record<string, { value: string; valueKey?: string; emphasis?: string }> }> }>;
    const tradesFeed = feeds.find((f) => f.key === 'trades')!;
    const openRow = tradesFeed.items.find((i) => i.id === 'pos-open')!;
    expect(openRow.cells!['pnl']!.value).toBe('+15.00');
    expect(openRow.cells!['pnl']!.emphasis).toBe('positive');
    expect(openRow.cells!['exitPrice']!.value).toBe('—');
    expect(openRow.cells!['status']!.valueKey).toBe('capability.trading.value.open');
    expect(openRow.cells!['size']!.value).toBe('2');
    expect(openRow.cells!['size']!.value).not.toBe('—');
  });

  it('renders a neutral em-dash unrealized tile and closed-only total when an open mark is missing', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], [ACTIVE_ASSIGNMENT]]);
    const open = openPositionRow({ unrealizedPnl: null, markPrice: null, markedAt: null });
    const { client } = makeMarksClient({ positions: [open] });
    await tradingCapabilityRoutes(app, db, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/presentation` });
    expect(res.statusCode).toBe(200);
    const attrs = res.json().attributes as Array<{ key: string; value: string; emphasis?: string; labelKey?: string }>;
    const byKey = Object.fromEntries(attrs.map((a) => [a.key, a]));
    expect(byKey['unrealized-pnl'].value).toBe('—');
    expect(byKey['unrealized-pnl'].emphasis).toBe('neutral');
    // Realized-only total, relabelled "closed trades only" (never a partial sum).
    expect(byKey['total-pnl'].labelKey).toBe('capability.trading.attr.totalPnlClosedOnly');
  });

  it('computes totals over the full scoped set while the trades table is capped by limit', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], [ACTIVE_ASSIGNMENT]]);
    // Seed 3 CLOSED winning positions, each realized +10.00. Query limit=2 so the
    // table shows 2 rows while the totals (+30.00, 3 of 3 wins) span all 3.
    const positions = [0, 1, 2].map((i) => ({
      id: `pos-win-${i}`,
      venueAccountId: 'va-1',
      actorType: 'agent',
      actorId: TEST_AGENT_ID,
      venue: 'hyperliquid',
      symbol: `SYM-${i}`,
      instrumentId: null,
      side: 'flat',
      size: '0',
      entryPrice: '100',
      realizedPnl: '10.000000',
      markSource: 'last_fill',
      exitReason: null,
      stopLoss: null,
      takeProfit: null,
      // Stagger openedAt so the newest-first slice is deterministic.
      openedAt: new Date(`2026-02-0${i + 1}T00:00:00.000Z`).toISOString(),
      closedAt: new Date(`2026-02-0${i + 1}T01:00:00.000Z`).toISOString(),
      updatedAt: NOW_ISO,
    }));
    const { client } = makeMarksClient({ positions });
    await tradingCapabilityRoutes(app, db, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/presentation?limit=2` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const attrs = body.attributes as Array<{ key: string; value: string }>;
    const byKey = Object.fromEntries(attrs.map((a) => [a.key, a]));
    expect(byKey['realized-pnl'].value).toBe('+30.00');
    expect(byKey['winning-trades'].value).toBe('3 of 3');

    const feeds = body.feeds as Array<{ key: string; items: unknown[] }>;
    const tradesFeed = feeds.find((f) => f.key === 'trades')!;
    expect(tradesFeed.items).toHaveLength(2);
  });

  it('excludes a different-venue position and fill from totals and both feeds', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], [ACTIVE_ASSIGNMENT]]);
    // One in-scope closed win (+10) on va-1, one OTHER-connection position (+99)
    // on va-other, plus fills on each venue account.
    const inScope = {
      id: 'pos-mine',
      venueAccountId: 'va-1',
      actorType: 'agent',
      actorId: TEST_AGENT_ID,
      venue: 'hyperliquid',
      symbol: 'BTC-PERP',
      instrumentId: null,
      side: 'flat',
      size: '0',
      entryPrice: '100',
      realizedPnl: '10.000000',
      markSource: 'last_fill',
      exitReason: null,
      stopLoss: null,
      takeProfit: null,
      openedAt: NOW_ISO,
      closedAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };
    const otherVenue = { ...inScope, id: 'pos-other', venueAccountId: 'va-other', realizedPnl: '99.000000' };
    const mineFill = { id: 'fill-mine', orderId: 'o-1', venueAccountId: 'va-1', actorType: 'agent', actorId: TEST_AGENT_ID, venue: 'hyperliquid', symbol: 'BTC-PERP', side: 'buy', quantity: '0.1', price: '100', fee: '1', feeCurrency: 'USDC', realizedPnlDelta: '1.000000', filledAt: NOW_ISO, createdAt: NOW_ISO };
    const otherFill = { ...mineFill, id: 'fill-other', venueAccountId: 'va-other' };
    const { client } = makeMarksClient({ positions: [inScope, otherVenue], fills: [mineFill, otherFill] });
    await tradingCapabilityRoutes(app, db, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/presentation` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Totals span only va-1 (+10.00), never the va-other +99.
    const attrs = body.attributes as Array<{ key: string; value: string }>;
    const byKey = Object.fromEntries(attrs.map((a) => [a.key, a]));
    expect(byKey['realized-pnl'].value).toBe('+10.00');
    expect(byKey['winning-trades'].value).toBe('1 of 1');

    const feeds = body.feeds as Array<{ key: string; items: Array<{ id: string }> }>;
    const tradeIds = feeds.find((f) => f.key === 'trades')!.items.map((i) => i.id);
    expect(tradeIds).toEqual(['pos-mine']);
    const fillIds = feeds.find((f) => f.key === 'fills')!.items.map((i) => i.id);
    expect(fillIds).toEqual(['fill-mine']);

    expect(JSON.stringify(body)).not.toContain('pos-other');
    expect(JSON.stringify(body)).not.toContain('fill-other');
  });

  it('requests agent positions with marks included', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    const db = buildDb([[AGENT_ROW], [ACTIVE_ASSIGNMENT]]);
    const { client, invoke } = makeMarksClient({ positions: [] });
    await tradingCapabilityRoutes(app, db, client);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/capabilities/trading/presentation` });
    expect(res.statusCode).toBe(200);

    const positionsCall = invoke.mock.calls.find((c) => (c[0] as { toolName: string }).toolName === 'get_agent_positions');
    expect(positionsCall).toBeDefined();
    expect((positionsCall![0] as { payload: unknown }).payload).toEqual({ includeMarks: true });
  });
});