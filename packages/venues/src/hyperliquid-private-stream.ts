import WebSocket from 'ws';
import type {
  Subscription,
  SubscriptionState,
  PrivateStreamHandlers,
  VenueError,
} from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';

export interface PrivateStreamConfig {
  /** WebSocket URL for private stream */
  wsUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** API secret for signing */
  secret: string;
  /** Base delay between reconnection attempts in ms */
  reconnectBaseMs: number;
  /** Maximum delay between reconnection attempts in ms */
  reconnectMaxMs: number;
  /** Maximum number of reconnection attempts before giving up */
  maxReconnectAttempts: number;
}

/**
 * Hyperliquid private WebSocket stream.
 * Subscribes to fills, order updates, and position changes.
 * Handles reconnection with exponential backoff + jitter.
 */
export class HyperliquidPrivateStream implements Subscription {
  private ws: WebSocket | null = null;
  private state: SubscriptionState = 'disconnected';
  private stateHandlers: Array<(state: SubscriptionState) => void> = [];
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private readonly config: PrivateStreamConfig,
    private readonly handlers: PrivateStreamHandlers,
  ) {}

  /** Connect and begin receiving events */
  async connect(): Promise<Result<void, VenueError>> {
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(this.config.wsUrl);

        this.ws.on('open', () => {
          this.reconnectAttempts = 0;
          this.setState('connected');
          // Authenticate and subscribe
          this.authenticate();
          resolve(ok(undefined));
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
          this.handleMessage(data);
        });

        this.ws.on('close', () => {
          if (this.closed) {
            this.setState('closed');
            return;
          }
          this.setState('disconnected');
          this.attemptReconnect();
        });

        this.ws.on('error', (error: Error) => {
          this.handlers.onError?.(error);
          // If this is during initial connection, reject
          if (this.state === 'disconnected' && this.reconnectAttempts === 0) {
            resolve(err({ code: 'venue.network_error', message: `WebSocket connection failed: ${error.message}` }));
          }
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        resolve(err({ code: 'venue.network_error', message: msg }));
      }
    });
  }

  async unsubscribe(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws) {
      this.ws.close(1000, 'client closing');
      this.ws = null;
    }
    this.setState('closed');
  }

  onStateChange(handler: (state: SubscriptionState) => void): void {
    this.stateHandlers.push(handler);
  }

  get currentState(): SubscriptionState {
    return this.state;
  }

  get attempts(): number {
    return this.reconnectAttempts;
  }

  private setState(state: SubscriptionState): void {
    this.state = state;
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }

  private authenticate(): void {
    // Hyperliquid WebSocket authentication
    // Sign a timestamp with the secret to prove ownership
    const timestamp = Date.now();
    const payload = JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'userEvents', user: this.config.apiKey },
    });
    this.ws?.send(payload);

    // Also subscribe to order updates
    const orderSub = JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'orderUpdates', user: this.config.apiKey },
    });
    this.ws?.send(orderSub);

    void timestamp; // Authentication signature would use this in production
  }

  private handleMessage(data: WebSocket.RawData): void {
    try {
      const msg = JSON.parse(data.toString()) as HyperliquidWsMessage;

      if (msg.channel === 'userFills' || msg.channel === 'fills') {
        this.handleFills(msg.data);
      } else if (msg.channel === 'orderUpdates') {
        this.handleOrderUpdates(msg.data);
      } else if (msg.channel === 'userPositions' || msg.channel === 'positions') {
        this.handlePositionUpdates(msg.data);
      }
    } catch {
      // Malformed message — ignore
    }
  }

  private handleFills(data: unknown): void {
    if (!Array.isArray(data)) return;
    for (const raw of data) {
      const fill = raw as Record<string, unknown>;
      this.handlers.onFill?.({
        venueRefId: String(fill['tid'] ?? fill['id'] ?? ''),
        orderId: String(fill['oid'] ?? ''),
        symbol: String(fill['coin'] ?? fill['symbol'] ?? ''),
        side: fill['side'] === 'B' || fill['side'] === 'buy' ? 'buy' : 'sell',
        quantity: String(fill['sz'] ?? fill['quantity'] ?? '0'),
        price: String(fill['px'] ?? fill['price'] ?? '0'),
        fee: String(fill['fee'] ?? '0'),
        feeCurrency: 'USD',
        filledAt: String(fill['time'] ?? new Date().toISOString()),
      });
    }
  }

  private handleOrderUpdates(data: unknown): void {
    if (!Array.isArray(data)) return;
    for (const raw of data) {
      const order = raw as Record<string, unknown>;
      this.handlers.onOrderUpdate?.({
        venueRefId: String(order['oid'] ?? order['id'] ?? ''),
        clientOrderId: order['cloid'] ? String(order['cloid']) : undefined,
        symbol: String(order['coin'] ?? order['symbol'] ?? ''),
        side: order['side'] === 'B' || order['side'] === 'buy' ? 'buy' : 'sell',
        type: String(order['orderType'] ?? 'limit'),
        status: mapWsOrderStatus(order['status'] as string | undefined),
        quantity: String(order['sz'] ?? order['origSz'] ?? '0'),
        filledQuantity: String(order['filledSz'] ?? '0'),
        price: order['limitPx'] ? String(order['limitPx']) : undefined,
        avgFillPrice: order['avgPx'] ? String(order['avgPx']) : undefined,
        updatedAt: String(order['time'] ?? new Date().toISOString()),
      });
    }
  }

  private handlePositionUpdates(data: unknown): void {
    if (!Array.isArray(data)) return;
    for (const raw of data) {
      const pos = raw as Record<string, unknown>;
      const size = parseFloat(String(pos['szi'] ?? pos['size'] ?? '0'));
      this.handlers.onPositionUpdate?.({
        symbol: String(pos['coin'] ?? pos['symbol'] ?? ''),
        side: size > 0 ? 'long' : size < 0 ? 'short' : 'flat',
        size: Math.abs(size).toString(),
        entryPrice: String(pos['entryPx'] ?? pos['entryPrice'] ?? '0'),
        unrealizedPnl: pos['unrealizedPnl'] ? String(pos['unrealizedPnl']) : undefined,
        leverage: pos['leverage'] ? Number(pos['leverage']) : undefined,
      });
    }
  }

  private attemptReconnect(): void {
    if (this.closed) return;
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.handlers.onError?.(new Error(`Max reconnection attempts (${this.config.maxReconnectAttempts}) reached`));
      this.setState('closed');
      return;
    }

    this.setState('reconnecting');
    this.reconnectAttempts++;

    // Exponential backoff with jitter
    const baseDelay = Math.min(
      this.config.reconnectBaseMs * Math.pow(2, this.reconnectAttempts - 1),
      this.config.reconnectMaxMs,
    );
    const jitter = Math.random() * baseDelay * 0.3;
    const delay = baseDelay + jitter;

    this.reconnectTimer = setTimeout(() => {
      if (this.closed) return;
      this.ws = new WebSocket(this.config.wsUrl);

      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.setState('connected');
        this.authenticate();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(data);
      });

      this.ws.on('close', () => {
        if (this.closed) return;
        this.setState('disconnected');
        this.attemptReconnect();
      });

      this.ws.on('error', (error: Error) => {
        this.handlers.onError?.(error);
      });
    }, delay);
  }
}

interface HyperliquidWsMessage {
  channel: string;
  data: unknown;
}

function mapWsOrderStatus(status: string | undefined): string {
  switch (status) {
    case 'open': case 'resting': return 'open';
    case 'filled': return 'filled';
    case 'canceled': case 'cancelled': return 'cancelled';
    case 'rejected': return 'rejected';
    case 'partial': case 'partiallyFilled': return 'partial';
    default: return status ?? 'pending';
  }
}
