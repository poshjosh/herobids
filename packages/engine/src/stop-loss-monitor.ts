import type { Price } from '@herobids/domain';
import type { PositionState } from './position-tracker.js';
import { unrealizedPnl } from './position-tracker.js';

export interface StopLossConfig {
  /** Max unrealized loss per position as % of equity (0–100). 0 = disabled. */
  maxUnrealizedLossPct: number;
}

export interface StopLossCheck {
  instrument: string;
  position: PositionState;
  markPrice: Price;
  equity: Price;
}

export interface StopLossResult {
  triggered: boolean;
  instrument?: string;
  unrealizedLoss?: Price;
  threshold?: Price;
}

/**
 * Check if any position breaches the stop-loss threshold.
 * Returns the first triggered result, or { triggered: false } if all positions are within limits.
 */
export function checkStopLoss(config: StopLossConfig, checks: StopLossCheck[]): StopLossResult {
  if (config.maxUnrealizedLossPct <= 0) {
    return { triggered: false };
  }

  for (const check of checks) {
    if (check.position.side === 'flat') continue;

    const pnl = unrealizedPnl(check.position, check.markPrice);
    // Only trigger on losses (negative P&L)
    if (pnl.gte(0)) continue;

    const loss = pnl.abs();
    const threshold = check.equity.mul(config.maxUnrealizedLossPct).div(100);

    if (loss.gte(threshold)) {
      return {
        triggered: true,
        instrument: check.instrument,
        unrealizedLoss: loss,
        threshold,
      };
    }
  }

  return { triggered: false };
}
