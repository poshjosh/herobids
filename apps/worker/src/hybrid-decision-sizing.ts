/**
 * Hybrid USD-to-base-size conversion helper.
 *
 * Converts the LLM-facing `sizeUsd` contract into the execution-facing
 * `targetSize` (base units) contract using the runtime PriceService.
 * Only used by the hybrid-evaluator path — scout/judge trading flow
 * continues to use the existing tool-based sizing.
 *
 * Failures are loud (skip submission, log warning) because silently
 * guessing a quantity or forwarding raw USD is more dangerous than
 * missing a single tick of signals.
 */

import { price, quantity, Decimal } from '@herobids/domain';
import type { PriceService } from '@herobids/market-data';
import type { HybridPricingIdentity } from './runtime-composition.js';

// ─── Public types ────────────────────────────────────────────────────────────

export interface HybridTargetSizeOk {
  ok: true;
  targetSize: string;
  priceUsd: number;
  source?: string;
  resolvedSymbol?: string;
  resolvedChain?: string;
  resolvedAddress?: string;
}

export interface HybridTargetSizeErr {
  ok: false;
  code: string;
  message: string;
}

export type HybridTargetSizeResult = HybridTargetSizeOk | HybridTargetSizeErr;

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Decimal places for the converted target size.
 *
 * Generous enough that no reasonable sizeUsd/priceUsd ratio loses
 * significant digits. Downstream execution still owns final rounding
 * to venue/token precision — this is NOT a lot-size constant.
 */
const SIZE_DECIMAL_PLACES = 18;

// ─── Conversion ──────────────────────────────────────────────────────────────

/**
 * Convert a USD-denominated size to base units using the runtime price service.
 *
 * Rules:
 * - `sizeUsd` must be finite and > 0
 * - `priceUsd` must be finite and > 0
 * - Stale price results are rejected
 * - DEX signals without chain identity are rejected
 * - Result uses `.toFixed()` to avoid scientific notation
 */
export async function resolveHybridTargetSize(params: {
  instrumentId: string;
  sizeUsd: number;
  priceService: PriceService;
  pricingIdentity: HybridPricingIdentity;
}): Promise<HybridTargetSizeResult> {
  const { instrumentId, sizeUsd, priceService, pricingIdentity } = params;

  // Guard: sizeUsd must be a positive finite number
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
    return {
      ok: false,
      code: 'sizing.invalid_size_usd',
      message: `sizeUsd=${sizeUsd} for ${instrumentId} is not a positive finite number`,
    };
  }

  // Guard: DEX signals must have chain identity
  if (pricingIdentity.kind === 'dex') {
    if (!pricingIdentity.chain) {
      return {
        ok: false,
        code: 'sizing.dex_missing_chain',
        message: `DEX signal for ${instrumentId} is missing chain identity — cannot reprice safely`,
      };
    }
  }

  // Resolve the effective chain for price lookup
  const chain =
    pricingIdentity.kind === 'perps' ? 'hyperliquid' : pricingIdentity.chain!;

  // Fetch current price
  const priceResult = await priceService.resolvePriceTarget(
    pricingIdentity.symbol,
    chain,
    pricingIdentity.address,
  );

  if (!priceResult.ok) {
    return {
      ok: false,
      code: `sizing.price_lookup_failed(${priceResult.error.code})`,
      message: `Price lookup failed for ${instrumentId} (${pricingIdentity.symbol} on ${chain}): ${priceResult.error.message}`,
    };
  }

  const priceData = priceResult.data;

  // Guard: price must be positive and finite
  if (!Number.isFinite(priceData.priceUsd) || priceData.priceUsd <= 0) {
    return {
      ok: false,
      code: 'sizing.invalid_price',
      message: `Resolved price for ${instrumentId} is ${priceData.priceUsd} — not a positive finite number`,
    };
  }

  // Guard: reject stale prices for hybrid sizing
  if (priceData.stale) {
    return {
      ok: false,
      code: 'sizing.stale_price',
      message: `Resolved price for ${instrumentId} is stale (source=${priceData.source}, fetched=${priceData.fetchedAt}) — refusing to size off a stale reference`,
    };
  }

  // Compute target size in base units
  let targetSize: string;
  try {
    targetSize = quantity(sizeUsd).div(price(priceData.priceUsd)).toFixed(SIZE_DECIMAL_PLACES);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: 'sizing.computation_error',
      message: `Failed to compute targetSize for ${instrumentId}: ${msg}`,
    };
  }

  // Guard: computed target size must be positive and finite
  const targetSizeNum = new Decimal(targetSize);
  if (!targetSizeNum.isFinite() || targetSizeNum.lte(0)) {
    return {
      ok: false,
      code: 'sizing.invalid_target_size',
      message: `Computed targetSize=${targetSize} for ${instrumentId} is not a positive finite number`,
    };
  }

  return {
    ok: true,
    targetSize,
    priceUsd: priceData.priceUsd,
    source: priceData.source,
    resolvedSymbol: priceData.symbol,
    resolvedChain: priceData.chain,
    resolvedAddress: priceData.address,
  };
}
