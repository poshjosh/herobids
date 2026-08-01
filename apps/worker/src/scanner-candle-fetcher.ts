import { VenueCandleFetcher } from '@herobids/venues';
import { TokenBucketRateLimiter } from '@herobids/market-data';
import type { BinanceCandlesConfig, PriceCandle } from '@herobids/market-data';
import type { ScannerCandleTarget } from '@herobids/domain';

/**
 * Create a scanner candle fetcher that wraps VenueCandleFetcher with a
 * per-worker scanner rate limiter. The returned function accepts an explicit
 * {@link ScannerCandleTarget} — no venue-global assumptions about the provider
 * symbol are baked in.
 *
 * For orderbook venues, GeckoTerminal config is null because pool-based swap
 * routing is not needed. Swap candle routing will be wired in Phase 3.
 */
export function createScannerCandleFetcher(params: {
  binanceConfig: BinanceCandlesConfig;
  scannerRateLimiter: TokenBucketRateLimiter;
}): (target: ScannerCandleTarget, interval: string, limit: number) => Promise<PriceCandle[]> {
  const { binanceConfig, scannerRateLimiter } = params;

  const agentCandleFetcher = new VenueCandleFetcher(
    binanceConfig,
    null, // no GeckoTerminal config for orderbook; swap routing comes in Phase 3
    'orderbook',
  );

  return async (target: ScannerCandleTarget, interval: string, limit: number) => {
    await scannerRateLimiter.acquire();
    // Orderbook targets route to Binance by providerSymbol.
    // Swap targets are not yet supported at the fetcher level (Phase 3).
    if (target.venueType !== 'orderbook') {
      throw new Error(`SWAP_CANDLE_UNSUPPORTED: Swap candle fetching not yet implemented (target: ${target.network}:${target.poolAddress})`);
    }
    return agentCandleFetcher.fetchCandles(target.providerSymbol, interval, limit);
  };
}
