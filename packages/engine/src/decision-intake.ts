import type { Decision, MarkSource, SwapTokenSafetyPort, Price } from '@herobids/domain';
import { price } from '@herobids/domain';
import type { Executor, ExecutionResult } from './executor.js';
import type { ExecutionPlan, PlannerDeps } from './planner.js';
import { planDecision } from './planner.js';
import type { Journal } from './journal.js';
import { decisionEvent, planEvent, fillEvent, orderEvent, riskEvent } from './journal.js';
import type { RiskLimits, RiskError } from './risk-gate.js';
import { checkRisk } from './risk-gate.js';
import type { PositionState } from './position-tracker.js';
import { unrealizedPnl } from './position-tracker.js';
import { applyFillAccounting } from './fill-accounting.js';
import { computeDecisionContextHash, DecisionContextHashMismatchError } from './decision-context-hash.js';
import type {
  Clock,
  TradingCyclePersistence,
} from './trading-cycle.js';
import type { EquityTracker } from './equity-tracker.js';
import type { DailyLossTracker } from './daily-loss-tracker.js';
import type { SwapPositionTracker } from './swap-position-tracker.js';

/**
 * Dependencies for decision intake — the shared execution pipeline
 * that both strategies and agents funnel through.
 */
export interface DecisionIntakeDeps {
  actorType: string;
  actorId: string;
  venue: string;
  symbol: string;
  venueAccountId: string;
  venueType?: 'orderbook' | 'swap';
  swapAssets?: { baseAsset: string; quoteAsset: string; baseDecimals?: number; quoteDecimals?: number };
  swapNetwork?: string;
  swapBaseTokenAddress?: string;
  executor: Executor;
  journal: Journal;
  riskLimits: RiskLimits;
  markSource?: MarkSource;
  persistence: TradingCyclePersistence;
  idGen: { planId(): string };
  clock: Clock;
  swapTokenSafety?: SwapTokenSafetyPort;
  safetyOverrideId?: string;
  /** Instance-level swap-token thresholds that tighten operator defaults */
  swapTokenSafetyThresholds?: {
    minLiquidityUsd?: number;
    minVolume24hUsd?: number;
    minAgeHours?: number;
    allowOverrides?: boolean;
  };
  /** Aggregate open position count across all instruments (multi-instrument actors). When provided, overrides single-instrument derivation. */
  openPositionCount?: number;
  /** Current equity (used for %-based risk checks like maxPositionSizePct). */
  equity?: Price;
  /** Equity tracker for drawdown and dynamic equity computation */
  equityTracker?: EquityTracker;
  /** Daily loss tracker for rolling 24h loss */
  dailyLossTracker?: DailyLossTracker;
  /** All open positions for this actor (for multi-instrument unrealized P&L) */
  openPositions?: PositionState[];
  /** Timestamp of last stop-loss exit for this instrument (cooldown enforcement) */
  lastStopLossExitMs?: number;
  /** Pre-computed unrealized P&L (used when caller has per-instrument mark prices) */
  precomputedUnrealizedPnl?: Price;
  /** Swap fill projection tracker for actor-local swap accounting (swap venues only) */
  swapPositionTracker?: SwapPositionTracker;
  /** Execution timeout in ms for the executor call. Default 30_000 (30s).
   *  Prevents the decision intake from hanging indefinitely when the executor
   *  (e.g. shadow mode's market data feed) is unresponsive. */
  executionTimeoutMs?: number;
}

/**
 * Context snapshot for the decision — the market state at decision time.
 */
export interface DecisionContext {
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

/**
 * Pre-execution rejection — a guardrail rejection before execution starts.
 */
export interface PreExecutionRejection {
  scope: 'risk_gate' | 'swap_token_safety' | 'planner';
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

/**
 * Result of submitting a decision for execution.
 */
export interface DecisionIntakeResult {
  decision: Decision;
  plan?: ExecutionPlan;
  riskRejected: boolean;
  /** When riskRejected is true, carries the specific gate error (code, message, context). */
  riskError?: RiskError;
  executionResult?: ExecutionResult;
  position: PositionState;
  executionFailed: boolean;
  /** When executionFailed is true, carries the execution failure code and message (e.g. execution.timeout). */
  executionError?: { code: string; message: string };
  preExecutionRejection?: PreExecutionRejection;
}

/**
 * Submit a validated decision for execution through the engine-owned pipeline.
 *
 * This is the single reusable path for both strategy-originated and agent-originated decisions.
 * It performs: persist decision → persist context → plan → risk check → execute → journal.
 *
 * The caller is responsible for:
 * - validating the decision (schema, authorization, staleness)
 * - stamping `botId` and `contextHash`
 * - providing the decision context snapshot
 */
export async function submitDecisionForExecution(
  decision: Decision,
  context: DecisionContext,
  position: PositionState,
  deps: DecisionIntakeDeps,
): Promise<DecisionIntakeResult> {
  const canonicalContextHash = computeDecisionContextHash(context);
  const suppliedContextHash = normalizeContextHash(decision.contextHash);
  if (suppliedContextHash && suppliedContextHash !== canonicalContextHash) {
    throw new DecisionContextHashMismatchError(canonicalContextHash, suppliedContextHash);
  }

  const resolvedDecision: Decision = decision.contextHash === canonicalContextHash
    ? decision
    : { ...decision, contextHash: canonicalContextHash };

  // 1. Persist decision
  await deps.persistence.persistDecision(resolvedDecision);

  // 2. Persist decision context
  await deps.persistence.persistDecisionContext({
    decisionId: resolvedDecision.id,
    actorType: deps.actorType,
    actorId: deps.actorId,
    contextHash: canonicalContextHash,
    snapshot: context.snapshot,
    position: context.position,
    referenceMark: context.referenceMark,
    strategyParams: context.strategyParams,
  });

  // 3. Journal the decision
  await deps.journal.append(decisionEvent(resolvedDecision));

  // 4. Plan the execution
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
    ...planDecision(resolvedDecision, plannerDeps),
    id: deps.idGen.planId(),
    createdAt: deps.clock.now(),
  };

  if (plan.orders.length === 0) {
    // go_flat from a flat position is a deliberate no-op — the position is already at target.
    // Any other intent that produces no orders (e.g. go_short on a swap venue from flat, which
    // cannot open a borrowed short) should surface a rejection so callers receive actionable
    // feedback instead of a silent success with no trade history.
    if (resolvedDecision.intent !== 'go_flat') {
      return {
        decision: resolvedDecision,
        riskRejected: false,
        position,
        executionFailed: false,
        preExecutionRejection: {
          scope: 'planner',
          code: 'no_orders_planned',
          message: deps.venueType === 'swap' && resolvedDecision.intent === 'go_short'
            ? `Swap venues cannot open short positions — go_short is only valid when closing an existing long position`
            : `Intent '${resolvedDecision.intent}' produced no orders — position may already be at target`,
          retryable: false,
        },
      };
    }
    return { decision: resolvedDecision, riskRejected: false, position, executionFailed: false };
  }

  // 5. Write-ahead: persist execution plan BEFORE execution
  await deps.persistence.persistPlan({
    id: plan.id,
    decisionId: resolvedDecision.id,
    venueAccountId: deps.venueAccountId,
    actorType: deps.actorType,
    actorId: deps.actorId,
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

  // 5b. Swap token safety guard (pre-execution)
  if (deps.venueType === 'swap' && deps.swapTokenSafety && deps.swapBaseTokenAddress) {
    const isBuyPath = plan.orders.some((o) => o.side === 'buy');
    if (isBuyPath) {
      const estimatedNotional = computeEstimatedNotionalUsd(plan, context, deps.swapAssets);
      const safetyResult = await deps.swapTokenSafety.checkSwapTarget({
        actorType: deps.actorType,
        actorId: deps.actorId,
        botId: resolvedDecision.botId,
        venue: deps.venue,
        venueAccountId: deps.venueAccountId,
        network: deps.swapNetwork ?? '',
        tokenAddress: deps.swapBaseTokenAddress,
        tokenSymbol: deps.swapAssets?.baseAsset,
        swapSide: 'buy',
        estimatedOrderNotionalUsd: estimatedNotional,
        overrideId: deps.safetyOverrideId,
        instanceThresholds: deps.swapTokenSafetyThresholds,
      });

      if (!safetyResult.ok) {
        await deps.persistence.markPlanFailed(plan.id);
        return {
          decision: resolvedDecision,
          plan,
          riskRejected: false,
          position,
          executionFailed: false,
          preExecutionRejection: {
            scope: 'swap_token_safety',
            code: safetyResult.error.code,
            message: safetyResult.error.message,
            retryable: safetyResult.error.retryable,
            details: {
              ...safetyResult.error.details,
              overrideTicket: safetyResult.error.overrideTicket,
            },
          },
        };
      }
    }
  }

  // 6. Risk check
  const referenceMark = price(context.referenceMark.price);

  // Compute unrealized P&L for risk snapshot — prefer pre-computed (multi-instrument accuracy)
  const unrealized = deps.precomputedUnrealizedPnl
    ?? (deps.openPositions ?? (position.side !== 'flat' ? [position] : []))
      .filter(p => p.side !== 'flat')
      .reduce((sum, p) => sum.plus(unrealizedPnl(p, referenceMark)), price('0'));

  const riskResult = checkRisk(plan, deps.riskLimits, {
    currentPosition: position.side === 'flat' ? null : position,
    openPositionCount: deps.openPositionCount ?? (position.side === 'flat' ? 0 : 1),
    currentDrawdown: deps.equityTracker
      ? deps.equityTracker.currentDrawdown(unrealized)
      : price('0'),
    referenceMark,
    equity: deps.equityTracker
      ? deps.equityTracker.currentEquity(unrealized)
      : deps.equity,
    dailyLoss: deps.dailyLossTracker?.rollingLoss(Date.now()),
    nowMs: Date.now(),
    lastStopLossExitMs: deps.lastStopLossExitMs,
  });

  if (!riskResult.ok) {
    await deps.persistence.markPlanFailed(plan.id);
    await deps.journal.append(riskEvent(deps.actorType, deps.actorId, riskResult.error));
    return { decision: resolvedDecision, plan, riskRejected: true, riskError: riskResult.error, position, executionFailed: false };
  }

  // 7. Execute (with timeout guard to prevent indefinite hangs)
  await deps.persistence.markPlanExecuting(plan.id);
  const snapshotPrice = price(context.snapshot.price);
  const execTimeoutMs = deps.executionTimeoutMs ?? 30_000;
  const timeoutToken = Symbol('execution_timeout');
  const execResult = await Promise.race([
    deps.executor.execute(plan, snapshotPrice),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(timeoutToken), execTimeoutMs),
    ),
  ]).catch((err: unknown) => {
    if (err === timeoutToken) {
      return { ok: false as const, error: { code: 'execution.timeout', message: `Executor timed out after ${execTimeoutMs}ms for plan ${plan.id}` } };
    }
    throw err;
  });
  if (!execResult.ok) {
    await deps.persistence.markPlanFailed(plan.id);
    await deps.journal.append(planEvent(plan, 'plan.failed'));
    return { decision: resolvedDecision, plan, riskRejected: false, position, executionFailed: true, executionError: execResult.error };
  }

  // 8. Record fills + update position
  let updatedPosition = position;
  for (const fill of execResult.data.fills) {
    const { position: nextPos, realizedPnlDelta } = applyFillAccounting(updatedPosition, fill, {
      equityTracker: deps.equityTracker,
      dailyLossTracker: deps.dailyLossTracker,
    });
    updatedPosition = nextPos;

    // Record the actor-local fill projection for swap venues.
    if (deps.swapPositionTracker && deps.swapAssets) {
      const isBuy = fill.side === 'buy';
      deps.swapPositionTracker.recordSwapFill({
        inputAsset: isBuy ? deps.swapAssets.quoteAsset : deps.swapAssets.baseAsset,
        inputAmount: isBuy ? fill.price.mul(fill.quantity) : fill.quantity,
        outputAsset: isBuy ? deps.swapAssets.baseAsset : deps.swapAssets.quoteAsset,
        outputAmount: isBuy ? fill.quantity : fill.price.mul(fill.quantity),
        timestamp: new Date(fill.filledAt).getTime(),
      });
    }

    await deps.journal.append(fillEvent(fill));
    await deps.persistence.persistFill({
      orderId: fill.orderId as string,
      venueAccountId: deps.venueAccountId,
      botId: fill.botId ?? resolvedDecision.botId,
      actorType: deps.actorType,
      actorId: deps.actorId,
      venue: deps.venue,
      symbol: deps.symbol,
      side: fill.side,
      quantity: fill.quantity.toString(),
      price: fill.price.toString(),
      fee: fill.fee?.toString(),
      feeCurrency: fill.feeCurrency,
      realizedPnlDelta: realizedPnlDelta.toString(),
      filledAt: new Date(fill.filledAt),
    });
  }

  // Persist position state
  await deps.persistence.persistPosition({
    venueAccountId: deps.venueAccountId,
    botId: resolvedDecision.botId,
    actorType: deps.actorType,
    actorId: deps.actorId,
    venue: deps.venue,
    symbol: deps.symbol,
    side: updatedPosition.side,
    size: updatedPosition.size.toString(),
    entryPrice: updatedPosition.entryPrice.toString(),
    realizedPnl: updatedPosition.realizedPnl.toString(),
    markSource: context.referenceMark.source,
  });

  // Mark plan completed/failed
  if (execResult.data.plan.status === 'completed') {
    await deps.persistence.markPlanCompleted(plan.id);
    await deps.journal.append(planEvent(execResult.data.plan, 'plan.completed'));
  }

  // Persist orders
  for (const order of execResult.data.orders) {
    await deps.journal.append(orderEvent(order));
    await deps.persistence.persistOrder({
      id: order.id as string,
      venueAccountId: deps.venueAccountId,
      botId: order.botId ?? resolvedDecision.botId,
      actorType: deps.actorType,
      actorId: deps.actorId,
      executionPlanId: order.executionPlanId,
      venueRefId: order.venueRefId,
      clientOrderId: order.clientOrderId,
      venue: order.venue,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity.toString(),
      price: order.price?.toString(),
      referencePrice: order.referencePrice?.toString(),
      status: order.status,
      submissionState: order.submissionState,
      submitAttemptedAt: order.submitAttemptedAt,
      acknowledgedAt: order.acknowledgedAt,
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
    decision: resolvedDecision,
    plan: execResult.data.plan,
    riskRejected: false,
    executionResult: execResult.data,
    position: updatedPosition,
    executionFailed: false,
  };
}

function normalizeContextHash(contextHash: string | undefined): string | undefined {
  const trimmed = contextHash?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

const STABLECOIN_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'PYUSD', 'USDP', 'TUSD', 'FRAX']);

function computeEstimatedNotionalUsd(
  plan: ExecutionPlan,
  context: DecisionContext,
  swapAssets?: { baseAsset: string; quoteAsset: string },
): string | undefined {
  const buyOrder = plan.orders.find((o) => o.side === 'buy');
  if (!buyOrder) return undefined;

  const quantity = Number(buyOrder.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return undefined;

  // For swap buys, quantity is denominated in the quote asset.
  // If the quote asset is a stablecoin, quantity is already ≈ USD notional.
  if (swapAssets && STABLECOIN_SYMBOLS.has(swapAssets.quoteAsset.toUpperCase())) {
    return quantity.toFixed(2);
  }

  const refPrice = Number(context.referenceMark.price);
  if (!Number.isFinite(refPrice) || refPrice <= 0) return undefined;

  return (quantity * refPrice).toFixed(2);
}
