import { Worker } from 'bullmq';
import pino from 'pino';
import type { Database } from '@herobids/db';
import { BacktestingRepository, PgJournal, DecisionRepository } from '@herobids/db';
import { MomentumStrategy, LlmStrategy } from '@herobids/strategy';
import { runBacktest, ArrayHistoricalDataFeed, runValidation } from '@herobids/backtesting';
import type { HistoricalFrame, ValidationThresholds, BacktestConfig } from '@herobids/backtesting';
import { quantity, price } from '@herobids/domain';
import type { Strategy } from '@herobids/domain';
import crypto from 'node:crypto';

export const BACKTEST_QUEUE_NAME = 'backtest-runs';

export interface BacktestJobData {
  runId: string;
  mode?: 'backtest' | 'validation';
  strategyType?: string;
  config?: Record<string, unknown>;
  corpusId: string;
  venue: string;
  symbol: string;
  baseline?: { strategyType: string; config: Record<string, unknown> };
  candidate?: { strategyType: string; config: Record<string, unknown> };
  thresholds?: ValidationThresholds;
}

export interface BacktestRuntimeConfig {
  redis: { host: string; port: number; password?: string; username?: string; db?: number };
  concurrency?: number;
  maxDataGapMs?: number;
  defaultWarmUpFrames?: number;
  validationThresholds?: ValidationThresholds;
}

const logger = pino({ name: 'backtest-runtime' });

/**
 * BacktestRuntime — processes bounded backtest jobs via BullMQ.
 * Separate from WorkerRuntime which manages long-lived trading actors.
 */
export class BacktestRuntime {
  private worker: Worker<BacktestJobData> | undefined;

  constructor(
    private readonly config: BacktestRuntimeConfig,
    private readonly db: Database,
  ) {}

  start(): void {
    const repo = new BacktestingRepository(this.db);

    this.worker = new Worker<BacktestJobData>(
      BACKTEST_QUEUE_NAME,
      async (job) => {
        const { runId, corpusId, venue, symbol } = job.data;
        const mode = job.data.mode ?? 'backtest';
        logger.info({ runId, mode, venue, symbol }, 'Starting backtest run');

        try {
          await repo.markBacktestRunning(runId);

          // Load market data — determines which event type stream will be replayed
          const { frames, eventType: replayEventType } = await this.loadFrames(repo, corpusId, venue, symbol);
          if (frames.length === 0) {
            throw new Error('No market data frames available for replay');
          }

          // Validate gaps against the specific event stream that will be replayed
          await this.assertNoCorpusGaps(repo, corpusId, venue, symbol, replayEventType);

          const feed = new ArrayHistoricalDataFeed(frames);
          const decisionRepo = new DecisionRepository(this.db);

          // Build a backtest-scoped journal
          const backtestJournal = new PgJournal(this.db);
          // Wrap to inject backtestRunId
          const scopedJournal = {
            append: async (entry: { actorType?: string; actorId?: string; type: string; payload: Record<string, unknown> }) => {
              await backtestJournal.append({ ...entry, backtestRunId: runId });
            },
            appendBatch: async (entries: Array<{ actorType?: string; actorId?: string; type: string; payload: Record<string, unknown> }>) => {
              await backtestJournal.appendBatch(entries.map((e) => ({ ...e, backtestRunId: runId })));
            },
          };

          if (mode === 'validation') {
            await this.runValidationJob(repo, decisionRepo, feed, scopedJournal, job.data);
            logger.info({ runId }, 'Validation completed');
          } else {
            await this.runBacktestJob(repo, decisionRepo, feed, scopedJournal, job.data);
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          await repo.markBacktestFailed(runId, { message: error.message, stack: error.stack });
          logger.error({ runId, err: error.message }, 'Backtest failed');
          throw error;
        }
      },
      {
        connection: this.config.redis,
        concurrency: this.config.concurrency ?? 2,
      },
    );

    this.worker.on('error', (err) => {
      logger.error({ err: err.message }, 'Backtest worker error');
    });

    logger.info('Backtest runtime started');
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = undefined;
    }
    logger.info('Backtest runtime stopped');
  }

  private createStrategy(strategyType: string): Strategy {
    const repo = new BacktestingRepository(this.db);
    switch (strategyType) {
      case 'momentum':
        return new MomentumStrategy(() => crypto.randomUUID());
      case 'llm':
        return new LlmStrategy(
          () => crypto.randomUUID(),
          async (artifact) => { await repo.insertLlmArtifact({ ...artifact, parsedDecision: artifact.parsedDecision as Record<string, unknown> | null }); },
        );
      default:
        throw new Error(`Unknown strategy type: ${strategyType}`);
    }
  }

  private async runBacktestJob(
    repo: BacktestingRepository,
    decisionRepo: DecisionRepository,
    feed: ArrayHistoricalDataFeed,
    journal: { append: (entry: { actorType?: string; actorId?: string; type: string; payload: Record<string, unknown> }) => Promise<void>; appendBatch: (entries: Array<{ actorType?: string; actorId?: string; type: string; payload: Record<string, unknown> }>) => Promise<void> },
    job: BacktestJobData,
  ): Promise<void> {
    if (!job.strategyType || !job.config) {
      throw new Error('Backtest job missing strategyType or config');
    }

    const strategy = this.createStrategy(job.strategyType);
    const config = this.buildReplayConfig({
      runId: job.runId,
      role: 'backtest',
      strategyType: job.strategyType,
      rawConfig: job.config,
      strategy,
      venue: job.venue,
      symbol: job.symbol,
      journal,
      repo,
      decisionRepo,
    }, feed.length);

    const report = await runBacktest(feed, config);

    await repo.markBacktestCompleted(job.runId, {
      mode: 'backtest',
      totalFrames: report.totalFrames,
      warmUpFrames: report.warmUpFrames,
      totalDecisions: report.totalDecisions,
      strategyErrors: report.strategyErrors,
      riskRejections: report.riskRejections,
      executionFailures: report.executionFailures,
      totalFills: report.totalFills,
      realizedPnl: report.realizedPnl,
      finalPositionSide: report.finalPosition.side,
      finalPositionSize: report.finalPosition.size.toString(),
      startTimestamp: report.startTimestamp,
      endTimestamp: report.endTimestamp,
    });

    logger.info({ runId: job.runId, totalFills: report.totalFills, realizedPnl: report.realizedPnl }, 'Backtest completed');
  }

  private async runValidationJob(
    repo: BacktestingRepository,
    decisionRepo: DecisionRepository,
    feed: ArrayHistoricalDataFeed,
    journal: { append: (entry: { actorType?: string; actorId?: string; type: string; payload: Record<string, unknown> }) => Promise<void>; appendBatch: (entries: Array<{ actorType?: string; actorId?: string; type: string; payload: Record<string, unknown> }>) => Promise<void> },
    job: BacktestJobData,
  ): Promise<void> {
    if (!job.baseline || !job.candidate) {
      throw new Error('Validation job missing baseline or candidate strategy config');
    }

    const baselineStrategy = this.createStrategy(job.baseline.strategyType);
    const candidateStrategy = this.createStrategy(job.candidate.strategyType);
    const baselineConfig = this.buildReplayConfig({
      runId: `${job.runId}-baseline`,
      role: 'baseline',
      strategyType: job.baseline.strategyType,
      rawConfig: job.baseline.config,
      strategy: baselineStrategy,
      venue: job.venue,
      symbol: job.symbol,
      journal,
      repo,
      decisionRepo,
    }, feed.length);
    const candidateConfig = this.buildReplayConfig({
      runId: `${job.runId}-candidate`,
      role: 'candidate',
      strategyType: job.candidate.strategyType,
      rawConfig: job.candidate.config,
      strategy: candidateStrategy,
      venue: job.venue,
      symbol: job.symbol,
      journal,
      repo,
      decisionRepo,
    }, feed.length);

    const thresholds: ValidationThresholds = {
      maxDecisionDivergencePct: job.thresholds?.maxDecisionDivergencePct ?? this.config.validationThresholds?.maxDecisionDivergencePct ?? 20,
      maxPnlRegressionPct: job.thresholds?.maxPnlRegressionPct ?? this.config.validationThresholds?.maxPnlRegressionPct ?? 10,
    };

    const validation = await runValidation(feed, baselineConfig, candidateConfig, thresholds);

    await repo.markBacktestCompleted(job.runId, {
      mode: 'validation',
      passed: validation.passed,
      failures: validation.failures,
      thresholds,
      comparison: validation.comparison,
    });
  }

  private buildReplayConfig(
    params: {
      runId: string;
      role: 'backtest' | 'baseline' | 'candidate';
      strategyType: string;
      rawConfig: Record<string, unknown>;
      strategy: Strategy;
      venue: string;
      symbol: string;
      journal: { append: (entry: { actorType?: string; actorId?: string; type: string; payload: Record<string, unknown> }) => Promise<void>; appendBatch: (entries: Array<{ actorType?: string; actorId?: string; type: string; payload: Record<string, unknown> }>) => Promise<void> };
      repo: BacktestingRepository;
      decisionRepo: DecisionRepository;
    },
    frameCount: number,
  ): BacktestConfig {
    const strategyParams = (params.rawConfig['strategyParams'] as Record<string, unknown>) ?? params.rawConfig;
    const lookbackPeriod = params.strategyType === 'momentum' ? ((strategyParams['lookbackPeriod'] as number) ?? 5) : 0;
    const configuredWarmUp = params.rawConfig['warmUpFrames'] as number | undefined;
    const defaultWarmUp = params.strategyType === 'llm'
      ? 0
      : Math.max(
          lookbackPeriod,
          Math.min(
            this.config.defaultWarmUpFrames ?? 200,
            Math.max(5, Math.floor(frameCount * 0.1)),
          ),
        );
    const warmUpFrames = configuredWarmUp ?? defaultWarmUp;

    return {
      runId: params.runId,
      botId: `backtest-${params.runId}`,
      venue: params.venue,
      symbol: params.symbol,
      venueAccountId: 'backtest',
      strategy: params.strategy,
      strategyType: params.strategyType,
      strategyConfig: strategyParams,
      riskLimits: {
        maxPositionSize: quantity(String(params.rawConfig['maxPositionSize'] ?? '100')),
        maxOpenPositions: (params.rawConfig['maxOpenPositions'] as number) ?? 5,
        maxDrawdown: price(String(params.rawConfig['maxDrawdown'] ?? '10000')),
      },
      warmUpFrames,
      journal: params.journal,
      persistence: this.createBacktestPersistence(params.repo, params.decisionRepo, params.runId, params.role),
    };
  }

  private createBacktestPersistence(
    repo: BacktestingRepository,
    decisionRepo: DecisionRepository,
    runId: string,
    role: 'backtest' | 'baseline' | 'candidate',
  ) {
    return {
      persistDecision: async (decision: { id: string; venueAccountId: string; actorType?: string; actorId?: string; instrumentId: string; intent: string; targetSize: { toString(): string }; limitPrice?: { toString(): string }; contextHash?: string; metadata?: Record<string, unknown> }) => {
        await decisionRepo.insertDecision({
          id: decision.id,
          venueAccountId: decision.venueAccountId,
          actorType: decision.actorType,
          actorId: decision.actorId,
          instrumentId: decision.instrumentId,
          intent: decision.intent,
          targetSize: decision.targetSize.toString(),
          limitPrice: decision.limitPrice?.toString(),
          contextHash: decision.contextHash,
          metadata: {
            ...decision.metadata,
            backtestRunId: runId,
            replayRole: role,
          },
        });
      },
      persistDecisionContext: async (context: { decisionId: string; venueAccountId: string; actorType?: string; actorId?: string; contextHash: string; snapshot: { symbol: string; price: string; timestamp: string; data?: Record<string, unknown> }; position: { side: string; size: string; entryPrice: string; realizedPnl: string } | null; referenceMark: { price: string; source: string }; strategyParams: Record<string, unknown> }) => {
        await repo.insertDecisionContext({
          decisionId: context.decisionId,
          venueAccountId: context.venueAccountId,
          actorType: context.actorType,
          actorId: context.actorId,
          contextHash: context.contextHash,
          context: {
            snapshot: context.snapshot,
            position: context.position,
            referenceMark: context.referenceMark,
            balanceSnapshot: null,
            strategyParams: context.strategyParams,
          },
        });
      },
      persistPlan: async () => {},
      markPlanExecuting: async () => {},
      markPlanCompleted: async () => {},
      markPlanFailed: async () => {},
      persistFill: async () => {},
      persistPosition: async () => {},
      persistOrder: async () => {},
    };
  }

  private async assertNoCorpusGaps(
    repo: BacktestingRepository,
    corpusId: string,
    venue: string,
    symbol: string,
    eventType: string,
  ): Promise<void> {
    const maxGapMs = this.config.maxDataGapMs ?? 60_000;
    const gaps = await repo.detectGaps(corpusId, symbol, maxGapMs, venue, eventType);
    if (gaps.length > 0) {
      const firstGap = gaps[0]!;
      throw new Error(
        `Replay corpus has ${gaps.length} gap(s) over ${maxGapMs}ms; first gap ${firstGap.gapMs}ms between ${firstGap.before.toISOString()} and ${firstGap.after.toISOString()}`,
      );
    }
  }

  private async loadFrames(
    repo: BacktestingRepository,
    corpusId: string,
    venue: string,
    symbol: string,
  ): Promise<{ frames: HistoricalFrame[]; eventType: string }> {
    // Load ticker events first; fall back to trade or mark events if no tickers exist.
    // This ensures corpora recorded from trade/mark sources are still replayable.
    let events = await repo.getMarketEvents(corpusId, symbol, { eventType: 'ticker', venue });
    let eventType = 'ticker';
    if (events.length === 0) {
      events = await repo.getMarketEvents(corpusId, symbol, { eventType: 'trade', venue });
      eventType = 'trade';
    }
    if (events.length === 0) {
      events = await repo.getMarketEvents(corpusId, symbol, { eventType: 'mark', venue });
      eventType = 'mark';
    }
    return {
      frames: events.map((e) => ({
        timestamp: e.eventAt.toISOString(),
        symbol: e.symbol,
        price: price(e.price),
        data: (e.data as Record<string, unknown>) ?? undefined,
      })),
      eventType,
    };
  }
}
