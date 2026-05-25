import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HyperliquidPublicStream } from './hyperliquid-public-stream.js';
import type { StreamPoolConfig } from './stream-pool.js';
import type { StreamTicker, StreamTrade, StreamOrderbook } from '@herobids/domain';

/** Per-instance event handlers collected by the mock */
interface MockWsInstance {
  handlers: Map<string, Array<(...args: unknown[]) => void>>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
}

let latestWsInstance: MockWsInstance | undefined;

vi.mock('ws', () => {
  const MockWebSocket = vi.fn(() => {
    const instance: MockWsInstance = {
      handlers: new Map(),
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1, // OPEN
    };
    (instance as Record<string, unknown>)['on'] = (event: string, handler: (...args: unknown[]) => void) => {
      if (!instance.handlers.has(event)) instance.handlers.set(event, []);
      instance.handlers.get(event)!.push(handler);
    };
    latestWsInstance = instance;
    return instance;
  });
  (MockWebSocket as unknown as Record<string, unknown>)['OPEN'] = 1;
  return { default: MockWebSocket, __esModule: true };
});

function triggerWsOpen() {
  for (const h of latestWsInstance!.handlers.get('open') ?? []) h();
}

function triggerWsMessage(data: unknown) {
  const raw = { toString: () => JSON.stringify(data) };
  for (const h of latestWsInstance!.handlers.get('message') ?? []) h(raw);
}

const defaultConfig: StreamPoolConfig = {
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  maxReconnectAttempts: 20,
  depthLevels: 5,
};

describe('HyperliquidPublicStream — symbol normalization (BUG-001 regression)', () => {
  let stream: HyperliquidPublicStream;

  beforeEach(() => {
    latestWsInstance = undefined;
    stream = new HyperliquidPublicStream({ wsUrl: 'wss://fake.test/ws' });
  });

  it('subscribes on WS with raw coin name extracted from unified symbol', async () => {
    const connectPromise = stream.connect(['BTC/USD:USD', 'ETH/USDC'], defaultConfig);
    triggerWsOpen();
    await connectPromise;

    const sendCalls = latestWsInstance!.send.mock.calls.map((c: string[]) => JSON.parse(c[0]));

    // Should subscribe with raw coin 'BTC' not 'BTC/USD:USD'
    const tradesSubs = sendCalls.filter((m: Record<string, unknown>) =>
      (m['subscription'] as Record<string, unknown>)?.['type'] === 'trades',
    );
    expect(tradesSubs).toHaveLength(2);
    expect((tradesSubs[0]['subscription'] as Record<string, string>)['coin']).toBe('BTC');
    expect((tradesSubs[1]['subscription'] as Record<string, string>)['coin']).toBe('ETH');
  });

  it('subscribes to allMids only once per connection even with multiple coins', async () => {
    const connectPromise = stream.connect(['BTC/USD:USD', 'ETH/USDC'], defaultConfig);
    triggerWsOpen();
    await connectPromise;

    const sendCalls = latestWsInstance!.send.mock.calls.map((c: string[]) => JSON.parse(c[0]));
    const allMidsSubs = sendCalls.filter((m: Record<string, unknown>) =>
      (m['subscription'] as Record<string, unknown>)?.['type'] === 'allMids',
    );

    expect(allMidsSubs).toHaveLength(1);
  });

  it('does not re-subscribe allMids when adding a new coin on an open socket', async () => {
    const connectPromise = stream.connect(['BTC/USD:USD'], defaultConfig);
    triggerWsOpen();
    await connectPromise;

    latestWsInstance!.send.mockClear();
    stream.subscribe(['ETH/USDC']);

    const sendCalls = latestWsInstance!.send.mock.calls.map((c: string[]) => JSON.parse(c[0]));
    const allMidsSubs = sendCalls.filter((m: Record<string, unknown>) =>
      (m['subscription'] as Record<string, unknown>)?.['type'] === 'allMids',
    );

    expect(allMidsSubs).toHaveLength(0);
  });

  it('emits ticker events with unified symbol (not raw coin)', async () => {
    const connectPromise = stream.connect(['BTC/USD:USD'], defaultConfig);
    triggerWsOpen();
    await connectPromise;

    const tickers: StreamTicker[] = [];
    stream.onTicker((t) => tickers.push(t));

    // Simulate allMids message from Hyperliquid (uses raw coin 'BTC')
    triggerWsMessage({
      channel: 'allMids',
      data: { mids: { BTC: '67500.5' } },
    });

    expect(tickers).toHaveLength(1);
    expect(tickers[0].symbol).toBe('BTC/USD:USD'); // unified, not 'BTC'
    expect(tickers[0].last).toBe('67500.5');
  });

  it('emits trade events with unified symbol', async () => {
    const connectPromise = stream.connect(['ETH/USDC'], defaultConfig);
    triggerWsOpen();
    await connectPromise;

    const trades: StreamTrade[] = [];
    stream.onTrade((t) => trades.push(t));

    triggerWsMessage({
      channel: 'trades',
      data: [{ coin: 'ETH', side: 'B', px: '3500', sz: '1.5', time: 1716552000000 }],
    });

    expect(trades).toHaveLength(1);
    expect(trades[0].symbol).toBe('ETH/USDC'); // unified
    expect(trades[0].side).toBe('buy');
    expect(trades[0].price).toBe('3500');
  });

  it('emits orderbook events with unified symbol', async () => {
    const connectPromise = stream.connect(['BTC/USD:USD'], defaultConfig);
    triggerWsOpen();
    await connectPromise;

    const books: StreamOrderbook[] = [];
    stream.onOrderbook((b) => books.push(b));

    triggerWsMessage({
      channel: 'l2Book',
      data: {
        coin: 'BTC',
        levels: [
          [{ px: '67000', sz: '2' }],
          [{ px: '67100', sz: '1' }],
        ],
      },
    });

    expect(books).toHaveLength(1);
    expect(books[0].symbol).toBe('BTC/USD:USD'); // unified
    expect(books[0].bids[0].price).toBe('67000');
  });

  it('filters events for unsubscribed coins', async () => {
    const connectPromise = stream.connect(['BTC/USD:USD'], defaultConfig);
    triggerWsOpen();
    await connectPromise;

    const tickers: StreamTicker[] = [];
    stream.onTicker((t) => tickers.push(t));

    // SOL is not subscribed
    triggerWsMessage({
      channel: 'allMids',
      data: { mids: { SOL: '150.00', BTC: '67500' } },
    });

    expect(tickers).toHaveLength(1);
    expect(tickers[0].symbol).toBe('BTC/USD:USD');
  });

  it('handles multiple unified symbols mapping to the same coin', async () => {
    // Both map to BTC via toRawCoin
    const connectPromise = stream.connect(['BTC/USD:USD'], defaultConfig);
    triggerWsOpen();
    await connectPromise;

    // Add another symbol for same coin
    stream.subscribe(['BTC/USDT']);

    const tickers: StreamTicker[] = [];
    stream.onTicker((t) => tickers.push(t));

    triggerWsMessage({
      channel: 'allMids',
      data: { mids: { BTC: '67500' } },
    });

    // Should emit for both unified symbols
    expect(tickers).toHaveLength(2);
    const symbols = tickers.map((t) => t.symbol).sort();
    expect(symbols).toEqual(['BTC/USD:USD', 'BTC/USDT']);
  });

  it('unsubscribes only when no more symbols need the coin', async () => {
    const connectPromise = stream.connect(['BTC/USD:USD', 'BTC/USDT'], defaultConfig);
    triggerWsOpen();
    await connectPromise;

    // Unsubscribe one of the two BTC symbols — coin should NOT be unsubscribed on WS
    stream.unsubscribe(['BTC/USD:USD']);

    const unsubCalls = latestWsInstance!.send.mock.calls
      .map((c: string[]) => JSON.parse(c[0]))
      .filter((m: Record<string, unknown>) => m['method'] === 'unsubscribe');
    expect(unsubCalls).toHaveLength(0);

    // Unsubscribe the last BTC symbol — NOW it should unsubscribe on WS
    stream.unsubscribe(['BTC/USDT']);

    const allUnsubCalls = latestWsInstance!.send.mock.calls
      .map((c: string[]) => JSON.parse(c[0]))
      .filter((m: Record<string, unknown>) => m['method'] === 'unsubscribe');
    expect(allUnsubCalls.length).toBeGreaterThan(0);
    expect((allUnsubCalls[0]['subscription'] as Record<string, string>)['coin']).toBe('BTC');
  });
});
