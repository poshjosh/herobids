import WebSocket from 'ws';
import type { StreamTicker, StreamOrderbook, StreamTrade } from '@herobids/domain';
import type { VenueStreamConnector, StreamPoolConfig } from './stream-pool.js';

export interface HyperliquidPublicStreamConfig {
  wsUrl: string;
}

/**
 * Converts a unified symbol (e.g. 'BTC/USD:USD', 'ETH/USDC') to the raw Hyperliquid coin name (e.g. 'BTC', 'ETH').
 * Hyperliquid WS uses bare coin names, not CCXT-unified pairs.
 */
function toRawCoin(unifiedSymbol: string): string {
  // Take the base asset: everything before the first '/' or the whole string if no '/'
  const slash = unifiedSymbol.indexOf('/');
  return slash === -1 ? unifiedSymbol : unifiedSymbol.slice(0, slash);
}

/**
 * Hyperliquid public WebSocket stream connector.
 * Implements the venue-specific subscribe/unsubscribe messages and payload normalization.
 * Owned by the PublicStreamPool — not directly by adapters.
 */
export class HyperliquidPublicStream implements VenueStreamConnector {
  readonly venue = 'hyperliquid';

  private ws: WebSocket | null = null;
  private config: StreamPoolConfig | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private allMidsSubscribed = false;
  /** Raw coin names currently subscribed on the WS (e.g. 'BTC', 'ETH') */
  private subscribedCoins = new Set<string>();
  /** Map from raw coin → original unified symbol(s) for reverse translation */
  private coinToSymbols = new Map<string, Set<string>>();

  private tickerHandlers: Array<(ticker: StreamTicker) => void> = [];
  private orderbookHandlers: Array<(book: StreamOrderbook) => void> = [];
  private tradeHandlers: Array<(trade: StreamTrade) => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private disconnectHandlers: Array<() => void> = [];
  private reconnectHandlers: Array<() => void> = [];

  constructor(private readonly wsConfig: HyperliquidPublicStreamConfig) {}

  async connect(symbols: string[], config: StreamPoolConfig): Promise<void> {
    this.config = config;
    this.closed = false;
    for (const s of symbols) this.trackSymbol(s);
    await this.openConnection();
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.allMidsSubscribed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws) {
      this.ws.close(1000, 'pool shutdown');
      this.ws = null;
    }
  }

  subscribe(symbols: string[]): void {
    const newCoins: string[] = [];
    for (const s of symbols) {
      const coin = this.trackSymbol(s);
      if (coin) newCoins.push(coin);
    }
    if (newCoins.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscriptions(newCoins);
    }
  }

  unsubscribe(symbols: string[]): void {
    const removedCoins: string[] = [];
    for (const s of symbols) {
      const coin = this.untrackSymbol(s);
      if (coin) removedCoins.push(coin);
    }
    if (removedCoins.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.sendUnsubscriptions(removedCoins);
    }
  }

  /** Track a unified symbol, returns the raw coin if it's newly tracked (needs WS subscribe). */
  private trackSymbol(unified: string): string | null {
    const coin = toRawCoin(unified);
    let symbolSet = this.coinToSymbols.get(coin);
    if (!symbolSet) {
      symbolSet = new Set();
      this.coinToSymbols.set(coin, symbolSet);
    }
    symbolSet.add(unified);
    if (this.subscribedCoins.has(coin)) return null; // already subscribed on WS
    this.subscribedCoins.add(coin);
    return coin;
  }

  /** Untrack a unified symbol, returns the raw coin if no more symbols need it (needs WS unsubscribe). */
  private untrackSymbol(unified: string): string | null {
    const coin = toRawCoin(unified);
    const symbolSet = this.coinToSymbols.get(coin);
    if (symbolSet) {
      symbolSet.delete(unified);
      if (symbolSet.size === 0) {
        this.coinToSymbols.delete(coin);
        this.subscribedCoins.delete(coin);
        return coin;
      }
    }
    return null; // other symbols still need this coin
  }

  onTicker(handler: (ticker: StreamTicker) => void): void {
    this.tickerHandlers.push(handler);
  }

  onOrderbook(handler: (book: StreamOrderbook) => void): void {
    this.orderbookHandlers.push(handler);
  }

  onTrade(handler: (trade: StreamTrade) => void): void {
    this.tradeHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }

  onReconnect(handler: () => void): void {
    this.reconnectHandlers.push(handler);
  }

  private openConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsConfig.wsUrl);

      ws.on('open', () => {
        this.ws = ws;
        this.reconnectAttempts = 0;
        this.allMidsSubscribed = false;
        // Subscribe to all tracked coins
        this.sendSubscriptions(Array.from(this.subscribedCoins));
        resolve();
      });

      ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(data);
      });

      ws.on('close', () => {
        if (this.closed) return;
        for (const h of this.disconnectHandlers) h();
        this.attemptReconnect();
      });

      ws.on('error', (error: Error) => {
        for (const h of this.errorHandlers) h(error);
        if (!this.ws) {
          reject(error);
        }
      });
    });
  }

  private sendSubscriptions(coins: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (coins.length > 0 && !this.allMidsSubscribed) {
      this.ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'allMids' },
      }));
      this.allMidsSubscribed = true;
    }

    for (const coin of coins) {
      // Hyperliquid public WS subscriptions
      // Subscribe to trades
      this.ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'trades', coin },
      }));

      // Subscribe to L2 orderbook
      this.ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'l2Book', coin },
      }));
    }
  }

  private sendUnsubscriptions(coins: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    for (const coin of coins) {
      this.ws.send(JSON.stringify({
        method: 'unsubscribe',
        subscription: { type: 'trades', coin },
      }));

      this.ws.send(JSON.stringify({
        method: 'unsubscribe',
        subscription: { type: 'l2Book', coin },
      }));
    }
  }

  private handleMessage(raw: WebSocket.RawData): void {
    try {
      const msg = JSON.parse(raw.toString()) as HyperliquidWsMessage;
      if (!msg.channel || !msg.data) return;

      switch (msg.channel) {
        case 'trades':
          this.handleTrades(msg.data as HyperliquidTradeData[]);
          break;
        case 'l2Book':
          this.handleOrderbook(msg.data as HyperliquidL2BookData);
          break;
        case 'allMids':
          this.handleAllMids(msg.data as HyperliquidAllMidsData);
          break;
      }
    } catch {
      // Malformed messages are silently dropped
    }
  }

  private handleTrades(trades: HyperliquidTradeData[]): void {
    const now = new Date().toISOString();
    for (const t of trades) {
      if (!this.subscribedCoins.has(t.coin)) continue;
      // Emit one event per unified symbol mapped to this coin
      const symbols = this.coinToSymbols.get(t.coin);
      if (!symbols) continue;
      for (const symbol of symbols) {
        const event: StreamTrade = {
          symbol,
          side: t.side === 'B' ? 'buy' : 'sell',
          price: t.px,
          quantity: t.sz,
          timestamp: t.time ? new Date(t.time).toISOString() : now,
        };
        for (const h of this.tradeHandlers) h(event);
      }
    }
  }

  private handleOrderbook(data: HyperliquidL2BookData): void {
    if (!data.coin || !this.subscribedCoins.has(data.coin)) return;
    const symbols = this.coinToSymbols.get(data.coin);
    if (!symbols) return;
    const levels = this.config?.depthLevels ?? 5;
    for (const symbol of symbols) {
      const book: StreamOrderbook = {
        symbol,
        bids: (data.levels?.[0] ?? []).slice(0, levels).map((l) => ({ price: l.px, quantity: l.sz })),
        asks: (data.levels?.[1] ?? []).slice(0, levels).map((l) => ({ price: l.px, quantity: l.sz })),
        timestamp: new Date().toISOString(),
      };
      for (const h of this.orderbookHandlers) h(book);
    }
  }

  private handleAllMids(data: HyperliquidAllMidsData): void {
    if (!data.mids) return;
    const now = new Date().toISOString();
    for (const [coin, mid] of Object.entries(data.mids)) {
      if (!this.subscribedCoins.has(coin)) continue;
      const symbols = this.coinToSymbols.get(coin);
      if (!symbols) continue;
      for (const symbol of symbols) {
        const ticker: StreamTicker = {
          symbol,
          last: mid,
          timestamp: now,
        };
        for (const h of this.tickerHandlers) h(ticker);
      }
    }
  }

  private attemptReconnect(): void {
    if (this.closed || !this.config) return;
    // Guard against double-scheduling: ws 'close' and openConnection rejection
    // can both trigger this method for the same failed attempt.
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.config.maxReconnectAttempts) {
      for (const h of this.errorHandlers) {
        h(new Error(`Max reconnect attempts (${this.config.maxReconnectAttempts}) exceeded for Hyperliquid public stream`));
      }
      return;
    }

    const baseMs = this.config.reconnectBaseMs;
    const maxMs = this.config.reconnectMaxMs;
    const delay = Math.min(baseMs * Math.pow(2, this.reconnectAttempts - 1), maxMs);
    // Add jitter: ±25%
    const jitter = delay * (0.75 + Math.random() * 0.5);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openConnection().then(() => {
        for (const h of this.reconnectHandlers) h();
      }).catch((err) => {
        for (const h of this.errorHandlers) h(err instanceof Error ? err : new Error(String(err)));
        // ws 'close' will also fire for the failed connection and call attemptReconnect.
        // The timer guard at the top of attemptReconnect prevents double-scheduling.
        this.attemptReconnect();
      });
    }, jitter);
  }
}

// --- Hyperliquid WS message types ---

interface HyperliquidWsMessage {
  channel?: string;
  data?: unknown;
}

interface HyperliquidTradeData {
  coin: string;
  side: 'B' | 'A';
  px: string;
  sz: string;
  time?: number;
}

interface HyperliquidL2BookData {
  coin?: string;
  levels?: Array<Array<{ px: string; sz: string }>>;
}

interface HyperliquidAllMidsData {
  mids?: Record<string, string>;
}
