import type { TradingCycleResult, PositionState } from '@herobids/engine';
import type { HistoricalDataFeed } from './historical-data-feed.js';
import type { BacktestConfig } from './replay-runner.js';

/**
 * Summary metrics for a completed backtest run.
 */
export interface BacktestReport {
  runId: string;
  tradingInstanceId: string;
  venue: string;
  symbol: string;
  /** Total frames processed (excluding warm-up) */
  totalFrames: number;
  /** Number of warm-up frames skipped */
  warmUpFrames: number;
  /** Number of cycles that produced a decision */
  totalDecisions: number;
  /** Number of strategy evaluation errors */
  strategyErrors: number;
  /** Number of risk rejections */
  riskRejections: number;
  /** Number of execution failures */
  executionFailures: number;
  /** Total fills executed */
  totalFills: number;
  /** Final position state */
  finalPosition: PositionState;
  /** Realized P&L from position tracker */
  realizedPnl: string;
  /** Start timestamp of replay window */
  startTimestamp: string;
  /** End timestamp of replay window */
  endTimestamp: string;
}

export function buildReport(
  config: BacktestConfig,
  feed: HistoricalDataFeed,
  results: TradingCycleResult[],
  finalPosition: PositionState,
): BacktestReport {
  let totalDecisions = 0;
  let strategyErrors = 0;
  let riskRejections = 0;
  let executionFailures = 0;
  let totalFills = 0;

  for (const r of results) {
    if (r.decided) totalDecisions++;
    if (r.strategyError) strategyErrors++;
    if (r.riskRejected) riskRejections++;
    if (r.executionFailed) executionFailures++;
    if (r.executionResult) totalFills += r.executionResult.fills.length;
  }

  return {
    runId: config.runId,
    tradingInstanceId: config.tradingInstanceId,
    venue: config.venue,
    symbol: config.symbol,
    totalFrames: results.length,
    warmUpFrames: config.warmUpFrames,
    totalDecisions,
    strategyErrors,
    riskRejections,
    executionFailures,
    totalFills,
    finalPosition,
    realizedPnl: finalPosition.realizedPnl.toString(),
    startTimestamp: feed.frame(config.warmUpFrames).timestamp,
    endTimestamp: feed.frame(feed.length - 1).timestamp,
  };
}
