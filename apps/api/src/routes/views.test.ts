import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { journalRoutes, positionRoutes } from './views.js';
import type { Database } from '@herobids/db';
import type { TradertonClient, TradertonClientResult } from '@herobids/domain/traderton';

const TEST_USER_ID = 'user-1';
const TEST_BOT_ID = 'bot-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
  });
}

const now = new Date('2026-02-02T10:00:00.000Z').toISOString();

const positionIso = (over: Record<string, unknown> = {}) => ({
  id: 'pos-1',
  venueAccountId: 'va-1',
  actorType: 'bot',
  actorId: TEST_BOT_ID,
  venue: 'hyperliquid',
  symbol: 'BTC-PERP',
  side: 'long',
  size: '1',
  entryPrice: '50000',
  realizedPnl: '0',
  markSource: 'last_fill',
  openedAt: now,
  closedAt: null,
  updatedAt: now,
  ...over,
});

const journalIso = (over: Record<string, unknown> = {}) => ({
  id: 'ev-1',
  actorType: 'bot',
  actorId: TEST_BOT_ID,
  type: 'order.filled',
  payload: {},
  createdAt: now,
  ...over,
});

/** Success read client returning the given rows per tool (keyed by array field). */
function makeReadClient(payloads: {
  get_owner_bot_positions?: unknown[];
  get_owner_bot_journal?: unknown[];
}): { client: TradertonClient; invoke: ReturnType<typeof vi.fn> } {
  const keyFor: Record<string, string> = {
    get_owner_bot_positions: 'positions',
    get_owner_bot_journal: 'events',
  };
  const invoke = vi.fn().mockImplementation((input: { toolName: string }) => {
    const key = keyFor[input.toolName];
    const rows = (payloads as Record<string, unknown[] | undefined>)[input.toolName] ?? [];
    const result: TradertonClientResult = {
      kind: 'success', requestId: 'r', correlationId: 'c', payload: key ? { [key]: rows } : {},
    };
    return Promise.resolve(result);
  });
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

/** Read client that resolves to the wire not_found shape (unowned/absent bot). */
function makeNotFoundReadClient(): { client: TradertonClient; invoke: ReturnType<typeof vi.fn> } {
  const result: TradertonClientResult = {
    kind: 'failure', requestId: 'r', correlationId: 'c',
    code: 'validation.invalid_payload', message: 'Bot not found', retryable: false,
    details: { errorCode: 'not_found.resource' },
  };
  const invoke = vi.fn().mockResolvedValue(result);
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

const noDb = {} as unknown as Database;

/**
 * A minimal DB stub whose `agents` lookup resolves to no owned agent (so the
 * `/journal` route takes the bot branch). Pass `agentId` to simulate an OWNED
 * agent and exercise the agent-scoped branch instead.
 */
function makeJournalDb(agentId: string | null = null): Database {
  const limit = vi.fn().mockResolvedValue(agentId ? [{ id: agentId }] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as unknown as Database;
}

beforeEach(() => vi.clearAllMocks());

describe('positionRoutes — /bots/:botId/positions[/open]', () => {
  it('returns all bot positions over get_owner_bot_positions (USER subject)', async () => {
    const { client, invoke } = makeReadClient({
      get_owner_bot_positions: [positionIso({ id: 'p-open', closedAt: null }), positionIso({ id: 'p-closed', closedAt: now })],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await positionRoutes(app, noDb, client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/positions` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ botId: string; positions: Array<{ id: string }> }>();
    expect(body.botId).toBe(TEST_BOT_ID);
    expect(body.positions.map((p) => p.id)).toEqual(['p-open', 'p-closed']);

    const arg = invoke.mock.calls[0]![0] as { toolName: string; payload: Record<string, unknown>; subject: unknown };
    expect(arg.toolName).toBe('get_owner_bot_positions');
    expect(arg.payload).toMatchObject({ botId: TEST_BOT_ID });
    expect(arg.subject).toEqual({ ownerId: TEST_USER_ID, actor: { type: 'user', id: TEST_USER_ID } });
  });

  it('/open filters to positions with closedAt === null in-app', async () => {
    const { client } = makeReadClient({
      get_owner_bot_positions: [positionIso({ id: 'p-open', closedAt: null }), positionIso({ id: 'p-closed', closedAt: now })],
    });
    const app = Fastify();
    decorateWithAuth(app);
    await positionRoutes(app, noDb, client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/positions/open` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ positions: Array<{ id: string }> }>();
    expect(body.positions.map((p) => p.id)).toEqual(['p-open']);
  });

  it('returns 404 for an unowned/absent bot', async () => {
    const { client } = makeNotFoundReadClient();
    const app = Fastify();
    decorateWithAuth(app);
    await positionRoutes(app, noDb, client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/positions` });
    expect(res.statusCode).toBe(404);
    expect(res.json<Record<string, unknown>>()['error']).toBe('not_found');
  });

  it('returns 503 when the read boundary is unconfigured', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await positionRoutes(app, noDb);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/positions` });
    expect(res.statusCode).toBe(503);
    expect(res.json<Record<string, unknown>>()['error']).toBe('precondition.not_ready');
  });
});

describe('journalRoutes — /journal', () => {
  it('returns bot journal events over get_owner_bot_journal (owner-scoped by the bot actorId)', async () => {
    const { client, invoke } = makeReadClient({ get_owner_bot_journal: [journalIso()] });
    const app = Fastify();
    decorateWithAuth(app);
    await journalRoutes(app, makeJournalDb(null), client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/journal?actorId=${TEST_BOT_ID}&limit=30` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ events: Array<{ id: string }> }>();
    expect(body.events.map((e) => e.id)).toEqual(['ev-1']);

    const arg = invoke.mock.calls[0]![0] as { toolName: string; payload: Record<string, unknown> };
    expect(arg.toolName).toBe('get_owner_bot_journal');
    expect(arg.payload).toMatchObject({ botId: TEST_BOT_ID, limit: 30 });
  });

  it('returns 400 when actorId is missing (never touches the boundary)', async () => {
    const { client, invoke } = makeReadClient({ get_owner_bot_journal: [] });
    const app = Fastify();
    decorateWithAuth(app);
    await journalRoutes(app, makeJournalDb(null), client, 10_000);

    const res = await app.inject({ method: 'GET', url: '/journal' });
    expect(res.statusCode).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns 404 when the bot actorId is unowned/absent', async () => {
    const { client } = makeNotFoundReadClient();
    const app = Fastify();
    decorateWithAuth(app);
    await journalRoutes(app, makeJournalDb(null), client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/journal?actorId=${TEST_BOT_ID}` });
    expect(res.statusCode).toBe(404);
  });

  it('returns 503 when the read boundary is unconfigured', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await journalRoutes(app, makeJournalDb(null));

    const res = await app.inject({ method: 'GET', url: `/journal?actorId=${TEST_BOT_ID}` });
    expect(res.statusCode).toBe(503);
  });

  it('routes an OWNED agent actorId through get_agent_journal_events (agent subject)', async () => {
    const agentId = 'agent-1';
    const record = journalIso({ actorType: 'agent', actorId: agentId });
    const { client, invoke } = makeReadClient({});
    // Stub get_agent_journal_events via the invoke mock directly (agent tool
    // returns `{ events: [...] }`).
    invoke.mockImplementation((input: { toolName: string }) => {
      const result: TradertonClientResult = {
        kind: 'success', requestId: 'r', correlationId: 'c',
        payload: input.toolName === 'get_agent_journal_events' ? { events: [record] } : { events: [] },
      };
      return Promise.resolve(result);
    });

    const app = Fastify();
    decorateWithAuth(app);
    await journalRoutes(app, makeJournalDb(agentId), client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/journal?actorId=${agentId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ events: Array<{ id: string }> }>().events.map((e) => e.id)).toEqual(['ev-1']);

    const arg = invoke.mock.calls[0]![0] as { toolName: string; subject: unknown };
    expect(arg.toolName).toBe('get_agent_journal_events');
    expect(arg.subject).toEqual({ ownerId: TEST_USER_ID, actor: { type: 'agent', id: agentId } });
  });
});
