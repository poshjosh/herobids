import type { DecisionIntakeDeps, DecisionContext, PositionState } from '@herobids/engine';

/**
 * ExecutionActor — the shared decision-routing contract.
 *
 * Both TradingActor (bots) and AgentTradingActor implement this interface.
 * The actorRegistry stores ExecutionActors keyed by actor ID (bot ID or agent ID).
 * The intakeResolver uses this surface to resolve execution context for any submitted decision.
 */
export interface ExecutionActor {
  readonly isRunning: boolean;
  getIntakeDeps(instrumentId?: string): DecisionIntakeDeps | undefined;
  getDecisionContext(instrumentId?: string): DecisionContext | undefined | Promise<DecisionContext | undefined>;
  getPosition(instrumentId?: string): PositionState | undefined;
}
