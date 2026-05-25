import type { StreamTicker, StreamTrade, PublicStreamHandlers } from '@herobids/domain';
import { price as toPrice } from '@herobids/domain';
import type { MarketDataFeed, TickerSnapshot, TradeEvent, TradeHandler } from './market-data-feed.js';

export interface StreamPoolHandle {
  subscribe(
    venue: string,
    symbols: string[],
    handlers: PublicStreamHandlers,
  ): Promise<{ unsubscribe(): Promise<void> }>;
}

export type TickerFetcher = (symbol: string) => Promise<TickerSnapshot | null>;

/**
 * StreamMarketDataFeed — MarketDataFeed backed by the PublicStreamPool.
 * Replaces PollingMarketDataFeed for shadow executor real-time fill heuristics.
 * No changes needed to ShadowExecutor — only the injected dependency swaps.
 *
 * On connect failure, if a `fallbackFetcher` is provided, the feed degrades to
 * a polling loop that populates the same internal ticker/trade maps the executor reads.
 */
export class StreamMarketDataFeed implements MarketDataFeed {
  private tickers = new Map<string, TickerSnapshot>();
  private tradeHandlers = new Map<string, Set<TradeHandler>>();
  private subscription?: { unsubscribe(): Promise<void> };
  private running = false;
  private connectError?: Error;
  private onConnectError?: (error: Error) => void;
  private fallbackFetcher?: TickerFetcher;
  private fallbackTimer?: ReturnType<typeof setInterval>;
  private fallbackIntervalMs: number;
  private reconnectTimer?: ReturnType<typeof setInterval>;
  private reconnectIntervalMs: number;

  constructor(
    private readonly symbols: string[],
    private readonly venue: string,
    private readonly pool: StreamPoolHandle,
    options?: {
      onConnectError?: (error: Error) => void;
      fallbackFetcher?: TickerFetcher;
      fallbackIntervalMs?: number;
      /** Interval between reconnection attempts after initial subscribe failure. Default: 30000ms */
      reconnectIntervalMs?: number;
    },
  ) {
    this.onConnectError = options?.onConnectError;
    this.fallbackFetcher = options?.fallbackFetcher;
    this.fallbackIntervalMs = options?.fallbackIntervalMs ?? 2000;
    this.reconnectIntervalMs = options?.reconnectIntervalMs ?? 30_000;
  }

  getTicker(symbol: string): TickerSnapshot | null {
    return this.tickers.get(symbol) ?? null;
  }

  onTrade(symbol: string, handler: TradeHandler): () => void {
    let handlers = this.tradeHandlers.get(symbol);
    if (!handlers) {
      handlers = new Set();
      this.tradeHandlers.set(symbol, handlers);
    }
    handlers.add(handler);
    return () => { handlers!.delete(handler); };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect().catch((err) => {
      this.connectError = err instanceof Error ? err : new Error(String(err));
      this.onConnectError?.(this.connectError);
      this.startFallbackPolling();
      this.scheduleReconnect();
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.subscription) {
      void this.subscription.unsubscribe();
      this.subscription = undefined;
    }
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private async connect(): Promise<void> {
    // Unsubscribe previous subscription before reconnecting to prevent
    // ghost subscribers accumulating in the pool on repeated reconnects.
    if (this.subscription) {
      await this.subscription.unsubscribe();
      this.subscription = undefined;
    }

    const handlers: PublicStreamHandlers = {
      onTicker: (ticker: StreamTicker) => {
        this.clearFallbackIfActive();
        const snapshot: TickerSnapshot = {
          symbol: ticker.symbol,
          last: toPrice(ticker.last),
          bid: ticker.bid ? toPrice(ticker.bid) : undefined,
          ask: ticker.ask ? toPrice(ticker.ask) : undefined,
          timestamp: ticker.timestamp,
        };
        this.tickers.set(ticker.symbol, snapshot);
      },
      onTrade: (trade: StreamTrade) => {
        this.clearFallbackIfActive();
        const event: TradeEvent = {
          symbol: trade.symbol,
          side: trade.side,
          price: toPrice(trade.price),
          quantity: toPrice(trade.quantity),
          timestamp: trade.timestamp,
        };
        const handlers = this.tradeHandlers.get(trade.symbol);
        if (handlers) {
          for (const h of handlers) h(event);
        }
      },
      onOrderbook: (book) => {
        // Update ticker bid/ask from orderbook top-of-book
        if (book.bids.length > 0 || book.asks.length > 0) {
          const existing = this.tickers.get(book.symbol);
          const bid = book.bids[0]?.price ? toPrice(book.bids[0].price) : existing?.bid;
          const ask = book.asks[0]?.price ? toPrice(book.asks[0].price) : existing?.ask;
          const last = existing?.last ?? bid ?? ask;
          if (last) {
            this.tickers.set(book.symbol, {
              symbol: book.symbol,
              last,
              bid,
              ask,
              timestamp: book.timestamp,
            });
          }
        }
      },
      onError: (_error: Error) => {
        // If the error indicates fatal stream failure (max reconnect exhausted),
        // activate fallback polling so the feed doesn't go dead.
        if (!this.fallbackTimer && this.running) {
          this.startFallbackPolling();
        }
        // Schedule periodic reconnect attempts so the feed can recover from
        // polling back to the live WebSocket once the pool is healthy again.
        this.scheduleReconnect();
      },
    };

    this.subscription = await this.pool.subscribe(this.venue, this.symbols, handlers);

    // Guard: if stop() was called while subscribe was in flight, unsubscribe immediately
    if (!this.running) {
      void this.subscription.unsubscribe();
      this.subscription = undefined;
    }
  }

  /**
   * Start polling as a degraded fallback when stream connect fails.
   * Populates the same internal tickers map the executor reads from.
   */
  private startFallbackPolling(): void {
    if (!this.running || !this.fallbackFetcher || this.fallbackTimer) return;
    const fetcher = this.fallbackFetcher;
    const poll = async () => {
      for (const symbol of this.symbols) {
        try {
          const ticker = await fetcher(symbol);
          if (ticker) {
            const prev = this.tickers.get(symbol);
            this.tickers.set(symbol, ticker);
            // Emit synthetic trade for limit-order heuristic
            if (ticker.last) {
              const handlers = this.tradeHandlers.get(symbol);
              if (handlers && handlers.size > 0) {
                const trade: TradeEvent = {
                  symbol,
                  side: prev && ticker.last.gt(prev.last) ? 'buy' : 'sell',
                  price: ticker.last,
                  quantity: ticker.last,
                  timestamp: ticker.timestamp,
                };
                for (const h of handlers) h(trade);
              }
            }
          }
        } catch { /* skip transient errors */ }
      }
    };
    void poll();
    this.fallbackTimer = setInterval(() => void poll(), this.fallbackIntervalMs);
  }

  /** Periodically attempt to reconnect after initial subscribe failure. */
  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setInterval(() => {
      if (!this.running) return;
      void this.connect().then(() => {
        // Reconnected — stop retry timer (fallback cleared by incoming stream events)
        if (this.reconnectTimer) {
          clearInterval(this.reconnectTimer);
          this.reconnectTimer = undefined;
        }
        this.connectError = undefined;
      }).catch(() => {
        // Still failing — keep retrying on next interval
      });
    }, this.reconnectIntervalMs);
  }

  /** Stop fallback polling and reconnect timer when live stream events resume. */
  private clearFallbackIfActive(): void {
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
