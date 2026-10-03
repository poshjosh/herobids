// Stable `requestId` derivation for keyed (write) invocations (Phase 3 T0.6, D18).
//
// The boundary's idempotency store keys on (consumerId, ownerId, toolName,
// idempotencyKey) and its status endpoint looks invocations up by `requestId`.
// Deriving the `requestId` from that same four-tuple means every re-issue of one
// logical write carries the same `requestId` with zero extra state, so an unknown
// outcome stays reconcilable from the persisted key alone.

import { createHash } from 'node:crypto';

/**
 * Fixed namespace for invocation requestIds (RFC 4122 §4.3), minted once.
 *
 * DO NOT CHANGE — changing it remints every derived requestId, so an in-flight
 * write could no longer be reconciled through the status endpoint.
 */
const INVOCATION_REQUEST_ID_NAMESPACE = '331aee8f-debd-495a-8643-22dac35ada63';

export interface RequestIdKey {
  consumerId: string;
  ownerId: string;
  toolName: string;
  idempotencyKey: string;
}

/**
 * Derive the `requestId` for a keyed invocation as an RFC 4122 v5 UUID over the
 * boundary's idempotency four-tuple. Owner/tool scoping keeps a caller-supplied
 * key (e.g. a messageId) from colliding with another owner's or tool's requestId
 * on the (non-owner-scoped) status lookup.
 */
export function deriveRequestId(key: RequestIdKey): string {
  // JSON array encoding is injective: field boundaries cannot shift between parts.
  const name = JSON.stringify([key.consumerId, key.ownerId, key.toolName, key.idempotencyKey]);
  return uuidV5(name, INVOCATION_REQUEST_ID_NAMESPACE);
}

/** RFC 4122 §4.3 name-based UUID (version 5, SHA-1). */
function uuidV5(name: string, namespace: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(Buffer.from(name, 'utf-8'))
    .digest();

  const bytes = hash.subarray(0, 16);
  // Version 5: high nibble of byte 6 = 0b0101.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  // Variant RFC 4122: high bits of byte 8 = 0b10.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
