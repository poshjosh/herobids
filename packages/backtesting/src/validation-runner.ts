import type { Strategy, Decision } from '@herobids/domain';
import { Decimal } from '@herobids/domain';
import type { BacktestConfig } from './replay-runner.js';
import type { BacktestReport } from './backtest-report.js';
import { runBacktest } from './replay-runner.js';
import type { HistoricalDataFeed } from './historical-data-feed.js';

/**
 * Comparison between two backtest runs over the same corpus.
 */
export interface ValidationComparison {
  /** Baseline strategy identifier */
  baselineStrategy: string;
  /** Candidate strategy identifier */
  candidateStrategy: string;
  /** Total frames processed */
  totalFrames: number;
  /** Number of frames where intent differed */
  intentDivergences: number;
  /** Number of frames where target size differed */
  sizeDivergences: number;
  /** Number of frames where only the candidate decided go_flat */
  candidateOnlyFlats: number;
  /** Number of frames where only the baseline decided go_flat */
  baselineOnlyFlats: number;
  /** Intent divergence percentage */
  intentDivergencePct: number;
  /** P&L comparison */
  pnl: {
    baseline: string;
    candidate: string;
    /** Regression: candidate PnL minus baseline PnL (negative = worse) */
    delta: string;
    /** Percentage regression (negative = worse) */
    regressionPct: number;
  };
  /** Metrics from baseline report */
  baselineReport: BacktestReport;
  /** Metrics from candidate report */
  candidateReport: BacktestReport;
  /** Per-frame decision diffs (only divergent frames included) */
  diffs: DecisionDiff[];
}

/**
 * A single frame where the two strategies diverged.
 */
export interface DecisionDiff {
  frameIndex: number;
  timestamp: string;
  price: string;
  baseline: { intent: string | null; targetSize: string | null };
  candidate: { intent: string | null; targetSize: string | null };
}

/**
 * Thresholds for pass/fail validation.
 */
export interface ValidationThresholds {
  /** Max allowed intent divergence percentage */
  maxDecisionDivergencePct: number;
  /** Max allowed P&L regression percentage (positive number, compared against magnitude of regression) */
  maxPnlRegressionPct: number;
}

/**
 * Validation result — pass or fail with details.
 */
export interface ValidationResult {
  passed: boolean;
  comparison: ValidationComparison;
  /** Specific reasons for failure */
  failures: string[];
}

/**
 * Run a validation comparing a candidate strategy against a baseline.
 * Both are run over the same historical feed with identical risk/config.
 */
export async function runValidation(
  feed: HistoricalDataFeed,
  baselineConfig: BacktestConfig,
  candidateConfig: BacktestConfig,
  thresholds: ValidationThresholds,
): Promise<ValidationResult> {
  if (baselineConfig.warmUpFrames !== candidateConfig.warmUpFrames) {
    throw new Error(
      `Validation requires identical warmUpFrames for both configs (baseline: ${baselineConfig.warmUpFrames}, candidate: ${candidateConfig.warmUpFrames})`,
    );
  }

  // Collect per-frame decisions from both runs
  const baselineDecisions: Array<Decision | null> = [];
  const candidateDecisions: Array<Decision | null> = [];

  const baselineWrapped = wrapStrategy(baselineConfig.strategy, baselineDecisions);
  const candidateWrapped = wrapStrategy(candidateConfig.strategy, candidateDecisions);

  const baselineReport = await runBacktest(feed, { ...baselineConfig, strategy: baselineWrapped });
  const candidateReport = await runBacktest(feed, { ...candidateConfig, strategy: candidateWrapped });

  const comparison = buildComparison(
    feed,
    baselineConfig,
    candidateConfig,
    baselineDecisions,
    candidateDecisions,
    baselineReport,
    candidateReport,
  );

  const failures: string[] = [];

  // Fail if either strategy is erroring — comparisons against error-produced nulls are meaningless
  if (baselineReport.strategyErrors > 0) {
    const errorPct = (baselineReport.strategyErrors / baselineReport.totalFrames) * 100;
    failures.push(
      `Baseline strategy errored on ${baselineReport.strategyErrors}/${baselineReport.totalFrames} frames (${errorPct.toFixed(1)}%)`,
    );
  }
  if (candidateReport.strategyErrors > 0) {
    const errorPct = (candidateReport.strategyErrors / candidateReport.totalFrames) * 100;
    failures.push(
      `Candidate strategy errored on ${candidateReport.strategyErrors}/${candidateReport.totalFrames} frames (${errorPct.toFixed(1)}%)`,
    );
  }

  if (comparison.intentDivergencePct > thresholds.maxDecisionDivergencePct) {
    failures.push(
      `Intent divergence ${comparison.intentDivergencePct.toFixed(1)}% exceeds threshold ${thresholds.maxDecisionDivergencePct}%`,
    );
  }

  if (comparison.pnl.regressionPct < -thresholds.maxPnlRegressionPct) {
    failures.push(
      `P&L regression ${comparison.pnl.regressionPct.toFixed(1)}% exceeds threshold -${thresholds.maxPnlRegressionPct}%`,
    );
  }

  return {
    passed: failures.length === 0,
    comparison,
    failures,
  };
}

/**
 * Wrap a strategy to capture its decisions for comparison.
 */
function wrapStrategy(strategy: Strategy, decisions: Array<Decision | null>): Strategy {
  return {
    id: strategy.id,
    name: strategy.name,
    async evaluate(snapshot, config) {
      const result = await strategy.evaluate(snapshot, config);
      if (result.ok) {
        decisions.push(result.data);
      } else {
        decisions.push(null);
      }
      return result;
    },
  };
}

function buildComparison(
  feed: HistoricalDataFeed,
  baselineConfig: BacktestConfig,
  candidateConfig: BacktestConfig,
  baselineDecisions: Array<Decision | null>,
  candidateDecisions: Array<Decision | null>,
  baselineReport: BacktestReport,
  candidateReport: BacktestReport,
): ValidationComparison {
  const totalFrames = baselineReport.totalFrames;
  const diffs: DecisionDiff[] = [];
  let intentDivergences = 0;
  let sizeDivergences = 0;
  let candidateOnlyFlats = 0;
  let baselineOnlyFlats = 0;

  // Decisions arrays include warm-up evaluations, but reports only count post-warmup.
  // The wrapped strategy captures ALL evaluate() calls including warm-up.
  // We compare only post-warmup decisions — each side uses its own warm-up offset.
  const baselineWarmUp = baselineConfig.warmUpFrames;
  const candidateWarmUp = candidateConfig.warmUpFrames;

  for (let i = 0; i < totalFrames; i++) {
    const bDec = baselineDecisions[baselineWarmUp + i] ?? null;
    const cDec = candidateDecisions[candidateWarmUp + i] ?? null;

    const bIntent = bDec?.intent ?? null;
    const cIntent = cDec?.intent ?? null;
    const bSize = bDec?.targetSize?.toString() ?? null;
    const cSize = cDec?.targetSize?.toString() ?? null;

    const intentDiff = bIntent !== cIntent;
    const sizeDiff = bSize !== cSize;

    if (intentDiff) intentDivergences++;
    if (sizeDiff) sizeDivergences++;
    if (cIntent === 'go_flat' && bIntent !== 'go_flat') candidateOnlyFlats++;
    if (bIntent === 'go_flat' && cIntent !== 'go_flat') baselineOnlyFlats++;

    if (intentDiff || sizeDiff) {
      const frame = feed.frame(baselineWarmUp + i);
      diffs.push({
        frameIndex: baselineWarmUp + i,
        timestamp: frame.timestamp,
        price: frame.price.toString(),
        baseline: { intent: bIntent, targetSize: bSize },
        candidate: { intent: cIntent, targetSize: cSize },
      });
    }
  }

  const baselinePnl = new Decimal(baselineReport.realizedPnl);
  const candidatePnl = new Decimal(candidateReport.realizedPnl);
  const pnlDelta = candidatePnl.minus(baselinePnl);
  // Regression pct relative to baseline absolute PnL (avoid div by zero)
  const regressionPct = baselinePnl.isZero()
    ? (pnlDelta.isZero() ? 0 : (pnlDelta.gt(0) ? 100 : -100))
    : pnlDelta.div(baselinePnl.abs()).mul(100).toNumber();

  return {
    baselineStrategy: baselineConfig.strategy.id,
    candidateStrategy: candidateConfig.strategy.id,
    totalFrames,
    intentDivergences,
    sizeDivergences,
    candidateOnlyFlats,
    baselineOnlyFlats,
    intentDivergencePct: totalFrames > 0 ? (intentDivergences / totalFrames) * 100 : 0,
    pnl: {
      baseline: baselinePnl.toString(),
      candidate: candidatePnl.toString(),
      delta: pnlDelta.toString(),
      regressionPct,
    },
    baselineReport,
    candidateReport,
    diffs,
  };
}
