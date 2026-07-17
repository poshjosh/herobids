import { VenueCandleFetcher } from '@herobids/venues';
import { TokenBucketRateLimiter } from '@herobids/market-data';
import type { BinanceCandlesConfig, PriceCandle } from '@herobids/market-data';
import type { ScannerCandleTarget } from '@herobids/strategy';

/**
 * Create a scanner candle fetcher that wraps VenueCandleFetcher with a
 * per-worker scanner rate limiter. The returned function accepts an explicit
 * {@link ScannerCandleTarget} — no venue-global assumptions about the provider
 * symbol are baked in.
 *
 * For orderbook venues, GeckoTerminal config is null because pool-based swap
 * routing is not needed.
 */
export function createScannerCandleFetcher(params: {
  binanceConfig: BinanceCandlesConfig;
  scannerRateLimiter: TokenBucketRateLimiter;
}): (target: ScannerCandleTarget, interval: string, limit: number) => Promise<PriceCandle[]> {
  const { binanceConfig, scannerRateLimiter } = params;

  const agentCandleFetcher = new VenueCandleFetcher(
    binanceConfig,
    null, // no GeckoTerminal config for orderbook
    'orderbook',
  );

  return async (target: ScannerCandleTarget, interval: string, limit: number) => {
    await scannerRateLimiter.acquire();
    return agentCandleFetcher.fetchCandles(target.providerSymbol, interval, limit);
  };
}
