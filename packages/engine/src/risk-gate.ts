import type { Result, DomainError } from '@herobids/domain';
import type { Price, Quantity } from '@herobids/domain';
import { ok, err, Decimal } from '@herobids/domain';
import type { ExecutionPlan } from './planner.js';
import type { PositionState } from './position-tracker.js';

/** Risk gate rejection error */
export interface RiskError extends DomainError {
  code: string;
}

/** Risk limits configuration for a trading instance */
export interface RiskLimits {
  /** Maximum absolute position size (in base units) */
  maxPositionSize: Quantity;
  /** Maximum number of open (non-flat) positions across all instruments */
  maxOpenPositions: number;
  /** Maximum allowed drawdown from peak equity (as a positive value, e.g. 1000 = $1000) */
  maxDrawdown: Price;
  /** Maximum notional per single order */
  maxOrderNotional?: Price;
  /** Maximum position size as % of current equity (0–100). Checked only when equity is provided. */
  maxPositionSizePct?: number;
  /** Maximum allowed loss in a rolling 24h window as % of equity (0–100). */
  dailyMaxLossPct?: number;
  /** Minimum ms before re-entering an instrument after a stop-loss exit (0 = disabled). */
  stopLossCooldownMs?: number;
  /** Maximum unrealized loss per position as % of equity (0–100) before stop-loss fires. 0 = disabled. */
  stopLossMaxUnrealizedLossPct?: number;
}

/** Snapshot of current risk state passed to the gate */
export interface RiskSnapshot {
  /** Current position for the instrument being traded */
  currentPosition: PositionState | null;
  /** Total number of open (non-flat) positions */
  openPositionCount: number;
  /** Current drawdown from peak equity (positive value) */
  currentDrawdown: Price;
  /** Current equity (needed for %-based checks) */
  equity?: Price;
  /** Loss realised in the rolling 24h window (positive value) */
  dailyLoss?: Price;
  /** Timestamp (ms) of the last stop-loss exit for this instrument (undefined = no recent SL) */
  lastStopLossExitMs?: number;
  /** Current timestamp (ms) — used for cooldown comparison */
  nowMs?: number;
  /** Canonical reference mark for notional calculations (stable, auditable). Falls back to order.price if absent. */
  referenceMark?: Price;
}

export type RiskCheckResult = Result<void, RiskError>;

/**
 * Pre-execution risk gate.
 * Evaluates a plan against risk limits and returns ok() or a rejection error.
 * Pure function — no side effects.
 */
export function checkRisk(
  plan: ExecutionPlan,
  limits: RiskLimits,
  snapshot: RiskSnapshot,
): RiskCheckResult {
  const isRiskReducing = plan.action === 'close' || plan.action === 'reduce';

  // 1. Max drawdown breach
  if (!isRiskReducing && snapshot.currentDrawdown.gte(limits.maxDrawdown)) {
    return err({
      code: 'risk.max_drawdown_exceeded',
      message: `Current drawdown ${snapshot.currentDrawdown.toString()} exceeds limit ${limits.maxDrawdown.toString()}`,
      context: {
        currentDrawdown: snapshot.currentDrawdown.toString(),
        maxDrawdown: limits.maxDrawdown.toString(),
      },
    });
  }

  // 1b. Daily max loss (rolling 24h) — checked when both limit and snapshot data present
  if (
    !isRiskReducing &&
    limits.dailyMaxLossPct != null &&
    snapshot.dailyLoss != null &&
    snapshot.equity != null
  ) {
    const dailyLossLimit = snapshot.equity.mul(new Decimal(limits.dailyMaxLossPct)).div(new Decimal(100));
    if (snapshot.dailyLoss.gte(dailyLossLimit)) {
      return err({
        code: 'risk.daily_max_loss_exceeded',
        message: `Daily loss ${snapshot.dailyLoss.toString()} exceeds ${limits.dailyMaxLossPct}% of equity (${dailyLossLimit.toString()})`,
        context: {
          dailyLoss: snapshot.dailyLoss.toString(),
          dailyMaxLossPct: limits.dailyMaxLossPct,
          equityLimit: dailyLossLimit.toString(),
        },
      });
    }
  }

  // 1c. Stop-loss cooldown — reject entry if instrument was stopped-out too recently
  if (
    !isRiskReducing &&
    limits.stopLossCooldownMs != null &&
    limits.stopLossCooldownMs > 0 &&
    snapshot.lastStopLossExitMs != null &&
    snapshot.nowMs != null
  ) {
    const elapsed = snapshot.nowMs - snapshot.lastStopLossExitMs;
    if (elapsed < limits.stopLossCooldownMs) {
      return err({
        code: 'risk.stop_loss_cooldown',
        message: `Stop-loss cooldown: ${elapsed}ms elapsed, requires ${limits.stopLossCooldownMs}ms`,
        context: {
          elapsedMs: elapsed,
          cooldownMs: limits.stopLossCooldownMs,
          lastStopLossExitMs: snapshot.lastStopLossExitMs,
        },
      });
    }
  }

  // 2. Max open positions (only check if opening a new position)
  const isOpening = plan.action === 'open_long' || plan.action === 'open_short';
  if (isOpening && snapshot.openPositionCount >= limits.maxOpenPositions) {
    return err({
      code: 'risk.max_open_positions_exceeded',
      message: `Open position count ${snapshot.openPositionCount} would exceed limit ${limits.maxOpenPositions}`,
      context: {
        openPositionCount: snapshot.openPositionCount,
        maxOpenPositions: limits.maxOpenPositions,
      },
    });
  }

  // 3. Max position size — check resulting size after plan executes
  for (const order of plan.orders) {
    const resultingSize = computeResultingSize(snapshot.currentPosition, order.side, order.quantity);
    if (resultingSize.gt(limits.maxPositionSize)) {
      return err({
        code: 'risk.max_position_size_exceeded',
        message: `Resulting position size ${resultingSize.toString()} would exceed limit ${limits.maxPositionSize.toString()}`,
        context: {
          resultingSize: resultingSize.toString(),
          maxPositionSize: limits.maxPositionSize.toString(),
          orderSide: order.side,
          orderQuantity: order.quantity.toString(),
        },
      });
    }

    // 3b. Max position size as % of equity
    if (limits.maxPositionSizePct != null && snapshot.equity != null) {
      let markForNotional: typeof snapshot.referenceMark;
      if (snapshot.referenceMark && order.price) {
        markForNotional = snapshot.referenceMark.gt(order.price) ? snapshot.referenceMark : order.price;
      } else {
        markForNotional = snapshot.referenceMark ?? order.price;
      }
      if (!markForNotional) {
        return err({
          code: 'risk.no_mark_for_notional',
          message: 'maxPositionSizePct configured but no reference mark or order price available',
          context: { maxPositionSizePct: limits.maxPositionSizePct },
        });
      }
      const resultingNotional = resultingSize.mul(markForNotional);
      const maxNotionalByPct = snapshot.equity.mul(new Decimal(limits.maxPositionSizePct)).div(new Decimal(100));
      if (resultingNotional.gt(maxNotionalByPct)) {
        return err({
          code: 'risk.max_position_size_pct_exceeded',
          message: `Resulting position notional ${resultingNotional.toString()} exceeds ${limits.maxPositionSizePct}% of equity (${maxNotionalByPct.toString()})`,
          context: {
            resultingNotional: resultingNotional.toString(),
            maxPositionSizePct: limits.maxPositionSizePct,
            equityLimit: maxNotionalByPct.toString(),
          },
        });
      }
    }

    // 4. Max order notional (optional)
    // For limit orders, the actual execution price is the limit — use the worse of
    // (referenceMark, order.price) so an aggressively priced limit can't bypass the cap.
    if (limits.maxOrderNotional) {
      const markPrice = snapshot.referenceMark;
      const orderPrice = order.price;
      // Worst-case price: highest of mark vs limit (for buys the limit is the ceiling;
      // for sells the mark may be higher — conservative approach uses max of both).
      let markForNotional: typeof markPrice;
      if (markPrice && orderPrice) {
        markForNotional = markPrice.gt(orderPrice) ? markPrice : orderPrice;
      } else {
        markForNotional = markPrice ?? orderPrice;
      }
      if (!markForNotional) {
        return err({
          code: 'risk.no_mark_for_notional',
          message: 'maxOrderNotional configured but no reference mark or order price available',
          context: { maxOrderNotional: limits.maxOrderNotional.toString() },
        });
      }
      const notional = order.quantity.mul(markForNotional);
      if (notional.gt(limits.maxOrderNotional)) {
        return err({
          code: 'risk.max_order_notional_exceeded',
          message: `Order notional ${notional.toString()} exceeds limit ${limits.maxOrderNotional.toString()}`,
          context: {
            orderNotional: notional.toString(),
            maxOrderNotional: limits.maxOrderNotional.toString(),
          },
        });
      }
    }
  }

  return ok(undefined);
}

/**
 * Compute the resulting absolute position size after an order executes.
 */
function computeResultingSize(
  position: PositionState | null,
  orderSide: 'buy' | 'sell',
  orderQuantity: Quantity,
): Quantity {
  if (!position || position.side === 'flat') {
    return orderQuantity;
  }

  const currentSize = position.size;
  const sameDirection =
    (position.side === 'long' && orderSide === 'buy') ||
    (position.side === 'short' && orderSide === 'sell');

  if (sameDirection) {
    return currentSize.plus(orderQuantity);
  }

  // Opposite direction — reducing or reversing
  const remaining = currentSize.minus(orderQuantity);
  return remaining.abs();
}
