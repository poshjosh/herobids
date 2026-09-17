// Agent risk-limit contract consumed by the worker's agent risk-limit builder.
//
// Copied VERBATIM (byte-faithful, declaration only) from the local package
// `packages/engine/src/risk-gate.ts` (Slice 4 Plan B, ruling: amended Option
// A — narrow consumer-side type seams; copy sources cited). The herobids and
// Traderton `RiskLimits` blocks are byte-identical; the Traderton copy remains
// the runtime authority — this seam is the worker-side type carriage only.
//
// `Price`/`Quantity` are domain value types (`@herobids/domain`, both aliases
// of `Decimal`), already exported there.

import type { Price, Quantity } from '@herobids/domain';

/** Risk limits configuration for a trading instance */
export interface RiskLimits {
  /** Maximum absolute position size (in base units) */
  maxPositionSize?: Quantity;
  /** Maximum number of open (non-flat) positions across all instruments */
  maxOpenPositions?: number;
  /** Maximum allowed drawdown from peak equity (as a positive value, e.g. 1000 = $1000).
   *  Preserved for non-agent trading flows. Agents should use maxDrawdownPct instead. */
  maxDrawdown?: Price;
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
  /** Maximum allowed peak-to-current equity drawdown as % of peak equity (0–100).
   *  Agent-facing drawdown control. Separate from maxDrawdown (absolute USD). */
  maxDrawdownPct?: number;
}
