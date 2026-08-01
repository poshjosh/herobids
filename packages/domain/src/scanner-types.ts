/**
 * Identity needed to safely reprice a signal for hybrid USD-to-base-size
 * conversion. Perps use an execution mark (chain = 'hyperliquid' or 'bybit');
 * DEX assets require chain + address to avoid ambiguous-ticker repricing.
 *
 * Originally defined in apps/worker/src/runtime-composition.ts.
 * Moved to @herobids/domain so the strategy package can reference it
 * without depending on the worker.
 */
export interface HybridPricingIdentity {
  kind: 'perps' | 'dex';
  symbol: string;
  chain?: string;
  address?: string;
}

/**
 * Identifies a candle source for scanner candle fetching.
 *
 * Orderbook targets route to Binance by provider symbol.
 * Swap targets route to GeckoTerminal by network + pool address.
 *
 * Moved from @herobids/strategy so domain consumers (worker,
 * market-data adapters) can reference the full union without
 * depending on the strategy package.
 */
export type ScannerCandleTarget =
  | { venueType: 'orderbook'; providerSymbol: string }
  | { venueType: 'swap'; network: string; poolAddress: string };

/**
 * Exact on-chain identity for a DEX swap pair.
 *
 * Carried unchanged from discovery → candidate → signal → decision
 * so the execution layer receives address-qualified assets without
 * re-resolving a display symbol.
 */
export interface SwapExecutionIdentity {
  network: string;
  baseSymbol: string;
  baseAddress: string;
  quoteSymbol: string;
  quoteAddress: string;
}

/**
 * Derive a stable breaker key from a ScannerCandleTarget for use
 * with the cross-scan circuit breaker and other keyed maps.
 *
 * - orderbook: `orderbook:<providerSymbol>`
 * - swap:      `swap:<network>:<poolAddress>`
 */
export function scannerTargetKey(target: ScannerCandleTarget): string {
  if (target.venueType === 'orderbook') {
    return `orderbook:${target.providerSymbol}`;
  }
  return `swap:${target.network}:${target.poolAddress}`;
}
