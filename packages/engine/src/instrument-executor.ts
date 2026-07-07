import type { Decision, OrderbookVenuePort, SwapVenuePort, MarkSource, SwapTokenSafetyPort } from '@herobids/domain';
import { PaperExecutor } from './paper-executor.js';
import { LiveExecutor } from './live-executor.js';
import { SwapLiveExecutor } from './swap-live-executor.js';
import type { Executor } from './executor.js';
import type { FillEvent, ManagedOrder } from './order-state.js';
import type { PositionState } from './position-tracker.js';
import type { RiskLimits } from './risk-gate.js';
import type { TradingCyclePersistence, PersistFillParams, PersistOrderParams, PersistPositionParams } from './trading-cycle.js';
import { realClock } from './trading-cycle.js';
import { submitDecisionForExecution } from './decision-intake.js';
import type { DecisionContext, PreExecutionRejection } from './decision-intake.js';
import type { Journal } from './journal.js';
import type { EquityTracker } from './equity-tracker.js';
import type { DailyLossTracker } from './daily-loss-tracker.js';
import type { IdGenerator } from './paper-executor.js';
import type { SwapPositionTracker } from './swap-position-tracker.js';

/** Minimal fill persistence. Structurally compatible with @herobids/db FillRepository. */
interface FillRepo {
  insertFill(fill: PersistFillParams): Promise<string>;
}

/** Minimal order persistence. Structurally compatible with @herobids/db OrderRepository. */
interface OrderRepo {
  upsertByVenueRefId(order: PersistOrderParams): Promise<void>;
  upsertByClientOrderId?(order: PersistOrderParams): Promise<void>;
}

/** Minimal position persistence. Structurally compatible with @herobids/db PositionRepository. */
type UpsertPositionInput = Omit<PersistPositionParams, 'actorType' | 'actorId'> & {
  actorType: string;
  actorId: string;
};

interface PositionRepo {
  upsert(pos: UpsertPositionInput): Promise<void>;
}

export interface InstrumentExecutorDeps {
  venue: string;
  symbol: string;
  venueAccountId: string;
  executionMode: 'paper' | 'shadow' | 'live';
  venueType: 'orderbook' | 'swap';
  /** Required when executionMode === 'live' and venueType === 'orderbook' */
  venuePort?: OrderbookVenuePort;
  /** Required when executionMode === 'live' and venueType === 'swap' */
  swapVenue?: SwapVenuePort;
  riskLimits: RiskLimits;
  idGen: IdGenerator & { planId(): string };
  fillRepo: FillRepo;
  orderRepo: OrderRepo;
  positionRepo: PositionRepo;
  journal: Journal;
  /** Current market price for execution and risk gate notional checks. */
  snapshotPrice: string;
  equityTracker?: EquityTracker;
  dailyLossTracker?: DailyLossTracker;
  /** Aggregate open position count across instruments (for maxOpenPositions check).
   *  Defaults to 1 if currentPosition is non-flat, 0 otherwise. */
  openPositionCount?: number;
  /** Pre-built executor — when provided, skips internal construction.
   *  Use when the caller already owns a running Executor (e.g. TradingActor tick). */
  executor?: Executor;
  /** Full persistence hooks — when provided, enables decision/plan tracking.
   *  If omitted, plan and decision records are not persisted. */
  persistence?: TradingCyclePersistence;
  /** Mark oracle for reference price in risk context. Falls back to snapshotPrice if omitted. */
  markSource?: MarkSource;
  /** Swap asset identifiers for routing. Required for swap venue executions. */
  swapAssets?: { baseAsset: string; quoteAsset: string; baseDecimals?: number; quoteDecimals?: number };
  /** Swap network identifier (e.g. 'solana'). */
  swapNetwork?: string;
  /** Base token address for swap token safety checks. */
  swapBaseTokenAddress?: string;
  /** Swap token safety port for pre-execution guardrails. */
  swapTokenSafety?: SwapTokenSafetyPort;
  /** Instance-level swap-token thresholds. */
  swapTokenSafetyThresholds?: {
    minLiquidityUsd?: number;
    minVolume24hUsd?: number;
    minAgeHours?: number;
    allowOverrides?: boolean;
  };
  /** Stop-loss exit timestamp for cooldown enforcement in risk gate. */
  lastStopLossExitMs?: number;
  /** Open positions for multi-instrument unrealized P&L in risk checks. */
  openPositions?: PositionState[];
  /** Swap fill projection tracker for actor-local swap accounting. */
  swapPositionTracker?: SwapPositionTracker;
  /** Strategy params for decision context record. */
  strategyParams?: Record<string, unknown>;
  /** Snapshot timestamp for context record. Defaults to current time if omitted. */
  snapshotTimestamp?: string;
}

export interface InstrumentExecutionResult {
  executed: boolean;
  riskRejected: boolean;
  fills: FillEvent[];
  newPosition: PositionState;
  error?: string;
  /** Pre-execution guardrail rejection (e.g. swap token safety). */
  preExecutionRejection?: PreExecutionRejection;
  /** Orders from this execution, for credential audit tracking. */
  orders?: ManagedOrder[];
  /** Execution plan ID, when a plan was created (present even on pre-execution rejections). */
  planId?: string;
}

/**
 * Execute a single decision on a specific instrument.
 *
 * Stateless per call — position state is passed in and returned as `newPosition`.
 * Handles: plan generation → risk gate → execution → fill persistence → position update.
 *
 * For paper/shadow modes uses PaperExecutor (no venue interaction).
 * For live mode builds a LiveExecutor or SwapLiveExecutor from deps.
 *
 * Unlike TradingActor, this function has no lifecycle, no streams, and no reconciliation.
 * It is intended for lightweight / one-shot execution contexts such as the agent technical phase.
 */
export async function executeDecision(
  decision: Decision,
  currentPosition: PositionState,
  deps: InstrumentExecutorDeps,
): Promise<InstrumentExecutionResult> {
  // 1. Create executor based on execution mode.
  //    When deps.executor is provided (e.g. TradingActor tick), use it directly so the
  //    caller's pre-built ShadowExecutor/LiveExecutor state is preserved.
  //    Paper and shadow both use PaperExecutor for one-shot contexts (e.g. agent phase).
  let executor: Executor;

  if (deps.executor) {
    executor = deps.executor;
  } else if (deps.executionMode === 'live') {
    if (deps.venueType === 'swap' && deps.swapVenue) {
      executor = new SwapLiveExecutor({
        swapVenue: deps.swapVenue,
        idGen: deps.idGen,
        clientOrderId: (planId, idx) => `exec:${planId}:${idx}`,
        onOrderStateChange: async (order: ManagedOrder) => {
          const payload = marshalOrder(order);
          if (payload.venueRefId) {
            await deps.orderRepo.upsertByVenueRefId(payload);
          } else if (payload.clientOrderId) {
            await deps.orderRepo.upsertByClientOrderId?.(payload);
          }
        },
      });
    } else if (deps.venuePort) {
      executor = new LiveExecutor({
        venuePort: deps.venuePort,
        idGen: deps.idGen,
        clientOrderId: (planId, idx) => `exec:${planId}:${idx}`,
        onOrderStateChange: async (order: ManagedOrder) => {
          const payload = marshalOrder(order);
          if (payload.venueRefId) {
            await deps.orderRepo.upsertByVenueRefId(payload);
          } else if (payload.clientOrderId) {
            await deps.orderRepo.upsertByClientOrderId?.(payload);
          }
        },
      });
    } else {
      return {
        executed: false,
        riskRejected: false,
        fills: [],
        newPosition: currentPosition,
        error: 'live execution requires venuePort (orderbook) or swapVenue (swap)',
      };
    }
  } else {
    executor = new PaperExecutor(deps.idGen);
  }

  // 2. Build TradingCyclePersistence.
  //    When deps.persistence is provided (e.g. TradingActor tick), use it for full tracking.
  //    Otherwise fall back to minimal hooks: plan-tracking no-ops, fill/position from repos.
  const actorType = decision.actorType ?? 'agent';
  const actorId = decision.actorId ?? '';

  const persistence: TradingCyclePersistence = deps.persistence ?? {
    persistDecision: async () => {},
    persistDecisionContext: async () => {},
    persistPlan: async () => {},
    markPlanExecuting: async () => {},
    markPlanCompleted: async () => {},
    markPlanFailed: async () => {},
    persistFill: async (fill) => {
      await deps.fillRepo.insertFill(fill);
    },
    persistPosition: async (pos) => {
      await deps.positionRepo.upsert({
        actorType: pos.actorType ?? actorType,
        actorId: pos.actorId ?? actorId,
        venueAccountId: pos.venueAccountId,
        venue: pos.venue,
        symbol: pos.symbol,
        instrumentId: pos.instrumentId ?? undefined,
        side: pos.side,
        size: pos.size,
        entryPrice: pos.entryPrice,
        realizedPnl: pos.realizedPnl,
        markSource: pos.markSource,
        exitReason: pos.exitReason,
      });
    },
    persistOrder: async (order) => {
      if (order.venueRefId) {
        await deps.orderRepo.upsertByVenueRefId(order);
      } else if (order.clientOrderId) {
        await deps.orderRepo.upsertByClientOrderId?.(order);
      }
    },
  };

  // 3. Resolve reference mark. Use mark oracle when provided; fall back to snapshot price.
  let referenceMark = deps.snapshotPrice;
  let referenceMarkSource = 'snapshot';
  if (deps.markSource) {
    const markResult = await deps.markSource.fetchMark(deps.symbol);
    if (markResult.ok && !markResult.data.stale) {
      referenceMark = markResult.data.price.toString();
      referenceMarkSource = markResult.data.source;
    }
  }

  // 4. Build decision context.
  const context: DecisionContext = {
    snapshot: {
      symbol: deps.symbol,
      price: deps.snapshotPrice,
      timestamp: deps.snapshotTimestamp ?? new Date().toISOString(),
    },
    position: currentPosition.side === 'flat' ? null : {
      side: currentPosition.side,
      size: currentPosition.size.toString(),
      entryPrice: currentPosition.entryPrice.toString(),
      realizedPnl: currentPosition.realizedPnl.toString(),
    },
    referenceMark: {
      price: referenceMark,
      source: referenceMarkSource,
    },
    strategyParams: deps.strategyParams ?? {},
  };

  // 5. Execute through the shared intake pipeline.
  try {
    const result = await submitDecisionForExecution(decision, context, currentPosition, {
      actorType,
      actorId,
      venue: deps.venue,
      symbol: deps.symbol,
      venueAccountId: deps.venueAccountId,
      venueType: deps.venueType,
      swapAssets: deps.swapAssets,
      swapNetwork: deps.swapNetwork,
      swapBaseTokenAddress: deps.swapBaseTokenAddress,
      executor,
      journal: deps.journal,
      riskLimits: deps.riskLimits,
      markSource: deps.markSource,
      persistence,
      idGen: { planId: () => deps.idGen.planId() },
      clock: realClock,
      swapTokenSafety: deps.swapTokenSafety,
      swapTokenSafetyThresholds: deps.swapTokenSafetyThresholds,
      equityTracker: deps.equityTracker,
      dailyLossTracker: deps.dailyLossTracker,
      openPositionCount: deps.openPositionCount ?? (currentPosition.side !== 'flat' ? 1 : 0),
      openPositions: deps.openPositions,
      lastStopLossExitMs: deps.lastStopLossExitMs,
      swapPositionTracker: deps.swapPositionTracker,
    });

    return {
      executed: !!result.executionResult && !result.executionFailed && !result.riskRejected,
      riskRejected: result.riskRejected,
      fills: result.executionResult?.fills ?? [],
      newPosition: result.position,
      preExecutionRejection: result.preExecutionRejection,
      orders: result.executionResult?.orders,
      planId: result.plan?.id,
    };
  } catch (err) {
    return {
      executed: false,
      riskRejected: false,
      fills: [],
      newPosition: currentPosition,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function marshalOrder(order: ManagedOrder): PersistOrderParams {
  return {
    id: order.id as unknown as string,
    venueAccountId: order.venueAccountId,
    actorType: order.actorType,
    actorId: order.actorId,
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
    filledQuantity: order.filledQuantity.toString(),
    avgFillPrice: order.avgFillPrice?.toString(),
  };
}
