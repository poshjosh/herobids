import type { Result, DomainError } from '../result.js';
import type { OrderId } from '../values/ids.js';
import type { Price, Quantity } from '../values/money.js';
import type { OrderSide, OrderType, OrderStatus } from '../enums.js';

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

/**
 * Port interface for orderbook venues (CEX perps, spot exchanges).
 * Stateful order lifecycle: submit → amend → cancel.
 */
export interface OrderbookVenuePort {
  submitOrder(cmd: OrderCommand): Promise<Result<OrderReceipt, VenueError>>;
  cancelOrder(cmd: CancelCommand): Promise<Result<void, VenueError>>;
  amendOrder(cmd: AmendCommand): Promise<Result<OrderReceipt, VenueError>>;
  fetchPositions(): Promise<Result<Position[], VenueError>>;
  fetchBalances(): Promise<Result<BalanceSnapshot, VenueError>>;
  fetchTicker(symbol: string): Promise<Result<Ticker, VenueError>>;
}
