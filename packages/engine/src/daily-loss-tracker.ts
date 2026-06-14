import type { Price } from '@herobids/domain';
import { price } from '@herobids/domain';

interface LossEntry {
  loss: Price;
  timestampMs: number;
}

const DAY_MS = 86_400_000;

/**
 * Tracks rolling 24h realized losses per actor.
 * Only negative P&L (losses) are recorded; profits are ignored.
 */
export class DailyLossTracker {
  private entries: LossEntry[] = [];

  /** Record a realized P&L delta. Only losses (negative values) accumulate. */
  recordFill(realizedPnlDelta: Price, timestampMs: number): void {
    if (realizedPnlDelta.lt(0)) {
      this.entries.push({ loss: realizedPnlDelta.abs(), timestampMs });
    }
  }

  /** Get rolling 24h loss total (positive number representing magnitude of losses) */
  rollingLoss(nowMs: number): Price {
    const cutoff = nowMs - DAY_MS;
    // Prune expired entries
    this.entries = this.entries.filter(e => e.timestampMs > cutoff);
    return this.entries.reduce(
      (sum, e) => sum.plus(e.loss),
      price('0') as Price,
    );
  }
}
