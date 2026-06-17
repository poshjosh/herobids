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
  /** Whether the plan itself had zero orders (e.g. a hold or go_flat while already flat).
   *  Distinct from no_orders_submitted (plan had orders but none were submitted to venue). */
  noOrdersPlanned: boolean;
}

export interface LiveRecoveryFillEvidence {
  hasFills: boolean;
  matchedFillCount: number;
  hasLookupFilledOrders: boolean;
  hasLocalFilledOrders: boolean;
}

export type LiveRecoveryReason =
  | 'open_orders_present'
  | 'fills_confirmed'
  | 'all_orders_terminal_non_filled'
  | 'prepared_not_submitted'
  | 'non_terminal_without_evidence'
  | 'submit_attempting_without_proof_of_absence'
  | 'venue_lookup_ambiguous'
  | 'no_orders_submitted'
  | 'no_orders_planned';

export interface LiveRecoveryTerminalState {
  status: string;
  count: number;
}

export type LiveRecoveryDecision = {
  kind: 'keep_executing' | 'mark_completed' | 'mark_failed' | 'halt_ambiguous';
  reason: LiveRecoveryReason;
  /** When kind is keep_executing due to open orders, but fills are also present. */
  fillEvidence?: LiveRecoveryFillEvidence;
  /** When reason is all_orders_terminal_non_filled, breaks down the terminal statuses present.
   *  Allows callers to distinguish 'replaced' (in-progress via replacement) from 'cancelled'/'rejected' (nothing achieved). */
  terminalStatuses?: LiveRecoveryTerminalState[];
};

function isOpenStatus(status: string): boolean {
  return status === 'open' || status === 'partial' || status === 'pending';
}

/**
 * Terminal-status check that accepts any string — unknown values safely return false.
 * Avoids the unsafe OrderStatus cast while retaining the same semantics:
 * only 'filled', 'cancelled', 'expired', 'replaced', and 'rejected' are treated as terminal.
 */
function isTerminalString(status: string): boolean {
  return status === 'filled' || status === 'cancelled' || status === 'expired' || status === 'replaced' || status === 'rejected';
}

export function evaluateOrderbookRecovery(input: EvaluateOrderbookRecoveryInput): LiveRecoveryDecision {
  const { orders, hasOpenOrders, matchedFillCount, matchedOrdersFromLookup, lookupAmbiguous } = input;

  if (orders.length === 0) {
    return {
      kind: 'mark_failed',
      reason: input.noOrdersPlanned ? 'no_orders_planned' : 'no_orders_submitted',
    };
  }

  // Compute fill evidence upfront so the caller can observe fills
  // even when keep_executing is the primary decision (e.g., some orders
  // are still resting while others have already filled).
  const hasLookupFilledOrders = matchedOrdersFromLookup.some((order) => order.status === 'filled');
  const hasLocalFilledOrders = orders.some((order) => order.status === 'filled');
  const fillEvidence: LiveRecoveryFillEvidence | undefined =
    (matchedFillCount > 0 || hasLookupFilledOrders || hasLocalFilledOrders)
      ? { hasFills: true, matchedFillCount, hasLookupFilledOrders, hasLocalFilledOrders }
      : undefined;

  const hasLookupOpenOrders = matchedOrdersFromLookup.some((order) => isOpenStatus(order.status));
  if (hasOpenOrders || hasLookupOpenOrders) {
    return { kind: 'keep_executing', reason: 'open_orders_present', fillEvidence };
  }

  if (fillEvidence) {
    return { kind: 'mark_completed', reason: 'fills_confirmed' };
  }

  if (lookupAmbiguous) {
    return { kind: 'halt_ambiguous', reason: 'venue_lookup_ambiguous' };
  }

  // Filled orders are terminal-positive (fills confirmed), while cancelled/expired/replaced/rejected
  // are terminal-non-filled (the plan did not achieve its objective).
  // Build a status breakdown so callers can distinguish 'replaced' (in-progress via replacement)
  // from 'cancelled'/'rejected' (nothing achieved).
  const terminalNonFilledStatuses = ['cancelled', 'expired', 'replaced', 'rejected'] as const;
  const terminalStatuses: LiveRecoveryTerminalState[] = [];
  let allOrdersTerminalNonFilled = true;
  for (const order of orders) {
    if (terminalNonFilledStatuses.includes(order.status as typeof terminalNonFilledStatuses[number])) {
      const existing = terminalStatuses.find((s) => s.status === order.status);
      if (existing) { existing.count++; } else { terminalStatuses.push({ status: order.status, count: 1 }); }
    } else {
      allOrdersTerminalNonFilled = false;
    }
  }
  if (allOrdersTerminalNonFilled) {
    return { kind: 'mark_failed', reason: 'all_orders_terminal_non_filled', terminalStatuses, fillEvidence };
  }

  const hasPreparedOnly = orders.some((order) => {
    if (order.submissionState === 'prepared') return true;
    return order.status === 'pending' && !order.submissionState && !order.venueRefId && !order.clientOrderId;
  });
  if (hasPreparedOnly) {
    return { kind: 'mark_failed', reason: 'prepared_not_submitted', fillEvidence };
  }

  const hasSubmitAttemptingOrder = orders.some((order) => order.submissionState === 'submit_attempting');
  if (hasSubmitAttemptingOrder) {
    return { kind: 'halt_ambiguous', reason: 'submit_attempting_without_proof_of_absence', fillEvidence };
  }

  const hasNonTerminalOrder = orders.some((order) => !isTerminalString(order.status));
  if (hasNonTerminalOrder) {
    return { kind: 'halt_ambiguous', reason: 'non_terminal_without_evidence', fillEvidence };
  }

  return { kind: 'mark_failed', reason: 'all_orders_terminal_non_filled', terminalStatuses, fillEvidence };
}
