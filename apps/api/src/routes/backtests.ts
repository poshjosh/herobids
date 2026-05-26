import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import type { Database } from '@herobids/db';
import { BacktestingRepository, PgJournal } from '@herobids/db';
import { StrategyConfigSchema, Decimal } from '@herobids/domain';
import type { BacktestJob } from '../types.js';
import crypto from 'node:crypto';

const decimalString = z.string().refine(
  (v) => { try { const d = new Decimal(v); return d.isFinite(); } catch { return false; } },
  { message: 'Must be a valid finite decimal number string' },
);

const BacktestConfigSchema = z.object({
  warmUpFrames: z.number().int().min(0).optional(),
  maxPositionSize: z.union([decimalString, z.number()]).optional(),
  maxOpenPositions: z.number().int().min(1).optional(),
  maxDrawdown: z.union([decimalString, z.number()]).optional(),
}).passthrough();

export const BACKTEST_QUEUE_NAME = 'backtest-runs';

export async function backtestRoutes(app: FastifyInstance, backtestQueue: Queue<BacktestJob>, db: Database) {
  const repo = new BacktestingRepository(db);
  const journal = new PgJournal(db);

  // Create a backtest run
  app.post<{ Body: { strategyType: string; config: Record<string, unknown>; corpusId: string; venue: string; symbol: string } }>(
    '/backtests',
    async (request, reply) => {
      const body = request.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object') {
        return reply.status(400).send({ error: 'Request body must be a JSON object' });
      }
      const { strategyType, config, corpusId, venue, symbol } = body as { strategyType: string; config: Record<string, unknown>; corpusId: string; venue: string; symbol: string };
      if (!strategyType || !config || !corpusId || !venue || !symbol) {
        return reply.status(400).send({ error: 'Missing required fields: strategyType, config, corpusId, venue, symbol' });
      }

      // Validate strategy config at the API boundary
      const strategyParse = StrategyConfigSchema.safeParse({ type: strategyType, params: config['strategyParams'] ?? config });
      if (!strategyParse.success) {
        return reply.status(400).send({
          error: 'Invalid strategy config',
          issues: strategyParse.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }

      // Validate backtest-specific config fields
      const configParse = BacktestConfigSchema.safeParse(config);
      if (!configParse.success) {
        return reply.status(400).send({
          error: 'Invalid backtest config',
          issues: configParse.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }

      const runId = crypto.randomUUID();
      await repo.insertBacktestRun({ id: runId, strategyType, config, corpusId, venue, symbol });

      try {
        await backtestQueue.add('backtest', { runId, strategyType, config, corpusId, venue, symbol });
      } catch (enqueueErr) {
        await repo.markBacktestFailed(runId, {
          message: enqueueErr instanceof Error ? enqueueErr.message : 'Failed to enqueue backtest job',
        });
        return reply.status(503).send({ error: 'Failed to enqueue backtest job', id: runId });
      }

      return reply.status(201).send({ id: runId, status: 'pending' });
    },
  );

  // Get backtest run status
  app.get<{ Params: { runId: string } }>('/backtests/:runId', async (request, reply) => {
    const run = await repo.getBacktestRun(request.params.runId);
    if (!run) return reply.status(404).send({ error: 'Backtest run not found' });
    return run;
  });

  // List backtest runs
  app.get<{ Querystring: { limit?: string; offset?: string } }>('/backtests', async (request) => {
    const limit = Math.min(Math.max(1, parseInt(request.query.limit ?? '50', 10) || 50), 500);
    const offset = Math.max(0, parseInt(request.query.offset ?? '0', 10) || 0);
    return repo.listBacktestRuns(limit, offset);
  });

  // Get backtest report/metrics
  app.get<{ Params: { runId: string } }>('/backtests/:runId/report', async (request, reply) => {
    const run = await repo.getBacktestRun(request.params.runId);
    if (!run) return reply.status(404).send({ error: 'Backtest run not found' });
    if (run.status !== 'completed') return reply.status(409).send({ error: 'Backtest not yet completed', status: run.status });
    return { runId: run.id, status: run.status, metrics: run.metrics };
  });

  // Get journal events scoped to a backtest run
  app.get<{ Params: { runId: string }; Querystring: { type?: string; limit?: string; offset?: string } }>(
    '/backtests/:runId/journal',
    async (request, reply) => {
      const run = await repo.getBacktestRun(request.params.runId);
      if (!run) return reply.status(404).send({ error: 'Backtest run not found' });

      const events = await journal.query({
        backtestRunId: request.params.runId,
        type: request.query.type,
        limit: Math.min(Math.max(1, parseInt(request.query.limit ?? '100', 10) || 100), 1000),
        offset: Math.max(0, parseInt(request.query.offset ?? '0', 10) || 0),
      });
      return events;
    },
  );
}
