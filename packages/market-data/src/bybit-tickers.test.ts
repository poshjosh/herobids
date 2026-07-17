import { describe, it, expect, vi } from 'vitest';
import { fetchBybitTickers, fetchBybitTicker, type BybitTickersConfig } from './bybit-tickers.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(fetchFn: typeof fetch): BybitTickersConfig {
  return {
    baseUrl: 'https://api.bybit.com',
    rateLimiter: { acquire: vi.fn().mockResolvedValue(undefined) },
    timeoutMs: 5_000,
    fetchFn,
  };
}

function makeTickerResponse(items: Array<{
  symbol: string;
  lastPrice?: string;
  markPrice?: string;
  turnover24h?: string;
  price24hPcnt?: string;
}>) {
  return new Response(
    JSON.stringify({
      retCode: 0,
      result: { category: 'linear', list: items },
    }),
    { status: 200, statusText: 'OK' },
  );
}

// ─── fetchBybitTickers ───────────────────────────────────────────────────────

describe('fetchBybitTickers', () => {
  it('parses successful API response into BybitTicker array', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeTickerResponse([
        { symbol: 'BTCUSDT', lastPrice: '67000.5', markPrice: '67001.0', turnover24h: '1234567890', price24hPcnt: '0.025' },
        { symbol: 'ETHUSDT', lastPrice: '3500.25', markPrice: '3500.5', turnover24h: '987654321', price24hPcnt: '-0.015' },
      ]),
    );
    const config = makeConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchBybitTickers(config);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      symbol: 'BTCUSDT',
      markPrice: 67001.0,
      lastPrice: 67000.5,
      volume24hUsd: 1234567890,
      priceChange24hPct: 0.025,
    });
    expect(result[1]).toEqual({
      symbol: 'ETHUSDT',
      markPrice: 3500.5,
      lastPrice: 3500.25,
      volume24hUsd: 987654321,
      priceChange24hPct: -0.015,
    });
  });

  it('calls rate limiter before fetching', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeTickerResponse([]));
    const acquire = vi.fn().mockResolvedValue(undefined);
    const config: BybitTickersConfig = {
      baseUrl: 'https://api.bybit.com',
      rateLimiter: { acquire },
      timeoutMs: 5_000,
      fetchFn: fetchFn as unknown as typeof fetch,
    };

    await fetchBybitTickers(config);

    expect(acquire).toHaveBeenCalledTimes(1);
    // acquire must be called before fetch
    const acquireOrder = acquire.mock.invocationCallOrder[0]!;
    const fetchOrder = fetchFn.mock.invocationCallOrder[0]!;
    expect(acquireOrder).toBeLessThan(fetchOrder);
  });

  it('returns empty array when API response list is empty', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeTickerResponse([]));
    const config = makeConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchBybitTickers(config);

    expect(result).toEqual([]);
  });

  it('returns empty array when result field is missing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ retCode: 0 }),
        { status: 200, statusText: 'OK' },
      ),
    );
    const config = makeConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchBybitTickers(config);

    expect(result).toEqual([]);
  });

  it('treats null markPrice as null', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeTickerResponse([
        { symbol: 'BTCUSDT', lastPrice: '67000', markPrice: undefined, turnover24h: '1000', price24hPcnt: '0.01' },
      ]),
    );
    const config = makeConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchBybitTickers(config);

    expect(result[0]!.markPrice).toBeNull();
  });

  it('treats markPrice as null when the field is absent from the API item', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          retCode: 0,
          result: { category: 'linear', list: [{ symbol: 'BTCUSDT' }] },
        }),
        { status: 200, statusText: 'OK' },
      ),
    );
    const config = makeConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchBybitTickers(config);

    expect(result[0]!.markPrice).toBeNull();
    expect(result[0]!.lastPrice).toBeNull();
    expect(result[0]!.volume24hUsd).toBeNull();
    expect(result[0]!.priceChange24hPct).toBeNull();
    expect(result[0]!.symbol).toBe('BTCUSDT');
  });

  it('falls back to UNKNOWN symbol when symbol field is absent', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          retCode: 0,
          result: { category: 'linear', list: [{ markPrice: '67000' }] },
        }),
        { status: 200, statusText: 'OK' },
      ),
    );
    const config = makeConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchBybitTickers(config);

    expect(result[0]!.symbol).toBe('UNKNOWN');
  });

  it('throws on network error', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('Network error'));
    const config = makeConfig(fetchFn as unknown as typeof fetch);

    await expect(fetchBybitTickers(config)).rejects.toThrow('Network error');
  });

  it('throws on HTTP error status', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response('Rate limited', { status: 429, statusText: 'Too Many Requests' }),
    );
    const config = makeConfig(fetchFn as unknown as typeof fetch);

    await expect(fetchBybitTickers(config)).rejects.toThrow('HTTP error');
  });
});

// ─── fetchBybitTicker (single symbol) ────────────────────────────────────────

describe('fetchBybitTicker', () => {
  it('fetches and returns a single ticker by symbol', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeTickerResponse([
        { symbol: 'BTCUSDT', lastPrice: '67000.5', markPrice: '67001.0', turnover24h: '1234567890', price24hPcnt: '0.025' },
      ]),
    );
    const config = makeConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchBybitTicker('BTCUSDT', config);

    expect(result).not.toBeNull();
    expect(result!.symbol).toBe('BTCUSDT');
    expect(result!.markPrice).toBe(67001.0);
  });

  it('URL-encodes the symbol parameter', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeTickerResponse([]));
    const config = makeConfig(fetchFn as unknown as typeof fetch);

    await fetchBybitTicker('btc usdt', config);

    const url = (fetchFn.mock.calls[0] as [string])[0];
    expect(url).toContain('symbol=BTC%20USDT');
  });

  it('returns null when no matching ticker found', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeTickerResponse([]));
    const config = makeConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchBybitTicker('NONEXISTENT', config);

    expect(result).toBeNull();
  });

  it('calls rate limiter before fetching', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeTickerResponse([]));
    const acquire = vi.fn().mockResolvedValue(undefined);
    const config: BybitTickersConfig = {
      baseUrl: 'https://api.bybit.com',
      rateLimiter: { acquire },
      timeoutMs: 5_000,
      fetchFn: fetchFn as unknown as typeof fetch,
    };

    await fetchBybitTicker('BTCUSDT', config);

    expect(acquire).toHaveBeenCalledTimes(1);
    const acquireOrder = acquire.mock.invocationCallOrder[0]!;
    const fetchOrder = fetchFn.mock.invocationCallOrder[0]!;
    expect(acquireOrder).toBeLessThan(fetchOrder);
  });

  it('throws on network error', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('Timeout'));
    const config = makeConfig(fetchFn as unknown as typeof fetch);

    await expect(fetchBybitTicker('BTCUSDT', config)).rejects.toThrow('Timeout');
  });
});
