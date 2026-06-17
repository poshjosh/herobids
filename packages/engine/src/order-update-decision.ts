import type { VenueCapabilities, TimeInForce } from '@herobids/domain';
import type { Price, Quantity } from '@herobids/domain';
import type { OrderId } from '@herobids/domain';

// ── Order update request ─────────────────────────────────────────────────

export interface OrderUpdateRequest {
  orderId: OrderId;
  venueRefId: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'limit';
  newPrice?: Price;
  newQuantity?: Quantity;
  timeInForce?: TimeInForce;
  postOnly?: boolean;
  reduceOnly?: boolean;
  reason: string;
}

// ── Decision result ──────────────────────────────────────────────────────

export type OrderUpdateAction =
  | { kind: 'amend_in_place'; orderId: OrderId; venueRefId: string; symbol: string; price?: Price; quantity?: Quantity }
  | { kind: 'cancel_and_replace'; cancelOrderId: OrderId; venueRefId: string; symbol: string; replacement: OrderUpdateRequest }
  | { kind: 'reject_unsupported'; orderId: OrderId; reason: string };

// ── Decision function ────────────────────────────────────────────────────

/**
 * Decide whether to amend-in-place or cancel-and-replace for an order update,
 * based on the venue's declared capabilities.
 *
 * Strategy:
 * - If the venue supports amend-in-place → use it (lowest latency, no gap).
 * - Else if the venue supports cancel-and-replace → fall back.
 * - Otherwise → reject as unsupported.
 *
 * Pure function — no side effects.
 */
export function decideOrderUpdateAction(
  request: OrderUpdateRequest,
  capabilities: VenueCapabilities,
): OrderUpdateAction {
  if (!capabilities.limitOrderSubmission) {
    return {
      kind: 'reject_unsupported',
      orderId: request.orderId,
      reason: 'Venue does not support limit orders',
    };
  }

  // Check if any advanced attribute is unsupported
  if (request.postOnly && !capabilities.postOnly) {
    return {
      kind: 'reject_unsupported',
      orderId: request.orderId,
      reason: 'Venue does not support post-only orders',
    };
  }

  if (request.reduceOnly && !capabilities.reduceOnly) {
    return {
      kind: 'reject_unsupported',
      orderId: request.orderId,
      reason: 'Venue does not support reduce-only orders',
    };
  }

  if (request.timeInForce && !capabilities.supportedTimeInForce.includes(request.timeInForce)) {
    return {
      kind: 'reject_unsupported',
      orderId: request.orderId,
      reason: `Venue does not support time-in-force: ${request.timeInForce}`,
    };
  }

  // Prefer amend-in-place
  if (capabilities.amendInPlace) {
    return {
      kind: 'amend_in_place',
      orderId: request.orderId,
      venueRefId: request.venueRefId,
      symbol: request.symbol,
      price: request.newPrice,
      quantity: request.newQuantity,
    };
  }

  // Fall back to cancel-and-replace
  if (capabilities.cancelAndReplace) {
    return {
      kind: 'cancel_and_replace',
      cancelOrderId: request.orderId,
      venueRefId: request.venueRefId,
      symbol: request.symbol,
      replacement: request,
    };
  }

  // Neither amend nor cancel-and-replace supported
  return {
    kind: 'reject_unsupported',
    orderId: request.orderId,
    reason: 'Venue supports neither amend-in-place nor cancel-and-replace',
  };
}
