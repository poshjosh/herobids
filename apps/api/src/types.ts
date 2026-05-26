export type LifecycleCommand = 'start' | 'stop' | 'restart';

export interface LifecycleJob {
  command: LifecycleCommand;
  tradingInstanceId: string;
  config?: Record<string, unknown>;
}

export interface BacktestJob {
  runId: string;
  strategyType: string;
  config: Record<string, unknown>;
  corpusId: string;
  venue: string;
  symbol: string;
}
