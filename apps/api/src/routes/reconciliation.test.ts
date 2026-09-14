import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { reconciliationRoutes } from './reconciliation.js';
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

const noDb = {} as unknown as Database;

function makeClient(payload: unknown, kind: 'success' | 'notfound' = 'success'): {
  client: TradertonClient;
  invoke: ReturnType<typeof vi.fn>;
} {
  const result: TradertonClientResult = kind === 'success'
    ? { kind: 'success', requestId: 'r', correlationId: 'c', payload }
    : { kind: 'failure', requestId: 'r', correlationId: 'c', code: 'validation.invalid_payload', message: 'Bot not found', retryable: false, details: { errorCode: 'not_found.resource' } };
  const invoke = vi.fn().mockResolvedValue(result);
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

beforeEach(() => vi.clearAllMocks());

describe('reconciliationRoutes — /bots/:id/reconciliation-events (c4.2)', () => {
  it('returns events over get_owner_bot_reconciliation_events (USER subject)', async () => {
    const events = [{ id: 'rec-1', result: 'match' }];
    const { client, invoke } = makeClient({ ok: true, botId: TEST_BOT_ID, venueAccountId: 'va-1', events });
    const app = Fastify();
    decorateWithAuth(app);
    await reconciliationRoutes(app, noDb, client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/reconciliation-events` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ botId: string; venueAccountId: string; events: Array<{ id: string }> }>();
    expect(body.botId).toBe(TEST_BOT_ID);
    expect(body.venueAccountId).toBe('va-1');
    expect(body.events.map((e) => e.id)).toEqual(['rec-1']);

    const arg = invoke.mock.calls[0]![0] as { toolName: string; payload: Record<string, unknown>; subject: unknown };
    expect(arg.toolName).toBe('get_owner_bot_reconciliation_events');
    expect(arg.payload).toMatchObject({ botId: TEST_BOT_ID });
    expect(arg.subject).toEqual({ ownerId: TEST_USER_ID, actor: { type: 'user', id: TEST_USER_ID } });
  });

  it('threads limit/offset/since into the tool payload', async () => {
    const { client, invoke } = makeClient({ ok: true, botId: TEST_BOT_ID, venueAccountId: 'va-1', events: [] });
    const app = Fastify();
    decorateWithAuth(app);
    await reconciliationRoutes(app, noDb, client, 10_000);

    const since = '2026-01-01T00:00:00.000Z';
    await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/reconciliation-events?limit=10&offset=5&since=${encodeURIComponent(since)}` });
    const arg = invoke.mock.calls[0]![0] as { payload: Record<string, unknown> };
    expect(arg.payload).toMatchObject({ botId: TEST_BOT_ID, limit: 10, offset: 5, since });
  });

  it('returns 404 for an unowned/absent bot', async () => {
    const { client } = makeClient(null, 'notfound');
    const app = Fastify();
    decorateWithAuth(app);
    await reconciliationRoutes(app, noDb, client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/reconciliation-events` });
    expect(res.statusCode).toBe(404);
    expect(res.json<Record<string, unknown>>()['error']).toBe('not_found');
  });

  it('returns 400 for an invalid query', async () => {
    const { client } = makeClient({ ok: true, events: [] });
    const app = Fastify();
    decorateWithAuth(app);
    await reconciliationRoutes(app, noDb, client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/reconciliation-events?result=bogus` });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 when the read boundary is unconfigured', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await reconciliationRoutes(app, noDb);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/reconciliation-events` });
    expect(res.statusCode).toBe(503);
    expect(res.json<Record<string, unknown>>()['error']).toBe('precondition.not_ready');
  });
});
