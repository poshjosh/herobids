export type LifecycleCommand = 'start' | 'stop' | 'restart';

export interface LifecycleJob {
  command: LifecycleCommand;
  tradingInstanceId: string;
  config?: Record<string, unknown>;
}
