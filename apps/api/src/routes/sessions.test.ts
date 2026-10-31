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

function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'offset']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

function buildMockDb(): Database {
  return {
    select: vi.fn().mockImplementation(() => makeChain([])),
  } as unknown as Database;
}

/** Each `select` call resolves to the next queued result, in call order. */
function buildQueuedDb(results: unknown[][]): Database {
  const queue = [...results];
  return {
    select: vi.fn().mockImplementation(() => makeChain(queue.shift() ?? [])),
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

  describe('startup facts do not leak', () => {
    const STARTED_AT = new Date('2026-10-30T10:00:00.000Z');
    const LEAKY_ROW = {
      id: 'sess-1',
      agentId: 'agent-1',
      status: 'starting',
      lastHeartbeatAt: null,
      startedAt: STARTED_AT,
      stoppedAt: null,
      runtimeRegisteredAt: new Date(STARTED_AT.getTime() + 1_000),
      firstPlacedAt: null,
      placementAllocationId: 'alloc-secret-123',
      apiKeyHash: 'hash-secret-456',
    };
    const FORBIDDEN_KEYS = [
      'placementAllocationId',
      'placement_allocation_id',
      'firstPlacedAt',
      'first_placed_at',
      'runtimeRegisteredAt',
      'runtime_registered_at',
      'apiKeyHash',
      'api_key_hash',
    ];
    const FORBIDDEN_VALUES = ['alloc-secret-123', 'hash-secret-456'];

    function expectNoLeak(body: string) {
      for (const key of FORBIDDEN_KEYS) expect(body).not.toContain(`"${key}"`);
      for (const value of FORBIDDEN_VALUES) expect(body).not.toContain(value);
    }

    it('GET /sessions/:id exposes only the typed startupProgress view', async () => {
      const db = buildQueuedDb([[LEAKY_ROW], [{ id: 'agent-1' }]]);
      const app = Fastify();
      decorateWithAuth(app);
      await sessionRoutes(app, db, { enabled: true, capacityWaitTimeoutMs: 600_000, placedStartTimeoutMs: 120_000 });

      const res = await app.inject({ method: 'GET', url: '/sessions/sess-1' });
      expect(res.statusCode).toBe(200);
      expect(res.json().session.startupProgress).toEqual({
        phase: 'waiting_for_capacity',
        deadline: new Date(STARTED_AT.getTime() + 600_000).toISOString(),
        reason: 'queue_deadline',
      });
      expectNoLeak(res.body);
    });

    it('GET /sessions list exposes only the typed startupProgress view', async () => {
      const db = buildQueuedDb([[{ id: 'agent-1' }], [LEAKY_ROW]]);
      const app = Fastify();
      decorateWithAuth(app);
      await sessionRoutes(app, db, { enabled: true, capacityWaitTimeoutMs: 600_000, placedStartTimeoutMs: 120_000 });

      const res = await app.inject({ method: 'GET', url: '/sessions' });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessions[0].startupProgress.phase).toBe('waiting_for_capacity');
      expectNoLeak(res.body);
    });

    it('omits startupProgress when the capacityAwareStart gate is off', async () => {
      const db = buildQueuedDb([[LEAKY_ROW], [{ id: 'agent-1' }]]);
      const app = Fastify();
      decorateWithAuth(app);
      await sessionRoutes(app, db);

      const res = await app.inject({ method: 'GET', url: '/sessions/sess-1' });
      expect(res.statusCode).toBe(200);
      expect(res.json().session.startupProgress).toBeNull();
      expectNoLeak(res.body);
    });

    describe('startupFailureReason', () => {
      const STOPPED_AT = new Date(STARTED_AT.getTime() + 60_000);
      const STOPPED_ROW = { ...LEAKY_ROW, status: 'stopped', stoppedAt: STOPPED_AT, lastHeartbeatAt: null };

      it.each(['start_timeout', 'queue_deadline', 'boot_deadline', 'observation_failure'] as const)(
        'GET /sessions/:id exposes the %s reason as a bounded enum and nothing else from the failure',
        async (reason) => {
          const db = buildQueuedDb([[{ ...STOPPED_ROW, startupFailureReason: reason }], [{ id: 'agent-1' }]]);
          const app = Fastify();
          decorateWithAuth(app);
          await sessionRoutes(app, db, { enabled: true, capacityWaitTimeoutMs: 600_000, placedStartTimeoutMs: 120_000 });

          const res = await app.inject({ method: 'GET', url: '/sessions/sess-1' });
          expect(res.statusCode).toBe(200);
          expect(res.json().session.startupFailureReason).toBe(reason);
          expect(res.json().session.startupProgress).toBeNull();
          expectNoLeak(res.body);
        },
      );

      it('GET /sessions list exposes the reason per session and no raw failure column', async () => {
        const db = buildQueuedDb([[{ id: 'agent-1' }], [{ ...STOPPED_ROW, startupFailureReason: 'boot_deadline' }]]);
        const app = Fastify();
        decorateWithAuth(app);
        await sessionRoutes(app, db);

        const res = await app.inject({ method: 'GET', url: '/sessions' });
        expect(res.statusCode).toBe(200);
        expect(res.json().sessions[0].startupFailureReason).toBe('boot_deadline');
        expect(res.body).not.toContain('startup_failure_reason');
        expectNoLeak(res.body);
      });

      it('reports null for a session that did not fail during startup', async () => {
        const db = buildQueuedDb([[{ ...STOPPED_ROW, startupFailureReason: null }], [{ id: 'agent-1' }]]);
        const app = Fastify();
        decorateWithAuth(app);
        await sessionRoutes(app, db);

        const res = await app.inject({ method: 'GET', url: '/sessions/sess-1' });
        expect(res.json().session.startupFailureReason).toBeNull();
        expectNoLeak(res.body);
      });

      it('never returns an unrecognised stored value, so free text cannot reach the client', async () => {
        const db = buildQueuedDb([[{ ...STOPPED_ROW, startupFailureReason: 'raw-internal-token-xyz' }], [{ id: 'agent-1' }]]);
        const app = Fastify();
        decorateWithAuth(app);
        await sessionRoutes(app, db);

        const res = await app.inject({ method: 'GET', url: '/sessions/sess-1' });
        expect(res.json().session.startupFailureReason).toBeNull();
        expect(res.body).not.toContain('raw-internal-token-xyz');
        expectNoLeak(res.body);
      });
    });
  });
});
