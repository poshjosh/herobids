export type LifecycleCommand = 'start' | 'stop' | 'restart';

export interface LifecycleJob {
  command: LifecycleCommand;
  botId: string;
  config?: Record<string, unknown>;
}

export interface BacktestJob {
  runId: string;
  mode?: 'backtest' | 'validation';
  strategyType?: string;
  config?: Record<string, unknown>;
  corpusId: string;
  venue: string;
  symbol: string;
  baseline?: { strategyType: string; config: Record<string, unknown> };
  candidate?: { strategyType: string; config: Record<string, unknown> };
  thresholds?: { maxDecisionDivergencePct?: number; maxPnlRegressionPct?: number };
}
