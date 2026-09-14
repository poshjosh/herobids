import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { analyticsRoutes } from './analytics.js';
import type { Database } from '@herobids/db';
import type { TradertonClient, TradertonClientResult } from '@herobids/domain/traderton';

const TEST_USER_ID = 'user-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>) {
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = TEST_USER_ID;
  });
}

const now = new Date('2026-01-15T10:00:00Z');
const nowIso = now.toISOString();

// Owner bots as returned by list_owner_bots (id + creator provenance).
const bot1Summary = { id: 'bot-1', status: 'running', strategyPreset: 'momentum', creatorType: 'user', creatorId: TEST_USER_ID };

// Per-bot RAW config returned by get_owner_bot_status.
const bot1Config = {
  ok: true,
  id: 'bot-1',
  status: 'running',
  config: { strategy: { type: 'momentum', decisionMode: 'mechanical' }, execution: { mode: 'paper' } },
};

const event1 = {
  id: 'e-1',
  actorId: 'bot-1',
  actorType: 'bot',
  type: 'decision.created',
  payload: {},
  createdAt: nowIso,
  backtestRunId: null,
};

const ethPosIso = {
  id: 'pos-1',
  actorId: 'bot-1',
  actorType: 'bot',
  symbol: 'ETH-USD',
  side: 'flat',
  size: '0',
  entryPrice: '3000',
  realizedPnl: '50',
  venue: 'hyperliquid',
  venueAccountId: 'va-1',
  openedAt: nowIso,
  closedAt: nowIso,
  updatedAt: nowIso,
  markSource: null,
  exitReason: 'signal_lost',
};

type StubPayloads = {
  bots?: unknown[];
  status?: Record<string, Record<string, unknown>>; // botId → get_owner_bot_status payload
  events?: unknown[];
  positions?: unknown[];
};

/**
 * A read client that answers each owner-scoped tool from the supplied payloads.
 * Records every invoke so tests can assert the payloads threaded to each tool.
 */
function makeReadClient(payloads: StubPayloads): { client: TradertonClient; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn().mockImplementation((input: { toolName: string; payload: Record<string, unknown> }) => {
    let result: TradertonClientResult;
    switch (input.toolName) {
      case 'list_owner_bots':
        result = { kind: 'success', requestId: 'r', correlationId: 'c', payload: { bots: payloads.bots ?? [] } };
        break;
      case 'get_owner_bot_status': {
        const botId = input.payload['botId'] as string;
        const status = payloads.status?.[botId];
        result = status
          ? { kind: 'success', requestId: 'r', correlationId: 'c', payload: status }
          : { kind: 'failure', requestId: 'r', correlationId: 'c', code: 'validation.invalid_payload', message: 'not found', retryable: false, details: { errorCode: 'not_found.resource' } };
        break;
      }
      case 'get_owner_journal':
        result = { kind: 'success', requestId: 'r', correlationId: 'c', payload: { events: payloads.events ?? [] } };
        break;
      case 'get_owner_positions':
        result = { kind: 'success', requestId: 'r', correlationId: 'c', payload: { positions: payloads.positions ?? [] } };
        break;
      default:
        result = { kind: 'success', requestId: 'r', correlationId: 'c', payload: {} };
    }
    return Promise.resolve(result);
  });
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

/** A read client that always fails at the transport layer (drives the 503 boundary path). */
function makeTransportErrorClient(): TradertonClient {
  const invoke = vi.fn().mockResolvedValue({
    kind: 'transport_error', requestId: 'r', correlationId: 'c', message: 'unreachable', retryable: true,
  } as TradertonClientResult);
  return { invoke } as unknown as TradertonClient;
}

/** Local db stub for the agents / agentRuntimeSessions reads (empty by default). */
function makeLocalDb(responses: unknown[][] = []): Database {
  let i = 0;
  const makeChain = (value: unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit', 'offset']) {
      chain[m] = vi.fn(() => chain);
    }
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
    return chain;
  };
  return {
    select: vi.fn().mockImplementation(() => makeChain(responses[i++] ?? [])),
  } as unknown as Database;
}

const READ_TIMEOUT_MS = 10_000;

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── GET /analytics ────────────────────────────────────────────────────────

describe('GET /analytics', () => {
  it('returns empty groups when the user has no bots', async () => {
    const { client } = makeReadClient({ bots: [] });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toEqual([]);
    expect(body.groupBy).toBe('day');
  });

  it('returns 400 for invalid groupBy value', async () => {
    const { client } = makeReadClient({ bots: [] });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?groupBy=month' });
    expect(res.statusCode).toBe(400);
  });

  it('returns daily groups with correct event counts', async () => {
    const { client } = makeReadClient({
      bots: [bot1Summary],
      status: { 'bot-1': bot1Config },
      events: [event1],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?groupBy=day' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].period).toBe('2026-01-15');
    expect(body.groups[0].eventCount).toBe(1);
    expect(body.groups[0].decisionCount).toBe(1);
  });

  it('decisionModes filter excludes bots with non-matching decisionMode', async () => {
    const { client } = makeReadClient({ bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [] });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    // bot1 has decisionMode=mechanical; filter to llm should exclude it
    const res = await app.inject({ method: 'GET', url: '/analytics?decisionModes=llm' });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups).toEqual([]);
  });

  it('decisionModes filter includes bots with matching decisionMode', async () => {
    const { client } = makeReadClient({ bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [event1] });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?decisionModes=mechanical' });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups.length).toBeGreaterThan(0);
  });

  it('rejects invalid decisionModes value', async () => {
    const { client } = makeReadClient({ bots: [] });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?decisionModes=shadow' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('executionModes filter excludes bots with non-matching execution mode', async () => {
    const { client } = makeReadClient({ bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [] });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    // bot1 has mode=paper; filter to live should exclude it
    const res = await app.inject({ method: 'GET', url: '/analytics?executionModes=live' });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups).toEqual([]);
  });

  it('executionModes filter includes bots with matching execution mode', async () => {
    const { client } = makeReadClient({ bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [event1] });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?executionModes=paper' });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups.length).toBeGreaterThan(0);
  });

  it('rejects invalid executionModes value', async () => {
    const { client } = makeReadClient({ bots: [] });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?executionModes=invalid' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('strategy groupBy groups events by strategy type', async () => {
    const { client } = makeReadClient({ bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [event1] });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?groupBy=strategy' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].period).toBe('momentum');
  });
});

// ─── boundary posture ────────────────────────────────────────────────────────

describe('analytics — boundary posture', () => {
  it('returns 503 precondition.not_ready when the read client is unconfigured', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb()); // no client

    const res = await app.inject({ method: 'GET', url: '/analytics' });
    expect(res.statusCode).toBe(503);
    expect(res.json<Record<string, unknown>>()['error']).toBe('precondition.not_ready');
  });

  it('POST /analytics/query returns 503 when the read client is unconfigured', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb());

    const res = await app.inject({ method: 'POST', url: '/analytics/query', payload: { groupBy: 'day' } });
    expect(res.statusCode).toBe(503);
    expect(res.json<Record<string, unknown>>()['error']).toBe('precondition.not_ready');
  });

  it('surfaces a boundary transport error as 503 precondition.not_ready', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), makeTransportErrorClient(), READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics' });
    expect(res.statusCode).toBe(503);
    expect(res.json<Record<string, unknown>>()['error']).toBe('precondition.not_ready');
  });
});

// ─── payload threading ─────────────────────────────────────────────────────

describe('analytics — threads targetBotIds / time / limit into the tool payloads', () => {
  it('passes botIds, from, to, limit to get_owner_journal and get_owner_positions', async () => {
    const { client, invoke } = makeReadClient({
      bots: [bot1Summary],
      status: { 'bot-1': bot1Config },
      events: [event1],
      positions: [ethPosIso],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-02-01T00:00:00.000Z';
    const res = await app.inject({ method: 'GET', url: `/analytics?from=${from}&to=${to}` });
    expect(res.statusCode).toBe(200);

    const journalCall = invoke.mock.calls.find((c) => (c[0] as { toolName: string }).toolName === 'get_owner_journal');
    const positionsCall = invoke.mock.calls.find((c) => (c[0] as { toolName: string }).toolName === 'get_owner_positions');
    expect(journalCall).toBeDefined();
    expect(positionsCall).toBeDefined();

    const journalPayload = (journalCall![0] as { payload: Record<string, unknown> }).payload;
    expect(journalPayload).toEqual({ botIds: ['bot-1'], from, to, limit: 10_000 });

    const positionsPayload = (positionsCall![0] as { payload: Record<string, unknown> }).payload;
    expect(positionsPayload).toEqual({ botIds: ['bot-1'], from, to, limit: 10_000 });

    // Subject is the requesting USER.
    const subject = (journalCall![0] as { subject: unknown }).subject;
    expect(subject).toEqual({ ownerId: TEST_USER_ID, actor: { type: 'user', id: TEST_USER_ID } });
  });

  it('uses the RAW config from get_owner_bot_status (not the lossy strategyPreset)', async () => {
    // list_owner_bots reports strategyPreset='momentum' but decisionMode lives only
    // in the RAW config — the decisionModes filter must read the raw config.
    const { client, invoke } = makeReadClient({
      bots: [bot1Summary],
      status: { 'bot-1': bot1Config },
      events: [event1],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?decisionModes=mechanical' });
    expect(res.statusCode).toBe(200);
    // The raw config's decisionMode=mechanical matched, so events are grouped.
    expect(res.json().groups.length).toBeGreaterThan(0);
    // get_owner_bot_status was called for the bot to obtain the raw config.
    const statusCall = invoke.mock.calls.find((c) => (c[0] as { toolName: string }).toolName === 'get_owner_bot_status');
    expect(statusCall).toBeDefined();
    expect((statusCall![0] as { payload: Record<string, unknown> }).payload).toEqual({ botId: 'bot-1' });
  });
});

// ─── POST /analytics/query ────────────────────────────────────────────────

describe('POST /analytics/query', () => {
  it('returns same result as GET with JSON body', async () => {
    const { client } = makeReadClient({ bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [event1] });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'POST', url: '/analytics/query', payload: { groupBy: 'day' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groupBy).toBe('day');
  });

  it('returns 400 for invalid body', async () => {
    const { client } = makeReadClient({ bots: [] });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'POST', url: '/analytics/query', payload: { groupBy: 'invalid' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid decisionModes value in POST body', async () => {
    const { client } = makeReadClient({ bots: [] });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'POST', url: '/analytics/query', payload: { decisionModes: ['shadow'], groupBy: 'day' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid executionModes value in POST body', async () => {
    const { client } = makeReadClient({ bots: [] });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'POST', url: '/analytics/query', payload: { executionModes: ['invalid'], groupBy: 'day' } });
    expect(res.statusCode).toBe(400);
  });

  it('botIds filter scopes results to specified bots', async () => {
    const bot2Summary = { id: 'bot-2', status: 'running', strategyPreset: 'dca', creatorType: 'user', creatorId: TEST_USER_ID };
    const bot2Config = { ok: true, id: 'bot-2', config: { strategy: { type: 'dca' }, execution: { mode: 'paper' } } };
    const { client, invoke } = makeReadClient({
      bots: [bot1Summary, bot2Summary],
      status: { 'bot-1': bot1Config, 'bot-2': bot2Config },
      events: [],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'POST', url: '/analytics/query', payload: { botIds: ['bot-2'] } });
    expect(res.statusCode).toBe(200);
    // Only bot-2 should be threaded into the journal/positions reads.
    const journalCall = invoke.mock.calls.find((c) => (c[0] as { toolName: string }).toolName === 'get_owner_journal');
    expect((journalCall![0] as { payload: Record<string, unknown> }).payload).toMatchObject({ botIds: ['bot-2'] });
  });

  it('session groupBy assigns events to no_session when no sessions exist', async () => {
    // groupBy=session needs the local agents read (empty → no sessions).
    const { client } = makeReadClient({ bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [event1] });
    const app = Fastify();
    decorateWithAuth(app);
    // Local db: agents read returns [] (no owned agents → no sessions).
    await analyticsRoutes(app, makeLocalDb([[]]), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'POST', url: '/analytics/query', payload: { groupBy: 'session' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].period).toBe('no_session');
  });
});

// ─── symbols filter & symbol groupBy ──────────────────────────────────────

const btcPosIso = { ...ethPosIso, id: 'pos-2', symbol: 'BTC-USD', realizedPnl: '200', exitReason: 'parabolic_move' };
const solPosIso = { ...ethPosIso, id: 'pos-3', symbol: 'SOL-USD', realizedPnl: '-30', exitReason: null };

describe('GET /analytics — symbols filter & groupBy', () => {
  it('filters positions by a single symbol', async () => {
    const { client } = makeReadClient({
      bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [], positions: [ethPosIso, btcPosIso],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?symbols=ETH-USD' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].realizedPnl).toBe(50);
  });

  it('filters positions by multiple symbols', async () => {
    const { client } = makeReadClient({
      bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [], positions: [ethPosIso, btcPosIso, solPosIso],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?symbols=ETH-USD&symbols=BTC-USD' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].realizedPnl).toBe(250); // 50 + 200
  });

  it('returns empty groups when no positions match the symbol filter', async () => {
    const { client } = makeReadClient({
      bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [], positions: [ethPosIso],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?symbols=SOL-USD' });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups).toEqual([]);
  });

  it('groupBy=symbol returns one group per symbol', async () => {
    const { client } = makeReadClient({
      bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [], positions: [ethPosIso, btcPosIso, solPosIso],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?groupBy=symbol' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groupBy).toBe('symbol');
    expect(body.groups).toHaveLength(3);
    const groupMap = new Map(body.groups.map((g: { period: string; realizedPnl: number }) => [g.period, g.realizedPnl]));
    expect(groupMap.get('ETH-USD')).toBe(50);
    expect(groupMap.get('BTC-USD')).toBe(200);
    expect(groupMap.get('SOL-USD')).toBe(-30);
  });

  it('symbol groupBy skips journal events (eventCount=0, fillCount=0)', async () => {
    const { client } = makeReadClient({
      bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [event1], positions: [ethPosIso],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?groupBy=symbol' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].eventCount).toBe(0);
    expect(body.groups[0].decisionCount).toBe(0);
    expect(body.groups[0].fillCount).toBe(0);
    expect(body.groups[0].realizedPnl).toBe(50);
  });
});

// ─── exitReasons filter & exitReason groupBy ──────────────────────────────

const sigLostPosIso = { ...ethPosIso, id: 'pos-sl', symbol: 'ETH-USD', realizedPnl: '-100', exitReason: 'signal_lost' };
const parabolicPosIso = { ...ethPosIso, id: 'pos-pm', symbol: 'BTC-USD', realizedPnl: '500', exitReason: 'parabolic_move' };
const unknownExitPosIso = { ...ethPosIso, id: 'pos-unk', symbol: 'SOL-USD', realizedPnl: '30', exitReason: null };

describe('GET /analytics — exitReasons filter & groupBy', () => {
  it('filters positions by a single exit reason', async () => {
    const { client } = makeReadClient({
      bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [], positions: [sigLostPosIso, parabolicPosIso],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?exitReasons=signal_lost' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].realizedPnl).toBe(-100);
  });

  it('filters positions by multiple exit reasons', async () => {
    const { client } = makeReadClient({
      bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [], positions: [sigLostPosIso, parabolicPosIso, unknownExitPosIso],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?exitReasons=signal_lost&exitReasons=parabolic_move' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].realizedPnl).toBe(400); // -100 + 500
  });

  it('returns empty groups when no positions match the exit reason filter', async () => {
    const { client } = makeReadClient({
      bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [], positions: [sigLostPosIso],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?exitReasons=daily_limit_reached' });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups).toEqual([]);
  });

  it('excludes positions with null exitReason from exit reason filter', async () => {
    const { client } = makeReadClient({
      bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [], positions: [unknownExitPosIso],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?exitReasons=signal_lost' });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups).toEqual([]);
  });

  it('groupBy=exitReason returns one group per exit reason', async () => {
    const { client } = makeReadClient({
      bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [], positions: [sigLostPosIso, parabolicPosIso, unknownExitPosIso],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?groupBy=exitReason' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groupBy).toBe('exitReason');
    expect(body.groups).toHaveLength(3);
    const groupMap = new Map(body.groups.map((g: { period: string; realizedPnl: number }) => [g.period, g.realizedPnl]));
    expect(groupMap.get('signal_lost')).toBe(-100);
    expect(groupMap.get('parabolic_move')).toBe(500);
    expect(groupMap.get('unknown')).toBe(30);
  });

  it('exitReason groupBy skips journal events (eventCount=0, no synthetic unknown)', async () => {
    const { client } = makeReadClient({
      bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [event1], positions: [sigLostPosIso],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?groupBy=exitReason' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].period).toBe('signal_lost');
    expect(body.groups[0].eventCount).toBe(0);
    expect(body.groups[0].decisionCount).toBe(0);
    expect(body.groups[0].fillCount).toBe(0);
    expect(body.groups.every((g: { period: string }) => g.period !== 'unknown')).toBe(true);
  });
});

// ─── event skip when position-only filters are active ─────────────────────

describe('GET /analytics — event skip on position-only filters', () => {
  it('skips events when symbols filter is active with day groupBy', async () => {
    const { client } = makeReadClient({
      bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [event1], positions: [ethPosIso, btcPosIso],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?symbols=ETH-USD&groupBy=day' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].eventCount).toBe(0);
    expect(body.groups[0].decisionCount).toBe(0);
    expect(body.groups[0].fillCount).toBe(0);
    expect(body.groups[0].realizedPnl).toBe(50);
  });

  it('skips events when exitReasons filter is active with day groupBy', async () => {
    const { client } = makeReadClient({
      bots: [bot1Summary], status: { 'bot-1': bot1Config }, events: [event1], positions: [sigLostPosIso, parabolicPosIso],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await analyticsRoutes(app, makeLocalDb(), client, READ_TIMEOUT_MS);

    const res = await app.inject({ method: 'GET', url: '/analytics?exitReasons=signal_lost&groupBy=day' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups[0].eventCount).toBe(0);
    expect(body.groups[0].decisionCount).toBe(0);
    expect(body.groups[0].fillCount).toBe(0);
    expect(body.groups[0].realizedPnl).toBe(-100);
  });
});
