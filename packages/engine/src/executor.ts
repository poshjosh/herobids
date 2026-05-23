import type { Result } from '@herobids/domain';
import type { DomainError } from '@herobids/domain';
import type { Price } from '@herobids/domain';
import type { ExecutionPlan } from './planner.js';
import type { FillEvent, ManagedOrder } from './order-state.js';

/** Engine-layer error */
export interface EngineError extends DomainError {
  code: string;
}

/**
 * Executor interface — the boundary between plan and venue.
 * Paper and live executors both implement this.
 */
export interface Executor {
  /**
   * Execute a plan: submit orders, track fills, return results.
   * The executor owns the full order lifecycle for the plan.
   */
  execute(plan: ExecutionPlan, currentPrice: Price): Promise<Result<ExecutionResult, EngineError>>;
}

export interface ExecutionResult {
  plan: ExecutionPlan;
  orders: ManagedOrder[];
  fills: FillEvent[];
}
