import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { BillingConfigSchema, PlansConfigSchema } from '@herobids/domain';
import { billingRoutes } from './billing.js';

describe('billing routes ledger', () => {
  it('GET /billing/ledger returns 200 with empty records', async () => {
    const billingConfig = BillingConfigSchema.parse({});
    const plansConfig = PlansConfigSchema.parse({});

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
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    };

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'user-1';
    });
    await billingRoutes(
      app,
      billingConfig,
      plansConfig,
      db as unknown as import('@herobids/db').Database,
    );

    const res = await app.inject({ method: 'GET', url: '/billing/ledger' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.records).toEqual([]);
  });
});
