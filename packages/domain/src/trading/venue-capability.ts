import type { Result } from '../result.js';
import { ok, err } from '../result.js';

// ── Time-in-force variants ────────────────────────────────────────────────

export type TimeInForce = 'GTC' | 'IOC' | 'FOK' | 'PO';

// ── Venue capability descriptor ───────────────────────────────────────────

/**
 * Describes what advanced limit-order semantics a venue supports.
 * Each adapter must declare its capabilities explicitly.
 * The engine gates advanced behavior on these flags.
 */
export interface VenueCapabilities {
  /** The venue can submit limit orders (basic). */
  limitOrderSubmission: boolean;

  /** The venue supports amend-in-place (modify price/size of a resting order). */
  amendInPlace: boolean;

  /** The venue supports cancel-and-replace (cancel old order, place new one atomically). */
  cancelAndReplace: boolean;

  /** The venue supports post-only limit orders (never take liquidity). */
  postOnly: boolean;

  /** The venue supports reduce-only orders (only reduce position, never increase). */
  reduceOnly: boolean;

  /** The set of time-in-force variants the venue supports. */
  supportedTimeInForce: TimeInForce[];

  /** Whether the venue supports client order IDs for idempotency. */
  supportsClientOrderId: boolean;

  /** Whether the venue can look up an order by client order ID. */
  supportsLookupByClientOrderId: boolean;

  /** Whether the venue can look up an order by its venue reference ID. */
  supportsLookupByVenueRefId: boolean;
}

// ── Capability error codes ────────────────────────────────────────────────

export type VenueCapabilityErrorCode =
  | 'capability.limit_order_not_supported'
  | 'capability.amend_not_supported'
  | 'capability.cancel_replace_not_supported'
  | 'capability.post_only_not_supported'
  | 'capability.reduce_only_not_supported'
  | 'capability.time_in_force_not_supported';

export interface VenueCapabilityError {
  code: VenueCapabilityErrorCode;
  message: string;
}

// ── Capability check helpers ──────────────────────────────────────────────

/**
 * Validate that a venue supports a requested time-in-force value.
 * Returns ok(undefined) if supported, err otherwise.
 */
export function validateTimeInForce(
  capabilities: VenueCapabilities,
  requestedTif: TimeInForce,
): Result<void, VenueCapabilityError> {
  if (!capabilities.supportedTimeInForce.includes(requestedTif)) {
    return err({
      code: 'capability.time_in_force_not_supported',
      message: `Venue does not support time-in-force: ${requestedTif}`,
    });
  }
  return ok(undefined);
}

/**
 * Validate that amend-in-place is supported.
 */
export function validateAmendInPlace(
  capabilities: VenueCapabilities,
): Result<void, VenueCapabilityError> {
  if (!capabilities.amendInPlace) {
    return err({
      code: 'capability.amend_not_supported',
      message: 'Venue does not support amend-in-place',
    });
  }
  return ok(undefined);
}

/**
 * Validate that cancel-and-replace is supported.
 */
export function validateCancelAndReplace(
  capabilities: VenueCapabilities,
): Result<void, VenueCapabilityError> {
  if (!capabilities.cancelAndReplace) {
    return err({
      code: 'capability.cancel_replace_not_supported',
      message: 'Venue does not support cancel-and-replace',
    });
  }
  return ok(undefined);
}

/**
 * Validate that post-only is supported.
 */
export function validatePostOnly(
  capabilities: VenueCapabilities,
): Result<void, VenueCapabilityError> {
  if (!capabilities.postOnly) {
    return err({
      code: 'capability.post_only_not_supported',
      message: 'Venue does not support post-only orders',
    });
  }
  return ok(undefined);
}

/**
 * Validate that reduce-only is supported.
 */
export function validateReduceOnly(
  capabilities: VenueCapabilities,
): Result<void, VenueCapabilityError> {
  if (!capabilities.reduceOnly) {
    return err({
      code: 'capability.reduce_only_not_supported',
      message: 'Venue does not support reduce-only orders',
    });
  }
  return ok(undefined);
}

// ── Composite validator ───────────────────────────────────────────────────

export interface OrderAttributeFlags {
  timeInForce?: TimeInForce;
  postOnly?: boolean;
  reduceOnly?: boolean;
}

/**
 * Validate all requested limit-order attributes against venue capabilities in a single pass.
 * Returns the first capability error encountered, or ok(undefined) if all pass.
 * Only validates attributes that are explicitly set (truthy) — undefined/falsy attributes are skipped.
 */
export function validateOrderAttributes(
  capabilities: VenueCapabilities,
  flags: OrderAttributeFlags,
): Result<void, VenueCapabilityError> {
  if (flags.timeInForce) {
    const result = validateTimeInForce(capabilities, flags.timeInForce);
    if (!result.ok) return result;
  }
  if (flags.postOnly) {
    const result = validatePostOnly(capabilities);
    if (!result.ok) return result;
  }
  if (flags.reduceOnly) {
    const result = validateReduceOnly(capabilities);
    if (!result.ok) return result;
  }
  return ok(undefined);
}
