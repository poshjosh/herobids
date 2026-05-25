import type { PublicStreamHandlers, StreamTicker, StreamOrderbook, StreamTrade } from '@herobids/domain';

export interface StreamPoolConfig {
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  maxReconnectAttempts: number;
  depthLevels: number;
}

export interface VenueStreamConnector {
  readonly venue: string;
  connect(symbols: string[], config: StreamPoolConfig): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(symbols: string[]): void;
  unsubscribe(symbols: string[]): void;
  onTicker(handler: (ticker: StreamTicker) => void): void;
  onOrderbook(handler: (book: StreamOrderbook) => void): void;
  onTrade(handler: (trade: StreamTrade) => void): void;
  onError(handler: (error: Error) => void): void;
  onDisconnect(handler: () => void): void;
  onReconnect(handler: () => void): void;
}

interface SubscriberEntry {
  id: string;
  symbols: Set<string>;
  handlers: PublicStreamHandlers;
}

interface VenueConnection {
  connector: VenueStreamConnector;
  subscribers: Map<string, SubscriberEntry>;
  subscribedSymbols: Set<string>;
  connected: boolean;
  /** In-flight connect promise — guards against concurrent first-connect races */
  connectingPromise?: Promise<void>;
}

let nextSubId = 0;
function genSubId(): string {
  return `sub-${++nextSubId}-${Date.now()}`;
}

/**
 * PublicStreamPool — worker-scoped WebSocket connection pool.
 * One connection per venue, fan-out to all subscribed actors.
 * Keyed by venue (not by trading instance) — pure optimization, no privacy concern.
 */
export class PublicStreamPool {
  private readonly venues = new Map<string, VenueConnection>();
  private readonly connectorFactory: Map<string, () => VenueStreamConnector>;
  private readonly config: StreamPoolConfig;

  constructor(
    config: StreamPoolConfig,
    connectorFactory: Map<string, () => VenueStreamConnector>,
  ) {
    this.config = config;
    this.connectorFactory = connectorFactory;
  }

  /**
   * Subscribe to public market data for a set of symbols on a venue.
   * Opens the venue connection on first subscriber.
   * Returns a subscription handle for unsubscribing.
   */
  async subscribe(
    venue: string,
    symbols: string[],
    handlers: PublicStreamHandlers,
  ): Promise<PoolSubscription> {
    let conn = this.venues.get(venue);
    let isNewConnection = false;

    if (!conn) {
      const factory = this.connectorFactory.get(venue);
      if (!factory) {
        throw new Error(`No stream connector registered for venue: ${venue}`);
      }
      const connector = factory();
      conn = {
        connector,
        subscribers: new Map(),
        subscribedSymbols: new Set(),
        connected: false,
      };
      this.venues.set(venue, conn);
      isNewConnection = true;

      // Wire connector events to fan-out
      connector.onTicker((ticker) => this.fanOut(venue, 'onTicker', ticker));
      connector.onOrderbook((book) => this.fanOut(venue, 'onOrderbook', book));
      connector.onTrade((trade) => this.fanOut(venue, 'onTrade', trade));
      connector.onError((error) => {
        this.fanOutError(venue, error);
        // Detect fatal "max reconnect exhausted" errors and mark the entry dead
        // so subsequent subscribers trigger a fresh connection attempt.
        if (error.message.includes('Max reconnect attempts') && conn) {
          conn.connected = false;
          conn.connector.disconnect().catch(() => {});
          this.venues.delete(venue);
        }
      });
      connector.onDisconnect(() => {
        if (conn) conn.connected = false;
      });
      connector.onReconnect(() => {
        if (conn) conn.connected = true;
      });
    }

    const subId = genSubId();
    const entry: SubscriberEntry = {
      id: subId,
      symbols: new Set(symbols),
      handlers,
    };
    conn.subscribers.set(subId, entry);

    // Determine new symbols that need subscribing
    const newSymbols = symbols.filter((s) => !conn!.subscribedSymbols.has(s));
    for (const s of symbols) {
      conn.subscribedSymbols.add(s);
    }

    // Connect if first subscriber on a new connection
    if (!conn.connected && !conn.connectingPromise && isNewConnection) {
      conn.connectingPromise = conn.connector.connect(Array.from(conn.subscribedSymbols), this.config)
        .then(() => {
          conn!.connected = true;
          conn!.connectingPromise = undefined;
        })
        .catch((err) => {
          // Rollback: remove subscriber so it doesn't leak
          conn!.subscribers.delete(subId);
          conn!.connectingPromise = undefined;
          // If no subscribers remain, clean up the venue entry and stop the
          // connector's internal retry loop so it doesn't run orphaned.
          if (conn!.subscribers.size === 0) {
            conn!.connector.disconnect().catch(() => {});
            this.venues.delete(venue);
          }
          throw err;
        });
      await conn.connectingPromise;
    } else if (conn.connectingPromise) {
      // Another call is already connecting — wait for it
      try {
        await conn.connectingPromise;
      } catch (err) {
        // Connect failed — rollback this subscriber too
        conn.subscribers.delete(subId);
        for (const s of symbols) {
          // Only remove symbols not needed by any remaining subscriber
          const stillNeeded = Array.from(conn.subscribers.values()).some((sub) => sub.symbols.has(s));
          if (!stillNeeded) conn.subscribedSymbols.delete(s);
        }
        if (conn.subscribers.size === 0) {
          conn.connector.disconnect().catch(() => {});
          this.venues.delete(venue);
        }
        throw err;
      }
      // After connect, subscribe any symbols not yet on the wire
      if (newSymbols.length > 0) {
        conn.connector.subscribe(newSymbols);
      }
    } else if (conn.connected && newSymbols.length > 0) {
      // Already connected — just subscribe new symbols
      conn.connector.subscribe(newSymbols);
    } else if (!conn.connected && !isNewConnection && !conn.connectingPromise && newSymbols.length > 0) {
      // Connector is internally reconnecting — track new symbols so they're
      // included in subscribedCoins when the connector replays on reconnect.
      conn.connector.subscribe(newSymbols);
    }

    return new PoolSubscription(subId, venue, this);
  }

  /** Unsubscribe a specific subscription. Closes venue connection on last unsubscribe. */
  async unsubscribe(subId: string, venue: string): Promise<void> {
    const conn = this.venues.get(venue);
    if (!conn) return;

    const entry = conn.subscribers.get(subId);
    if (!entry) return;

    conn.subscribers.delete(subId);

    // Determine which symbols are no longer needed by any subscriber
    const stillNeeded = new Set<string>();
    for (const sub of conn.subscribers.values()) {
      for (const s of sub.symbols) {
        stillNeeded.add(s);
      }
    }

    const toRemove = Array.from(entry.symbols).filter((s) => !stillNeeded.has(s));
    for (const s of toRemove) {
      conn.subscribedSymbols.delete(s);
    }

    if (toRemove.length > 0 && conn.connected) {
      conn.connector.unsubscribe(toRemove);
    }

    // Close connection on last unsubscribe
    if (conn.subscribers.size === 0) {
      await conn.connector.disconnect();
      conn.connected = false;
      this.venues.delete(venue);
    }
  }

  /** Graceful shutdown: close all venue connections */
  async shutdown(): Promise<void> {
    for (const [venue, conn] of this.venues) {
      // Always call disconnect to clear reconnect timers, even if not marked connected
      await conn.connector.disconnect();
      this.venues.delete(venue);
    }
  }

  private fanOut(venue: string, event: 'onTicker', data: StreamTicker): void;
  private fanOut(venue: string, event: 'onOrderbook', data: StreamOrderbook): void;
  private fanOut(venue: string, event: 'onTrade', data: StreamTrade): void;
  private fanOut(venue: string, event: 'onTicker' | 'onOrderbook' | 'onTrade', data: StreamTicker | StreamOrderbook | StreamTrade): void {
    const conn = this.venues.get(venue);
    if (!conn) return;

    const symbol = data.symbol;
    for (const sub of conn.subscribers.values()) {
      if (!sub.symbols.has(symbol)) continue;
      const handler = sub.handlers[event];
      if (handler) {
        (handler as (d: typeof data) => void)(data);
      }
    }
  }

  private fanOutError(venue: string, error: Error): void {
    const conn = this.venues.get(venue);
    if (!conn) return;

    for (const sub of conn.subscribers.values()) {
      sub.handlers.onError?.(error);
    }
  }
}

/**
 * Handle returned to subscribers for lifecycle management.
 */
export class PoolSubscription {
  constructor(
    private readonly subId: string,
    private readonly venue: string,
    private readonly pool: PublicStreamPool,
  ) {}

  async unsubscribe(): Promise<void> {
    await this.pool.unsubscribe(this.subId, this.venue);
  }
}
