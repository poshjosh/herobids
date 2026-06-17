import type { VenueCapabilities } from '@herobids/domain';

/** Full capability set — used as the default stub in test fixtures.
 *  Frozen to prevent accidental mutation when spread into test overrides. */
export const FULL_CAPABILITIES: VenueCapabilities = Object.freeze({
  limitOrderSubmission: true,
  amendInPlace: true,
  cancelAndReplace: true,
  postOnly: true,
  reduceOnly: true,
  supportedTimeInForce: ['GTC', 'IOC', 'FOK', 'PO'],
  supportsClientOrderId: true,
  supportsLookupByClientOrderId: true,
  supportsLookupByVenueRefId: true,
});
