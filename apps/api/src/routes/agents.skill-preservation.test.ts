import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { Database } from '@herobids/db';
import { agentRoutes } from './agents.js';

const TEST_USER_ID = 'user-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = 'free';
  });
}

function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy', 'limit', 'innerJoin']) {
    chain[method] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

describe('agent routes skill preservation', () => {
  it('allows PATCH to preserve an already-assigned non-selectable skill while updating unrelated fields', async () => {
    let selectCount = 0;
    const updatedAgent = {
      id: 'agent-1',
      userId: TEST_USER_ID,
      status: 'stopped',
      name: 'renamed agent',
      prompt: 'existing prompt',
      toolPolicy: null,
      modelPolicy: null,
      notificationPolicy: null,
      executionMode: null,
      dailyTokenBudget: null,
      dailyLossLimit: null,
      maxBots: null,
      maxSlippageBps: null,
      tickIntervalMs: null,
      capital: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return makeChain([{ ...updatedAgent, name: 'old name' }]);
        }
        if (selectCount === 2) {
          return makeChain([{ skillId: 'paid-skill' }]);
        }
        if (selectCount === 3) {
          return makeChain([{
            id: 'paid-skill',
            authorId: 'other-user',
            publicationStatus: 'delisted',
            priceCents: 500,
            currentRevisionId: 'paid-skill:v2',
          }]);
        }
        if (selectCount === 4) {
          return makeChain([]);
        }
        if (selectCount === 5) {
          return makeChain([]);
        }
        if (selectCount === 6) {
          return makeChain([{ skillId: 'paid-skill', skillRevisionId: 'paid-skill:v2' }]);
        }
        if (selectCount === 7) {
          return makeChain([updatedAgent]);
        }
        return makeChain([{ skillId: 'paid-skill' }]);
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }),
      }),
      transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    } as unknown as Database;

    const app = Fastify();
    decorateWithAuth(app);
    await agentRoutes(app, db);

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { name: 'renamed agent' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expect.objectContaining({
      name: 'renamed agent',
      skillIds: ['paid-skill'],
    }));
  });
});