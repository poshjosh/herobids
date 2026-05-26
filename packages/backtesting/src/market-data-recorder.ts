import type { MarketSnapshot } from '@herobids/domain';

/**
 * Record of a single market observation for corpus building.
 */
export interface MarketEventRecord {
  venue: string;
  symbol: string;
  eventType: string;
  price: string;
  eventAt: Date;
  data?: Record<string, unknown>;
}

/**
 * Market data recorder — captures live market observations for later replay.
 * Accumulates events in memory and flushes on demand.
 */
export class MarketDataRecorder {
  private buffer: MarketEventRecord[] = [];

  constructor(
    private readonly venue: string,
  ) {}

  /** Record a ticker/snapshot observation */
  recordSnapshot(snapshot: MarketSnapshot): void {
    this.buffer.push({
      venue: this.venue,
      symbol: snapshot.symbol,
      eventType: 'ticker',
      price: snapshot.price.toString(),
      eventAt: new Date(snapshot.timestamp),
      data: snapshot.data,
    });
  }

  /** Record a trade print */
  recordTrade(symbol: string, price: string, timestamp: string, data?: Record<string, unknown>): void {
    this.buffer.push({
      venue: this.venue,
      symbol,
      eventType: 'trade',
      price,
      eventAt: new Date(timestamp),
      data,
    });
  }

  /** Record a mark price observation */
  recordMark(symbol: string, price: string, source: string, timestamp: string): void {
    this.buffer.push({
      venue: this.venue,
      symbol,
      eventType: 'mark',
      price,
      eventAt: new Date(timestamp),
      data: { source },
    });
  }

  /** Flush buffered events and return them (resets the buffer) */
  flush(): MarketEventRecord[] {
    const events = this.buffer;
    this.buffer = [];
    return events;
  }

  /** Current buffer size */
  get pendingCount(): number {
    return this.buffer.length;
  }
}
