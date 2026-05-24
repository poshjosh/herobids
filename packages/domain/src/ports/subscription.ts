/**
 * Subscription handle for WebSocket streams (private or public).
 * Returned by subscribe* methods on venue ports.
 * Reconnection is the caller's responsibility.
 */
export interface Subscription {
  /** Close the subscription and release resources */
  unsubscribe(): Promise<void>;

  /** Register a handler for connection-state changes */
  onStateChange(handler: (state: SubscriptionState) => void): void;
}

export type SubscriptionState = 'connected' | 'disconnected' | 'reconnecting' | 'closed';

/** Handlers for private stream events (fills, orders, positions) */
export interface PrivateStreamHandlers {
  onFill?: (fill: PrivateStreamFill) => void;
  onOrderUpdate?: (order: PrivateStreamOrder) => void;
  onPositionUpdate?: (position: PrivateStreamPosition) => void;
  onError?: (error: Error) => void;
}

/** Handlers for public stream events (ticker, orderbook, trades) */
export interface PublicStreamHandlers {
  onTicker?: (ticker: StreamTicker) => void;
  onOrderbook?: (book: StreamOrderbook) => void;
  onTrade?: (trade: StreamTrade) => void;
  onError?: (error: Error) => void;
}

/** A fill event from the private stream */
export interface PrivateStreamFill {
  venueRefId: string;
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: string;
  price: string;
  fee: string;
  feeCurrency: string;
  filledAt: string;
}

/** An order update from the private stream */
export interface PrivateStreamOrder {
  venueRefId: string;
  clientOrderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  status: string;
  quantity: string;
  filledQuantity: string;
  price?: string;
  avgFillPrice?: string;
  updatedAt: string;
}

/** A position update from the private stream */
export interface PrivateStreamPosition {
  symbol: string;
  side: 'long' | 'short' | 'flat';
  size: string;
  entryPrice: string;
  unrealizedPnl?: string;
  leverage?: number;
}

/** Ticker from public stream */
export interface StreamTicker {
  symbol: string;
  last: string;
  bid?: string;
  ask?: string;
  timestamp: string;
}

/** Orderbook snapshot from public stream */
export interface StreamOrderbook {
  symbol: string;
  bids: Array<{ price: string; quantity: string }>;
  asks: Array<{ price: string; quantity: string }>;
  timestamp: string;
}

/** A trade print from public stream */
export interface StreamTrade {
  symbol: string;
  side: 'buy' | 'sell';
  price: string;
  quantity: string;
  timestamp: string;
}
