import WebSocket from 'ws';
import type { StreamTicker, StreamOrderbook, StreamTrade } from '@herobids/domain';
import type { VenueStreamConnector, StreamPoolConfig } from './stream-pool.js';

export interface BybitPublicStreamConfig {
  wsUrl: string;
}

/**
 * Bybit public WebSocket stream connector (v5 linear API).
 * Normalizes ticker, orderbook, and trade messages into the shared stream types.
 * Owned by the PublicStreamPool — not directly by adapters.
 */
export class BybitPublicStream implements VenueStreamConnector {
  readonly venue = 'bybit';

  private ws: WebSocket | null = null;
  private config: StreamPoolConfig | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private subscribedSymbols = new Set<string>();

  private tickerHandlers: Array<(ticker: StreamTicker) => void> = [];
  private orderbookHandlers: Array<(book: StreamOrderbook) => void> = [];
  private tradeHandlers: Array<(trade: StreamTrade) => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private disconnectHandlers: Array<() => void> = [];
  private reconnectHandlers: Array<() => void> = [];

  constructor(private readonly wsConfig: BybitPublicStreamConfig) {}

  async connect(symbols: string[], config: StreamPoolConfig): Promise<void> {
    this.config = config;
    this.closed = false;
    for (const s of symbols) this.subscribedSymbols.add(s);
    await this.openConnection();
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.stopPingLoop();
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
    const newSymbols: string[] = [];
    for (const s of symbols) {
      if (!this.subscribedSymbols.has(s)) {
        this.subscribedSymbols.add(s);
        newSymbols.push(s);
      }
    }
    if (newSymbols.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscriptions(newSymbols);
    }
  }

  unsubscribe(symbols: string[]): void {
    const removed: string[] = [];
    for (const s of symbols) {
      if (this.subscribedSymbols.delete(s)) {
        removed.push(s);
      }
    }
    if (removed.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.sendUnsubscriptions(removed);
    }
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
        this.sendSubscriptions(Array.from(this.subscribedSymbols));
        this.startPingLoop();
        resolve();
      });

      ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(data);
      });

      ws.on('close', () => {
        this.stopPingLoop();
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

  private startPingLoop(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, 18_000);
  }

  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  /**
   * Convert unified ccxt symbol (e.g. 'BTC/USDT:USDT') to Bybit raw symbol (e.g. 'BTCUSDT').
   * Drops the settlement suffix (after ':') then removes the '/'.
   */
  private toBybitSymbol(unified: string): string {
    // Drop settlement: 'BTC/USDT:USDT' → 'BTC/USDT', then remove '/': → 'BTCUSDT'
    const withoutSettlement = unified.includes(':') ? unified.slice(0, unified.indexOf(':')) : unified;
    return withoutSettlement.replace(/\//g, '');
  }

  /**
   * Convert Bybit raw symbol back to the original unified symbol.
   * Falls back to raw if no mapping found.
   */
  private toUnifiedSymbol(raw: string): string | undefined {
    for (const s of this.subscribedSymbols) {
      if (this.toBybitSymbol(s) === raw) return s;
    }
    return undefined;
  }

  private sendSubscriptions(symbols: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Always use depth 1: the consumer only reads top-of-book (bids[0]/asks[0]),
    // and depth 1 guarantees every message is a full snapshot (no delta application needed).
    const depth = 1;

    const args: string[] = [];
    for (const s of symbols) {
      const raw = this.toBybitSymbol(s);
      args.push(`tickers.${raw}`);
      args.push(`orderbook.${depth}.${raw}`);
      args.push(`publicTrade.${raw}`);
    }

    if (args.length > 0) {
      this.ws.send(JSON.stringify({ op: 'subscribe', args }));
    }
  }

  private sendUnsubscriptions(symbols: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const depth = 1;

    const args: string[] = [];
    for (const s of symbols) {
      const raw = this.toBybitSymbol(s);
      args.push(`tickers.${raw}`);
      args.push(`orderbook.${depth}.${raw}`);
      args.push(`publicTrade.${raw}`);
    }

    if (args.length > 0) {
      this.ws.send(JSON.stringify({ op: 'unsubscribe', args }));
    }
  }

  private handleMessage(raw: WebSocket.RawData): void {
    try {
      const msg = JSON.parse(raw.toString()) as BybitPublicWsMessage;

      // Ignore pong
      if (msg.op === 'pong') return;

      // Handle subscription responses — emit error on failure so operators notice
      if (msg.op === 'subscribe') {
        if (msg.success === false) {
          for (const h of this.errorHandlers) {
            h(new Error(`Bybit subscribe failed: ${msg.ret_msg ?? 'unknown reason'}`));
          }
        }
        return;
      }

      if (!msg.topic || !msg.data) return;

      if (msg.topic.startsWith('tickers.')) {
        this.handleTicker(msg.topic, msg.data);
      } else if (msg.topic.startsWith('orderbook.')) {
        this.handleOrderbook(msg.topic, msg.data);
      } else if (msg.topic.startsWith('publicTrade.')) {
        this.handleTrades(msg.topic, msg.data);
      }
    } catch {
      // Malformed messages are silently dropped
    }
  }

  private handleTicker(topic: string, data: unknown): void {
    // topic: "tickers.BTCUSDT"
    const rawSymbol = topic.split('.')[1];
    if (!rawSymbol) return;
    const symbol = this.toUnifiedSymbol(rawSymbol);
    if (!symbol) return;

    const d = data as Record<string, unknown>;
    const ticker: StreamTicker = {
      symbol,
      last: String(d['lastPrice'] ?? '0'),
      bid: d['bid1Price'] ? String(d['bid1Price']) : undefined,
      ask: d['ask1Price'] ? String(d['ask1Price']) : undefined,
      timestamp: d['timestamp'] ? new Date(Number(d['timestamp'])).toISOString() : new Date().toISOString(),
    };
    for (const h of this.tickerHandlers) h(ticker);
  }

  private handleOrderbook(topic: string, data: unknown): void {
    // topic: "orderbook.5.BTCUSDT"
    const parts = topic.split('.');
    const rawSymbol = parts[2];
    if (!rawSymbol) return;
    const symbol = this.toUnifiedSymbol(rawSymbol);
    if (!symbol) return;

    const d = data as Record<string, unknown>;
    const bids = (d['b'] as Array<[string, string]> | undefined) ?? [];
    const asks = (d['a'] as Array<[string, string]> | undefined) ?? [];

    const book: StreamOrderbook = {
      symbol,
      bids: bids.map(([p, q]) => ({ price: p, quantity: q })),
      asks: asks.map(([p, q]) => ({ price: p, quantity: q })),
      timestamp: d['ts'] ? new Date(Number(d['ts'])).toISOString() : new Date().toISOString(),
    };
    for (const h of this.orderbookHandlers) h(book);
  }

  private handleTrades(topic: string, data: unknown): void {
    // topic: "publicTrade.BTCUSDT"
    const rawSymbol = topic.split('.')[1];
    if (!rawSymbol) return;
    const symbol = this.toUnifiedSymbol(rawSymbol);
    if (!symbol) return;

    if (!Array.isArray(data)) return;
    for (const raw of data) {
      const t = raw as Record<string, unknown>;
      const trade: StreamTrade = {
        symbol,
        side: String(t['S'] ?? '').toLowerCase() === 'buy' ? 'buy' : 'sell',
        price: String(t['p'] ?? '0'),
        quantity: String(t['v'] ?? '0'),
        timestamp: t['T'] ? new Date(Number(t['T'])).toISOString() : new Date().toISOString(),
      };
      for (const h of this.tradeHandlers) h(trade);
    }
  }

  private attemptReconnect(): void {
    if (this.closed || !this.config) return;
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.config.maxReconnectAttempts) {
      for (const h of this.errorHandlers) {
        h(new Error(`Max reconnect attempts (${this.config.maxReconnectAttempts}) exceeded for Bybit public stream`));
      }
      return;
    }

    const baseMs = this.config.reconnectBaseMs;
    const maxMs = this.config.reconnectMaxMs;
    const delay = Math.min(baseMs * Math.pow(2, this.reconnectAttempts - 1), maxMs);
    const jitter = delay * (0.75 + Math.random() * 0.5);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openConnection().then(() => {
        for (const h of this.reconnectHandlers) h();
      }).catch((connectErr) => {
        for (const h of this.errorHandlers) h(connectErr instanceof Error ? connectErr : new Error(String(connectErr)));
        this.attemptReconnect();
      });
    }, jitter);
  }
}

interface BybitPublicWsMessage {
  op?: string;
  success?: boolean;
  ret_msg?: string;
  topic?: string;
  data?: unknown;
}

