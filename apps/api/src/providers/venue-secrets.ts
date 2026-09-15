// Venue-secret canonicalization + validation helpers.
//
// Relocated from the deleted `routes/credentials.ts` (c4.3 — the standalone
// /credentials flow was removed entirely, Q4). These are provider-secret
// validation UTILITIES, not part of the credential CRUD route; they are consumed
// by the surviving guided setup flow (routes/setup.ts) to canonicalize + validate
// venue secrets before provisioning a trading link over the boundary. Copied
// verbatim (no behaviour change) — only the home module changed.

import { findProviderRegistryEntry } from './registry.js';
import { canonicalizeProviderSecrets, validateProviderSecrets, type ProviderValidationError } from './validator.js';

export interface SecretValidationError {
  field: string;
  code: string;
  message: string;
  params?: Record<string, unknown>;
}

export function canonicalizeVenueSecrets(venue: string, secrets: Record<string, string>): Record<string, string> {
  return canonicalizeProviderSecrets(venue, secrets, findProviderRegistryEntry(venue));
}

/** Venue-specific validation of credential secrets. Returns empty array if valid. */
export function validateVenueSecrets(venue: string, secrets: Record<string, string>): SecretValidationError[] {
  return validateProviderSecrets(venue, secrets, findProviderRegistryEntry(venue)) as ProviderValidationError[];
}
