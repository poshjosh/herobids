import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { PlansConfig } from '@herobids/domain';
// --- helpers ---

const TEST_USER_ID = 'user-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID, planId = 'free') {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.userPlanId = planId;
  });
}

function makePlansConfig(overrides: Partial<PlansConfig> = {}): PlansConfig {
  return {
    defaultPlanId: 'free',
    plans: {
      free: {
        maxPortfolios: 3,
        maxVenueAccounts: 5,
        maxCredentials: 5,
        maxTradingInstances: 3,
        maxConcurrentBacktests: 2,
        liveEnabled: false,
      },
      pro: {
        maxPortfolios: 10,
        maxVenueAccounts: 10,
        maxCredentials: 10,
        maxTradingInstances: 10,
        maxConcurrentBacktests: 10,
        liveEnabled: true,
      },
    },
    ...overrides,
  };
}

const validConfig = {
  strategy: {
    type: 'momentum',
    params: { symbol: 'BTC-PERP', intervalMs: 5000, lookbackPeriods: 14 },
  },
  risk: {},
  execution: { mode: 'paper' },
  venue: 'hyperliquid',
  symbol: 'BTC-PERP',
};

describe('bot routes', () => {
  describe('POST /bots — plan limit enforcement', () => {
    it('returns 403 when trading instance limit is reached', async () => {
      const { botRoutes } = await import('./bots.js');

      const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

      // DB mock: select returns 3 existing instances (at limit)
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue(Promise.resolve([
              { id: 'inst-1' },
              { id: 'inst-2' },
              { id: 'inst-3' },
            ])),
          }),
        }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
      };

      const app = Fastify();
      decorateWithAuth(app, TEST_USER_ID, 'free');
      await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, makePlansConfig());

      const res = await app.inject({
        method: 'POST',
        url: '/bots',
        payload: {
          portfolioId: 'port-1',
          venueAccountId: 'va-1',
          strategyId: 'momentum',
          venue: 'hyperliquid',
          symbol: 'BTC-PERP',
          config: validConfig,
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('plan.limit_exceeded');
    });
  });

  describe('POST /bots/:id/start — live plan gate', () => {
    it('returns 403 when free plan tries to start in live mode', async () => {
      const { botRoutes } = await import('./bots.js');

      const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

      const liveInstance = {
        id: 'inst-1',
        userId: TEST_USER_ID,
        portfolioId: 'port-1',
        venueAccountId: 'va-1',
        strategyId: 'momentum',
        config: { ...validConfig, execution: { mode: 'live' } },
        status: 'stopped',
        configVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        stoppedAt: null,
      };

      let selectCallCount = 0;
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockImplementation(() => {
                return Promise.resolve([liveInstance]);
              }),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'inst-1' }]),
            }),
          }),
        }),
      };
      // Override for the first call (instance lookup by id+userId)
      (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              // Instance lookup: returns the live instance
              return Promise.resolve([liveInstance]);
            }
            // Blocker check
            return Promise.resolve([]);
          }),
        }),
      });

      const app = Fastify();
      decorateWithAuth(app, TEST_USER_ID, 'free'); // free plan = no live
      await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, makePlansConfig());

      const res = await app.inject({
        method: 'POST',
        url: '/bots/inst-1/start',
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('plan.live_disabled');
    });

    it('allows live start for pro plan', async () => {
      const { botRoutes } = await import('./bots.js');

      const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

      const liveInstance = {
        id: 'inst-1',
        userId: TEST_USER_ID,
        portfolioId: 'port-1',
        venueAccountId: 'va-1',
        strategyId: 'momentum',
        config: { ...validConfig, execution: { mode: 'live' } },
        status: 'stopped',
        configVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        stoppedAt: null,
      };

      let selectCallCount = 0;
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              selectCallCount++;
              if (selectCallCount === 1) return Promise.resolve([liveInstance]);
              if (selectCallCount === 2) return Promise.resolve([{ credentialId: 'cred-1' }]);
              return Promise.resolve([]); // No blocker
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'inst-1' }]),
            }),
          }),
        }),
      };

      const app = Fastify();
      decorateWithAuth(app, TEST_USER_ID, 'pro'); // pro plan = live allowed
      await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, makePlansConfig());

      const res = await app.inject({
        method: 'POST',
        url: '/bots/inst-1/start',
      });

      expect(res.statusCode).toBe(200);
      expect(mockQueue.add).toHaveBeenCalledWith('start-instance', {
        command: 'start',
        tradingInstanceId: 'inst-1',
        config: expect.objectContaining({
          venueAccountId: 'va-1',
          userId: TEST_USER_ID,
        }),
      });
    });

    it('returns 409 when the linked venue account has no credential', async () => {
      const { botRoutes } = await import('./bots.js');

      const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

      // Must be live mode and non-paper so the credential guard is reached.
      // Paper-mode bots skip the credential check by design.
      const liveInstance = {
        id: 'inst-2',
        userId: TEST_USER_ID,
        portfolioId: 'port-1',
        venueAccountId: 'va-2',
        strategyId: 'momentum',
        config: { ...validConfig, execution: { mode: 'live' } },
        status: 'stopped',
        configVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        stoppedAt: null,
      };

      let selectCallCount = 0;
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              selectCallCount++;
              if (selectCallCount === 1) return Promise.resolve([liveInstance]);
              if (selectCallCount === 2) return Promise.resolve([{ credentialId: null }]);
              return Promise.resolve([]);
            }),
          }),
        }),
      };

      const app = Fastify();
      decorateWithAuth(app, TEST_USER_ID, 'pro'); // pro plan so live gate passes
      await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, makePlansConfig());

      const res = await app.inject({ method: 'POST', url: '/bots/inst-2/start' });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('no_credential');
      expect(mockQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('ownership scoping', () => {
    it('returns 404 when instance belongs to different user', async () => {
      const { botRoutes } = await import('./bots.js');
      const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

      // DB returns empty (no match for userId)
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue(Promise.resolve([])),
          }),
        }),
      };

      const app = Fastify();
      decorateWithAuth(app, 'user-attacker');
      await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database);

      const res = await app.inject({ method: 'POST', url: '/bots/inst-victim/start' });
      expect(res.statusCode).toBe(404);
    });
  });
});
