import { describe, expect, it } from 'vitest';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import {
  fetchBirdeyeTrending,
  fetchBirdeyeTokenOverview,
  fetchBirdeyeOhlcv,
  type BirdeyeConfig,
} from './birdeye.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<BirdeyeConfig> = {}): BirdeyeConfig {
  const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 10_000 });
  return {
    baseUrl: 'https://public-api.birdeye.so',
    apiKey: 'test-key',
    rateLimiter,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    json: async () => body,
  } as Response;
}

const TRENDING_TOKEN = {
  address: 'So1abc123',
  decimals: 6,
  liquidity: 500_000,
  logoURI: 'https://example.com/logo.png',
  name: 'MyToken',
  symbol: 'MYT',
  volume24hUSD: 1_000_000,
  rank: 0,
};

function makeTrendingData(tokens: object[]) {
  return {
    success: true,
    data: {
      updateUnixTime: 1720012620,
      updateTime: '2024-07-03T13:17:00',
      tokens,
      total: tokens.length,
    },
  };
}

const OVERVIEW_DATA = {
  address: 'So1abc123',
  decimals: 6,
  symbol: 'MYT',
  name: 'MyToken',
  liquidity: 500_000,
  price: 2.5,
  priceChange24hPercent: 5.0,
  mc: 10_000_000,
  supply: 1_000_000,
  v24hUSD: 1_000_000,
};

function makeOverviewData() {
  return { success: true, data: OVERVIEW_DATA };
}

const OHLCV_ITEM = { unixTime: 1720012620, o: 1.5, h: 1.6, l: 1.4, c: 1.55, v: 100_000 };

function makeOhlcvData(items: object[]) {
  return { success: true, data: { items } };
}

// ---------------------------------------------------------------------------
// fetchBirdeyeTrending
// ---------------------------------------------------------------------------

describe('fetchBirdeyeTrending', () => {
  it('maps Birdeye trending tokens to DiscoveredToken with correct fields', async () => {
    const config = makeConfig({
      fetchFn: async () => makeResponse(makeTrendingData([TRENDING_TOKEN])),
    });

    const result = await fetchBirdeyeTrending('solana', config);

    expect(result).toHaveLength(1);
    const token = result[0]!;
    expect(token.address).toBe('So1abc123');
    expect(token.symbol).toBe('MYT');
    expect(token.name).toBe('MyToken');
    expect(token.network).toBe('solana');
    expect(token.volume24hUsd).toBe(1_000_000);
    expect(token.liquidityUsd).toBe(500_000);
    expect(token.source).toBe('birdeye');
    expect(token.discoveryVectors).toEqual(['birdeye_trending']);
  });

  it('returns [] for non-Solana chains without making a network call', async () => {
    let called = false;
    const config = makeConfig({
      fetchFn: async () => {
        called = true;
        return makeResponse({});
      },
    });

    const result = await fetchBirdeyeTrending('ethereum', config);

    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it('filters out tokens missing address or symbol', async () => {
    const noAddress = { ...TRENDING_TOKEN, address: '' };
    const noSymbol = { ...TRENDING_TOKEN, symbol: '', address: 'So1def456' };
    const valid = { ...TRENDING_TOKEN, address: 'So1ghi789', symbol: 'GHI' };
    const config = makeConfig({
      fetchFn: async () => makeResponse(makeTrendingData([noAddress, noSymbol, valid])),
    });

    const result = await fetchBirdeyeTrending('solana', config);

    expect(result).toHaveLength(1);
    expect(result[0]?.address).toBe('So1ghi789');
  });

  it('returns [] on HTTP 400 without throwing (warn-and-skip)', async () => {
    const config = makeConfig({
      fetchFn: async () => makeResponse({ success: false, message: 'Invalid request' }, 400),
    });

    const result = await fetchBirdeyeTrending('solana', config);

    expect(result).toEqual([]);
  });

  it('throws on non-400 HTTP errors (500)', async () => {
    const config = makeConfig({
      fetchFn: async () => makeResponse({ success: false, message: 'Server error' }, 500),
    });

    await expect(fetchBirdeyeTrending('solana', config)).rejects.toThrow('HTTP error: 500');
  });

  it('throws on network errors', async () => {
    const config = makeConfig({
      fetchFn: async () => { throw new Error('Network failure'); },
    });

    await expect(fetchBirdeyeTrending('solana', config)).rejects.toThrow('Network failure');
  });

  it('returns [] when response data has no tokens array', async () => {
    const config = makeConfig({
      fetchFn: async () => makeResponse({ success: true, data: {} }),
    });

    const result = await fetchBirdeyeTrending('solana', config);

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchBirdeyeTokenOverview
// ---------------------------------------------------------------------------

describe('fetchBirdeyeTokenOverview', () => {
  it('maps Birdeye overview response to BirdeyeTokenOverview', async () => {
    const config = makeConfig({
      fetchFn: async () => makeResponse(makeOverviewData()),
    });

    const result = await fetchBirdeyeTokenOverview('So1abc123', 'solana', config);

    expect(result).not.toBeNull();
    expect(result!.address).toBe('So1abc123');
    expect(result!.symbol).toBe('MYT');
    expect(result!.name).toBe('MyToken');
    expect(result!.network).toBe('solana');
    expect(result!.priceUsd).toBe(2.5);
    expect(result!.volume24hUsd).toBe(1_000_000);
    expect(result!.liquidityUsd).toBe(500_000);
    expect(result!.priceChange24hPct).toBe(5.0);
    expect(result!.marketCapUsd).toBe(10_000_000);
    expect(result!.supply).toBe(1_000_000);
  });

  it('returns null for non-Solana chains without a network call', async () => {
    let called = false;
    const config = makeConfig({
      fetchFn: async () => {
        called = true;
        return makeResponse({});
      },
    });

    const result = await fetchBirdeyeTokenOverview('0xabc', 'ethereum', config);

    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it('returns null when response data is missing', async () => {
    const config = makeConfig({
      fetchFn: async () => makeResponse({ success: true }),
    });

    const result = await fetchBirdeyeTokenOverview('So1abc123', 'solana', config);

    expect(result).toBeNull();
  });

  it('returns null when response data has no address', async () => {
    const config = makeConfig({
      fetchFn: async () => makeResponse({ success: true, data: { symbol: 'NONE' } }),
    });

    const result = await fetchBirdeyeTokenOverview('So1abc123', 'solana', config);

    expect(result).toBeNull();
  });

  it('returns null on HTTP 400 without throwing (warn-and-skip)', async () => {
    const config = makeConfig({
      fetchFn: async () => makeResponse({ success: false, message: 'Invalid request' }, 400),
    });

    const result = await fetchBirdeyeTokenOverview('So1abc123', 'solana', config);

    expect(result).toBeNull();
  });

  it('throws on non-400 HTTP errors (500) for overview', async () => {
    const config = makeConfig({
      fetchFn: async () => makeResponse({ success: false, message: 'Server error' }, 500),
    });

    await expect(fetchBirdeyeTokenOverview('So1abc123', 'solana', config)).rejects.toThrow('HTTP error: 500');
  });

  it('throws on network errors for overview', async () => {
    const config = makeConfig({
      fetchFn: async () => { throw new Error('Network failure'); },
    });

    await expect(fetchBirdeyeTokenOverview('So1abc123', 'solana', config)).rejects.toThrow('Network failure');
  });

  it('handles missing optional overview fields gracefully', async () => {
    const minimalData = {
      success: true,
      data: { address: 'So1abc123', symbol: 'MIN', name: 'Minimal', liquidity: 0, price: 0 },
    };
    const config = makeConfig({
      fetchFn: async () => makeResponse(minimalData),
    });

    const result = await fetchBirdeyeTokenOverview('So1abc123', 'solana', config);

    expect(result).not.toBeNull();
    expect(result!.priceChange24hPct).toBe(0);
    expect(result!.volume24hUsd).toBe(0);
    expect(result!.marketCapUsd).toBeUndefined();
    expect(result!.supply).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchBirdeyeOhlcv
// ---------------------------------------------------------------------------

describe('fetchBirdeyeOhlcv', () => {
  it('maps Birdeye OHLCV items to PriceCandle', async () => {
    const config = makeConfig({
      fetchFn: async () => makeResponse(makeOhlcvData([OHLCV_ITEM])),
    });

    const result = await fetchBirdeyeOhlcv('So1abc123', 'solana', '1H', config);

    expect(result).toHaveLength(1);
    const candle = result[0]!;
    expect(candle.open).toBe(1.5);
    expect(candle.high).toBe(1.6);
    expect(candle.low).toBe(1.4);
    expect(candle.close).toBe(1.55);
    expect(candle.volume).toBe(100_000);
    expect(candle.timestamp).toBe(new Date(1720012620 * 1000).toISOString());
  });

  it('returns [] for non-Solana chains without a network call', async () => {
    let called = false;
    const config = makeConfig({
      fetchFn: async () => {
        called = true;
        return makeResponse({});
      },
    });

    const result = await fetchBirdeyeOhlcv('0xabc', 'ethereum', '1H', config);

    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it('returns [] for unsupported intervals without a network call', async () => {
    let called = false;
    const config = makeConfig({
      fetchFn: async () => {
        called = true;
        return makeResponse({});
      },
    });

    const result = await fetchBirdeyeOhlcv('So1abc123', 'solana', '45m', config);

    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it('accepts all supported interval values', async () => {
    const supportedIntervals = ['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '6H', '8H', '12H', '1D', '3D', '1W', '1M'];

    for (const interval of supportedIntervals) {
      const config = makeConfig({
        fetchFn: async () => makeResponse(makeOhlcvData([OHLCV_ITEM])),
      });

      const result = await fetchBirdeyeOhlcv('So1abc123', 'solana', interval, config);
      expect(result).toHaveLength(1);
    }
  });

  it('returns [] on HTTP 400 without throwing (warn-and-skip)', async () => {
    const config = makeConfig({
      fetchFn: async () => makeResponse({ success: false, message: 'Invalid request' }, 400),
    });

    const result = await fetchBirdeyeOhlcv('So1abc123', 'solana', '1H', config);

    expect(result).toEqual([]);
  });

  it('throws on non-400 HTTP errors (500) for ohlcv', async () => {
    const config = makeConfig({
      fetchFn: async () => makeResponse({ success: false, message: 'Server error' }, 500),
    });

    await expect(fetchBirdeyeOhlcv('So1abc123', 'solana', '1H', config)).rejects.toThrow('HTTP error: 500');
  });

  it('throws on network errors for ohlcv', async () => {
    const config = makeConfig({
      fetchFn: async () => { throw new Error('Network failure'); },
    });

    await expect(fetchBirdeyeOhlcv('So1abc123', 'solana', '1H', config)).rejects.toThrow('Network failure');
  });

  it('filters out items with zero unixTime', async () => {
    const zeroTime = { unixTime: 0, o: 0, h: 0, l: 0, c: 0, v: 0 };
    const config = makeConfig({
      fetchFn: async () => makeResponse(makeOhlcvData([zeroTime, OHLCV_ITEM])),
    });

    const result = await fetchBirdeyeOhlcv('So1abc123', 'solana', '1H', config);

    expect(result).toHaveLength(1);
    expect(result[0]!.open).toBe(1.5);
  });

  it('sorts candles by timestamp ascending', async () => {
    const earlier = { ...OHLCV_ITEM, unixTime: 1720000000, c: 1.0 };
    const later = { ...OHLCV_ITEM, unixTime: 1720012620, c: 2.0 };
    const config = makeConfig({
      fetchFn: async () => makeResponse(makeOhlcvData([later, earlier])),
    });

    const result = await fetchBirdeyeOhlcv('So1abc123', 'solana', '1H', config);

    expect(result).toHaveLength(2);
    expect(result[0]!.close).toBe(1.0); // earlier
    expect(result[1]!.close).toBe(2.0); // later
  });

  it('returns [] when response data has no items array', async () => {
    const config = makeConfig({
      fetchFn: async () => makeResponse({ success: true, data: {} }),
    });

    const result = await fetchBirdeyeOhlcv('So1abc123', 'solana', '1H', config);

    expect(result).toEqual([]);
  });
});
