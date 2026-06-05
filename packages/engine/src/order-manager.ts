import type { Result, DomainError } from '@herobids/domain';
import type { OrderId, FillId } from '@herobids/domain';
import type { Price, Quantity } from '@herobids/domain';
import type { OrderSide, OrderType } from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import { Decimal } from '@herobids/domain';
import type { ManagedOrder, FillEvent } from './order-state.js';
import { canTransition, isTerminal } from './order-state.js';

/** Error codes specific to the order manager */
export interface OrderManagerError extends DomainError {
  code:
    | 'engine.order_not_found'
    | 'engine.invalid_transition'
    | 'engine.order_terminal'
    | 'engine.overfill';
}

/** Parameters for creating a new order */
export interface CreateOrderParams {
  id: OrderId;
  venueAccountId: string;
  tradingInstanceId?: string;
  actorType: string;
  actorId: string;
  executionPlanId?: string;
  clientOrderId?: string;
  venue: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: Quantity;
  price?: Price;
}

/** Parameters for acknowledging an order from the venue */
export interface AcknowledgeParams {
  venueRefId: string;
}

/** Parameters for applying a fill */
export interface ApplyFillParams {
  fillId: FillId;
  venueRefId?: string;
  quantity: Quantity;
  price: Price;
  fee?: Quantity;
  feeCurrency?: string;
  filledAt: string;
}

/**
 * OrderManager — stateful tracker for orders within a trading instance.
 *
 * Responsibilities:
 * - Track orders through their lifecycle (pending → open → partial → filled / cancelled / rejected)
 * - Validate all transitions
 * - Compute cumulative fill quantity and average fill price
 * - Emit FillEvent objects for downstream consumers (position tracker, journal)
 *
 * One OrderManager per trading instance (actor).
 */
export class OrderManager {
  private readonly orders = new Map<OrderId, ManagedOrder>();

  /** Create a new order in pending state */
  create(params: CreateOrderParams): ManagedOrder {
    const now = new Date().toISOString();
    const order: ManagedOrder = {
      id: params.id,
      venueAccountId: params.venueAccountId,
      tradingInstanceId: params.tradingInstanceId,
      actorType: params.actorType,
      actorId: params.actorId,
      executionPlanId: params.executionPlanId,
      clientOrderId: params.clientOrderId,
      venue: params.venue,
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      quantity: params.quantity,
      price: params.price,
      status: 'pending',
      filledQuantity: new Decimal(0),
      avgFillPrice: undefined,
      venueRefId: undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.orders.set(order.id, order);
    return order;
  }

  /** Venue acknowledged the order — transition to open */
  acknowledge(orderId: OrderId, params: AcknowledgeParams): Result<ManagedOrder, OrderManagerError> {
    const order = this.orders.get(orderId);
    if (!order) {
      return err({ code: 'engine.order_not_found', message: `Order ${orderId} not found` });
    }
    if (!canTransition(order.status, 'open')) {
      return err({
        code: 'engine.invalid_transition',
        message: `Cannot transition order ${orderId} from ${order.status} to open`,
        context: { orderId, from: order.status, to: 'open' },
      });
    }
    order.status = 'open';
    order.venueRefId = params.venueRefId;
    order.updatedAt = new Date().toISOString();
    return ok(order);
  }

  /** Apply a fill to an order — transitions to partial or filled */
  applyFill(orderId: OrderId, params: ApplyFillParams): Result<{ order: ManagedOrder; fill: FillEvent }, OrderManagerError> {
    const order = this.orders.get(orderId);
    if (!order) {
      return err({ code: 'engine.order_not_found', message: `Order ${orderId} not found` });
    }
    if (isTerminal(order.status)) {
      return err({
        code: 'engine.order_terminal',
        message: `Order ${orderId} is in terminal state ${order.status}`,
        context: { orderId, status: order.status },
      });
    }

    const newFilledQty = order.filledQuantity.plus(params.quantity);
    if (newFilledQty.greaterThan(order.quantity)) {
      return err({
        code: 'engine.overfill',
        message: `Fill would exceed order quantity (${newFilledQty} > ${order.quantity})`,
        context: { orderId, orderQty: order.quantity.toString(), filledSoFar: order.filledQuantity.toString(), fillQty: params.quantity.toString() },
      });
    }

    // Compute new weighted average fill price
    const prevNotional = order.avgFillPrice
      ? order.avgFillPrice.times(order.filledQuantity)
      : new Decimal(0);
    const fillNotional = params.price.times(params.quantity);
    const totalNotional = prevNotional.plus(fillNotional);
    const newAvgPrice = totalNotional.dividedBy(newFilledQty);

    // Determine new status
    const isFull = newFilledQty.equals(order.quantity);
    const targetStatus = isFull ? 'filled' : 'partial';

    if (!canTransition(order.status, targetStatus)) {
      return err({
        code: 'engine.invalid_transition',
        message: `Cannot transition order ${orderId} from ${order.status} to ${targetStatus}`,
        context: { orderId, from: order.status, to: targetStatus },
      });
    }

    order.filledQuantity = newFilledQty;
    order.avgFillPrice = newAvgPrice;
    order.status = targetStatus;
    order.updatedAt = new Date().toISOString();

    const fill: FillEvent = {
      id: params.fillId,
      orderId: order.id,
      venueAccountId: order.venueAccountId,
      tradingInstanceId: order.tradingInstanceId,
      actorType: order.actorType,
      actorId: order.actorId,
      venueRefId: params.venueRefId,
      venue: order.venue,
      symbol: order.symbol,
      side: order.side,
      quantity: params.quantity,
      price: params.price,
      fee: params.fee,
      feeCurrency: params.feeCurrency,
      filledAt: params.filledAt,
    };

    return ok({ order, fill });
  }

  /** Cancel an order */
  cancel(orderId: OrderId): Result<ManagedOrder, OrderManagerError> {
    const order = this.orders.get(orderId);
    if (!order) {
      return err({ code: 'engine.order_not_found', message: `Order ${orderId} not found` });
    }
    if (!canTransition(order.status, 'cancelled')) {
      return err({
        code: 'engine.invalid_transition',
        message: `Cannot cancel order ${orderId} in state ${order.status}`,
        context: { orderId, from: order.status, to: 'cancelled' },
      });
    }
    order.status = 'cancelled';
    order.updatedAt = new Date().toISOString();
    return ok(order);
  }

  /** Reject an order (venue rejected it) */
  reject(orderId: OrderId, reason?: string): Result<ManagedOrder, OrderManagerError> {
    const order = this.orders.get(orderId);
    if (!order) {
      return err({ code: 'engine.order_not_found', message: `Order ${orderId} not found` });
    }
    if (!canTransition(order.status, 'rejected')) {
      return err({
        code: 'engine.invalid_transition',
        message: `Cannot reject order ${orderId} in state ${order.status}`,
        context: { orderId, from: order.status, to: 'rejected', reason },
      });
    }
    order.status = 'rejected';
    order.updatedAt = new Date().toISOString();
    return ok(order);
  }

  /** Get an order by ID */
  get(orderId: OrderId): ManagedOrder | undefined {
    return this.orders.get(orderId);
  }

  /** Get all orders for a plan */
  getByPlan(executionPlanId: string): ManagedOrder[] {
    return Array.from(this.orders.values()).filter((o) => o.executionPlanId === executionPlanId);
  }

  /** Get all active (non-terminal) orders */
  getActive(): ManagedOrder[] {
    return Array.from(this.orders.values()).filter((o) => !isTerminal(o.status));
  }

  /** Get all orders */
  getAll(): ManagedOrder[] {
    return Array.from(this.orders.values());
  }

  /** Remove terminal orders older than the given threshold (housekeeping) */
  prune(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    let pruned = 0;
    for (const [id, order] of this.orders) {
      if (isTerminal(order.status) && new Date(order.updatedAt).getTime() < cutoff) {
        this.orders.delete(id);
        pruned++;
      }
    }
    return pruned;
  }
}
