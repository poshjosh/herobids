import type { DecisionIntakeDeps, DecisionContext, PositionState } from '@herobids/engine';

/** Rejection codes for when getIntakeDeps cannot provide execution context */
export type IntakeRejectionCode =
  | 'circuit_breaker_open'
  | 'stop_loss_active'
  | 'instance_not_running'
  | 'no_executor'
  | 'swap_recovery_ambiguous';

export interface IntakeRejection {
  rejected: true;
  code: IntakeRejectionCode;
  message: string;
  retryable: boolean;
}

export type IntakeResult = DecisionIntakeDeps | IntakeRejection | undefined;

export function isIntakeRejection(result: IntakeResult): result is IntakeRejection {
  return result != null && 'rejected' in result && result.rejected === true;
}

/**
 * ExecutionActor — the shared decision-routing contract.
 *
 * Both TradingActor (bots) and AgentTradingActor implement this interface.
 * The actorRegistry stores ExecutionActors keyed by actor ID (bot ID or agent ID).
 * The intakeResolver uses this surface to resolve execution context for any submitted decision.
 */
export interface ExecutionActor {
  readonly isRunning: boolean;
  getIntakeDeps(instrumentId?: string): IntakeResult;
  getDecisionContext(instrumentId?: string): DecisionContext | undefined | Promise<DecisionContext | undefined>;
  getPosition(instrumentId?: string): PositionState | undefined;
  /** Notify the actor of an execution outcome for circuit breaker tracking */
  recordExecutionOutcome?(success: boolean): void;
}
