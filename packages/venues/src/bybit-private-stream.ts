import WebSocket from 'ws';
import crypto from 'node:crypto';
import type {
  Subscription,
  SubscriptionState,
  PrivateStreamHandlers,
  VenueError,
} from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';

export interface BybitPrivateStreamConfig {
  /** WebSocket URL for private stream */
  wsUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** API secret for HMAC signing */
  secret: string;
  /** Base delay between reconnection attempts in ms */
  reconnectBaseMs: number;
  /** Maximum delay between reconnection attempts in ms */
  reconnectMaxMs: number;
  /** Maximum number of reconnection attempts before giving up */
  maxReconnectAttempts: number;
}

/**
 * Bybit private WebSocket stream (v5 API).
 * Subscribes to order, execution (fill), and position topics.
 * Handles reconnection with exponential backoff + jitter.
 *
 * Auth: HMAC-SHA256 of "GET/realtime{expires}" using the API secret.
 */
export class BybitPrivateStream implements Subscription {
  private ws: WebSocket | null = null;
  private state: SubscriptionState = 'disconnected';
  private stateHandlers: Array<(state: SubscriptionState) => void> = [];
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  /** Deferred resolver for connect() — only resolved once auth is confirmed or fails */
  private connectResolve?: (result: Result<void, VenueError>) => void;

  constructor(
    private readonly config: BybitPrivateStreamConfig,
    private readonly handlers: PrivateStreamHandlers,
  ) {}

  async connect(): Promise<Result<void, VenueError>> {
    return new Promise((resolve) => {
      try {
        this.connectResolve = resolve;
        this.ws = new WebSocket(this.config.wsUrl);

        this.ws.on('open', () => {
          this.reconnectAttempts = 0;
          this.authenticate();
          this.startPingLoop();
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
          this.handleMessage(data);
        });

        this.ws.on('close', () => {
          this.stopPingLoop();
          if (this.closed) {
            this.setState('closed');
            return;
          }
          // If we never got auth confirmation, reject the connect promise
          if (this.connectResolve) {
            this.connectResolve(err({ code: 'venue.auth_failed', message: 'WebSocket closed before auth confirmation' }));
            this.connectResolve = undefined;
          }
          this.setState('disconnected');
          this.attemptReconnect();
        });

        this.ws.on('error', (error: Error) => {
          this.handlers.onError?.(error);
          if (this.connectResolve && this.state === 'disconnected' && this.reconnectAttempts === 0) {
            this.connectResolve(err({ code: 'venue.network_error', message: `WebSocket connection failed: ${error.message}` }));
            this.connectResolve = undefined;
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
    this.stopPingLoop();
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

  /**
   * Bybit WebSocket auth: sign "GET/realtime{expires}" with HMAC-SHA256.
   * After auth success, subscribe to private topics.
   */
  private authenticate(): void {
    const expires = Date.now() + 10_000; // 10s validity
    const signature = crypto
      .createHmac('sha256', this.config.secret)
      .update(`GET/realtime${expires}`)
      .digest('hex');

    this.ws?.send(JSON.stringify({
      op: 'auth',
      args: [this.config.apiKey, expires, signature],
    }));
  }

  private subscribeTopics(): void {
    this.ws?.send(JSON.stringify({
      op: 'subscribe',
      args: ['order', 'execution', 'position'],
    }));
  }

  private startPingLoop(): void {
    // Bybit requires ping every 20s to keep connection alive
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

  private handleMessage(data: WebSocket.RawData): void {
    try {
      const msg = JSON.parse(data.toString()) as BybitWsMessage;

      // Auth response — subscribe to topics after successful auth
      if (msg.op === 'auth') {
        if (msg.success) {
          this.setState('connected');
          this.subscribeTopics();
          if (this.connectResolve) {
            this.connectResolve(ok(undefined));
            this.connectResolve = undefined;
          }
        } else {
          const authErr = { code: 'venue.auth_failed', message: `Bybit auth failed: ${msg.ret_msg ?? 'unknown'}` } satisfies VenueError;
          this.handlers.onError?.(new Error(authErr.message));
          // Mark closed to prevent the close handler from triggering reconnect.
          // Auth failure is terminal — reconnecting with the same credentials would loop forever.
          this.closed = true;
          this.stopPingLoop();
          this.ws?.close(1000, 'auth failed');
          this.ws = null;
          if (this.connectResolve) {
            this.connectResolve(err(authErr));
            this.connectResolve = undefined;
          }
        }
        return;
      }

      // Pong response — ignore
      if (msg.op === 'pong' || msg.ret_msg === 'pong') return;

      // Data messages
      if (msg.topic === 'execution') {
        this.handleFills(msg.data);
      } else if (msg.topic === 'order') {
        this.handleOrderUpdates(msg.data);
      } else if (msg.topic === 'position') {
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
        venueRefId: String(fill['execId'] ?? ''),
        orderId: String(fill['orderId'] ?? ''),
        symbol: String(fill['symbol'] ?? ''),
        side: String(fill['side'] ?? '').toLowerCase() === 'buy' ? 'buy' : 'sell',
        quantity: String(fill['execQty'] ?? '0'),
        price: String(fill['execPrice'] ?? '0'),
        fee: String(fill['execFee'] ?? '0'),
        feeCurrency: String(fill['feeCurrency'] ?? 'USDT'),
        filledAt: toIsoTimestamp(fill['execTime']),
      });
    }
  }

  private handleOrderUpdates(data: unknown): void {
    if (!Array.isArray(data)) return;
    for (const raw of data) {
      const order = raw as Record<string, unknown>;
      this.handlers.onOrderUpdate?.({
        venueRefId: String(order['orderId'] ?? ''),
        clientOrderId: order['orderLinkId'] ? String(order['orderLinkId']) : undefined,
        symbol: String(order['symbol'] ?? ''),
        side: String(order['side'] ?? '').toLowerCase() === 'buy' ? 'buy' : 'sell',
        type: mapBybitOrderType(String(order['orderType'] ?? '')),
        status: mapBybitOrderStatus(String(order['orderStatus'] ?? '')),
        quantity: String(order['qty'] ?? '0'),
        filledQuantity: String(order['cumExecQty'] ?? '0'),
        price: order['price'] && String(order['price']) !== '0' ? String(order['price']) : undefined,
        avgFillPrice: order['avgPrice'] && String(order['avgPrice']) !== '0' ? String(order['avgPrice']) : undefined,
        updatedAt: toIsoTimestamp(order['updatedTime']),
      });
    }
  }

  private handlePositionUpdates(data: unknown): void {
    if (!Array.isArray(data)) return;
    for (const raw of data) {
      const pos = raw as Record<string, unknown>;
      const size = parseFloat(String(pos['size'] ?? '0'));
      const side = String(pos['side'] ?? '').toLowerCase();
      this.handlers.onPositionUpdate?.({
        symbol: String(pos['symbol'] ?? ''),
        side: size === 0 ? 'flat' : side === 'buy' ? 'long' : 'short',
        size: Math.abs(size).toString(),
        entryPrice: String(pos['entryPrice'] ?? '0'),
        unrealizedPnl: pos['unrealisedPnl'] ? String(pos['unrealisedPnl']) : undefined,
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
        this.authenticate();
        this.startPingLoop();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(data);
      });

      this.ws.on('close', () => {
        this.stopPingLoop();
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

interface BybitWsMessage {
  op?: string;
  success?: boolean;
  ret_msg?: string;
  topic?: string;
  data?: unknown;
}

/** Convert a Bybit timestamp (epoch ms number/string, or ISO string) to ISO-8601. */
function toIsoTimestamp(value: unknown): string {
  if (value == null) return new Date().toISOString();
  const s = String(value);
  // If it looks like epoch milliseconds (all digits, 13 chars), convert
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  // If it looks like epoch seconds (all digits, 10 chars), convert
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  // Otherwise assume it's already an ISO string or parseable date string
  return s;
}

function mapBybitOrderType(type: string): string {
  switch (type.toLowerCase()) {
    case 'market': return 'market';
    case 'limit': return 'limit';
    default: return type.toLowerCase();
  }
}

function mapBybitOrderStatus(status: string): string {
  switch (status) {
    case 'New': return 'open';
    case 'PartiallyFilled': return 'partial';
    case 'Filled': return 'filled';
    case 'Cancelled': return 'cancelled';
    case 'Rejected': return 'rejected';
    case 'Deactivated': return 'cancelled';
    default: return status.toLowerCase();
  }
}
