import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { PlansConfig } from '@herobids/domain';

vi.mock('@herobids/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@herobids/db')>();
  return {
    ...actual,
    BacktestingRepository: vi.fn(),
    PgJournal: vi.fn(),
  };
});

vi.mock('@herobids/backtesting', () => ({
  parseCsvToFrames: vi.fn().mockReturnValue([]),
}));

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

function makePlansConfig(): PlansConfig {
  return {
    defaultPlanId: 'free',
    plans: {
      free: {
        maxPortfolios: 3,
        maxVenueAccounts: 5,
        maxCredentials: 5,
        maxTradingInstances: 3,
        maxConcurrentBacktests: 1,
        liveEnabled: false,
      },
    },
  };
}

function makeMockRepo() {
  return {
    getCorpusForUser: vi.fn().mockResolvedValue(null),
    listCorporaForUser: vi.fn().mockResolvedValue([]),
    insertCorpus: vi.fn().mockResolvedValue('corpus-1'),
    insertMarketEventsBatch: vi.fn().mockResolvedValue(undefined),
    updateCorpusWindow: vi.fn().mockResolvedValue(undefined),
    insertBacktestRun: vi.fn().mockResolvedValue(undefined),
    getBacktestRunForUser: vi.fn().mockResolvedValue(null),
    listBacktestRunsForUser: vi.fn().mockResolvedValue([]),
    markBacktestFailed: vi.fn().mockResolvedValue(undefined),
    getBacktestReport: vi.fn().mockResolvedValue(null),
    getBacktestJournalEvents: vi.fn().mockResolvedValue([]),
  };
}

// --- tests ---

describe('backtests routes', () => {
  describe('ownership scoping', () => {
    it('returns 404 for corpus that belongs to another user', async () => {
      const { BacktestingRepository, PgJournal } = await import('@herobids/db');
      const mockRepo = makeMockRepo();
      // getCorpusForUser returns null — meaning it's not owned by this user
      mockRepo.getCorpusForUser.mockResolvedValue(null);

      vi.mocked(BacktestingRepository).mockImplementation(() => mockRepo as unknown as InstanceType<typeof BacktestingRepository>);
      vi.mocked(PgJournal).mockImplementation(() => ({}) as unknown as InstanceType<typeof PgJournal>);

      const { backtestRoutes } = await import('./backtests.js');
      const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

      const db = {
        select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }) }),
      };

      const app = Fastify();
      decorateWithAuth(app, 'user-attacker');
      await backtestRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database);

      const res = await app.inject({ method: 'GET', url: '/backtests/corpora/corpus-victim' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('plan limit enforcement — POST /backtests/run', () => {
    it('returns 403 when concurrent backtest limit is reached', async () => {
      const { BacktestingRepository, PgJournal } = await import('@herobids/db');
      const mockRepo = makeMockRepo();
      vi.mocked(BacktestingRepository).mockImplementation(() => mockRepo as unknown as InstanceType<typeof BacktestingRepository>);
      vi.mocked(PgJournal).mockImplementation(() => ({}) as unknown as InstanceType<typeof PgJournal>);

      const { backtestRoutes } = await import('./backtests.js');
      const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

      // backtestRuns select returns 1 running backtest (at limit for free plan = 1)
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue(Promise.resolve([{ id: 'run-1' }])),
          }),
        }),
      };

      const app = Fastify();
      decorateWithAuth(app, TEST_USER_ID, 'free');
      await backtestRoutes(app, mockQueue as unknown as import('bullmq').Queue, db as unknown as import('@herobids/db').Database, makePlansConfig());

      const res = await app.inject({
        method: 'POST',
        url: '/backtests',
        payload: {
          strategyType: 'momentum',
          config: {
            strategyParams: { symbol: 'BTC-USD', intervalMs: 5000, lookbackPeriods: 14 },
          },
          corpusId: 'corpus-1',
          venue: 'hyperliquid',
          symbol: 'BTC-USD',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('plan.limit_exceeded');
    });
  });
});
