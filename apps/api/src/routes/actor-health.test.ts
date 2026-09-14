import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { actorHealthRoutes } from './actor-health.js';
import type { Database } from '@herobids/db';
import type Redis from 'ioredis';
import type { TradertonClient, TradertonClientResult } from '@herobids/domain/traderton';

const TEST_USER_ID = 'user-1';
const TEST_BOT_ID = 'bot-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
  });
}

/** Redis stub — no live snapshot by default (drives the static-status fallback). */
function makeRedis(raw: string | null = null): Redis {
  return { get: vi.fn().mockResolvedValue(raw) } as unknown as Redis;
}

const noDb = {} as unknown as Database;

/** Success read client returning a get_owner_bot_status payload. */
function makeStatusClient(status: string): { client: TradertonClient; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn().mockImplementation((input: { toolName: string }) => {
    const payload = input.toolName === 'get_owner_bot_status'
      ? { ok: true, id: TEST_BOT_ID, status }
      : {};
    return Promise.resolve({ kind: 'success', requestId: 'r', correlationId: 'c', payload } as TradertonClientResult);
  });
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

function makeNotFoundClient(): { client: TradertonClient; invoke: ReturnType<typeof vi.fn> } {
  const result: TradertonClientResult = {
    kind: 'failure', requestId: 'r', correlationId: 'c',
    code: 'validation.invalid_payload', message: 'Bot not found', retryable: false,
    details: { errorCode: 'not_found.resource' },
  };
  return { client: { invoke: vi.fn().mockResolvedValue(result) } as unknown as TradertonClient, invoke: vi.fn() };
}

beforeEach(() => vi.clearAllMocks());

describe('actor-health /bots/:id/health — boundary re-point (c4.2)', () => {
  it('derives the static-fallback status from get_owner_bot_status when no runtime snapshot', async () => {
    const { client, invoke } = makeStatusClient('running');
    const app = Fastify();
    decorateWithAuth(app);
    await actorHealthRoutes(app, noDb, makeRedis(null), client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/health` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['actorType']).toBe('bot');
    expect(body['source']).toBe('static');
    // running → degraded static fallback (parity with the old mapping).
    expect(body['status']).toBe('degraded');

    const arg = invoke.mock.calls[0]![0] as { toolName: string; payload: Record<string, unknown>; subject: unknown };
    expect(arg.toolName).toBe('get_owner_bot_status');
    expect(arg.payload).toMatchObject({ botId: TEST_BOT_ID });
    expect(arg.subject).toEqual({ ownerId: TEST_USER_ID, actor: { type: 'user', id: TEST_USER_ID } });
  });

  it('returns the runtime snapshot when present (status source unaffected)', async () => {
    const snapshot = { actorType: 'bot', actorId: TEST_BOT_ID, status: 'healthy', reasons: [], updatedAt: 'x' };
    const { client } = makeStatusClient('running');
    const app = Fastify();
    decorateWithAuth(app);
    await actorHealthRoutes(app, noDb, makeRedis(JSON.stringify(snapshot)), client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/health` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['source']).toBe('runtime');
    expect(body['status']).toBe('healthy');
  });

  it('returns 404 for an unowned/absent bot', async () => {
    const { client } = makeNotFoundClient();
    const app = Fastify();
    decorateWithAuth(app);
    await actorHealthRoutes(app, noDb, makeRedis(null), client, 10_000);

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/health` });
    expect(res.statusCode).toBe(404);
    expect(res.json<Record<string, unknown>>()['error']).toBe('not_found');
  });

  it('returns 503 when the read boundary is unconfigured', async () => {
    const app = Fastify();
    decorateWithAuth(app);
    await actorHealthRoutes(app, noDb, makeRedis(null));

    const res = await app.inject({ method: 'GET', url: `/bots/${TEST_BOT_ID}/health` });
    expect(res.statusCode).toBe(503);
    expect(res.json<Record<string, unknown>>()['error']).toBe('precondition.not_ready');
  });
});
