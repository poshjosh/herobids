import type { OrderId, FillId } from '@herobids/domain';
import type { OrderSide, OrderType, OrderStatus } from '@herobids/domain';
import type { Price, Quantity } from '@herobids/domain';
import type { TimeInForce } from '@herobids/domain';

export type LiveSubmissionState = 'prepared' | 'submit_attempting' | 'venue_acknowledged' | 'terminal';

/**
 * Order state machine — tracks a single order through its lifecycle.
 * Transitions: pending → open → partial → filled / cancelled / expired / rejected
 *              open → replaced (cancel-and-replace or amend lineage)
 */

/** Metadata recorded for each status transition in the order lifecycle. */
export interface OrderTransition {
  from: OrderStatus;
  to: OrderStatus;
  reason: string;
  timestamp: string;
  /** Optional fill event that triggered this transition (for partial/filled). */
  fillId?: FillId;
  /** Optional replacement order ID (for replaced transitions). */
  replacementOrderId?: OrderId;
}

export interface ManagedOrder {
  id: OrderId;
  venueAccountId: string;
  botId?: string;
  actorType: string;
  actorId: string;
  executionPlanId?: string;
  venueRefId?: string;
  clientOrderId?: string;
  venue: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: Quantity;
  price?: Price;
  /** Time-in-force for limit orders. */
  timeInForce?: TimeInForce;
  /** Whether the order is post-only (maker-only). */
  postOnly?: boolean;
  /** Whether the order is reduce-only (never increase position). */
  reduceOnly?: boolean;
  /** Decision-time mark used for execution-quality checks. */
  referencePrice?: Price;
  status: OrderStatus;
  /** Durable live submission lifecycle phase (orderbook live only). */
  submissionState?: LiveSubmissionState;
  /** Timestamp when venue submit was attempted. */
  submitAttemptedAt?: string;
  /** Timestamp when venue ack was persisted. */
  acknowledgedAt?: string;
  /** Ordered list of status transitions for audit and recovery. */
  transitionHistory?: OrderTransition[];
  /** Set to true when transitionHistory has been capped (pathological amend/replace loop). */
  transitionHistoryCapped?: boolean;
  filledQuantity: Quantity;
  avgFillPrice?: Price;
  createdAt: string;
  updatedAt: string;
}

/** Valid status transitions */
const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['open', 'filled', 'cancelled', 'expired', 'rejected'],
  open: ['partial', 'filled', 'cancelled', 'expired', 'replaced'],
  partial: ['partial', 'filled', 'cancelled', 'expired', 'replaced'],
  filled: [],
  cancelled: [],
  expired: [],
  replaced: [],
  rejected: [],
};

/** Returns true if the transition is valid */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/** Terminal states — order can no longer change */
export function isTerminal(status: OrderStatus): boolean {
  return status === 'filled' || status === 'cancelled' || status === 'expired' || status === 'replaced' || status === 'rejected';
}

/** A fill event received from the venue or paper executor */
export interface FillEvent {
  id: FillId;
  orderId: OrderId;
  venueAccountId: string;
  botId?: string;
  actorType: string;
  actorId: string;
  venueRefId?: string;
  venue: string;
  symbol: string;
  side: OrderSide;
  quantity: Quantity;
  price: Price;
  fee?: Quantity;
  feeCurrency?: string;
  filledAt: string;
}
