import { VenueCandleFetcher } from '@herobids/venues';
import { TokenBucketRateLimiter } from '@herobids/market-data';
import type { BinanceCandlesConfig, PriceCandle, GeckoTerminalConfig } from '@herobids/market-data';
import type { ScannerCandleTarget } from '@herobids/domain';

/**
 * Create a scanner candle fetcher that wraps VenueCandleFetcher with
 * per-worker scanner rate limiters. The returned function accepts an explicit
 * {@link ScannerCandleTarget} — no venue-global assumptions about the provider
 * symbol are baked in.
 *
 * Orderbook targets route to Binance via a pre-constructed VenueCandleFetcher.
 * Swap targets construct a per-call VenueCandleFetcher with the target's
 * network and the shared GeckoTerminal config, then fetch by poolAddress.
 */
export function createScannerCandleFetcher(params: {
  binanceConfig: BinanceCandlesConfig;
  geckoTerminalConfig: GeckoTerminalConfig;
  scannerRateLimiter: TokenBucketRateLimiter;
  geckoTerminalRateLimiter: TokenBucketRateLimiter;
}): (target: ScannerCandleTarget, interval: string, limit: number) => Promise<PriceCandle[]> {
  const { binanceConfig, geckoTerminalConfig, scannerRateLimiter, geckoTerminalRateLimiter } = params;

  // Orderbook fetcher — re-used for all orderbook targets (Binance provider-symbol routing).
  const orderbookFetcher = new VenueCandleFetcher(
    binanceConfig,
    null,
    'orderbook',
  );

  return async (target: ScannerCandleTarget, interval: string, limit: number) => {
    if (target.venueType === 'swap') {
      await geckoTerminalRateLimiter.acquire();
      // Per-call fetcher because network varies per swap candidate.
      const swapFetcher = new VenueCandleFetcher(
        binanceConfig,
        { config: geckoTerminalConfig, network: target.network },
        'swap',
      );
      return swapFetcher.fetchCandles(target.poolAddress, interval, limit);
    }

    // Orderbook target
    await scannerRateLimiter.acquire();
    return orderbookFetcher.fetchCandles(target.providerSymbol, interval, limit);
  };
}
