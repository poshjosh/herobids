import type { OrderId } from '@herobids/domain';
import type { OrderStatus } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import type { ManagedOrder, OrderTransition, FillEvent } from './order-state.js';
import { canTransition, isTerminal } from './order-state.js';

// ── Lifecycle event input types ───────────────────────────────────────────

export interface FillAppliedEvent {
  type: 'fill_applied';
  fill: FillEvent;
}

export interface CancelRequestedEvent {
  type: 'cancel_requested';
  reason: string;
  timestamp: string;
}

export interface ExpiryEvent {
  type: 'expired';
  reason: string;
  timestamp: string;
}

export interface ReplaceRequestedEvent {
  type: 'replace_requested';
  replacementOrderId: OrderId;
  reason: string;
  timestamp: string;
}

export type LifecycleEvent =
  | FillAppliedEvent
  | CancelRequestedEvent
  | ExpiryEvent
  | ReplaceRequestedEvent;

// ── Lifecycle result ──────────────────────────────────────────────────────

export interface LifecycleResult {
  order: ManagedOrder;
  /** Journal entries to emit for this transition. */
  journalEntries: Array<{
    actorType: string;
    actorId: string;
    type: string;
    payload: Record<string, unknown>;
  }>;
}

// ── Error types ───────────────────────────────────────────────────────────

export interface LifecycleError {
  code: string;
  message: string;
}

// ── Lifecycle Manager ─────────────────────────────────────────────────────

/**
 * OrderLifecycleManager centralizes open-order monitoring and terminal-state
 * transitions for live limit orders.
 *
 * It is a pure-ish module: it takes current state + an event, validates the
 * transition, and produces the new state + journal entries. The caller is
 * responsible for persistence.
 *
 * Returns `ok(result)` on successful or no-op transitions. Returns
 * `err(LifecycleError)` when the event type is unrecognised.
 */
export class OrderLifecycleManager {

  /**
   * Apply a lifecycle event to an order, producing the new state.
   * Returns `ok(result)` with the updated order and any journal entries.
   * Silently no-ops (returns the original order unchanged) when the order
   * is already in a terminal state or the transition is invalid.
   */
  applyEvent(order: ManagedOrder, event: LifecycleEvent): Result<LifecycleResult, LifecycleError> {
    switch (event.type) {
      case 'fill_applied':
        return ok(this.applyFill(order, event));
      case 'cancel_requested':
        return ok(this.applyCancel(order, event));
      case 'expired':
        return ok(this.applyExpiry(order, event));
      case 'replace_requested':
        return ok(this.applyReplace(order, event));
      default:
        return err({
          code: 'engine.invalid_lifecycle_event',
          message: `Unknown lifecycle event type: ${(event as { type: string }).type}`,
        });
    }
  }

  private applyFill(order: ManagedOrder, event: FillAppliedEvent): LifecycleResult {
    const { fill } = event;
    const newFilledQty = order.filledQuantity.plus(fill.quantity);

    // Compute new avg fill price
    const prevTotal = order.filledQuantity.times(order.avgFillPrice ?? fill.price);
    const newTotal = fill.quantity.times(fill.price);
    const newAvgPrice = prevTotal.plus(newTotal).div(newFilledQty);

    const fullyFilled = newFilledQty.gte(order.quantity);
    const newStatus: OrderStatus = fullyFilled ? 'filled' : 'partial';
    const now = new Date().toISOString();

    if (!canTransition(order.status, newStatus)) {
      // If we can't transition (e.g. already terminal), return unchanged
      console.warn(`[OrderLifecycleManager] applyFill skipped — cannot transition order ${order.id} from ${order.status} to ${newStatus}`);
      return { order, journalEntries: [] };
    }

    const transition: OrderTransition = {
      from: order.status,
      to: newStatus,
      reason: `fill ${fill.id}: ${fill.quantity.toString()} @ ${fill.price.toString()}`,
      timestamp: now,
      fillId: fill.id,
    };

    const updated: ManagedOrder = {
      ...order,
      status: newStatus,
      filledQuantity: newFilledQty,
      avgFillPrice: newAvgPrice,
      transitionHistory: [...(order.transitionHistory ?? []), transition],
      updatedAt: now,
    };

    const journalType = fullyFilled ? 'order.filled' : 'order.partial';

    return {
      order: updated,
      journalEntries: [
        {
          actorType: order.actorType,
          actorId: order.actorId,
          type: journalType,
          payload: {
            orderId: order.id,
            fillId: fill.id,
            venueRefId: fill.venueRefId,
            symbol: order.symbol,
            side: order.side,
            fillQuantity: fill.quantity.toString(),
            fillPrice: fill.price.toString(),
            filledQuantity: newFilledQty.toString(),
            avgFillPrice: newAvgPrice.toString(),
            status: newStatus,
            venue: order.venue,
          },
        },
      ],
    };
  }

  private applyCancel(order: ManagedOrder, event: CancelRequestedEvent): LifecycleResult {
    if (isTerminal(order.status)) {
      console.warn(`[OrderLifecycleManager] applyCancel skipped — order ${order.id} is already terminal (${order.status})`);
      return { order, journalEntries: [] };
    }

    if (!canTransition(order.status, 'cancelled')) {
      console.warn(`[OrderLifecycleManager] applyCancel skipped — invalid transition for order ${order.id} from ${order.status} to cancelled`);
      return { order, journalEntries: [] };
    }

    const transition: OrderTransition = {
      from: order.status,
      to: 'cancelled',
      reason: event.reason,
      timestamp: event.timestamp,
    };

    const updated: ManagedOrder = {
      ...order,
      status: 'cancelled',
      submissionState: 'terminal',
      transitionHistory: [...(order.transitionHistory ?? []), transition],
      updatedAt: event.timestamp,
    };

    return {
      order: updated,
      journalEntries: [
        {
          actorType: order.actorType,
          actorId: order.actorId,
          type: 'order.cancelled',
          payload: {
            orderId: order.id,
            venueRefId: order.venueRefId,
            symbol: order.symbol,
            reason: event.reason,
            previousStatus: transition.from,
            venue: order.venue,
          },
        },
      ],
    };
  }

  private applyExpiry(order: ManagedOrder, event: ExpiryEvent): LifecycleResult {
    if (isTerminal(order.status)) {
      console.warn(`[OrderLifecycleManager] applyExpiry skipped — order ${order.id} is already terminal (${order.status})`);
      return { order, journalEntries: [] };
    }

    if (!canTransition(order.status, 'expired')) {
      console.warn(`[OrderLifecycleManager] applyExpiry skipped — invalid transition for order ${order.id} from ${order.status} to expired`);
      return { order, journalEntries: [] };
    }

    const transition: OrderTransition = {
      from: order.status,
      to: 'expired',
      reason: event.reason,
      timestamp: event.timestamp,
    };

    const updated: ManagedOrder = {
      ...order,
      status: 'expired',
      submissionState: 'terminal',
      transitionHistory: [...(order.transitionHistory ?? []), transition],
      updatedAt: event.timestamp,
    };

    return {
      order: updated,
      journalEntries: [
        {
          actorType: order.actorType,
          actorId: order.actorId,
          type: 'order.expired',
          payload: {
            orderId: order.id,
            venueRefId: order.venueRefId,
            symbol: order.symbol,
            reason: event.reason,
            previousStatus: transition.from,
            venue: order.venue,
          },
        },
      ],
    };
  }

  private applyReplace(order: ManagedOrder, event: ReplaceRequestedEvent): LifecycleResult {
    if (isTerminal(order.status)) {
      console.warn(`[OrderLifecycleManager] applyReplace skipped — order ${order.id} is already terminal (${order.status})`);
      return { order, journalEntries: [] };
    }

    if (!canTransition(order.status, 'replaced')) {
      console.warn(`[OrderLifecycleManager] applyReplace skipped — invalid transition for order ${order.id} from ${order.status} to replaced`);
      return { order, journalEntries: [] };
    }

    const transition: OrderTransition = {
      from: order.status,
      to: 'replaced',
      reason: event.reason,
      timestamp: event.timestamp,
      replacementOrderId: event.replacementOrderId,
    };

    const updated: ManagedOrder = {
      ...order,
      status: 'replaced',
      submissionState: 'terminal',
      transitionHistory: [...(order.transitionHistory ?? []), transition],
      updatedAt: event.timestamp,
    };

    return {
      order: updated,
      journalEntries: [
        {
          actorType: order.actorType,
          actorId: order.actorId,
          type: 'order.replaced',
          payload: {
            orderId: order.id,
            replacementOrderId: event.replacementOrderId,
            venueRefId: order.venueRefId,
            symbol: order.symbol,
            reason: event.reason,
            previousStatus: transition.from,
            venue: order.venue,
          },
        },
      ],
    };
  }
}
