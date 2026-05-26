import type { Strategy, MarketSnapshot, MarkSource } from '@herobids/domain';
import type { Executor, Journal, RiskLimits, TradingCyclePersistence, TradingCycleResult } from '@herobids/engine';
import { runTradingCycle, flatPosition, PaperExecutor, InMemoryJournal } from '@herobids/engine';
import type { PositionState } from '@herobids/engine';
import { SimulatedClock } from './simulated-clock.js';
import type { HistoricalDataFeed } from './historical-data-feed.js';
import type { BacktestReport } from './backtest-report.js';
import { buildReport } from './backtest-report.js';

/**
 * Configuration for a backtest run.
 */
export interface BacktestConfig {
  /** Unique run identifier */
  runId: string;
  /** Trading instance ID (for persistence hooks) */
  tradingInstanceId: string;
  /** Venue name */
  venue: string;
  /** Symbol being traded */
  symbol: string;
  /** Venue account ID */
  venueAccountId: string;
  /** Strategy to evaluate */
  strategy: Strategy;
  /** Strategy params to pass into evaluate() */
  strategyConfig: Record<string, unknown>;
  /** Risk limits */
  riskLimits: RiskLimits;
  /** Number of initial frames to skip (warm-up period for strategy lookback) */
  warmUpFrames: number;
  /** Optional mark source */
  markSource?: MarkSource;
  /** Optional venue type */
  venueType?: 'orderbook' | 'swap';
  /** Optional swap assets */
  swapAssets?: { baseAsset: string; quoteAsset: string };
  /** Optional persistence hooks (defaults to no-ops) */
  persistence?: TradingCyclePersistence;
  /** Optional executor (defaults to PaperExecutor) */
  executor?: Executor;
  /** Optional journal (defaults to InMemoryJournal) */
  journal?: Journal;
}

/** No-op persistence for backtests that don't need DB writes */
const noopPersistence: TradingCyclePersistence = {
  persistDecision: async () => {},
  persistPlan: async () => {},
  markPlanExecuting: async () => {},
  markPlanCompleted: async () => {},
  markPlanFailed: async () => {},
  persistFill: async () => {},
  persistPosition: async () => {},
  persistOrder: async () => {},
};

/**
 * Run a backtest over historical data using the extracted trading cycle.
 *
 * This is the replay core: it owns clock advancement, warm-up handling, and
 * frame iteration. All execution logic goes through `runTradingCycle()`.
 */
export async function runBacktest(
  feed: HistoricalDataFeed,
  config: BacktestConfig,
): Promise<BacktestReport> {
  if (config.warmUpFrames >= feed.length) {
    throw new Error(`warmUpFrames (${config.warmUpFrames}) must be less than feed length (${feed.length})`);
  }

  const clock = new SimulatedClock(feed.frame(0).timestamp);
  const journal = config.journal ?? new InMemoryJournal();
  const persistence = config.persistence ?? noopPersistence;
  let planCounter = 0;
  let decisionCounter = 0;
  const idGen = {
    planId: () => `${config.runId}-p-${++planCounter}`,
    decisionId: () => `${config.runId}-d-${++decisionCounter}`,
  };
  const executor = config.executor ?? new PaperExecutor(
    { orderId: () => `${config.runId}-o-${++planCounter}` as any, fillId: () => `${config.runId}-f-${++planCounter}` as any },
    clock,
  );

  let position: PositionState = flatPosition(config.venue, config.symbol);
  const cycleResults: TradingCycleResult[] = [];

  // Warm-up: feed frames to strategy without acting on decisions
  for (let i = 0; i < config.warmUpFrames; i++) {
    const frame = feed.frame(i);
    clock.advance(frame.timestamp);
    const snapshot: MarketSnapshot = { symbol: frame.symbol, price: frame.price, timestamp: frame.timestamp, data: frame.data };
    // Only evaluate strategy to build up internal state (e.g. lookback buffers)
    await config.strategy.evaluate(snapshot, config.strategyConfig);
  }

  // Main replay loop
  for (let i = config.warmUpFrames; i < feed.length; i++) {
    const frame = feed.frame(i);
    clock.advance(frame.timestamp);

    const snapshot: MarketSnapshot = { symbol: frame.symbol, price: frame.price, timestamp: frame.timestamp, data: frame.data };

    const result = await runTradingCycle(snapshot, position, {
      tradingInstanceId: config.tradingInstanceId,
      venue: config.venue,
      symbol: config.symbol,
      venueAccountId: config.venueAccountId,
      venueType: config.venueType,
      swapAssets: config.swapAssets,
      strategy: config.strategy,
      strategyConfig: config.strategyConfig,
      executor,
      journal,
      riskLimits: config.riskLimits,
      markSource: config.markSource,
      persistence,
      idGen,
      clock,
    });

    position = result.position;
    cycleResults.push(result);
  }

  return buildReport(config, feed, cycleResults, position);
}
