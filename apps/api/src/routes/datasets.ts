import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { datasets } from '@herobids/db';

// Root dir for dataset files (v1 — local filesystem)
const DATASETS_DIR = process.env['DATASETS_DIR'] ?? '/tmp/herobids-datasets';

// --- Schemas ---

const FetchDatasetSchema = z.object({
  venue: z.string().min(1),
  symbol: z.string().min(1),
  interval: z.string().min(1),
  from: z.string().datetime(),
  to: z.string().datetime(),
  name: z.string().min(1).max(100).optional(),
});

// --- Route module ---

export async function datasetRoutes(
  app: FastifyInstance,
  db: Database,
  redisClient: Redis,
): Promise<void> {
  // GET /datasets — list user's datasets
  app.get('/datasets', async (request, reply) => {
    const rows = await db.select().from(datasets)
      .where(eq(datasets.userId, request.userId))
      .orderBy(desc(datasets.createdAt));
    return reply.send({ datasets: rows });
  });

  // GET /datasets/:id — dataset detail
  app.get<{ Params: { id: string } }>('/datasets/:id', async (request, reply) => {
    const { id } = request.params;
    const [dataset] = await db.select().from(datasets)
      .where(and(eq(datasets.id, id), eq(datasets.userId, request.userId)));
    if (!dataset) return reply.status(404).send({ error: 'not_found' });
    return reply.send(dataset);
  });

  // POST /datasets/fetch — fetch OHLCV data from a venue (rate-limited: 1/min)
  app.post<{ Body: unknown }>('/datasets/fetch', async (request, reply) => {
    // Rate limit: 1 fetch per minute per user
    const rateLimitKey = `ratelimit:datasets:fetch:${request.userId}`;
    const count = await redisClient.incr(rateLimitKey);
    if (count === 1) await redisClient.expire(rateLimitKey, 60);
    if (count > 1) {
      return reply.status(429).send({ error: 'rate_limited', message: 'Maximum 1 dataset fetch per minute' });
    }

    const parsed = FetchDatasetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const id = crypto.randomUUID();
    const now = new Date();
    const name = parsed.data.name ?? `${parsed.data.symbol}_${parsed.data.interval}_${parsed.data.from.slice(0, 10)}`;

    // Insert as pending — actual data fetch is async in a real system
    await db.insert(datasets).values({
      id,
      userId: request.userId,
      name,
      venue: parsed.data.venue,
      symbol: parsed.data.symbol,
      interval: parsed.data.interval,
      from: new Date(parsed.data.from),
      to: new Date(parsed.data.to),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    const [dataset] = await db.select().from(datasets).where(eq(datasets.id, id));
    return reply.status(202).send(dataset);
  });

  // POST /datasets/upload — upload raw CSV body (rate-limited: 1/30s)
  // Registered in an encapsulated sub-plugin so that text/csv and text/plain
  // content types are parsed as raw strings (Fastify rejects unknown content
  // types by default, which would break the obvious `Content-Type: text/csv` case).
  app.register(async function uploadPlugin(sub) {
    sub.addContentTypeParser(
      ['text/csv', 'text/plain'],
      { parseAs: 'string' },
      (_req, body, done) => { done(null, body); },
    );

    sub.post<{ Body: unknown }>('/datasets/upload', async (request, reply) => {
    // Rate limit: 1 upload per 30 seconds per user
    const rateLimitKey = `ratelimit:datasets:upload:${request.userId}`;
    const count = await redisClient.incr(rateLimitKey);
    if (count === 1) await redisClient.expire(rateLimitKey, 30);
    if (count > 1) {
      return reply.status(429).send({ error: 'rate_limited', message: 'Maximum 1 upload per 30 seconds' });
    }

    // Expect raw CSV body; dataset name provided as query param
    const name = (request.query as Record<string, string>)['name'] ?? 'uploaded-dataset';
    const body = request.body;
    if (!body || typeof body !== 'string' && !Buffer.isBuffer(body)) {
      return reply.status(400).send({ error: 'missing_body', message: 'Request body is required' });
    }

    const id = crypto.randomUUID();
    const now = new Date();

    // Persist to local filesystem
    try {
      await mkdir(DATASETS_DIR, { recursive: true });
      const filePath = resolve(DATASETS_DIR, `${id}.csv`);
      await writeFile(filePath, Buffer.isBuffer(body) ? body : Buffer.from(String(body)));

      const content = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      const rowCount = Math.max(0, lines.length - 1); // subtract header

      await db.insert(datasets).values({
        id,
        userId: request.userId,
        name: String(name).slice(0, 100),
        status: 'ready',
        filePath,
        rowCount,
        createdAt: now,
        updatedAt: now,
      });
    } catch {
      await db.insert(datasets).values({
        id,
        userId: request.userId,
        name: String(name).slice(0, 100),
        status: 'failed',
        createdAt: now,
        updatedAt: now,
      });
    }

    const [dataset] = await db.select().from(datasets).where(eq(datasets.id, id));
    return reply.status(201).send(dataset);
  });
  }); // end uploadPlugin
}
