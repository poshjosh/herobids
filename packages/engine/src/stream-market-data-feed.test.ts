import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamMarketDataFeed } from './stream-market-data-feed.js';
import type { StreamPoolHandle } from './stream-market-data-feed.js';
import type { PublicStreamHandlers, StreamTicker, StreamTrade, StreamOrderbook } from '@herobids/domain';
import { price } from '@herobids/domain';

function createMockPool(): StreamPoolHandle & { capturedHandlers?: PublicStreamHandlers } {
  const mockPool: StreamPoolHandle & { capturedHandlers?: PublicStreamHandlers } = {
    subscribe: vi.fn(async (_venue: string, _symbols: string[], handlers: PublicStreamHandlers) => {
      mockPool.capturedHandlers = handlers;
      return { unsubscribe: vi.fn().mockResolvedValue(undefined) };
    }),
  };
  return mockPool;
}

describe('StreamMarketDataFeed', () => {
  let pool: ReturnType<typeof createMockPool>;
  let feed: StreamMarketDataFeed;

  beforeEach(() => {
    pool = createMockPool();
    feed = new StreamMarketDataFeed(['BTC', 'ETH'], 'hyperliquid', pool);
  });

  it('returns null ticker before any data arrives', () => {
    expect(feed.getTicker('BTC')).toBeNull();
  });

  it('subscribes to pool on start', async () => {
    feed.start();
    // Allow microtask for async connect
    await vi.waitFor(() => expect(pool.subscribe).toHaveBeenCalled());

    expect(pool.subscribe).toHaveBeenCalledWith(
      'hyperliquid',
      ['BTC', 'ETH'],
      expect.any(Object),
    );
  });

  it('updates ticker from stream ticker event', async () => {
    feed.start();
    await vi.waitFor(() => expect(pool.capturedHandlers).toBeDefined());

    pool.capturedHandlers!.onTicker!({
      symbol: 'BTC',
      last: '67000',
      bid: '66999',
      ask: '67001',
      timestamp: '2026-05-24T12:00:00Z',
    });

    const ticker = feed.getTicker('BTC');
    expect(ticker).not.toBeNull();
    expect(ticker!.last.toString()).toBe('67000');
    expect(ticker!.bid!.toString()).toBe('66999');
    expect(ticker!.ask!.toString()).toBe('67001');
  });

  it('updates ticker bid/ask from orderbook data', async () => {
    feed.start();
    await vi.waitFor(() => expect(pool.capturedHandlers).toBeDefined());

    // First set a ticker so there's a "last" price
    pool.capturedHandlers!.onTicker!({
      symbol: 'BTC',
      last: '67000',
      timestamp: '2026-05-24T12:00:00Z',
    });

    // Orderbook update with new top-of-book
    pool.capturedHandlers!.onOrderbook!({
      symbol: 'BTC',
      bids: [{ price: '66990', quantity: '2' }],
      asks: [{ price: '67010', quantity: '1.5' }],
      timestamp: '2026-05-24T12:00:01Z',
    });

    const ticker = feed.getTicker('BTC');
    expect(ticker!.bid!.toString()).toBe('66990');
    expect(ticker!.ask!.toString()).toBe('67010');
    expect(ticker!.last.toString()).toBe('67000'); // preserved from ticker event
  });

  it('dispatches trade events to registered handlers', async () => {
    feed.start();
    await vi.waitFor(() => expect(pool.capturedHandlers).toBeDefined());

    const handler = vi.fn();
    feed.onTrade('BTC', handler);

    pool.capturedHandlers!.onTrade!({
      symbol: 'BTC',
      side: 'buy',
      price: '67000',
      quantity: '0.1',
      timestamp: '2026-05-24T12:00:00Z',
    });

    expect(handler).toHaveBeenCalledWith({
      symbol: 'BTC',
      side: 'buy',
      price: expect.objectContaining({}),
      quantity: expect.objectContaining({}),
      timestamp: '2026-05-24T12:00:00Z',
    });
    expect(handler.mock.calls[0][0].price.toString()).toBe('67000');
  });

  it('does not dispatch trades for unsubscribed symbols', async () => {
    feed.start();
    await vi.waitFor(() => expect(pool.capturedHandlers).toBeDefined());

    const handler = vi.fn();
    feed.onTrade('ETH', handler);

    pool.capturedHandlers!.onTrade!({
      symbol: 'BTC',
      side: 'sell',
      price: '66000',
      quantity: '1',
      timestamp: 'ts',
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribes trade handler on cleanup', async () => {
    feed.start();
    await vi.waitFor(() => expect(pool.capturedHandlers).toBeDefined());

    const handler = vi.fn();
    const unsub = feed.onTrade('BTC', handler);
    unsub();

    pool.capturedHandlers!.onTrade!({
      symbol: 'BTC',
      side: 'buy',
      price: '67000',
      quantity: '0.5',
      timestamp: 'ts',
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('start is idempotent', async () => {
    feed.start();
    feed.start();
    await vi.waitFor(() => expect(pool.subscribe).toHaveBeenCalled());

    expect(pool.subscribe).toHaveBeenCalledTimes(1);
  });

  it('stop clears subscription', async () => {
    feed.start();
    await vi.waitFor(() => expect(pool.capturedHandlers).toBeDefined());

    feed.stop();
    // Second stop is a no-op
    feed.stop();
  });

  it('creates ticker from orderbook when no previous ticker exists', async () => {
    feed.start();
    await vi.waitFor(() => expect(pool.capturedHandlers).toBeDefined());

    pool.capturedHandlers!.onOrderbook!({
      symbol: 'ETH',
      bids: [{ price: '3500', quantity: '10' }],
      asks: [{ price: '3502', quantity: '5' }],
      timestamp: '2026-05-24T12:00:00Z',
    });

    const ticker = feed.getTicker('ETH');
    expect(ticker).not.toBeNull();
    // Last defaults to bid when no existing last
    expect(ticker!.last.toString()).toBe('3500');
    expect(ticker!.bid!.toString()).toBe('3500');
    expect(ticker!.ask!.toString()).toBe('3502');
  });

  // --- BUG-003 regression: unhandled subscribe failure ---

  it('invokes onConnectError callback when pool.subscribe rejects', async () => {
    const failingPool: StreamPoolHandle = {
      subscribe: vi.fn().mockRejectedValue(new Error('venue not registered')),
    };
    const errorHandler = vi.fn();
    const failFeed = new StreamMarketDataFeed(['BTC'], 'unknown-venue', failingPool, {
      onConnectError: errorHandler,
    });

    failFeed.start();

    // Wait for the async error to propagate
    await vi.waitFor(() => expect(errorHandler).toHaveBeenCalled());
    expect(errorHandler).toHaveBeenCalledWith(expect.any(Error));
    expect(errorHandler.mock.calls[0][0].message).toContain('venue not registered');
  });

  it('does not throw unhandled rejection when subscribe fails without callback', async () => {
    const failingPool: StreamPoolHandle = {
      subscribe: vi.fn().mockRejectedValue(new Error('network error')),
    };
    // No onConnectError — should not throw unhandled rejection
    const failFeed = new StreamMarketDataFeed(['BTC'], 'test', failingPool);

    failFeed.start();

    // Give time for the async rejection to be caught internally
    await new Promise((r) => setTimeout(r, 50));
    // If we reach here without unhandled rejection, the test passes
  });

  it('still returns null tickers after subscribe failure', async () => {
    const failingPool: StreamPoolHandle = {
      subscribe: vi.fn().mockRejectedValue(new Error('failed')),
    };
    const failFeed = new StreamMarketDataFeed(['BTC'], 'test', failingPool, {
      onConnectError: vi.fn(),
    });

    failFeed.start();
    await vi.waitFor(() => expect(failingPool.subscribe).toHaveBeenCalled());

    // Ticker should still be null — no data
    expect(failFeed.getTicker('BTC')).toBeNull();
  });

  // --- BUG-005 regression: fallback polling populates tickers after connect failure ---

  it('activates fallback polling and populates tickers after connect failure', async () => {
    vi.useFakeTimers();
    const failingPool: StreamPoolHandle = {
      subscribe: vi.fn().mockRejectedValue(new Error('ws connect failed')),
    };
    const fetcher = vi.fn().mockResolvedValue({
      symbol: 'BTC',
      last: price('67500'),
      bid: price('67499'),
      ask: price('67501'),
      timestamp: '2026-05-24T12:00:00Z',
    });

    const failFeed = new StreamMarketDataFeed(['BTC'], 'test', failingPool, {
      onConnectError: vi.fn(),
      fallbackFetcher: fetcher,
      fallbackIntervalMs: 1000,
    });

    failFeed.start();
    // Allow the connect rejection + initial fallback poll to run
    await vi.advanceTimersByTimeAsync(50);

    // Fallback fetcher should have been called
    expect(fetcher).toHaveBeenCalledWith('BTC');
    // Ticker map should now have data from the fallback fetcher
    const ticker = failFeed.getTicker('BTC');
    expect(ticker).not.toBeNull();
    expect(ticker!.last.toString()).toBe('67500');
    expect(ticker!.bid!.toString()).toBe('67499');
    expect(ticker!.ask!.toString()).toBe('67501');

    failFeed.stop();
    vi.useRealTimers();
  });

  it('fallback polling emits synthetic trades for registered handlers', async () => {
    vi.useFakeTimers();
    const failingPool: StreamPoolHandle = {
      subscribe: vi.fn().mockRejectedValue(new Error('ws connect failed')),
    };
    const fetcher = vi.fn().mockResolvedValue({
      symbol: 'ETH',
      last: price('3500'),
      timestamp: '2026-05-24T12:00:00Z',
    });

    const failFeed = new StreamMarketDataFeed(['ETH'], 'test', failingPool, {
      onConnectError: vi.fn(),
      fallbackFetcher: fetcher,
      fallbackIntervalMs: 1000,
    });

    const tradeHandler = vi.fn();
    failFeed.onTrade('ETH', tradeHandler);

    failFeed.start();
    await vi.advanceTimersByTimeAsync(50);

    // Should emit a synthetic trade from fallback data
    expect(tradeHandler).toHaveBeenCalled();
    expect(tradeHandler.mock.calls[0][0].symbol).toBe('ETH');

    failFeed.stop();
    vi.useRealTimers();
  });

  it('stop clears fallback polling timer', async () => {
    vi.useFakeTimers();
    const failingPool: StreamPoolHandle = {
      subscribe: vi.fn().mockRejectedValue(new Error('ws connect failed')),
    };
    const fetcher = vi.fn().mockResolvedValue({
      symbol: 'BTC',
      last: price('67500'),
      timestamp: '2026-05-24T12:00:00Z',
    });

    const failFeed = new StreamMarketDataFeed(['BTC'], 'test', failingPool, {
      onConnectError: vi.fn(),
      fallbackFetcher: fetcher,
      fallbackIntervalMs: 1000,
    });

    failFeed.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(fetcher).toHaveBeenCalledTimes(1);

    failFeed.stop();
    fetcher.mockClear();

    // Advance timer — fetcher should NOT be called after stop
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetcher).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('does not start fallback polling when no fallbackFetcher is provided', async () => {
    const failingPool: StreamPoolHandle = {
      subscribe: vi.fn().mockRejectedValue(new Error('ws connect failed')),
    };
    const errorHandler = vi.fn();
    const failFeed = new StreamMarketDataFeed(['BTC'], 'test', failingPool, {
      onConnectError: errorHandler,
      // No fallbackFetcher
    });

    failFeed.start();
    await vi.waitFor(() => expect(errorHandler).toHaveBeenCalled());

    // Ticker remains null — no fallback
    expect(failFeed.getTicker('BTC')).toBeNull();
  });

  // --- BUG-009 regression: fallback activates on runtime stream error (not just initial connect) ---

  it('activates fallback polling when runtime onError fires after successful connect', async () => {
    vi.useFakeTimers();
    const mockPool = createMockPool();
    const fetcher = vi.fn().mockResolvedValue({
      symbol: 'BTC',
      last: price('70000'),
      bid: price('69999'),
      ask: price('70001'),
      timestamp: '2026-05-24T13:00:00Z',
    });

    const feedWithFallback = new StreamMarketDataFeed(['BTC'], 'hyperliquid', mockPool, {
      fallbackFetcher: fetcher,
      fallbackIntervalMs: 1000,
    });

    feedWithFallback.start();
    await vi.advanceTimersByTimeAsync(10);
    // Feed connected successfully
    expect(mockPool.capturedHandlers).toBeDefined();

    // Simulate a fatal runtime error (e.g. max reconnect exhausted)
    mockPool.capturedHandlers!.onError!(new Error('Max reconnect attempts exceeded'));

    // Allow fallback poll to execute
    await vi.advanceTimersByTimeAsync(50);

    // Fallback fetcher should have been called
    expect(fetcher).toHaveBeenCalledWith('BTC');
    // Ticker should now have data from fallback
    const ticker = feedWithFallback.getTicker('BTC');
    expect(ticker).not.toBeNull();
    expect(ticker!.last.toString()).toBe('70000');

    feedWithFallback.stop();
    vi.useRealTimers();
  });

  it('does not double-start fallback polling on repeated runtime errors', async () => {
    vi.useFakeTimers();
    const mockPool = createMockPool();
    const fetcher = vi.fn().mockResolvedValue({
      symbol: 'BTC',
      last: price('70000'),
      timestamp: '2026-05-24T13:00:00Z',
    });

    const feedWithFallback = new StreamMarketDataFeed(['BTC'], 'hyperliquid', mockPool, {
      fallbackFetcher: fetcher,
      fallbackIntervalMs: 1000,
    });

    feedWithFallback.start();
    await vi.advanceTimersByTimeAsync(10);

    // Multiple error events (e.g. transient then fatal)
    mockPool.capturedHandlers!.onError!(new Error('connection lost'));
    mockPool.capturedHandlers!.onError!(new Error('max reconnect exceeded'));

    await vi.advanceTimersByTimeAsync(50);

    // Only one initial poll should have happened (not doubled)
    expect(fetcher).toHaveBeenCalledTimes(1);

    feedWithFallback.stop();
    vi.useRealTimers();
  });

  it('does not activate fallback on runtime error when feed is stopped', async () => {
    vi.useFakeTimers();
    const mockPool = createMockPool();
    const fetcher = vi.fn().mockResolvedValue({
      symbol: 'BTC',
      last: price('70000'),
      timestamp: '2026-05-24T13:00:00Z',
    });

    const feedWithFallback = new StreamMarketDataFeed(['BTC'], 'hyperliquid', mockPool, {
      fallbackFetcher: fetcher,
      fallbackIntervalMs: 1000,
    });

    feedWithFallback.start();
    await vi.advanceTimersByTimeAsync(10);

    // Stop the feed first
    feedWithFallback.stop();

    // Then an error arrives (delayed callback)
    mockPool.capturedHandlers!.onError!(new Error('stream died'));
    await vi.advanceTimersByTimeAsync(50);

    // Fallback should NOT activate — feed is stopped
    expect(fetcher).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  // --- clearFallbackIfActive: live stream data stops fallback polling ---

  it('stops fallback polling when live ticker event arrives', async () => {
    vi.useFakeTimers();
    const mockPool = createMockPool();
    const fetcher = vi.fn().mockResolvedValue({
      symbol: 'BTC',
      last: price('70000'),
      timestamp: '2026-05-24T13:00:00Z',
    });

    const feedWithFallback = new StreamMarketDataFeed(['BTC'], 'hyperliquid', mockPool, {
      fallbackFetcher: fetcher,
      fallbackIntervalMs: 1000,
    });

    feedWithFallback.start();
    await vi.advanceTimersByTimeAsync(10);

    // Simulate runtime error — activates fallback
    mockPool.capturedHandlers!.onError!(new Error('reconnect exhausted'));
    await vi.advanceTimersByTimeAsync(50);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Now live stream recovers — ticker event arrives
    fetcher.mockClear();
    mockPool.capturedHandlers!.onTicker!({
      symbol: 'BTC',
      last: '71000',
      timestamp: '2026-05-24T13:01:00Z',
    });

    // Advance past several polling intervals — fetcher should NOT be called again
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).not.toHaveBeenCalled();

    // Ticker should reflect the live stream value, not fallback
    const ticker = feedWithFallback.getTicker('BTC');
    expect(ticker!.last.toString()).toBe('71000');

    feedWithFallback.stop();
    vi.useRealTimers();
  });

  it('stops fallback polling when live trade event arrives', async () => {
    vi.useFakeTimers();
    const mockPool = createMockPool();
    const fetcher = vi.fn().mockResolvedValue({
      symbol: 'BTC',
      last: price('70000'),
      timestamp: '2026-05-24T13:00:00Z',
    });

    const feedWithFallback = new StreamMarketDataFeed(['BTC'], 'hyperliquid', mockPool, {
      fallbackFetcher: fetcher,
      fallbackIntervalMs: 1000,
    });

    feedWithFallback.start();
    await vi.advanceTimersByTimeAsync(10);

    // Activate fallback
    mockPool.capturedHandlers!.onError!(new Error('connection lost'));
    await vi.advanceTimersByTimeAsync(50);
    expect(fetcher).toHaveBeenCalled();

    // Stream resumes with a trade
    fetcher.mockClear();
    mockPool.capturedHandlers!.onTrade!({
      symbol: 'BTC',
      side: 'buy',
      price: '71000',
      quantity: '0.5',
      timestamp: '2026-05-24T13:01:00Z',
    });

    // Fallback should be stopped — no more polling
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).not.toHaveBeenCalled();

    feedWithFallback.stop();
    vi.useRealTimers();
  });

  it('clearFallbackIfActive is a no-op when no fallback is running', async () => {
    // A live ticker event when fallback was never started should not crash
    const mockPool = createMockPool();
    const feed = new StreamMarketDataFeed(['BTC'], 'hyperliquid', mockPool);

    feed.start();
    await vi.waitFor(() => expect(mockPool.capturedHandlers).toBeDefined());

    // Send ticker — no fallback timer exists; should not throw
    mockPool.capturedHandlers!.onTicker!({
      symbol: 'BTC',
      last: '67000',
      timestamp: '2026-05-24T12:00:00Z',
    });

    expect(feed.getTicker('BTC')!.last.toString()).toBe('67000');
  });

  // --- Reconnect retry after initial subscribe failure ---

  it('retries subscribe after initial failure and clears fallback on success', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    let capturedHandlers: PublicStreamHandlers | undefined;
    const retryPool: StreamPoolHandle = {
      subscribe: vi.fn(async (_venue: string, _symbols: string[], handlers: PublicStreamHandlers) => {
        callCount++;
        if (callCount === 1) throw new Error('transient failure');
        capturedHandlers = handlers;
        return { unsubscribe: vi.fn().mockResolvedValue(undefined) };
      }),
    };
    const fetcher = vi.fn().mockResolvedValue({
      symbol: 'BTC',
      last: price('67500'),
      timestamp: '2026-05-24T12:00:00Z',
    });

    const retryFeed = new StreamMarketDataFeed(['BTC'], 'test', retryPool, {
      onConnectError: vi.fn(),
      fallbackFetcher: fetcher,
      fallbackIntervalMs: 1000,
      reconnectIntervalMs: 5000,
    });

    retryFeed.start();
    // Let connect failure + initial fallback poll settle
    await vi.advanceTimersByTimeAsync(50);
    expect(callCount).toBe(1);
    expect(fetcher).toHaveBeenCalled();

    // Advance past reconnect interval — should retry subscribe
    await vi.advanceTimersByTimeAsync(5000);
    expect(callCount).toBe(2);

    // Stream data arrives — should clear fallback
    capturedHandlers!.onTicker!({
      symbol: 'BTC',
      last: '68000',
      timestamp: '2026-05-24T12:01:00Z',
    });

    // Advance time — fallback should no longer poll
    fetcher.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).not.toHaveBeenCalled();

    // Ticker reflects live data
    expect(retryFeed.getTicker('BTC')!.last.toString()).toBe('68000');

    retryFeed.stop();
    vi.useRealTimers();
  });

  it('stop clears reconnect timer', async () => {
    vi.useFakeTimers();
    const failingPool: StreamPoolHandle = {
      subscribe: vi.fn().mockRejectedValue(new Error('ws connect failed')),
    };

    const retryFeed = new StreamMarketDataFeed(['BTC'], 'test', failingPool, {
      onConnectError: vi.fn(),
      reconnectIntervalMs: 5000,
    });

    retryFeed.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(failingPool.subscribe).toHaveBeenCalledTimes(1);

    retryFeed.stop();

    // Advance past reconnect interval — should NOT retry
    await vi.advanceTimersByTimeAsync(10000);
    expect(failingPool.subscribe).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
