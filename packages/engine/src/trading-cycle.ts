import type { Strategy, MarketSnapshot, Decision, MarkSource, SwapTokenSafetyPort, Price } from '@herobids/domain';
import type { Executor, ExecutionResult } from './executor.js';
import type { ExecutionPlan } from './planner.js';
import type { Journal } from './journal.js';
import type { RiskLimits } from './risk-gate.js';
import type { PositionState } from './position-tracker.js';
import type { EquityTracker } from './equity-tracker.js';
import type { DailyLossTracker } from './daily-loss-tracker.js';
import { submitDecisionForExecution } from './decision-intake.js';
import type { DecisionContext } from './decision-intake.js';
import { computeDecisionContextHash } from './decision-context-hash.js';

/**
 * Clock abstraction — allows backtesting to inject simulated time.
 */
export interface Clock {
  now(): string;
}

/** Real wall-clock implementation. */
export const realClock: Clock = {
  now: () => new Date().toISOString(),
};

/**
 * Persistence hooks called during a trading cycle.
 * The worker fills these with real DB calls; backtests may use no-ops or in-memory stores.
 */
export interface TradingCyclePersistence {
  persistDecision(decision: Decision): Promise<void>;
  persistDecisionContext(context: PersistDecisionContextParams): Promise<void>;
  persistPlan(plan: InsertPlanParams): Promise<void>;
  markPlanExecuting(planId: string): Promise<void>;
  markPlanCompleted(planId: string): Promise<void>;
  markPlanFailed(planId: string): Promise<void>;
  persistFill(fill: PersistFillParams): Promise<void>;
  persistPosition(position: PersistPositionParams): Promise<void>;
  persistOrder(order: PersistOrderParams): Promise<void>;
}

export interface InsertPlanParams {
  id: string;
  decisionId: string;
  venueAccountId: string;
  actorType?: string;
  actorId?: string;
  venue: string;
  symbol: string;
  action: string;
  plannedOrders: { side: string; type: string; quantity: string; price?: string }[];
}

export interface PersistFillParams {
  orderId: string;
  venueAccountId: string;
  botId?: string;
  actorType?: string;
  actorId?: string;
  venue: string;
  symbol: string;
  side: string;
  quantity: string;
  price: string;
  fee?: string;
  feeCurrency?: string;
  /** Realized P&L delta for this fill (position P&L minus fee) */
  realizedPnlDelta?: string;
  filledAt: Date;
}

export interface PersistDecisionContextParams {
  decisionId: string;
  actorType?: string;
  actorId?: string;
  contextHash: string;
  snapshot: {
    symbol: string;
    price: string;
    timestamp: string;
    data?: Record<string, unknown>;
  };
  position: {
    side: string;
    size: string;
    entryPrice: string;
    realizedPnl: string;
  } | null;
  referenceMark: {
    price: string;
    source: string;
  };
  strategyParams: Record<string, unknown>;
}

export interface PersistPositionParams {
  venueAccountId: string;
  botId?: string;
  actorType?: string;
  actorId?: string;
  venue: string;
  symbol: string;
  side: string;
  size: string;
  entryPrice: string;
  realizedPnl: string;
  markSource?: string;
}

export interface PersistOrderParams {
  id: string;
  venueAccountId: string;
  botId?: string;
  actorType?: string;
  actorId?: string;
  executionPlanId?: string;
  venueRefId?: string;
  clientOrderId?: string;
  venue: string;
  symbol: string;
  side: string;
  type: string;
  quantity: string;
  price?: string;
  referencePrice?: string;
  status: string;
  submissionState?: 'prepared' | 'submit_attempting' | 'venue_acknowledged' | 'terminal';
  submitAttemptedAt?: string;
  acknowledgedAt?: string;
  filledQuantity?: string;
  avgFillPrice?: string;
}

/**
 * Dependencies for a single trading cycle invocation.
 */
export interface TradingCycleDeps {
  actorType?: string;
  actorId?: string;
  botId?: string;
  venue: string;
  symbol: string;
  venueAccountId: string;
  venueType?: 'orderbook' | 'swap';
  swapAssets?: { baseAsset: string; quoteAsset: string };
  swapNetwork?: string;
  swapBaseTokenAddress?: string;
  strategy: Strategy;
  strategyConfig: Record<string, unknown>;
  executor: Executor;
  journal: Journal;
  riskLimits: RiskLimits;
  markSource?: MarkSource;
  persistence: TradingCyclePersistence;
  idGen: { planId(): string; decisionId(): string };
  clock: Clock;
  swapTokenSafety?: SwapTokenSafetyPort;
  swapTokenSafetyThresholds?: {
    minLiquidityUsd?: number;
    minVolume24hUsd?: number;
    minAgeHours?: number;
    allowOverrides?: boolean;
  };
  /** Equity tracker for drawdown risk checks */
  equityTracker?: EquityTracker;
  /** Rolling 24h daily loss tracker */
  dailyLossTracker?: DailyLossTracker;
  /** Open positions (for multi-position unrealized P&L) */
  openPositions?: PositionState[];
  /** Timestamp of last stop-loss exit (for cooldown enforcement) */
  lastStopLossExitMs?: number;
  /** Pre-computed unrealized P&L across all positions */
  precomputedUnrealizedPnl?: Price;
}

/**
 * The result of a single trading cycle.
 */
export interface TradingCycleResult {
  /** Whether a decision was produced */
  decided: boolean;
  /** The decision (if any) */
  decision?: Decision;
  /** The plan (if any) */
  plan?: ExecutionPlan;
  /** Whether risk rejected the plan */
  riskRejected: boolean;
  /** Execution result (if risk passed) */
  executionResult?: ExecutionResult;
  /** Updated position state after applying fills */
  position: PositionState;
  /** Whether execution failed */
  executionFailed: boolean;
  /** Whether the strategy returned an error (distinct from 'hold'/null) */
  strategyError: boolean;
  /** Pre-execution guardrail rejection (e.g. swap token safety) */
  preExecutionRejection?: import('./decision-intake.js').PreExecutionRejection;
}

/**
 * Run one trading cycle: snapshot → strategy → plan → risk → execute → persist.
 *
 * This is the reusable core that both the live worker and backtest runner call.
 * It does NOT own timers, stream lifecycle, reconciliation, or shadow pending-limit resolution.
 */
export async function runTradingCycle(
  snapshot: MarketSnapshot,
  position: PositionState,
  deps: TradingCycleDeps,
): Promise<TradingCycleResult> {
  // 1. Evaluate strategy
  const evalResult = await deps.strategy.evaluate(snapshot, deps.strategyConfig);
  if (!evalResult.ok) {
    // Surface strategy failures — journal them so they are observable
    await deps.journal.append({
      actorType: deps.actorType ?? 'bot',
      actorId: deps.actorId ?? deps.botId ?? '',
      type: 'strategy.error',
      payload: { code: evalResult.error.code, message: evalResult.error.message },
    });
    return { decided: false, riskRejected: false, position, executionFailed: false, strategyError: true };
  }

  const decision = evalResult.data;
  if (!decision) {
    return { decided: false, riskRejected: false, position, executionFailed: false, strategyError: false };
  }

  // Resolve reference mark for context
  const { referenceMark, referenceMarkSource } = await resolveReferenceMark(snapshot, deps.symbol, deps.markSource);

  // Build decision context
  const decisionContext: DecisionContext = {
    snapshot: {
      symbol: snapshot.symbol,
      price: snapshot.price.toString(),
      timestamp: snapshot.timestamp,
      data: snapshot.data,
    },
    position: position.side === 'flat'
      ? null
      : {
          side: position.side,
          size: position.size.toString(),
          entryPrice: position.entryPrice.toString(),
          realizedPnl: position.realizedPnl.toString(),
        },
    referenceMark: {
      price: referenceMark.toString(),
      source: referenceMarkSource,
    },
    strategyParams: deps.strategyConfig,
  };

  // Stamp actor context and canonical context hash.
  const contextHash = computeDecisionContextHash(decisionContext);
  const stampedDecision: Decision = {
    ...decision,
    venueAccountId: deps.venueAccountId as Decision['venueAccountId'],
    actorType: decision.actorType ?? deps.actorType as Decision['actorType'],
    actorId: decision.actorId || (deps.actorId ?? deps.botId ?? ''),
    botId: (deps.botId as import('@herobids/domain').BotId | undefined) ?? decision.botId,
    contextHash,
  };

  // 2. Submit decision through the shared intake pipeline
  const intakeResult = await submitDecisionForExecution(stampedDecision, decisionContext, position, {
    actorType: deps.actorType ?? 'bot',
    actorId: deps.actorId ?? deps.botId ?? '',
    venue: deps.venue,
    symbol: deps.symbol,
    venueAccountId: deps.venueAccountId,
    venueType: deps.venueType,
    swapAssets: deps.swapAssets,
    swapNetwork: deps.swapNetwork,
    swapBaseTokenAddress: deps.swapBaseTokenAddress,
    executor: deps.executor,
    journal: deps.journal,
    riskLimits: deps.riskLimits,
    markSource: deps.markSource,
    persistence: deps.persistence,
    idGen: deps.idGen,
    clock: deps.clock,
    swapTokenSafety: deps.swapTokenSafety,
    swapTokenSafetyThresholds: deps.swapTokenSafetyThresholds,
    equityTracker: deps.equityTracker,
    dailyLossTracker: deps.dailyLossTracker,
    openPositions: deps.openPositions,
    lastStopLossExitMs: deps.lastStopLossExitMs,
    precomputedUnrealizedPnl: deps.precomputedUnrealizedPnl,
  });

  return {
    decided: true,
    decision: intakeResult.decision,
    plan: intakeResult.plan,
    riskRejected: intakeResult.riskRejected,
    executionResult: intakeResult.executionResult,
    position: intakeResult.position,
    executionFailed: intakeResult.executionFailed,
    strategyError: false,
    preExecutionRejection: intakeResult.preExecutionRejection,
  };
}

async function resolveReferenceMark(
  snapshot: MarketSnapshot,
  symbol: string,
  markSource?: MarkSource,
): Promise<{
  markResult: Awaited<ReturnType<MarkSource['fetchMark']>> | undefined;
  referenceMark: typeof snapshot.price;
  referenceMarkSource: string;
}> {
  const markResult = markSource
    ? await markSource.fetchMark(symbol)
    : undefined;

  if (markResult?.ok && !markResult.data.stale) {
    return {
      markResult,
      referenceMark: markResult.data.price,
      referenceMarkSource: markResult.data.source,
    };
  }

  return {
    markResult,
    referenceMark: snapshot.price,
    referenceMarkSource: 'snapshot',
  };
}
