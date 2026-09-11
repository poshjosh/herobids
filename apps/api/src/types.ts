export type LifecycleCommand = 'start' | 'stop' | 'restart';

export interface LifecycleJob {
  command: LifecycleCommand;
  botId: string;
  config?: Record<string, unknown>;
}


