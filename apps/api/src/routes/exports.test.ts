import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { exportRoutes, clearRateLimitStore } from './exports.js';
import type { Database } from '@herobids/db';

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
  it('returns CSV with agent-native and bot fills', async () => {
    // agent lookup + agent bots + agentFills + botFills
    const db = buildDb([
      [{ id: TEST_AGENT_ID }],
      [{ id: TEST_BOT_ID }],
      [sampleAgentFill],
      [sampleFill],
    ]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/trades` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.body).toContain('ETH-PERP');
    expect(res.body).toContain('BTC-PERP');
  });

  it('returns agent-native fills when agent has no bots', async () => {
    // agent lookup + agent bots (empty) + agentFills + botFills (skipped)
    const db = buildDb([
      [{ id: TEST_AGENT_ID }],
      [],
      [sampleAgentFill],
    ]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/trades` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ETH-PERP');
  });

  it('returns 404 for unknown agent', async () => {
    const db = buildDb([[]]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/agents/unknown/export/trades' });
    expect(res.statusCode).toBe(404);
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
  // Query order: agents, skills, bots, agentFills, botFills, agentPositions, botPositions, agentJournal, botJournal, sessions
  it('returns a JSON bundle', async () => {
    const agentRow = { id: TEST_AGENT_ID, name: 'ag', prompt: 'p', skillIds: [], executionMode: null, dailyTokenBudget: null, dailyLossLimit: null, maxBots: null, maxSlippageBps: null, createdAt: now };
    const db = buildDb([
      [agentRow],
      [],                    // skills
      [{ id: TEST_BOT_ID }], // agent bots
      [sampleAgentFill],     // agentFills
      [sampleFill],          // botFills
      [sampleAgentPosition], // agentPositions
      [samplePosition],      // botPositions
      [sampleAgentJournalEvent], // agentJournal
      [sampleJournalEvent],  // botJournal
      [],                    // sessions
    ]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/bundle` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('agent bundle JSON contains expected keys', async () => {
    const agentRow = { id: TEST_AGENT_ID, name: 'ag', prompt: 'p', skillIds: [], executionMode: null, dailyTokenBudget: null, dailyLossLimit: null, maxBots: null, maxSlippageBps: null, createdAt: now };
    const db = buildDb([
      [agentRow],
      [],
      [{ id: TEST_BOT_ID }],
      [sampleAgentFill],
      [sampleFill],
      [sampleAgentPosition],
      [samplePosition],
      [sampleAgentJournalEvent],
      [sampleJournalEvent],
      [],
    ]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/bundle` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toHaveProperty('agent');
    expect(body).toHaveProperty('trades');
    expect(body).toHaveProperty('journal');
    expect(body).toHaveProperty('sessions');
    expect(body).toHaveProperty('exportedAt');
  });

  it('includes agent-native fills when agent has no bots', async () => {
    const agentRow = { id: TEST_AGENT_ID, name: 'ag', prompt: 'p', skillIds: [], executionMode: null, dailyTokenBudget: null, dailyLossLimit: null, maxBots: null, maxSlippageBps: null, createdAt: now };
    const db = buildDb([
      [agentRow],
      [],                    // skills
      [],                    // agent bots (none)
      [sampleAgentFill],     // agentFills
      // botFills skipped (no bots)
      [sampleAgentPosition], // agentPositions
      // botPositions skipped
      [sampleAgentJournalEvent], // agentJournal
      // botJournal skipped
      [],                    // sessions
    ]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/bundle` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    const trades = body['trades'] as Array<Record<string, unknown>>;
    expect(trades).toHaveLength(1);
    expect(trades[0]!['symbol']).toBe('ETH-PERP');
  });

  it('includes both agent-native and bot fills in trades', async () => {
    const agentRow = { id: TEST_AGENT_ID, name: 'ag', prompt: 'p', skillIds: [], executionMode: null, dailyTokenBudget: null, dailyLossLimit: null, maxBots: null, maxSlippageBps: null, createdAt: now };
    const db = buildDb([
      [agentRow],
      [],
      [{ id: TEST_BOT_ID }],
      [sampleAgentFill],     // agentFills
      [sampleFill],          // botFills
      [sampleAgentPosition], // agentPositions
      [samplePosition],      // botPositions
      [sampleAgentJournalEvent], // agentJournal
      [sampleJournalEvent],  // botJournal
      [],
    ]);
    const app = Fastify();
    decorateWithAuth(app);
    await exportRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/agents/${TEST_AGENT_ID}/export/bundle` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    const trades = body['trades'] as Array<Record<string, unknown>>;
    expect(trades).toHaveLength(2);
    const symbols = trades.map((t) => t['symbol']);
    expect(symbols).toContain('ETH-PERP');
    expect(symbols).toContain('BTC-PERP');
  });
});
