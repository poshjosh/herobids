import type { Result, DomainError } from '../result.js';
import type { OrderId } from '../values/ids.js';
import type { Price, Quantity } from '../values/money.js';
import type { OrderSide, OrderType, OrderStatus } from '../enums.js';
import type { Subscription, PrivateStreamHandlers, PublicStreamHandlers } from './subscription.js';
import type { VenueCapabilities, TimeInForce } from '../trading/venue-capability.js';

/** Venue-specific error */
export interface VenueError extends DomainError {
  /** e.g. "venue.timeout", "venue.rate_limited", "venue.order_rejected" */
  code: string;
}

/** Command to submit an order */
export interface OrderCommand {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: Quantity;
  price?: Price;
  /** Client-generated ID for idempotency */
  clientOrderId?: string;
  /** Time-in-force for limit orders (default: GTC). */
  timeInForce?: TimeInForce;
  /** Whether the order should only post liquidity (maker-only). */
  postOnly?: boolean;
  /** Whether the order should only reduce position (never increase). */
  reduceOnly?: boolean;
}

/** Command to cancel an order */
export interface CancelCommand {
  orderId: OrderId;
  symbol: string;
}

/** Command to amend an existing order */
export interface AmendCommand {
  orderId: OrderId;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price?: Price;
  quantity?: Quantity;
}

/** Receipt from a submitted/amended order */
export interface OrderReceipt {
  orderId: OrderId;
  clientOrderId?: string;
  status: OrderStatus;
  /** Venue's own reference ID for reconciliation */
  venueRefId: string;
  timestamp: string;
}

/** A single asset balance */
export interface AssetBalance {
  asset: string;
  free: Quantity;
  locked: Quantity;
  total: Quantity;
}

/** Snapshot of all balances on a venue account */
export interface BalanceSnapshot {
  balances: AssetBalance[];
  timestamp: string;
}

/** A position on a venue */
export interface Position {
  symbol: string;
  side: 'long' | 'short' | 'flat';
  size: Quantity;
  entryPrice: Price;
  unrealizedPnl?: Price;
  leverage?: number;
}

/** Market ticker — latest price info for a symbol */
export interface Ticker {
  symbol: string;
  last: Price;
  bid?: Price;
  ask?: Price;
  timestamp: string;
}

/** An order as reported by the venue (used for reconciliation) */
export interface VenueOrder {
  venueRefId: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  quantity: Quantity;
  filledQuantity: Quantity;
  price?: Price;
  avgFillPrice?: Price;
  createdAt: string;
}

/** A fill/trade as reported by the venue (used for reconciliation) */
export interface VenueFill {
  venueRefId: string;
  orderId?: string;
  symbol: string;
  side: OrderSide;
  quantity: Quantity;
  price: Price;
  fee: Quantity;
  feeCurrency: string;
  filledAt: string;
}

/** Full market metadata for a tradeable instrument. Used for populating the instruments table. */
export interface MarketMetadata {
  symbol: string;    // ccxt unified symbol, e.g. "BTC/USD:USD"
  type: string;      // "swap", "spot", "future"
  base: string;      // e.g. "BTC"
  quote: string;     // e.g. "USD"
  tickSize: string;  // as decimal string
  lotSize: string;   // as decimal string
}

/**
 * Port interface for orderbook venues (CEX perps, spot exchanges).
 * Stateful order lifecycle: submit → amend → cancel.
 */
export interface OrderbookVenuePort {
  /** Declare which advanced order-management capabilities this venue supports. */
  getCapabilities(): VenueCapabilities;

  submitOrder(cmd: OrderCommand): Promise<Result<OrderReceipt, VenueError>>;
  cancelOrder(cmd: CancelCommand): Promise<Result<void, VenueError>>;
  amendOrder(cmd: AmendCommand): Promise<Result<OrderReceipt, VenueError>>;
  fetchPositions(): Promise<Result<Position[], VenueError>>;
  fetchBalances(): Promise<Result<BalanceSnapshot, VenueError>>;
  fetchTicker(symbol: string): Promise<Result<Ticker, VenueError>>;

  // --- Reconciliation methods (Phase 2a) ---

  /** Fetch all open (non-terminal) orders on the venue */
  fetchOpenOrders(): Promise<Result<VenueOrder[], VenueError>>;

  /**
   * Fetch a single order by venue reference ID when the venue supports it.
   * Returns null when the venue confirms the order is absent.
   */
  fetchOrderByVenueRefId?(venueRefId: string, symbol?: string): Promise<Result<VenueOrder | null, VenueError>>;

  /**
   * Fetch a single order by client order ID when the venue supports it.
   * Returns null when the venue confirms the order is absent.
   */
  fetchOrderByClientOrderId?(clientOrderId: string, symbol?: string): Promise<Result<VenueOrder | null, VenueError>>;

  /** Fetch recent fills/trades since a given timestamp */
  fetchRecentFills(since?: Date): Promise<Result<VenueFill[], VenueError>>;

  // --- Streaming methods (stubs in Phase 2a; real in 2b/2c) ---

  /** Subscribe to private (authenticated) fill/order/position stream */
  subscribePrivate(handlers: PrivateStreamHandlers): Promise<Result<Subscription, VenueError>>;

  /** Subscribe to public market data stream for given symbols */
  subscribePublic(symbols: string[], handlers: PublicStreamHandlers): Promise<Result<Subscription, VenueError>>;

  /** Fetch all tradeable symbols on this venue. Used for decision intake validation. */
  fetchAvailableSymbols?(): Promise<Result<string[], VenueError>>;

  /** Fetch full market metadata for all tradeable instruments. Used for populating the instruments table. */
  fetchMarketMetadata?(): Promise<Result<MarketMetadata[], VenueError>>;
}

// ---------------------------------------------------------------------------
// Venue auto-detection (Phase 3)
// ---------------------------------------------------------------------------

/** The result of probing a venue account credential. */
export interface VenueProfile {
  /** Venue identifier: 'hyperliquid', 'bybit', 'jupiter', etc. */
  venue: string;
  /** Type: 'orderbook' for CEX perps/spot, 'swap' for DEX swaps. */
  venueType: 'orderbook' | 'swap';
  /** Tradeable symbols/instruments discovered at probe time. */
  availableSymbols: string[];
  /** Supported execution modes based on credential type. */
  supportedExecutionModes: Array<'paper' | 'shadow' | 'live'>;
  /** Whether the probe was authenticated (real credentials vs. public endpoint). */
  authenticated: boolean;
  /** Probe timestamp */
  probedAt: string;
}

