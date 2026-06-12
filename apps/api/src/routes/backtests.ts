import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import type { Database } from '@herobids/db';
import { BacktestingRepository, PgJournal } from '@herobids/db';
import { StrategyConfigSchema, Decimal } from '@herobids/domain';
import type { PlansConfig } from '@herobids/domain';
import { parseCsvToFrames } from '@herobids/backtesting';
import { checkBacktestLimit } from '../plan-guards.js';
import { errorPayload } from '../error-payload.js';
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

const ValidationRequestSchema = z.object({
  corpusId: z.string().min(1),
  venue: z.string().min(1),
  symbol: z.string().min(1),
  baseline: z.object({
    strategyType: z.string().min(1),
    config: z.record(z.unknown()),
  }),
  candidate: z.object({
    strategyType: z.string().min(1),
    config: z.record(z.unknown()),
  }),
  thresholds: z.object({
    maxDecisionDivergencePct: z.number().min(0).max(100).optional(),
    maxPnlRegressionPct: z.number().min(0).max(100).optional(),
  }).optional(),
});

const CsvImportSchema = z.object({
  name: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  venue: z.string().min(1),
  symbol: z.string().min(1),
  csvText: z.string().min(1),
  columns: z.object({
    timestamp: z.number().int().min(0),
    price: z.number().int().min(0),
    volume: z.number().int().min(0).optional(),
    high: z.number().int().min(0).optional(),
    low: z.number().int().min(0).optional(),
    open: z.number().int().min(0).optional(),
    close: z.number().int().min(0).optional(),
  }),
  skipRows: z.number().int().min(0).optional(),
  delimiter: z.string().min(1).max(1).optional(),
});

export const BACKTEST_QUEUE_NAME = 'backtest-runs';

export async function backtestRoutes(app: FastifyInstance, backtestQueue: Queue<BacktestJob>, db: Database, plansConfig?: PlansConfig) {
  const repo = new BacktestingRepository(db);
  const journal = new PgJournal(db);

  app.post('/backtests/corpora/import/csv', async (request, reply) => {
    const parsed = CsvImportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid CSV import request', details: parsed.error.issues });
    }

    let frames;
    try {
      frames = parseCsvToFrames(parsed.data.csvText, {
        symbol: parsed.data.symbol,
        columns: parsed.data.columns,
        skipRows: parsed.data.skipRows,
        delimiter: parsed.data.delimiter,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to parse CSV data';
      return reply.status(400).send({ error: message });
    }

    const { corpusId } = await repo.importCorpus({
      name: parsed.data.name ?? `${parsed.data.symbol}-${new Date().toISOString()}`,
      source: parsed.data.source ?? 'csv-import',
      venue: parsed.data.venue,
      symbols: [parsed.data.symbol],
      userId: request.userId,
      metadata: { importedFormat: 'csv' },
      events: frames.map((frame) => ({
        venue: parsed.data.venue,
        symbol: frame.symbol,
        eventType: 'ticker',
        price: frame.price.toString(),
        eventAt: new Date(frame.timestamp),
        data: frame.data,
      })),
    });

    return reply.status(201).send({
      corpusId,
      importedFrames: frames.length,
      startTimestamp: frames[0]!.timestamp,
      endTimestamp: frames[frames.length - 1]!.timestamp,
    });
  });

  app.get<{ Params: { corpusId: string } }>('/backtests/corpora/:corpusId', async (request, reply) => {
    const corpus = await repo.getCorpusForUser(request.params.corpusId, request.userId);
    if (!corpus) return reply.status(404).send({ error: 'Corpus not found' });
    return corpus;
  });

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

      // Plan enforcement: check concurrent backtest limit
      if (plansConfig) {
        const planCheck = await checkBacktestLimit(db, plansConfig, request.userId, request.userPlanId || 'free', request.isAdmin);
        if (!planCheck.ok) {
          return reply.status(403).send(errorPayload(planCheck.error.code, planCheck.error.message, planCheck.error.params));
        }
      }

      // Verify corpus belongs to this user
      const corpus = await repo.getCorpusForUser(corpusId, request.userId);
      if (!corpus) {
        return reply.status(404).send({ error: 'corpus_not_found', message: 'Corpus not found or does not belong to you' });
      }

      // Reject mismatched venue/symbol early — the worker would fail the job later
      // with an opaque "no market data frames" error otherwise.
      if (corpus.venue !== venue) {
        return reply.status(400).send({ error: 'corpus_venue_mismatch', message: `Corpus venue is "${corpus.venue}", not "${venue}"` });
      }
      const corpusSymbols = corpus.symbols.split(',').map((s) => s.trim());
      if (!corpusSymbols.includes(symbol)) {
        return reply.status(400).send({ error: 'corpus_symbol_not_found', message: `Symbol "${symbol}" not found in corpus (contains: ${corpus.symbols})` });
      }

      await repo.insertBacktestRun({ id: runId, strategyType, config, corpusId, venue, symbol, userId: request.userId });

      try {
        await backtestQueue.add('backtest', { runId, mode: 'backtest', strategyType, config, corpusId, venue, symbol });
      } catch (enqueueErr) {
        await repo.markBacktestFailed(runId, {
          message: enqueueErr instanceof Error ? enqueueErr.message : 'Failed to enqueue backtest job',
        });
        return reply.status(503).send({ error: 'Failed to enqueue backtest job', id: runId });
      }

      return reply.status(201).send({ id: runId, status: 'pending' });
    },
  );

  app.post('/backtests/validate', async (request, reply) => {
    const parsed = ValidationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid validation request', details: parsed.error.issues });
    }

    const baselineParse = StrategyConfigSchema.safeParse({
      type: parsed.data.baseline.strategyType,
      params: parsed.data.baseline.config['strategyParams'] ?? parsed.data.baseline.config,
    });
    if (!baselineParse.success) {
      return reply.status(400).send({
        error: 'Invalid baseline strategy config',
        issues: baselineParse.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }

    const candidateParse = StrategyConfigSchema.safeParse({
      type: parsed.data.candidate.strategyType,
      params: parsed.data.candidate.config['strategyParams'] ?? parsed.data.candidate.config,
    });
    if (!candidateParse.success) {
      return reply.status(400).send({
        error: 'Invalid candidate strategy config',
        issues: candidateParse.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }

    const runId = crypto.randomUUID();

    // Plan enforcement: check concurrent backtest limit
    if (plansConfig) {
      const planCheck = await checkBacktestLimit(db, plansConfig, request.userId, request.userPlanId || 'free', request.isAdmin);
      if (!planCheck.ok) {
        return reply.status(403).send(errorPayload(planCheck.error.code, planCheck.error.message, planCheck.error.params));
      }
    }

    // Verify corpus belongs to this user
    const validationCorpus = await repo.getCorpusForUser(parsed.data.corpusId, request.userId);
    if (!validationCorpus) {
      return reply.status(404).send({ error: 'corpus_not_found', message: 'Corpus not found or does not belong to you' });
    }

    // Reject mismatched venue/symbol early (same guard as regular backtest path)
    if (validationCorpus.venue !== parsed.data.venue) {
      return reply.status(400).send({ error: 'corpus_venue_mismatch', message: `Corpus venue is "${validationCorpus.venue}", not "${parsed.data.venue}"` });
    }
    const validationCorpusSymbols = validationCorpus.symbols.split(',').map((s) => s.trim());
    if (!validationCorpusSymbols.includes(parsed.data.symbol)) {
      return reply.status(400).send({ error: 'corpus_symbol_not_found', message: `Symbol "${parsed.data.symbol}" not found in corpus (contains: ${validationCorpus.symbols})` });
    }

    await repo.insertBacktestRun({
      id: runId,
      strategyType: 'validation',
      config: parsed.data,
      corpusId: parsed.data.corpusId,
      venue: parsed.data.venue,
      symbol: parsed.data.symbol,
      userId: request.userId,
    });

    try {
      await backtestQueue.add('validation', {
        runId,
        mode: 'validation',
        corpusId: parsed.data.corpusId,
        venue: parsed.data.venue,
        symbol: parsed.data.symbol,
        baseline: parsed.data.baseline,
        candidate: parsed.data.candidate,
        thresholds: parsed.data.thresholds,
      });
    } catch (enqueueErr) {
      await repo.markBacktestFailed(runId, {
        message: enqueueErr instanceof Error ? enqueueErr.message : 'Failed to enqueue validation job',
      });
      return reply.status(503).send({ error: 'Failed to enqueue validation job', id: runId });
    }

    return reply.status(201).send({ id: runId, status: 'pending', mode: 'validation' });
  });

  // Get backtest run status
  app.get<{ Params: { runId: string } }>('/backtests/:runId', async (request, reply) => {
    const run = await repo.getBacktestRunForUser(request.params.runId, request.userId);
    if (!run) return reply.status(404).send({ error: 'Backtest run not found' });
    return run;
  });

  // List backtest runs
  app.get<{ Querystring: { limit?: string; offset?: string } }>('/backtests', async (request) => {
    const limit = Math.min(Math.max(1, parseInt(request.query.limit ?? '50', 10) || 50), 500);
    const offset = Math.max(0, parseInt(request.query.offset ?? '0', 10) || 0);
    return repo.listBacktestRunsForUser(request.userId, limit, offset);
  });

  // Get backtest report/metrics
  app.get<{ Params: { runId: string } }>('/backtests/:runId/report', async (request, reply) => {
    const run = await repo.getBacktestRunForUser(request.params.runId, request.userId);
    if (!run) return reply.status(404).send({ error: 'Backtest run not found' });
    if (run.status !== 'completed') return reply.status(409).send({ error: 'Backtest not yet completed', status: run.status });
    return { runId: run.id, status: run.status, metrics: run.metrics };
  });

  // Get journal events scoped to a backtest run
  app.get<{ Params: { runId: string }; Querystring: { type?: string; limit?: string; offset?: string } }>(
    '/backtests/:runId/journal',
    async (request, reply) => {
      const run = await repo.getBacktestRunForUser(request.params.runId, request.userId);
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
