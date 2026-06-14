/**
 * Balance-delta position model for swap venues.
 *
 * Unlike orderbook positions (directional: long/short/flat + entryPrice),
 * swap positions are asset-flow projections: we track the net balance delta
 * implied by recorded fills without claiming full-wallet accounting truth.
 */

import { quantity, Decimal } from '@herobids/domain';
import type { Quantity } from '@herobids/domain';

export interface SwapAssetProjection {
  asset: string;
  projectedBalanceDelta: Quantity;
  lastUpdatedMs: number;
}

export interface SwapFill {
  inputAsset: string;
  inputAmount: Quantity;
  outputAsset: string;
  outputAmount: Quantity;
  timestamp: number;
}

export interface SwapBalanceVariance {
  asset: string;
  projectedBalanceDelta: Quantity;
  observedBalance: Quantity;
  variance: Quantity;         // observed - projected
  variancePct: number;        // abs(variance) / abs(projected) * 100
}

export class SwapPositionTracker {
  private projections = new Map<string, SwapAssetProjection>();

  constructor(initialProjections?: SwapAssetProjection[]) {
    if (initialProjections) {
      for (const projection of initialProjections) {
        this.projections.set(projection.asset, { ...projection });
      }
    }
  }

  /** Record a swap fill as the net asset-flow projection implied by that fill. */
  recordSwapFill(fill: SwapFill): void {
    const inputProjection = this.projections.get(fill.inputAsset);
    const newInputDelta = inputProjection
      ? (inputProjection.projectedBalanceDelta as Decimal).minus(fill.inputAmount)
      : new Decimal(fill.inputAmount.toString()).neg();
    this.projections.set(fill.inputAsset, {
      asset: fill.inputAsset,
      projectedBalanceDelta: quantity(newInputDelta.toString()),
      lastUpdatedMs: fill.timestamp,
    });

    const outputProjection = this.projections.get(fill.outputAsset);
    const newOutputDelta = outputProjection
      ? (outputProjection.projectedBalanceDelta as Decimal).plus(fill.outputAmount)
      : quantity(fill.outputAmount.toString());
    this.projections.set(fill.outputAsset, {
      asset: fill.outputAsset,
      projectedBalanceDelta: newOutputDelta,
      lastUpdatedMs: fill.timestamp,
    });
  }

  /** Get all non-zero fill-derived asset projections. */
  getAssetProjections(): SwapAssetProjection[] {
    return [...this.projections.values()].filter(
      projection => !(projection.projectedBalanceDelta as Decimal).isZero(),
    );
  }

  /** Get the fill-derived net balance delta for a specific asset. */
  getProjectedBalanceDelta(asset: string): Quantity {
    const projection = this.projections.get(asset);
    return projection ? projection.projectedBalanceDelta : quantity('0');
  }

  /**
   * Compare fill-derived asset projections to observed balances.
   * variance = observed - projected. Positive means observed balance exceeds the projection.
   */
  compareToObservedBalances(observedBalances: Map<string, Quantity>): SwapBalanceVariance[] {
    const results: SwapBalanceVariance[] = [];
    const allAssets = new Set([...this.projections.keys(), ...observedBalances.keys()]);

    for (const asset of allAssets) {
      const projectedBalanceDelta = this.getProjectedBalanceDelta(asset);
      const observedBalance = observedBalances.get(asset) ?? quantity('0');
      const variance = (observedBalance as Decimal).minus(projectedBalanceDelta);

      if (variance.isZero()) continue;

      const projectedAbs = (projectedBalanceDelta as Decimal).abs();
      const variancePct = projectedAbs.isZero()
        ? 100
        : (variance as Decimal).abs().div(projectedAbs).mul(100).toNumber();

      results.push({
        asset,
        projectedBalanceDelta,
        observedBalance,
        variance: quantity(variance.toString()),
        variancePct,
      });
    }

    return results;
  }
}
