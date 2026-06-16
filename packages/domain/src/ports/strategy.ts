import type { Result, DomainError } from '../result.js';
import type { Decision } from '../models/decision.js';
import type { Price } from '../values/money.js';
import type { RiskPlaybook } from '../config/schema.js';

/** Strategy error */
export interface StrategyError extends DomainError {
  code: string;
}

/** Market data snapshot provided to a strategy for decision-making */
export interface MarketSnapshot {
  symbol: string;
  /** Mid-price or last trade price */
  price: Price;
  /** Optional additional data the strategy may need */
  data?: Record<string, unknown>;
  timestamp: string;
  /**
   * Risk playbook guards forwarded from RiskConfigSchema.
   * Populated by the TradingActor before calling strategy.evaluate().
   * If absent or individual fields are undefined, the corresponding
   * playbook check is treated as "not configured" and skipped.
   */
  playbook?: RiskPlaybook;
}

/**
 * Port interface for strategies.
 * A strategy receives market state and produces a Decision (or nothing).
 */
export interface Strategy {
  /** Unique identifier for this strategy type */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;

  /**
   * Evaluate current market state and optionally produce a decision.
   * Returns null/undefined if the strategy has no opinion (hold).
   */
  evaluate(snapshot: MarketSnapshot, config: Record<string, unknown>): Promise<Result<Decision | null, StrategyError>>;
}
