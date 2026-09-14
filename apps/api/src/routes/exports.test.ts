import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { exportRoutes, clearRateLimitStore } from './exports.js';
import type { Database } from '@herobids/db';
import type { TradertonClient, TradertonClientResult } from '@herobids/domain/traderton';

const TEST_USER_ID = 'user-1';
const TEST_BOT_ID = 'bot-1';
const TEST_AGENT_ID = 'agent-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = 'free';
  });
}

const now = new Date('2026-01-15T10:00:00Z');

const sampleFill = {
  id: 'fill-1',
  orderId: 'order-1',
  venueAccountId: 'va-1',
  actorType: 'bot',
  actorId: TEST_BOT_ID,
  venueRefId: 'ref-1',
  venue: 'hyperliquid',
  symbol: 'BTC-PERP',
  side: 'buy',
  quantity: '0.1',
  price: '50000',
  fee: '5.00',
  feeCurrency: 'USDC',
  filledAt: now,
  createdAt: now,
};

const samplePosition = {
  id: 'pos-1',
  venueAccountId: 'va-1',
  actorType: 'bot',
  actorId: TEST_BOT_ID,
  venue: 'hyperliquid',
  symbol: 'BTC-PERP',
  side: 'long',
  size: '0',
  entryPrice: '50000',
  realizedPnl: '100.00',
  markSource: 'last_fill',
  openedAt: now,
  closedAt: now,
  updatedAt: now,
};

const sampleJournalEvent = {
  id: 'ev-1',
  actorType: 'bot',
  actorId: TEST_BOT_ID,
  backtestRunId: null,
  type: 'order.filled',
  payload: { orderId: 'order-1' },
  createdAt: now,
};

const sampleAgentFill = {
  id: 'fill-agent-1',
  orderId: 'order-agent-1',
  venueAccountId: 'va-agent-1',
  actorType: 'agent',
  actorId: TEST_AGENT_ID,
  venueRefId: 'ref-agent-1',
  venue: 'hyperliquid',
  symbol: 'ETH-PERP',
  side: 'sell',
  quantity: '1.5',
  price: '3200',
  fee: '2.40',
  feeCurrency: 'USDC',
  filledAt: now,
  createdAt: now,
};

const sampleAgentPosition = {
  id: 'pos-agent-1',
  venueAccountId: 'va-agent-1',
  actorType: 'agent',
  actorId: TEST_AGENT_ID,
  venue: 'hyperliquid',
  symbol: 'ETH-PERP',
  side: 'short',
  size: '1.5',
  entryPrice: '3200',
  realizedPnl: '-50.00',
  markSource: 'last_fill',
  openedAt: now,
  closedAt: null,
  updatedAt: now,
};

const sampleAgentJournalEvent = {
  id: 'ev-agent-1',
  actorType: 'agent',
  actorId: TEST_AGENT_ID,
  backtestRunId: null,
  type: 'decision.submitted',
  payload: { intent: 'go_short', symbol: 'ETH-PERP' },
  createdAt: now,
};

function buildDb(selectSequence: unknown[][]): Database {
  let i = 0;

  const makeChain = (value: unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit', 'offset']) {
      self[m] = vi.fn(() => self);
    }
    // Make it thenable
    (self as { then: unknown }).then = (
      resolve: (v: unknown) => unknown,
      reject?: (v: unknown) => unknown,
    ) => Promise.resolve(value).then(resolve, reject);
    return self;
  };

  return {
    select: vi.fn().mockImplementation(() => {
      const val = selectSequence[i++] ?? [];
      return makeChain(val as unknown[]);
    }),
  } as unknown as Database;
}

// ─── Traderton read-boundary stub for AGENT trading-evidence endpoints ─────────
//
// The agent trades/journal/costs/bundle endpoints now source fills/journal/
// positions over the Traderton read boundary. The boundary returns tool payloads
// as JSON, so date columns arrive as ISO strings (the seam rehydrates them to
// Date). These ISO-shaped samples mirror the DB-shaped samples above.

const nowIso = now.toISOString();

const sampleAgentFillIso = { ...sampleAgentFill, filledAt: nowIso, createdAt: nowIso };
const sampleBotFillIso = { ...sampleFill, filledAt: nowIso, createdAt: nowIso };
const sampleAgentPositionIso = { ...sampleAgentPosition, openedAt: nowIso, closedAt: null, updatedAt: nowIso };
const sampleBotPositionIso = { ...samplePosition, openedAt: nowIso, closedAt: nowIso, updatedAt: nowIso };
const sampleAgentJournalEventIso = { ...sampleAgentJournalEvent, createdAt: nowIso };
const sampleBotJournalEventIso = { ...sampleJournalEvent, createdAt: nowIso };

/** Which agent-scoped read tool an invocation targets. */
type ReadToolPayloads = {
  get_agent_fills?: unknown[];
  get_agent_journal_events?: unknown[];
  get_agent_positions?: unknown[];
};

/**
 * Build a stub Traderton read client whose `invoke` returns a success payload
 * with the given rows per tool (keyed by the tool's array field). Every call
 * records the bound subject so tests can assert the per-request user subject.
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

/** A read client whose `invoke` resolves to a scripted non-success result. */
function makeFailingReadClient(result: TradertonClientResult): {
  client: TradertonClient;
  invoke: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn().mockResolvedValue(result);
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRateLimitStore();
});

// ─── Bot trade exports ───────────────────────────────────────────────────────

describe('GET /bots/:id/export/trades', () => {
  it('returns CSV by default for a bot with fills', async () => {
    const db = buildDb([[{ id: TEST_BOT_ID }], [sampleFill]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/export/trades` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const body = res.body;
    expect(body).toContain('date,side,symbol,quantity,price,pnl,fee,sessionId');
    expect(body).toContain('BTC-PERP');
    expect(body).toContain('buy');
  });

  it('returns JSON when format=json', async () => {
    const db = buildDb([[{ id: TEST_BOT_ID }], [sampleFill]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/export/trades?format=json` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json<unknown[]>();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toMatchObject({ symbol: 'BTC-PERP', side: 'buy' });
  });

  it('returns 404 for unknown bot', async () => {
    const db = buildDb([[]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/bots/unknown/export/trades' });
    expect(res.statusCode).toBe(404);
  });

  it('returns empty CSV with headers for zero-trade bot', async () => {
    const db = buildDb([[{ id: TEST_BOT_ID }], []]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/export/trades` });
    expect(res.statusCode).toBe(200);
    // Should return just the headers line, not 404
    expect(res.body).toBe('date,side,symbol,quantity,price,pnl,fee,sessionId');
  });

  it('returns 400 for invalid format', async () => {
    const db = buildDb([[{ id: TEST_BOT_ID }]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/export/trades?format=xlsx` });
    expect(res.statusCode).toBe(400);
  });
});

// ─── Bot journal exports ──────────────────────────────────────────────────────

describe('GET /bots/:id/export/journal', () => {
  it('returns JSON journal by default', async () => {
    const db = buildDb([[{ id: TEST_BOT_ID }], [sampleJournalEvent]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/export/journal` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json<unknown[]>();
    expect(Array.isArray(body)).toBe(true);
  });

  it('returns Markdown when format=md', async () => {
    const db = buildDb([[{ id: TEST_BOT_ID }], [sampleJournalEvent]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/export/journal?format=md` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/markdown/);
    expect(res.body).toContain('# Journal Export');
    expect(res.body).toContain('order.filled');
  });
});

// ─── Bot config export ────────────────────────────────────────────────────────

describe('GET /bots/:id/export/config', () => {
  const botConfig = { strategy: { type: 'momentum' }, execution: { mode: 'paper' }, secret: 'should-be-redacted' };

  it('returns JSON config without sensitive fields', async () => {
    const db = buildDb([[{ id: TEST_BOT_ID, config: botConfig }]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/export/config` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json<Record<string, unknown>>();
    expect(body['secret']).toBe('[redacted]');
    expect(body['strategy']).toBeDefined();
  });

  it('returns YAML when format=yaml', async () => {
    const db = buildDb([[{ id: TEST_BOT_ID, config: botConfig }]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/export/config?format=yaml` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/yaml/);
    expect(res.body).toContain('strategy:');
  });

  it('has Content-Disposition header', async () => {
    const db = buildDb([[{ id: TEST_BOT_ID, config: botConfig }]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/export/config` });
    expect(res.headers['content-disposition']).toContain('attachment');
  });
});

// ─── Bot report export ────────────────────────────────────────────────────────

describe('GET /bots/:id/export/report', () => {
  it('returns JSON report with tradeCount and totalPnl from positions', async () => {
    // bot lookup, then Promise.all([fills, positions])
    const db = buildDb([[{ id: TEST_BOT_ID }], [sampleFill], [samplePosition]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/export/report` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['tradeCount']).toBe(1);
    expect('sharpeRatio' in body).toBe(true);
    expect('winRate' in body).toBe(true);
    // With one closed position with realizedPnl=100, totalPnl should be 100
    expect(body['totalPnl']).toBeCloseTo(100);
  });

  it('returns winRate=null and totalPnl=null with zero positions', async () => {
    const db = buildDb([[{ id: TEST_BOT_ID }], [], []]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/export/report` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['totalPnl']).toBeNull();
    expect(body['winRate']).toBeNull();
  });

  it('computes winRate correctly with multiple winning positions', async () => {
    const winPos = { ...samplePosition, id: 'p1', realizedPnl: '50', closedAt: now };
    const lossPos = { ...samplePosition, id: 'p2', realizedPnl: '-20', closedAt: now };
    const db = buildDb([[{ id: TEST_BOT_ID }], [], [winPos, lossPos]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/export/report` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    // 1 win out of 2 = 0.5
    expect(body['winRate']).toBeCloseTo(0.5);
    expect(body['totalPnl']).toBeCloseTo(30);
  });

  it('returns CSV report when format=csv', async () => {
    const db = buildDb([[{ id: TEST_BOT_ID }], [sampleFill], [samplePosition]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/export/report?format=csv` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.body).toContain('tradeCount');
  });
});

// ─── Bot bundle export ────────────────────────────────────────────────────────

/** Read filenames from a ZIP buffer using the central directory. */
function readZipFilenames(zipBuf: Buffer): string[] {
  const names: string[] = [];
  // Scan for local file header signatures (PK\x03\x04)
  let offset = 0;
  while (offset < zipBuf.length - 4) {
    if (
      zipBuf[offset] === 0x50 && zipBuf[offset + 1] === 0x4b &&
      zipBuf[offset + 2] === 0x03 && zipBuf[offset + 3] === 0x04
    ) {
      const nameLen = zipBuf.readUInt16LE(offset + 26);
      const extraLen = zipBuf.readUInt16LE(offset + 28);
      const name = zipBuf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
      names.push(name);
      const compressedSize = zipBuf.readUInt32LE(offset + 18);
      offset += 30 + nameLen + extraLen + compressedSize;
    } else {
      offset++;
    }
  }
  return names;
}

describe('GET /bots/:id/export/bundle', () => {
  it('returns a ZIP file with correct content-type', async () => {
    // bot lookup + Promise.all([fills, journal, positions])
    const db = buildDb([[{ id: TEST_BOT_ID, config: {} }], [sampleFill], [sampleJournalEvent], [samplePosition]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/export/bundle` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    // Verify ZIP magic bytes: PK\x03\x04
    const rawBuf = Buffer.from(res.rawPayload);
    expect(rawBuf[0]).toBe(0x50);
    expect(rawBuf[1]).toBe(0x4b);
  });

  it('bundle ZIP contains expected files', async () => {
    const db = buildDb([[{ id: TEST_BOT_ID, config: {} }], [sampleFill], [sampleJournalEvent], [samplePosition]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/export/bundle` });
    expect(res.statusCode).toBe(200);
    const zipBuf = Buffer.from(res.rawPayload);
    const names = readZipFilenames(zipBuf);
    expect(names).toContain('trades.csv');
    expect(names).toContain('journal.md');
    expect(names).toContain('config.yaml');
    expect(names).toContain('report.json');
  });

  it('returns 404 for unknown bot', async () => {
    const db = buildDb([[]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/bots/unknown/export/bundle' });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Account-level trades ─────────────────────────────────────────────────────

describe('GET /export/trades', () => {
  it('returns CSV with all user fills', async () => {
    const db = buildDb([[{ id: TEST_BOT_ID }], [sampleFill]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/export/trades' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.body).toContain('BTC-PERP');
  });

  it('returns empty CSV headers when user has no bots', async () => {
    const db = buildDb([[]]); // no bots
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/export/trades' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('date,side,symbol,quantity,price,pnl,fee,sessionId');
  });
});

// ─── Account bundle ───────────────────────────────────────────────────────────

describe('GET /export/bundle', () => {
  it('returns a ZIP file', async () => {
    // user bots + Promise.all([fills, journal, positions])
    const db = buildDb([[{ id: TEST_BOT_ID }], [sampleFill], [sampleJournalEvent], [samplePosition]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/export/bundle' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
  });

  it('account bundle ZIP contains expected files', async () => {
    const db = buildDb([[{ id: TEST_BOT_ID }], [sampleFill], [sampleJournalEvent], [samplePosition]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/export/bundle' });
    expect(res.statusCode).toBe(200);
    const zipBuf = Buffer.from(res.rawPayload);
    const names = readZipFilenames(zipBuf);
    expect(names).toContain('trades.csv');
    expect(names).toContain('journal.md');
    expect(names).toContain('report.json');
  });
});

// ─── Rate limiting ────────────────────────────────────────────────────────────

describe('export route rate limiting', () => {
  it('returns 429 on the 6th request within 1 minute', async () => {
    // Each export call needs: bot lookup + fills
    const botRow = [{ id: TEST_BOT_ID }];
    const db = buildDb([
      botRow, [], // request 1
      botRow, [], // request 2
      botRow, [], // request 3
      botRow, [], // request 4
      botRow, [], // request 5
      botRow, [], // request 6 (should be rejected before hitting db lookup)
    ]);
    const app = Fastify();
    decorateWithAuth(app, 'rate-limit-test-user');
    await exportRoutes(app, db);

    const url = `/bots/${TEST_BOT_ID}/export/trades`;
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
    }

    const res6 = await app.inject({ method: 'GET', url });
    expect(res6.statusCode).toBe(429);
    expect(res6.headers['retry-after']).toBeDefined();
  });
});

// ─── Agent exports ────────────────────────────────────────────────────────────

describe('GET /agents/:id/export/trades', () => {
  it('returns CSV with agent-native and bot fills from the read boundary', async () => {
    const db = buildDb([[{ id: TEST_AGENT_ID }]]); // owner check only — fills come over the boundary
    const { client, invoke } = makeReadClient({ get_agent_fills: [sampleAgentFillIso, sampleBotFillIso] });
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db, client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/trades` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.body).toContain('ETH-PERP');
    expect(res.body).toContain('BTC-PERP');

    // The boundary was invoked with get_agent_fills bound to the requesting
    // user's subject (per-request USER subject).
    expect(invoke).toHaveBeenCalledTimes(1);
    const arg = invoke.mock.calls[0]![0] as { toolName: string; subject: { ownerId: string; actor: { type: string; id: string } } };
    expect(arg.toolName).toBe('get_agent_fills');
    expect(arg.subject).toEqual({ ownerId: TEST_USER_ID, actor: { type: 'agent', id: TEST_AGENT_ID } });
  });

  it('returns agent-native fills when agent has no bot fills', async () => {
    const db = buildDb([[{ id: TEST_AGENT_ID }]]);
    const { client } = makeReadClient({ get_agent_fills: [sampleAgentFillIso] });
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db, client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/trades` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ETH-PERP');
  });

  it('returns JSON when format=json with rehydrated dates', async () => {
    const db = buildDb([[{ id: TEST_AGENT_ID }]]);
    const { client } = makeReadClient({ get_agent_fills: [sampleAgentFillIso] });
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db, client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/trades?format=json` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Array<Record<string, unknown>>>();
    expect(body[0]!['date']).toBe(nowIso);
    expect(body[0]!['symbol']).toBe('ETH-PERP');
  });

  it('returns 404 for unknown agent before touching the boundary', async () => {
    const db = buildDb([[]]);
    const { client, invoke } = makeReadClient({});
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db, client, 10_000);

    const res = await app.inject({ method: 'GET', url: '/agents/unknown/export/trades' });
    expect(res.statusCode).toBe(404);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns 503 when the read boundary is unconfigured', async () => {
    const db = buildDb([[{ id: TEST_AGENT_ID }]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db); // no read client

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/trades` });
    expect(res.statusCode).toBe(503);
    expect(res.json<Record<string, unknown>>()['error']).toBe('precondition.not_ready');
  });

  it('returns 503 on a boundary transport error', async () => {
    const db = buildDb([[{ id: TEST_AGENT_ID }]]);
    const { client } = makeFailingReadClient({ kind: 'transport_error', requestId: 'r', retryable: true, message: 'boundary down' });
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db, client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/trades` });
    expect(res.statusCode).toBe(503);
    expect(res.json<Record<string, unknown>>()['error']).toBe('precondition.not_ready');
  });

  it('returns 502 and surfaces the code on a terminal boundary failure', async () => {
    const db = buildDb([[{ id: TEST_AGENT_ID }]]);
    const { client } = makeFailingReadClient({
      kind: 'failure',
      requestId: 'r',
      correlationId: 'c',
      code: 'authorization.denied',
      message: 'not allowed',
      retryable: false,
    });
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db, client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/trades` });
    expect(res.statusCode).toBe(502);
    expect(res.json<Record<string, unknown>>()['error']).toBe('authorization.denied');
  });
});

describe('GET /agents/:id/export/journal', () => {
  it('returns CSV by default from the read boundary', async () => {
    const db = buildDb([[{ id: TEST_AGENT_ID }]]);
    const { client, invoke } = makeReadClient({ get_agent_journal_events: [sampleAgentJournalEventIso, sampleBotJournalEventIso] });
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db, client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/journal` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.body).toContain('id,actor_type,actor_id,type,created_at');
    expect(res.body).toContain('decision.submitted');
    expect(res.body).toContain(nowIso);

    const arg = invoke.mock.calls[0]![0] as { toolName: string };
    expect(arg.toolName).toBe('get_agent_journal_events');
  });

  it('returns Markdown when format=md', async () => {
    const db = buildDb([[{ id: TEST_AGENT_ID }]]);
    const { client } = makeReadClient({ get_agent_journal_events: [sampleAgentJournalEventIso] });
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db, client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/journal?format=md` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/markdown/);
    expect(res.body).toContain('# Journal Export');
    expect(res.body).toContain('decision.submitted');
  });

  it('returns 503 when the read boundary is unconfigured', async () => {
    const db = buildDb([[{ id: TEST_AGENT_ID }]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/journal` });
    expect(res.statusCode).toBe(503);
  });
});

describe('GET /agents/:id/export/costs', () => {
  it('returns fee totals by currency from boundary fills', async () => {
    const db = buildDb([[{ id: TEST_AGENT_ID }]]);
    const { client, invoke } = makeReadClient({ get_agent_fills: [sampleAgentFillIso, sampleBotFillIso] });
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db, client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/costs` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.body).toContain('currency,total_fees');
    // 2.40 (agent) + 5.00 (bot) = 7.40 USDC
    expect(res.body).toContain('USDC,7.4');

    const arg = invoke.mock.calls[0]![0] as { toolName: string; payload: Record<string, unknown> };
    expect(arg.toolName).toBe('get_agent_fills');
    // costs is all-time — no time filter
    expect(arg.payload).toEqual({});
  });

  it('returns just the header for an agent with no fills', async () => {
    const db = buildDb([[{ id: TEST_AGENT_ID }]]);
    const { client } = makeReadClient({ get_agent_fills: [] });
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db, client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/costs` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('currency,total_fees\n');
  });

  it('returns 503 when the read boundary is unconfigured', async () => {
    const db = buildDb([[{ id: TEST_AGENT_ID }]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/costs` });
    expect(res.statusCode).toBe(503);
  });
});

describe('GET /agents/:id/export/config', () => {
  it('returns sanitized agent config as JSON', async () => {
    const db = buildDb([[{
      id: TEST_AGENT_ID,
      name: 'my agent',
      prompt: 'trade BTC',
      skillIds: ['trading'],
      executionMode: 'paper',
      dailyTokenBudget: 1000,
      dailyLossLimit: null,
      maxBots: 5,
      maxSlippageBps: 50,
      createdAt: now,
    }]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/config` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['name']).toBe('my agent');
    expect(body['prompt']).toBe('trade BTC');
  });
});

describe('GET /agents/:id/export/bundle', () => {
  // DB reads: agent lookup, skills, then (sessions — local). Fills / positions /
  // journal come over the read boundary; sessions stays a LOCAL loader read.
  const agentRow = { id: TEST_AGENT_ID, name: 'ag', prompt: 'p', skillIds: [], executionMode: null, dailyTokenBudget: null, dailyLossLimit: null, maxBots: null, maxSlippageBps: null, createdAt: now };

  const bundleDb = () => buildDb([
    [agentRow], // agent lookup
    [],         // skills
    [],         // loadAgentRuntimeSessions (local)
  ]);

  const bundlePayloads = () => ({
    get_agent_fills: [sampleAgentFillIso, sampleBotFillIso],
    get_agent_positions: [sampleAgentPositionIso, sampleBotPositionIso],
    get_agent_journal_events: [sampleAgentJournalEventIso, sampleBotJournalEventIso],
  });

  it('returns a JSON bundle', async () => {
    const { client } = makeReadClient(bundlePayloads());
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, bundleDb(), client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/bundle` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('agent bundle JSON contains expected keys and sources sessions locally', async () => {
    const { client, invoke } = makeReadClient(bundlePayloads());
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, bundleDb(), client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/bundle` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toHaveProperty('agent');
    expect(body).toHaveProperty('trades');
    expect(body).toHaveProperty('journal');
    expect(body).toHaveProperty('sessions');
    expect(body).toHaveProperty('exportedAt');

    // Trading evidence over the boundary (fills, positions, journal) — sessions
    // is NOT one of them (it stays a local loader read).
    const tools = invoke.mock.calls.map((c) => (c[0] as { toolName: string }).toolName);
    expect(tools).toEqual(['get_agent_fills', 'get_agent_positions', 'get_agent_journal_events']);
  });

  it('includes agent-native fills when agent has no bots', async () => {
    const { client } = makeReadClient({
      get_agent_fills: [sampleAgentFillIso],
      get_agent_positions: [sampleAgentPositionIso],
      get_agent_journal_events: [sampleAgentJournalEventIso],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, bundleDb(), client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/bundle` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    const trades = body['trades'] as Array<Record<string, unknown>>;
    expect(trades).toHaveLength(1);
    expect(trades[0]!['symbol']).toBe('ETH-PERP');
    // dates round-trip back to the same ISO strings (byte parity)
    expect(trades[0]!['filledAt']).toBe(nowIso);
  });

  it('includes both agent-native and bot fills in trades', async () => {
    const { client } = makeReadClient(bundlePayloads());
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, bundleDb(), client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/bundle` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    const trades = body['trades'] as Array<Record<string, unknown>>;
    expect(trades).toHaveLength(2);
    const symbols = trades.map((t) => t['symbol']);
    expect(symbols).toContain('ETH-PERP');
    expect(symbols).toContain('BTC-PERP');
  });

  it('returns 503 when the read boundary is unconfigured', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, bundleDb());

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/bundle` });
    expect(res.statusCode).toBe(503);
  });

  it('returns 502 when a boundary read fails', async () => {
    const { client } = makeFailingReadClient({
      kind: 'failure', requestId: 'r', correlationId: 'c', code: 'not_found.resource', message: 'nope', retryable: false,
    });
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, bundleDb(), client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/bundle` });
    expect(res.statusCode).toBe(502);
  });
});
