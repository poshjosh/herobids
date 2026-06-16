import type { CandleFetcher, PriceCandle } from '@herobids/domain';
import { fetchBinanceCandles, type BinanceCandlesConfig } from '@herobids/market-data';
import { fetchGeckoTerminalCandles, type GeckoTerminalConfig } from '@herobids/market-data';

export interface GeckoCandleFetcherConfig {
  config: GeckoTerminalConfig;
  network: string;
}

// Pool addresses are long hex strings (42 chars for EVM: 0x...) or base58 (Solana, ~43-44 chars).
// Ticker symbols like BTCUSDT are short and alphanumeric only.
function isPoolAddress(symbol: string): boolean {
  return symbol.length > 20;
}

function mapIntervalToTimeframe(interval: string): 'minute' | 'hour' | 'day' {
  const lower = interval.toLowerCase();
  if (lower.endsWith('d')) return 'day';
  if (lower.endsWith('h')) {
    const hours = parseInt(lower, 10);
    // Any multi-hour interval coarsens to 'hour' granularity — warn the caller
    if (!Number.isNaN(hours) && hours > 1) {
      console.warn(
        `[VenueCandleFetcher] interval '${interval}' coarsened to GeckoTerminal timeframe 'hour' — sub-interval granularity is lost`,
      );
    }
    return 'hour';
  }
  return 'minute';
}

export class VenueCandleFetcher implements CandleFetcher {
  constructor(
    private readonly binanceCfg: BinanceCandlesConfig,
    private readonly geckoTerminalCfg: GeckoCandleFetcherConfig | null,
  ) {}

  fetchCandles(symbol: string, interval: string, limit: number): Promise<PriceCandle[]> {
    if (isPoolAddress(symbol)) {
      if (!this.geckoTerminalCfg) {
        return Promise.reject(new Error(`VenueCandleFetcher: GeckoTerminal config not provided for pool address '${symbol}'`));
      }
      const timeframe = mapIntervalToTimeframe(interval);
      return fetchGeckoTerminalCandles(this.geckoTerminalCfg.network, symbol, this.geckoTerminalCfg.config, { timeframe, limit });
    }
    return fetchBinanceCandles(symbol, this.binanceCfg, { interval, limit });
  }
}
