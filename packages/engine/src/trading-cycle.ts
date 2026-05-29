import type { Strategy, MarketSnapshot, Decision, MarkSource, TradingInstanceId } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { price } from '@herobids/domain';
import crypto from 'node:crypto';
import type { Executor, ExecutionResult, EngineError } from './executor.js';
import type { ExecutionPlan, PlannerDeps } from './planner.js';
import { planDecision } from './planner.js';
import type { Journal } from './journal.js';
import { decisionEvent, planEvent, fillEvent, orderEvent, riskEvent } from './journal.js';
import type { RiskLimits, RiskSnapshot } from './risk-gate.js';
import { checkRisk } from './risk-gate.js';
import type { PositionState } from './position-tracker.js';
import { applyFill } from './position-tracker.js';
import type { FillEvent, ManagedOrder } from './order-state.js';

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
  tradingInstanceId: string;
  venue: string;
  symbol: string;
  action: string;
  plannedOrders: { side: string; type: string; quantity: string; price?: string }[];
}

export interface PersistFillParams {
  orderId: string;
  tradingInstanceId: string;
  venue: string;
  symbol: string;
  side: string;
  quantity: string;
  price: string;
  fee?: string;
  feeCurrency?: string;
  filledAt: Date;
}

export interface PersistDecisionContextParams {
  decisionId: string;
  tradingInstanceId: string;
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
  tradingInstanceId: string;
  venueAccountId: string;
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
  tradingInstanceId: string;
  executionPlanId?: string;
  venueRefId?: string;
  clientOrderId?: string;
  venue: string;
  symbol: string;
  side: string;
  type: string;
  quantity: string;
  price?: string;
  status: string;
  filledQuantity?: string;
  avgFillPrice?: string;
}

/**
 * Dependencies for a single trading cycle invocation.
 */
export interface TradingCycleDeps {
  tradingInstanceId: string;
  venue: string;
  symbol: string;
  venueAccountId: string;
  venueType?: 'orderbook' | 'swap';
  swapAssets?: { baseAsset: string; quoteAsset: string };
  strategy: Strategy;
  strategyConfig: Record<string, unknown>;
  executor: Executor;
  journal: Journal;
  riskLimits: RiskLimits;
  markSource?: MarkSource;
  persistence: TradingCyclePersistence;
  idGen: { planId(): string; decisionId(): string };
  clock: Clock;
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
      tradingInstanceId: deps.tradingInstanceId,
      type: 'strategy.error',
      payload: { code: evalResult.error.code, message: evalResult.error.message },
    });
    return { decided: false, riskRejected: false, position, executionFailed: false, strategyError: true };
  }

  const decision = evalResult.data;
  if (!decision) {
    return { decided: false, riskRejected: false, position, executionFailed: false, strategyError: false };
  }

  // Stamp the trading instance ID
  const stampedDecision: Decision = {
    ...decision,
    tradingInstanceId: deps.tradingInstanceId as TradingInstanceId,
    contextHash: decision.contextHash ?? computeContextHash(snapshot, position, deps.strategyConfig),
  };

  // Persist decision
  await deps.persistence.persistDecision(stampedDecision);

  const { markResult, referenceMark, referenceMarkSource } = await resolveReferenceMark(snapshot, deps.symbol, deps.markSource);

  await deps.persistence.persistDecisionContext({
    decisionId: stampedDecision.id,
    tradingInstanceId: deps.tradingInstanceId,
    contextHash: stampedDecision.contextHash,
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
  });

  // Journal the decision
  await deps.journal.append(decisionEvent(stampedDecision));

  // 2. Plan the execution
  const plannerDeps: PlannerDeps = {
    venue: deps.venue,
    symbol: deps.symbol,
    venueType: deps.venueType,
    swapAssets: deps.swapAssets,
    currentPosition: position.side === 'flat' ? null : {
      symbol: position.symbol,
      side: position.side,
      size: position.size,
      entryPrice: position.entryPrice,
    },
  };
  const plan: ExecutionPlan = {
    ...planDecision(stampedDecision, plannerDeps),
    id: deps.idGen.planId(),
    createdAt: deps.clock.now(),
  };

  if (plan.orders.length === 0) {
    return { decided: true, decision: stampedDecision, riskRejected: false, position, executionFailed: false, strategyError: false };
  }

  // Write-ahead: persist execution plan BEFORE execution
  await deps.persistence.persistPlan({
    id: plan.id,
    decisionId: stampedDecision.id ?? plan.decisionId,
    tradingInstanceId: deps.tradingInstanceId,
    venue: deps.venue,
    symbol: deps.symbol,
    action: plan.action,
    plannedOrders: plan.orders.map((o) => ({
      side: o.side,
      type: o.type,
      quantity: o.quantity.toString(),
      price: o.price?.toString(),
    })),
  });

  await deps.journal.append(planEvent(plan, 'plan.created'));

  // 3. Risk check
  const riskResult = checkRisk(plan, deps.riskLimits, {
    currentPosition: position.side === 'flat' ? null : position,
    openPositionCount: position.side === 'flat' ? 0 : 1,
    currentDrawdown: price('0'),
    referenceMark,
  });

  if (!riskResult.ok) {
    await deps.persistence.markPlanFailed(plan.id);
    await deps.journal.append(riskEvent(deps.tradingInstanceId, riskResult.error));
    return { decided: true, decision: stampedDecision, plan, riskRejected: true, position, executionFailed: false, strategyError: false };
  }

  // 4. Execute
  await deps.persistence.markPlanExecuting(plan.id);
  const execResult = await deps.executor.execute(plan, snapshot.price);
  if (!execResult.ok) {
    await deps.persistence.markPlanFailed(plan.id);
    await deps.journal.append(planEvent(plan, 'plan.failed'));
    return { decided: true, decision: stampedDecision, plan, riskRejected: false, position, executionFailed: true, strategyError: false };
  }

  // 5. Record fills + update position
  let updatedPosition = position;
  for (const fill of execResult.data.fills) {
    updatedPosition = applyFill(updatedPosition, fill);
    await deps.journal.append(fillEvent(fill));
    await deps.persistence.persistFill({
      orderId: fill.orderId as string,
      tradingInstanceId: deps.tradingInstanceId,
      venue: deps.venue,
      symbol: deps.symbol,
      side: fill.side,
      quantity: fill.quantity.toString(),
      price: fill.price.toString(),
      fee: fill.fee?.toString(),
      feeCurrency: fill.feeCurrency,
      filledAt: new Date(fill.filledAt),
    });
  }

  // Persist position state
  await deps.persistence.persistPosition({
    tradingInstanceId: deps.tradingInstanceId,
    venueAccountId: deps.venueAccountId,
    venue: deps.venue,
    symbol: deps.symbol,
    side: updatedPosition.side,
    size: updatedPosition.size.toString(),
    entryPrice: updatedPosition.entryPrice.toString(),
    realizedPnl: updatedPosition.realizedPnl.toString(),
    markSource: markResult?.ok ? markResult.data.source : undefined,
  });

  // Mark plan completed immediately (paper/shadow fill synchronously)
  if (execResult.data.plan.status === 'completed') {
    await deps.persistence.markPlanCompleted(plan.id);
    await deps.journal.append(planEvent(execResult.data.plan, 'plan.completed'));
  }

  // Persist orders (before marking failed — ensures rejection detail survives partial failures)
  for (const order of execResult.data.orders) {
    await deps.journal.append(orderEvent(order));
    await deps.persistence.persistOrder({
      id: order.id as string,
      tradingInstanceId: deps.tradingInstanceId,
      executionPlanId: order.executionPlanId,
      venueRefId: order.venueRefId ?? `local-${order.id}`,
      clientOrderId: order.clientOrderId,
      venue: order.venue,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity.toString(),
      price: order.price?.toString(),
      status: order.status,
      filledQuantity: order.filledQuantity?.toString(),
      avgFillPrice: order.avgFillPrice?.toString(),
    });
  }

  // Mark plan failed AFTER order detail is persisted
  if (execResult.data.plan.status === 'failed') {
    await deps.persistence.markPlanFailed(plan.id);
    await deps.journal.append(planEvent(execResult.data.plan, 'plan.failed'));
  }

  return {
    decided: true,
    decision: stampedDecision,
    plan: execResult.data.plan,
    riskRejected: false,
    executionResult: execResult.data,
    position: updatedPosition,
    executionFailed: false,
    strategyError: false,
  };
}

function computeContextHash(
  snapshot: MarketSnapshot,
  position: PositionState,
  strategyConfig: Record<string, unknown>,
): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      snapshot: {
        symbol: snapshot.symbol,
        price: snapshot.price.toString(),
        timestamp: snapshot.timestamp,
        data: snapshot.data,
      },
      position: {
        side: position.side,
        size: position.size.toString(),
        entryPrice: position.entryPrice.toString(),
        realizedPnl: position.realizedPnl.toString(),
      },
      strategyConfig,
    }))
    .digest('hex')
    .slice(0, 16);
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
