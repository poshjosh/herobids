import type { LiveSubmissionState } from './order-state.js';

export interface LiveRecoveryOrder {
  id: string;
  status: string;
  submissionState?: LiveSubmissionState | string | null;
  venueRefId?: string | null;
  clientOrderId?: string | null;
}

export interface LiveRecoveryMatchedOrder {
  venueRefId: string;
  status: string;
}

export interface EvaluateOrderbookRecoveryInput {
  orders: LiveRecoveryOrder[];
  hasOpenOrders: boolean;
  matchedFillCount: number;
  matchedOrdersFromLookup: LiveRecoveryMatchedOrder[];
  lookupAmbiguous: boolean;
}

export type LiveRecoveryDecision = {
  kind: 'keep_executing' | 'mark_completed' | 'mark_failed' | 'halt_ambiguous';
  reason:
    | 'open_orders_present'
    | 'fills_confirmed'
    | 'all_orders_cancelled_or_rejected'
    | 'prepared_not_submitted'
    | 'non_terminal_without_evidence'
    | 'submit_attempting_without_proof_of_absence'
    | 'venue_lookup_ambiguous'
    | 'no_orders_submitted';
};

function isTerminalStatus(status: string): boolean {
  return status === 'filled' || status === 'cancelled' || status === 'rejected';
}

function isOpenStatus(status: string): boolean {
  return status === 'open' || status === 'partial' || status === 'pending';
}

export function evaluateOrderbookRecovery(input: EvaluateOrderbookRecoveryInput): LiveRecoveryDecision {
  const { orders, hasOpenOrders, matchedFillCount, matchedOrdersFromLookup, lookupAmbiguous } = input;

  if (orders.length === 0) {
    return { kind: 'mark_failed', reason: 'no_orders_submitted' };
  }

  const hasLookupOpenOrders = matchedOrdersFromLookup.some((order) => isOpenStatus(order.status));
  if (hasOpenOrders || hasLookupOpenOrders) {
    return { kind: 'keep_executing', reason: 'open_orders_present' };
  }

  const hasLookupFilledOrders = matchedOrdersFromLookup.some((order) => order.status === 'filled');
  const hasLocalFilledOrders = orders.some((order) => order.status === 'filled');
  if (matchedFillCount > 0 || hasLookupFilledOrders || hasLocalFilledOrders) {
    return { kind: 'mark_completed', reason: 'fills_confirmed' };
  }

  if (lookupAmbiguous) {
    return { kind: 'halt_ambiguous', reason: 'venue_lookup_ambiguous' };
  }

  const allCancelledOrRejected = orders.every((order) => order.status === 'cancelled' || order.status === 'rejected');
  if (allCancelledOrRejected) {
    return { kind: 'mark_failed', reason: 'all_orders_cancelled_or_rejected' };
  }

  const hasPreparedOnly = orders.some((order) => {
    if (order.submissionState === 'prepared') return true;
    return order.status === 'pending' && !order.submissionState && !order.venueRefId && !order.clientOrderId;
  });
  if (hasPreparedOnly) {
    return { kind: 'mark_failed', reason: 'prepared_not_submitted' };
  }

  const hasSubmitAttemptingOrder = orders.some((order) => order.submissionState === 'submit_attempting');
  if (hasSubmitAttemptingOrder) {
    return { kind: 'halt_ambiguous', reason: 'submit_attempting_without_proof_of_absence' };
  }

  const hasNonTerminalOrder = orders.some((order) => !isTerminalStatus(order.status));
  if (hasNonTerminalOrder) {
    return { kind: 'halt_ambiguous', reason: 'non_terminal_without_evidence' };
  }

  return { kind: 'mark_failed', reason: 'all_orders_cancelled_or_rejected' };
}
