import { resolveBinanceSymbol } from './binance-candles.js';
import type { PriceCandle } from './types.js';

export type CandleProviderKey = 'binance';
type CandleProviderRegistry = {
  binance: {
    candles: (symbol: string, options?: { interval?: string; limit?: number }) => Promise<{ data: unknown[] }>;
  };
};

export interface CandleProviderDescriptor {
  id: CandleProviderKey;
  resolveSymbol: (input: string) => string;
  symbolFormatHint: string;
  fetchCandles: (registry: CandleProviderRegistry, symbol: string, options?: { interval?: string; limit?: number }) => Promise<PriceCandle[]>;
}

const binanceCandleProvider: CandleProviderDescriptor = {
  id: 'binance',
  resolveSymbol: resolveBinanceSymbol,
  symbolFormatHint: "Base ticker (e.g. 'BTC', 'SOL')",
  fetchCandles: async (registry, symbol, options) => {
    const response = await registry.binance.candles(binanceCandleProvider.resolveSymbol(symbol), options);
    return response.data as PriceCandle[];
  },
};

export const CANDLE_PROVIDERS: Record<CandleProviderKey, CandleProviderDescriptor> = {
  binance: binanceCandleProvider,
};
