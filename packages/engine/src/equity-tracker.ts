import type { Price } from '@herobids/domain';
import { Decimal, price } from '@herobids/domain';

/**
 * Tracks per-actor equity state: starting capital + realized P&L → equity → drawdown.
 * Peak equity is updated lazily on each equity query.
 */
export class EquityTracker {
  private realizedPnl: Price;
  private peak: Price;

  constructor(
    private readonly startingCapital: Price,
    initialRealizedPnl?: Price,
  ) {
    this.realizedPnl = initialRealizedPnl ?? new Decimal(0);
    this.peak = this.startingCapital.plus(this.realizedPnl);
  }

  /** Record a realized P&L delta from a fill (positive = profit, negative = loss) */
  recordFill(realizedPnlDelta: Price): void {
    this.realizedPnl = this.realizedPnl.plus(realizedPnlDelta);
  }

  /** Compute current equity given unrealized P&L */
  currentEquity(unrealizedPnl: Price): Price {
    const equity = this.startingCapital.plus(this.realizedPnl).plus(unrealizedPnl);
    if (equity.gt(this.peak)) {
      this.peak = equity;
    }
    return equity;
  }

  /** Compute drawdown from peak (always ≥ 0) */
  currentDrawdown(unrealizedPnl: Price): Price {
    const equity = this.currentEquity(unrealizedPnl);
    const dd = this.peak.minus(equity);
    return dd.lt(0) ? price('0') : dd;
  }

  /** Get peak equity (high-water mark) */
  get peakEquity(): Price {
    return this.peak;
  }
}
