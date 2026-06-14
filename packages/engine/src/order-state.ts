import type { OrderId, FillId } from '@herobids/domain';
import type { OrderSide, OrderType, OrderStatus } from '@herobids/domain';
import type { Price, Quantity } from '@herobids/domain';

export type LiveSubmissionState = 'prepared' | 'submit_attempting' | 'venue_acknowledged' | 'terminal';

/**
 * Order state machine — tracks a single order through its lifecycle.
 * Transitions: pending → open → partial → filled / cancelled / rejected
 */
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
  /** Decision-time mark used for execution-quality checks. */
  referencePrice?: Price;
  status: OrderStatus;
  /** Durable live submission lifecycle phase (orderbook live only). */
  submissionState?: LiveSubmissionState;
  /** Timestamp when venue submit was attempted. */
  submitAttemptedAt?: string;
  /** Timestamp when venue ack was persisted. */
  acknowledgedAt?: string;
  filledQuantity: Quantity;
  avgFillPrice?: Price;
  createdAt: string;
  updatedAt: string;
}

/** Valid status transitions */
const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['open', 'filled', 'cancelled', 'rejected'],
  open: ['partial', 'filled', 'cancelled'],
  partial: ['partial', 'filled', 'cancelled'],
  filled: [],
  cancelled: [],
  rejected: [],
};

/** Returns true if the transition is valid */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/** Terminal states — order can no longer change */
export function isTerminal(status: OrderStatus): boolean {
  return status === 'filled' || status === 'cancelled' || status === 'rejected';
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
