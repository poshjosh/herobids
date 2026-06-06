import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { sessionRoutes } from './sessions.js';
import type { Database } from '@herobids/db';

const TEST_USER_ID = 'user-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>) {
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = TEST_USER_ID;
  });
}

function buildMockDb(): Database {
  const makeChain = (value: unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit', 'offset']) {
      chain[m] = vi.fn(() => chain);
    }
    (chain as { then: unknown }).then = (
      resolve: (v: unknown) => unknown,
      reject?: (v: unknown) => unknown,
    ) => Promise.resolve(value).then(resolve, reject);
    return chain;
  };
  return {
    select: vi.fn().mockImplementation(() => makeChain([])),
  } as unknown as Database;
}

describe('session routes', () => {
  it('GET /sessions returns 200 with empty list when user has no agents', async () => {
    const db = buildMockDb();
    const app = Fastify();
    decorateWithAuth(app);
    await sessionRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessions).toEqual([]);
  });

  it('GET /sessions/:id returns 404 when session not found', async () => {
    const db = buildMockDb();
    const app = Fastify();
    decorateWithAuth(app);
    await sessionRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/sessions/some-id' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });
});
