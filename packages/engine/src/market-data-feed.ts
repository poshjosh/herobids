import type { Price } from '@herobids/domain';

/**
 * MarketDataFeed — abstraction over live market data for shadow execution.
 * Phase 2b: polling implementation via venue fetchTicker.
 * Phase 2c: upgraded to public stream pool (WebSocket fan-out) with no executor changes.
 */
export interface MarketDataFeed {
  /** Get the current best bid/ask/last for a symbol */
  getTicker(symbol: string): TickerSnapshot | null;

  /** Register a handler for trade prints (used for limit-order heuristic fills) */
  onTrade(symbol: string, handler: TradeHandler): () => void;

  /** Start the feed (begins polling or connects stream) */
  start(): void;

  /** Stop the feed and release resources */
  stop(): void;
}

export interface TickerSnapshot {
  symbol: string;
  last: Price;
  bid?: Price;
  ask?: Price;
  timestamp: string;
}

export interface TradeEvent {
  symbol: string;
  side: 'buy' | 'sell';
  price: Price;
  quantity: Price;
  timestamp: string;
}

export type TradeHandler = (trade: TradeEvent) => void;

/**
 * Polling-based MarketDataFeed — fetches ticker at a configurable interval.
 * For limit-order heuristic, each tick is emitted as a synthetic trade event
 * (any movement through a price level is treated as a print at that price).
 */
export class PollingMarketDataFeed implements MarketDataFeed {
  private timer?: ReturnType<typeof setInterval>;
  private tickers = new Map<string, TickerSnapshot>();
  private tradeHandlers = new Map<string, Set<TradeHandler>>();
  private running = false;

  constructor(
    private readonly symbols: string[],
    private readonly fetchTicker: (symbol: string) => Promise<TickerSnapshot | null>,
    private readonly intervalMs: number = 2000,
  ) {}

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
    // Initial fetch
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    for (const symbol of this.symbols) {
      try {
        const ticker = await this.fetchTicker(symbol);
        if (!ticker) continue;

        const prev = this.tickers.get(symbol);
        this.tickers.set(symbol, ticker);

        // Emit a synthetic trade event on each price update
        // This enables the shadow executor's limit-order heuristic
        if (ticker.last) {
          const handlers = this.tradeHandlers.get(symbol);
          if (handlers && handlers.size > 0) {
            const trade: TradeEvent = {
              symbol,
              side: prev && ticker.last.gt(prev.last) ? 'buy' : 'sell',
              price: ticker.last,
              quantity: ticker.last, // synthetic — quantity not meaningful in polling mode
              timestamp: ticker.timestamp,
            };
            for (const handler of handlers) {
              handler(trade);
            }
          }
        }
      } catch {
        // Transient errors — skip this poll cycle
      }
    }
  }
}
