import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScannerCandleFetcher } from './scanner-candle-fetcher.js';
import type { BinanceCandlesConfig, PriceCandle, GeckoTerminalConfig } from '@herobids/market-data';
import { VenueCandleFetcher } from '@herobids/venues';
import { TokenBucketRateLimiter } from '@herobids/market-data';
import type { ScannerCandleTarget } from '@herobids/domain';

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

function makeGeckoTerminalConfig(): GeckoTerminalConfig {
  return {
    baseUrl: 'https://api.geckoterminal.com',
    rateLimiter: { acquire: vi.fn().mockResolvedValue(undefined) },
    timeoutMs: 5_000,
  };
}

// ─── Phase 3: Swap target tests ─────────────────────────────────────────────

describe('createScannerCandleFetcher (Phase 3)', () => {
  beforeEach(() => {
    MockedVenueCandleFetcher.mockReset();
  });

  // ─── Orderbook target tests (pre-Phase-3 behaviour preserved) ────────────

  it('creates a function that calls VenueCandleFetcher.fetchCandles with the target providerSymbol', async () => {
    const mockFetchCandles = vi.fn().mockResolvedValue([
      makeCandle('2026-07-17T12:00:00.000Z', 100),
      makeCandle('2026-07-17T12:01:00.000Z', 101),
    ]);

    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: mockFetchCandles } as unknown as VenueCandleFetcher;
    });

    const binanceConfig = makeBinanceConfig();
    const scannerRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const geckoTerminalRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 15 });
    const fetchCandles = createScannerCandleFetcher({
      binanceConfig,
      geckoTerminalConfig: makeGeckoTerminalConfig(),
      scannerRateLimiter,
      geckoTerminalRateLimiter,
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

  it('constructs orderbook VenueCandleFetcher with binance config and null GeckoTerminal config', async () => {
    const mockFetchCandles = vi.fn().mockResolvedValue([]);
    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: mockFetchCandles } as unknown as VenueCandleFetcher;
    });

    const binanceConfig = makeBinanceConfig();
    const scannerRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const geckoTerminalRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 15 });
    createScannerCandleFetcher({
      binanceConfig,
      geckoTerminalConfig: makeGeckoTerminalConfig(),
      scannerRateLimiter,
      geckoTerminalRateLimiter,
    });

    // Orderbook fetcher constructed once with null GeckoTerminal config
    expect(MockedVenueCandleFetcher).toHaveBeenCalledWith(
      binanceConfig,
      null,
      'orderbook',
    );
  });

  it('acquires the orderbook rate limiter before fetching candles', async () => {
    const mockFetchCandles = vi.fn().mockResolvedValue([
      makeCandle('2026-07-17T12:00:00.000Z', 100),
    ]);
    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: mockFetchCandles } as unknown as VenueCandleFetcher;
    });

    const scannerRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const acquireSpy = vi.spyOn(scannerRateLimiter, 'acquire');
    const geckoTerminalRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 15 });

    const fetchCandles = createScannerCandleFetcher({
      binanceConfig: makeBinanceConfig(),
      geckoTerminalConfig: makeGeckoTerminalConfig(),
      scannerRateLimiter,
      geckoTerminalRateLimiter,
    });

    const target: ScannerCandleTarget = {
      venueType: 'orderbook',
      providerSymbol: 'ETHUSDT',
    };

    await fetchCandles(target, '1h', 50);

    expect(acquireSpy).toHaveBeenCalledTimes(1);
    const acquireOrder = acquireSpy.mock.invocationCallOrder[0]!;
    const fetchOrder = mockFetchCandles.mock.invocationCallOrder[0]!;
    expect(acquireOrder).toBeLessThan(fetchOrder);
  });

  it('propagates errors from VenueCandleFetcher.fetchCandles (orderbook)', async () => {
    const mockFetchCandles = vi.fn().mockRejectedValue(new Error('Binance fetch failed'));
    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: mockFetchCandles } as unknown as VenueCandleFetcher;
    });

    const scannerRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const geckoTerminalRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 15 });
    const fetchCandles = createScannerCandleFetcher({
      binanceConfig: makeBinanceConfig(),
      geckoTerminalConfig: makeGeckoTerminalConfig(),
      scannerRateLimiter,
      geckoTerminalRateLimiter,
    });

    const target: ScannerCandleTarget = {
      venueType: 'orderbook',
      providerSymbol: 'ETHUSDT',
    };

    await expect(fetchCandles(target, '15m', 100)).rejects.toThrow('Binance fetch failed');
  });

  it('passes the correct interval and limit to orderbook fetchCandles', async () => {
    const mockFetchCandles = vi.fn().mockResolvedValue([]);
    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: mockFetchCandles } as unknown as VenueCandleFetcher;
    });

    const scannerRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const geckoTerminalRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 15 });
    const fetchCandles = createScannerCandleFetcher({
      binanceConfig: makeBinanceConfig(),
      geckoTerminalConfig: makeGeckoTerminalConfig(),
      scannerRateLimiter,
      geckoTerminalRateLimiter,
    });

    const target: ScannerCandleTarget = {
      venueType: 'orderbook',
      providerSymbol: 'SOLUSDT',
    };

    await fetchCandles(target, '4h', 200);

    expect(mockFetchCandles).toHaveBeenCalledWith('SOLUSDT', '4h', 200);
  });

  // ─── Phase 3: Swap target tests ─────────────────────────────────────────

  it('creates a per-call VenueCandleFetcher for swap targets with correct network and poolAddress', async () => {
    const binanceConfig = makeBinanceConfig();
    const orderbookMock = vi.fn().mockResolvedValue([]);
    const swapMock = vi.fn().mockResolvedValue([
      makeCandle('2026-08-01T12:00:00.000Z', 50),
    ]);

    // First call: orderbook fetcher construction
    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: orderbookMock } as unknown as VenueCandleFetcher;
    });
    // Second call: per-call swap fetcher
    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: swapMock } as unknown as VenueCandleFetcher;
    });

    const geckoTerminalConfig = makeGeckoTerminalConfig();
    const scannerRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const geckoTerminalRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 15 });

    const fetchCandles = createScannerCandleFetcher({
      binanceConfig,
      geckoTerminalConfig,
      scannerRateLimiter,
      geckoTerminalRateLimiter,
    });

    const target: ScannerCandleTarget = {
      venueType: 'swap',
      network: 'solana',
      poolAddress: 'SoLx9b1mX...someSolanaPoolAddress',
    };

    const result = await fetchCandles(target, '15m', 100);

    expect(result).toHaveLength(1);
    expect(MockedVenueCandleFetcher).toHaveBeenCalledTimes(2); // orderbook + per-call swap
    expect(MockedVenueCandleFetcher).toHaveBeenNthCalledWith(
      2,
      binanceConfig,
      { config: geckoTerminalConfig, network: 'solana' },
      'swap',
    );
    // swapMock called with poolAddress as symbol
    expect(swapMock).toHaveBeenCalledWith('SoLx9b1mX...someSolanaPoolAddress', '15m', 100);
  });

  it('uses the GeckoTerminal rate limiter for swap targets', async () => {
    const orderbookMock = vi.fn().mockResolvedValue([]);
    const swapMock = vi.fn().mockResolvedValue([]);

    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: orderbookMock } as unknown as VenueCandleFetcher;
    });
    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: swapMock } as unknown as VenueCandleFetcher;
    });

    const scannerRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const scannerAcquireSpy = vi.spyOn(scannerRateLimiter, 'acquire');
    const geckoTerminalRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 15 });
    const geckoAcquireSpy = vi.spyOn(geckoTerminalRateLimiter, 'acquire');

    const fetchCandles = createScannerCandleFetcher({
      binanceConfig: makeBinanceConfig(),
      geckoTerminalConfig: makeGeckoTerminalConfig(),
      scannerRateLimiter,
      geckoTerminalRateLimiter,
    });

    const swapTarget: ScannerCandleTarget = {
      venueType: 'swap',
      network: 'solana',
      poolAddress: 'somePoolAddr',
    };

    await fetchCandles(swapTarget, '15m', 100);

    // Swap target uses GeckoTerminal rate limiter, not the Binance scanner one
    expect(geckoAcquireSpy).toHaveBeenCalledTimes(1);
    expect(scannerAcquireSpy).not.toHaveBeenCalled();
  });

  it('does NOT throw SWAP_CANDLE_UNSUPPORTED for swap targets (Phase 3)', async () => {
    const mockFetchCandles = vi.fn().mockResolvedValue([]);
    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: mockFetchCandles } as unknown as VenueCandleFetcher;
    });
    // Per-call swap fetcher
    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: mockFetchCandles } as unknown as VenueCandleFetcher;
    });

    const scannerRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const geckoTerminalRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 15 });
    const fetchCandles = createScannerCandleFetcher({
      binanceConfig: makeBinanceConfig(),
      geckoTerminalConfig: makeGeckoTerminalConfig(),
      scannerRateLimiter,
      geckoTerminalRateLimiter,
    });

    const target: ScannerCandleTarget = {
      venueType: 'swap',
      network: 'solana',
      poolAddress: 'SoLx9b1mX...',
    };

    // Should NOT throw SWAP_CANDLE_UNSUPPORTED — swap targets are now supported
    await expect(fetchCandles(target, '15m', 100)).resolves.toBeDefined();
  });

  it('propagates errors from swap VenueCandleFetcher', async () => {
    const orderbookMock = vi.fn().mockResolvedValue([]);
    const swapMock = vi.fn().mockRejectedValue(new Error('GeckoTerminal OHLCV fetch failed'));

    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: orderbookMock } as unknown as VenueCandleFetcher;
    });
    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: swapMock } as unknown as VenueCandleFetcher;
    });

    const scannerRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const geckoTerminalRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 15 });
    const fetchCandles = createScannerCandleFetcher({
      binanceConfig: makeBinanceConfig(),
      geckoTerminalConfig: makeGeckoTerminalConfig(),
      scannerRateLimiter,
      geckoTerminalRateLimiter,
    });

    const target: ScannerCandleTarget = {
      venueType: 'swap',
      network: 'base',
      poolAddress: '0xDeadBeef...',
    };

    await expect(fetchCandles(target, '15m', 100)).rejects.toThrow('GeckoTerminal OHLCV fetch failed');
  });

  it('constructs per-call swap fetcher with the correct network from the target', async () => {
    const binanceConfig = makeBinanceConfig();
    const orderbookMock = vi.fn().mockResolvedValue([]);
    const swapMock = vi.fn().mockResolvedValue([]);

    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: orderbookMock } as unknown as VenueCandleFetcher;
    });
    MockedVenueCandleFetcher.mockImplementationOnce(function () {
      return { fetchCandles: swapMock } as unknown as VenueCandleFetcher;
    });

    const geckoTerminalConfig = makeGeckoTerminalConfig();
    const scannerRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const geckoTerminalRateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 15 });

    const fetchCandles = createScannerCandleFetcher({
      binanceConfig,
      geckoTerminalConfig,
      scannerRateLimiter,
      geckoTerminalRateLimiter,
    });

    // 1inch/Base target
    const baseTarget: ScannerCandleTarget = {
      venueType: 'swap',
      network: 'base',
      poolAddress: '0xBasePoolAddress123',
    };

    await fetchCandles(baseTarget, '15m', 100);

    // Per-call VenueCandleFetcher constructed with network='base' from target
    expect(MockedVenueCandleFetcher).toHaveBeenNthCalledWith(
      2,
      binanceConfig,
      { config: geckoTerminalConfig, network: 'base' },
      'swap',
    );
  });
});
