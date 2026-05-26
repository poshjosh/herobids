import { Worker } from 'bullmq';
import pino from 'pino';
import type { Database } from '@herobids/db';
import { BacktestingRepository, PgJournal } from '@herobids/db';
import { MomentumStrategy, LlmStrategy } from '@herobids/strategy';
import { runBacktest, ArrayHistoricalDataFeed } from '@herobids/backtesting';
import type { HistoricalFrame } from '@herobids/backtesting';
import { quantity, price } from '@herobids/domain';
import type { Strategy } from '@herobids/domain';
import crypto from 'node:crypto';

export const BACKTEST_QUEUE_NAME = 'backtest-runs';

export interface BacktestJobData {
  runId: string;
  strategyType: string;
  config: Record<string, unknown>;
  corpusId: string;
  venue: string;
  symbol: string;
}

export interface BacktestRuntimeConfig {
  redis: { host: string; port: number; password?: string; username?: string; db?: number };
  concurrency?: number;
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
        const { runId, strategyType, config, corpusId, venue, symbol } = job.data;
        logger.info({ runId, strategyType, venue, symbol }, 'Starting backtest run');

        try {
          await repo.markBacktestRunning(runId);

          // Resolve strategy
          const strategy = this.createStrategy(strategyType);

          // Load market data
          const frames = await this.loadFrames(repo, corpusId, venue, symbol);
          if (frames.length === 0) {
            throw new Error('No market data frames available for replay');
          }

          const feed = new ArrayHistoricalDataFeed(frames);

          // Build a backtest-scoped journal
          const backtestJournal = new PgJournal(this.db);
          // Wrap to inject backtestRunId
          const scopedJournal = {
            append: async (entry: { tradingInstanceId?: string; type: string; payload: Record<string, unknown> }) => {
              await backtestJournal.append({ ...entry, backtestRunId: runId });
            },
            appendBatch: async (entries: Array<{ tradingInstanceId?: string; type: string; payload: Record<string, unknown> }>) => {
              await backtestJournal.appendBatch(entries.map((e) => ({ ...e, backtestRunId: runId })));
            },
          };

          // Run the backtest
          // LLM strategies are stateless (no lookback buffer) — warm-up would only waste tokens on real API calls.
          // Momentum strategies need at least `lookbackPeriod` frames to fill their internal buffer.
          const strategyParams = (config['strategyParams'] as Record<string, unknown>) ?? config;
          const lookbackPeriod = strategyType === 'momentum' ? ((strategyParams['lookbackPeriod'] as number) ?? 5) : 0;
          const defaultWarmUp = strategyType === 'llm' ? 0 : Math.max(lookbackPeriod, Math.min(5, Math.floor(frames.length * 0.1)));
          const warmUpFrames = (config['warmUpFrames'] as number) ?? defaultWarmUp;
          const riskLimits = {
            maxPositionSize: quantity(String(config['maxPositionSize'] ?? '100')),
            maxOpenPositions: (config['maxOpenPositions'] as number) ?? 5,
            maxDrawdown: price(String(config['maxDrawdown'] ?? '10000')),
          };

          const report = await runBacktest(feed, {
            runId,
            tradingInstanceId: `backtest-${runId}`,
            venue,
            symbol,
            venueAccountId: 'backtest',
            strategy,
            strategyConfig: (config['strategyParams'] as Record<string, unknown>) ?? config,
            riskLimits,
            warmUpFrames,
            journal: scopedJournal,
          });

          // Persist metrics
          await repo.markBacktestCompleted(runId, {
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

          logger.info({ runId, totalFills: report.totalFills, realizedPnl: report.realizedPnl }, 'Backtest completed');
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

  private async loadFrames(
    repo: BacktestingRepository,
    corpusId: string,
    venue: string,
    symbol: string,
  ): Promise<HistoricalFrame[]> {
    // Load ticker events first; fall back to trade or mark events if no tickers exist.
    // This ensures corpora recorded from trade/mark sources are still replayable.
    let events = await repo.getMarketEvents(corpusId, symbol, { eventType: 'ticker', venue });
    if (events.length === 0) {
      events = await repo.getMarketEvents(corpusId, symbol, { eventType: 'trade', venue });
    }
    if (events.length === 0) {
      events = await repo.getMarketEvents(corpusId, symbol, { eventType: 'mark', venue });
    }
    return events.map((e) => ({
      timestamp: e.eventAt.toISOString(),
      symbol: e.symbol,
      price: price(e.price),
      data: (e.data as Record<string, unknown>) ?? undefined,
    }));
  }
}
