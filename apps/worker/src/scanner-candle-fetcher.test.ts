import { describe, it, expect, vi } from 'vitest';
import { createScannerCandleFetcher } from './scanner-candle-fetcher.js';
import type { BinanceCandlesConfig, PriceCandle } from '@herobids/market-data';
import { VenueCandleFetcher } from '@herobids/venues';
import { TokenBucketRateLimiter } from '@herobids/market-data';
import type { ScannerCandleTarget } from '@herobids/strategy';

// ─── Mock VenueCandleFetcher ────────────────────────────────────────────────

vi.mock('@herobids/venues', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@herobids/venues')>();
  return {
    ...actual,
    VenueCandleFetcher: vi.fn(),
  };
});

const MockedVenueCandleFetcher = vi.mocked(VenueCandleFetcher);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCandle(timestamp: string, close: number): PriceCandle {
  return {
    timestamp,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 100,
  };
}

function makeBinanceConfig(): BinanceCandlesConfig {
  return {
    baseUrl: 'https://api.binance.com',
    rateLimiter: { acquire: vi.fn().mockResolvedValue(undefined) },
    timeoutMs: 5_000,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createScannerCandleFetcher', () => {
  it('creates a function that calls VenueCandleFetcher.fetchCandles with the target providerSymbol', async () => {
    const mockFetchCandles = vi.fn().mockResolvedValue([
      makeCandle('2026-07-17T12:00:00.000Z', 100),
      makeCandle('2026-07-17T12:01:00.000Z', 101),
    ]);

    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: mockFetchCandles } as unknown as VenueCandleFetcher;
    });

    const binanceConfig = makeBinanceConfig();
    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const fetchCandles = createScannerCandleFetcher({
      binanceConfig,
      scannerRateLimiter: rateLimiter,
    });

    const target: ScannerCandleTarget = {
      venueType: 'orderbook',
      providerSymbol: 'BTCUSDT',
    };

    const result = await fetchCandles(target, '15m', 100);

    expect(result).toHaveLength(2);
    expect(mockFetchCandles).toHaveBeenCalledTimes(1);
    expect(mockFetchCandles).toHaveBeenCalledWith('BTCUSDT', '15m', 100);
  });

  it('constructs VenueCandleFetcher with binance config and null GeckoTerminal config', async () => {
    const mockFetchCandles = vi.fn().mockResolvedValue([]);
    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: mockFetchCandles } as unknown as VenueCandleFetcher;
    });

    const binanceConfig = makeBinanceConfig();
    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    createScannerCandleFetcher({
      binanceConfig,
      scannerRateLimiter: rateLimiter,
    });

    expect(MockedVenueCandleFetcher).toHaveBeenCalledWith(
      binanceConfig,
      null, // no GeckoTerminal config for orderbook
      'orderbook',
    );
  });

  it('acquires the rate limiter before fetching candles', async () => {
    const mockFetchCandles = vi.fn().mockResolvedValue([
      makeCandle('2026-07-17T12:00:00.000Z', 100),
    ]);
    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: mockFetchCandles } as unknown as VenueCandleFetcher;
    });

    // Use a spy to track acquire calls
    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const acquireSpy = vi.spyOn(rateLimiter, 'acquire');

    const fetchCandles = createScannerCandleFetcher({
      binanceConfig: makeBinanceConfig(),
      scannerRateLimiter: rateLimiter,
    });

    const target: ScannerCandleTarget = {
      venueType: 'orderbook',
      providerSymbol: 'ETHUSDT',
    };

    await fetchCandles(target, '1h', 50);

    expect(acquireSpy).toHaveBeenCalledTimes(1);
    // acquire must be called before fetchCandles
    const acquireOrder = acquireSpy.mock.invocationCallOrder[0]!;
    const fetchOrder = mockFetchCandles.mock.invocationCallOrder[0]!;
    expect(acquireOrder).toBeLessThan(fetchOrder);
  });

  it('propagates errors from VenueCandleFetcher.fetchCandles', async () => {
    const mockFetchCandles = vi.fn().mockRejectedValue(new Error('Binance fetch failed'));
    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: mockFetchCandles } as unknown as VenueCandleFetcher;
    });

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const fetchCandles = createScannerCandleFetcher({
      binanceConfig: makeBinanceConfig(),
      scannerRateLimiter: rateLimiter,
    });

    const target: ScannerCandleTarget = {
      venueType: 'orderbook',
      providerSymbol: 'ETHUSDT',
    };

    await expect(fetchCandles(target, '15m', 100)).rejects.toThrow('Binance fetch failed');
  });

  it('passes the correct interval and limit to fetchCandles', async () => {
    const mockFetchCandles = vi.fn().mockResolvedValue([]);
    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: mockFetchCandles } as unknown as VenueCandleFetcher;
    });

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const fetchCandles = createScannerCandleFetcher({
      binanceConfig: makeBinanceConfig(),
      scannerRateLimiter: rateLimiter,
    });

    const target: ScannerCandleTarget = {
      venueType: 'orderbook',
      providerSymbol: 'SOLUSDT',
    };

    await fetchCandles(target, '4h', 200);

    expect(mockFetchCandles).toHaveBeenCalledWith('SOLUSDT', '4h', 200);
  });
});
