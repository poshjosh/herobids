import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { datasetRoutes } from './datasets.js';
import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';

const TEST_USER_ID = 'user-1';
const DATASET_ID = 'ds-1';

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

const stubDataset = {
  id: DATASET_ID,
  userId: TEST_USER_ID,
  name: 'BTC 1h OHLCV',
  venue: 'hyperliquid',
  symbol: 'BTC',
  interval: '1h',
  status: 'ready',
  rowCount: 100,
  filePath: '/tmp/ds-1.csv',
  from: new Date('2026-01-01'),
  to: new Date('2026-01-31'),
  description: null,
  meta: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function buildMockRedis(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as Redis;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── GET /datasets ────────────────────────────────────────────────────────

describe('GET /datasets', () => {
  it('returns empty list when no datasets exist', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await datasetRoutes(app, db, redis);

    const res = await app.inject({ method: 'GET', url: '/datasets' });
    expect(res.statusCode).toBe(200);
    expect(res.json().datasets).toEqual([]);
  });

  it('returns user datasets', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([stubDataset])),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await datasetRoutes(app, db, redis);

    const res = await app.inject({ method: 'GET', url: '/datasets' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.datasets).toHaveLength(1);
    expect(body.datasets[0].id).toBe(DATASET_ID);
  });
});

// ─── GET /datasets/:id ────────────────────────────────────────────────────

describe('GET /datasets/:id', () => {
  it('returns 200 for owned dataset', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([stubDataset])),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await datasetRoutes(app, db, redis);

    const res = await app.inject({ method: 'GET', url: `/datasets/${DATASET_ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(DATASET_ID);
  });

  it('returns 404 when dataset not found', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await datasetRoutes(app, db, redis);

    const res = await app.inject({ method: 'GET', url: `/datasets/${DATASET_ID}` });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /datasets/fetch ─────────────────────────────────────────────────

describe('POST /datasets/fetch', () => {
  it('returns 202 with pending dataset when valid body provided', async () => {
    const pendingDataset = { ...stubDataset, status: 'pending' };
    let selectCount = 0;
    const db = {
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1 ? [pendingDataset] : []);
      }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await datasetRoutes(app, db, redis);

    const res = await app.inject({
      method: 'POST',
      url: '/datasets/fetch',
      payload: {
        venue: 'hyperliquid',
        symbol: 'BTC',
        interval: '1h',
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-31T00:00:00Z',
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('pending');
  });

  it('returns 429 when rate limit exceeded', async () => {
    const db = {} as unknown as Database;
    const redis = buildMockRedis({ incr: vi.fn().mockResolvedValue(2) });
    const app = Fastify();
    decorateWithAuth(app);
    await datasetRoutes(app, db, redis);

    const res = await app.inject({
      method: 'POST',
      url: '/datasets/fetch',
      payload: {
        venue: 'hyperliquid',
        symbol: 'BTC',
        interval: '1h',
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-31T00:00:00Z',
      },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('rate_limited');
  });

  it('returns 400 when required fields are missing', async () => {
    const db = {} as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    decorateWithAuth(app);
    await datasetRoutes(app, db, redis);

    const res = await app.inject({
      method: 'POST',
      url: '/datasets/fetch',
      payload: { venue: 'hyperliquid' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── POST /datasets/upload ────────────────────────────────────────────────

describe('POST /datasets/upload', () => {
  it('returns 429 when rate limit exceeded', async () => {
    const db = {} as unknown as Database;
    const redis = buildMockRedis({ incr: vi.fn().mockResolvedValue(2) });
    const app = Fastify();
    decorateWithAuth(app);
    await datasetRoutes(app, db, redis);

    const res = await app.inject({
      method: 'POST',
      url: '/datasets/upload',
      payload: 'date,open,high,low,close\n2026-01-01,100,110,90,105',
      headers: { 'content-type': 'text/csv' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('rate_limited');
  });

  it('also accepts text/plain content type', async () => {
    const db = {} as unknown as Database;
    const redis = buildMockRedis({ incr: vi.fn().mockResolvedValue(2) });
    const app = Fastify();
    decorateWithAuth(app);
    await datasetRoutes(app, db, redis);

    const res = await app.inject({
      method: 'POST',
      url: '/datasets/upload',
      payload: 'date,open,high,low,close\n2026-01-01,100,110,90,105',
      headers: { 'content-type': 'text/plain' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('rate_limited');
  });
});
