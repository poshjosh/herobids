import { price } from '@herobids/domain';
import type { Price } from '@herobids/domain';
import type { DailyLossTracker } from './daily-loss-tracker.js';

/**
 * Minimal fill record from the DB, sufficient for daily-loss rehydration.
 * Only fills with a non-null realizedPnlDelta are useful.
 */
export interface StoredFill {
  symbol: string;
  side: string;
  quantity: string;
  price: string;
  fee: string | null;
  realizedPnlDelta: string | null;
  filledAt: Date;
}

/**
 * Rehydrate a DailyLossTracker from stored fills that already have
 * pre-computed realizedPnlDelta (Option A).
 *
 * For fills WITH realizedPnlDelta: use it directly.
 * For fills WITHOUT (legacy, pre-backfill): skip — they contribute no loss data.
 *
 * @param fills — fills ordered by filledAt ascending (oldest first)
 * @param tracker — the DailyLossTracker to populate
 */
export function rehydrateDailyLoss(
  fills: StoredFill[],
  tracker: DailyLossTracker,
): void {
  for (const fill of fills) {
    if (fill.realizedPnlDelta == null) continue;
    const pnlDelta: Price = price(fill.realizedPnlDelta);
    tracker.recordFill(pnlDelta, fill.filledAt.getTime());
  }
}
