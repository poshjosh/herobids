import type { Decision } from '@herobids/domain';
import type { ExecutionPlan } from './planner.js';
import type { ManagedOrder, FillEvent } from './order-state.js';
import type { RiskError } from './risk-gate.js';

/**
 * Journal event types — every significant system event.
 */
export type JournalEventType =
  | 'decision.created'
  | 'plan.created'
  | 'plan.completed'
  | 'plan.failed'
  | 'order.submitted'
  | 'order.filled'
  | 'order.partial'
  | 'order.cancelled'
  | 'order.rejected'
  | 'fill.recorded'
  | 'fill.private_stream'
  | 'order.private_stream'
  | 'risk.rejected'
  | 'instance.started'
  | 'instance.stopped'
  | 'instance.crashed'
  | 'reconciliation.match'
  | 'reconciliation.drift_detected'
  | 'reconciliation.drift_within_threshold'
  | 'reconciliation.correction';

export interface JournalEntry {
  id: string;
  tradingInstanceId?: string;
  type: JournalEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * Journal port — append-only event sink.
 * Implementations can write to DB, stdout, or both.
 */
export interface Journal {
  append(entry: Omit<JournalEntry, 'id' | 'createdAt'>): Promise<void>;
  appendBatch(entries: Omit<JournalEntry, 'id' | 'createdAt'>[]): Promise<void>;
}

/** Helper: create a journal entry for a decision */
export function decisionEvent(decision: Decision): Omit<JournalEntry, 'id' | 'createdAt'> {
  return {
    tradingInstanceId: decision.tradingInstanceId,
    type: 'decision.created',
    payload: {
      decisionId: decision.id,
      instrumentId: decision.instrumentId,
      intent: decision.intent,
      targetSize: decision.targetSize.toString(),
      limitPrice: decision.limitPrice?.toString(),
      contextHash: decision.contextHash,
    },
  };
}

/** Helper: create a journal entry for a plan */
export function planEvent(plan: ExecutionPlan, type: 'plan.created' | 'plan.completed' | 'plan.failed'): Omit<JournalEntry, 'id' | 'createdAt'> {
  return {
    tradingInstanceId: plan.tradingInstanceId,
    type,
    payload: {
      planId: plan.id,
      decisionId: plan.decisionId,
      action: plan.action,
      orderCount: plan.orders.length,
      venue: plan.venue,
      symbol: plan.symbol,
    },
  };
}

/** Helper: create a journal entry for an order status change */
export function orderEvent(order: ManagedOrder): Omit<JournalEntry, 'id' | 'createdAt'> {
  const typeMap: Record<string, JournalEventType> = {
    filled: 'order.filled',
    partial: 'order.partial',
    cancelled: 'order.cancelled',
    rejected: 'order.rejected',
  };
  return {
    tradingInstanceId: order.tradingInstanceId,
    type: typeMap[order.status] ?? 'order.submitted',
    payload: {
      orderId: order.id,
      venueRefId: order.venueRefId,
      side: order.side,
      type: order.type,
      quantity: order.quantity.toString(),
      price: order.price?.toString(),
      status: order.status,
      filledQuantity: order.filledQuantity.toString(),
    },
  };
}

/** Helper: create a journal entry for a fill */
export function fillEvent(fill: FillEvent): Omit<JournalEntry, 'id' | 'createdAt'> {
  return {
    tradingInstanceId: fill.tradingInstanceId,
    type: 'fill.recorded',
    payload: {
      fillId: fill.id,
      orderId: fill.orderId,
      side: fill.side,
      quantity: fill.quantity.toString(),
      price: fill.price.toString(),
      fee: fill.fee?.toString(),
      feeCurrency: fill.feeCurrency,
      filledAt: fill.filledAt,
    },
  };
}

/** Helper: create a journal entry for a risk rejection */
export function riskEvent(tradingInstanceId: string, error: RiskError): Omit<JournalEntry, 'id' | 'createdAt'> {
  return {
    tradingInstanceId,
    type: 'risk.rejected',
    payload: {
      code: error.code,
      message: error.message,
      context: error.context,
    },
  };
}
