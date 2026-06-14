import type { Price } from '@herobids/domain';
import { price } from '@herobids/domain';
import type { FillEvent } from './order-state.js';
import type { PositionState } from './position-tracker.js';
import { applyFill } from './position-tracker.js';
import type { EquityTracker } from './equity-tracker.js';
import type { DailyLossTracker } from './daily-loss-tracker.js';

/**
 * Result of applying a fill through the accounting path.
 */
export interface FillAccountingResult {
  position: PositionState;
  /** Fee-adjusted realized P&L delta (position P&L minus fee). */
  realizedPnlDelta: Price;
}

/**
 * Shared fill-accounting helper.
 *
 * Applies a fill to a position, computes the fee-adjusted realized P&L delta,
 * and updates the in-memory risk trackers (equity + daily loss).
 *
 * This is the single canonical path for P&L bookkeeping. Every code path that
 * processes a fill (decision-intake, shadow limit resolution, private-stream)
 * MUST use this helper to keep the realizedPnlDelta column, in-memory trackers,
 * and rehydration logic consistent.
 */
export function applyFillAccounting(
  position: PositionState,
  fill: FillEvent,
  trackers?: {
    equityTracker?: EquityTracker;
    dailyLossTracker?: DailyLossTracker;
    nowMs?: number;
  },
): FillAccountingResult {
  const prevRealizedPnl = position.realizedPnl;
  const updatedPosition = applyFill(position, fill);

  const positionPnlDelta = updatedPosition.realizedPnl.minus(prevRealizedPnl);
  const feeCost = fill.fee ?? price('0');
  const realizedPnlDelta = positionPnlDelta.minus(feeCost);

  if (trackers) {
    const fillTimestampMs = Date.parse(fill.filledAt);
    const nowMs = trackers.nowMs
      ?? (Number.isFinite(fillTimestampMs) ? fillTimestampMs : Date.now());
    if (trackers.equityTracker) {
      trackers.equityTracker.recordFill(realizedPnlDelta);
    }
    if (trackers.dailyLossTracker) {
      trackers.dailyLossTracker.recordFill(realizedPnlDelta, nowMs);
    }
  }

  return { position: updatedPosition, realizedPnlDelta };
}
