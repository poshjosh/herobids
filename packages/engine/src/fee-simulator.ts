import type { Price, Quantity } from '@herobids/domain';
import { Decimal } from '@herobids/domain';

export interface FeeSimulatorConfig {
  /** Taker fee rate as decimal (e.g. 0.001 = 0.1% = 10bps) */
  takerFeePct: number;
  /** Maker fee rate as decimal (e.g. 0.0005 = 0.05% = 5bps) */
  makerFeePct: number;
  /** Simulated half-spread in bps for paper mode (e.g. 5 = 5bps) */
  paperSlippageBps?: number;
}

/** Compute simulated fee for a fill given notional value */
export function simulateFee(config: FeeSimulatorConfig, notional: Price): Quantity {
  return notional.mul(new Decimal(config.takerFeePct)).abs();
}

/** Apply simulated slippage to a paper fill price (adverse direction) */
export function applyPaperSlippage(config: FeeSimulatorConfig, fillPrice: Price, side: 'buy' | 'sell'): Price {
  const bps = config.paperSlippageBps ?? 0;
  if (bps <= 0) return fillPrice;

  const factor = new Decimal(bps).div(10000);
  if (side === 'buy') {
    // Buy higher (adverse)
    return fillPrice.mul(new Decimal(1).plus(factor));
  }
  // Sell lower (adverse)
  return fillPrice.mul(new Decimal(1).minus(factor));
}
