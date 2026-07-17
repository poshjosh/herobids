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
