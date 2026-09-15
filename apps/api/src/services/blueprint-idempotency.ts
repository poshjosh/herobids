import { createHash } from 'node:crypto';

/**
 * Fixed namespace UUID for deriving instantiation actor ids.
 *
 * A random-but-CONSTANT v4 UUID reserved for the `instantiate` operation. It
 * makes `deriveInstantiateActorId` a true RFC 4122 §4.3 name-based (v5) UUID:
 * the same (userId, idempotencyKey) always maps to the same actorId, and the
 * namespace prevents collisions with any other name-based UUID scheme.
 *
 * DO NOT CHANGE — changing it would remint every actorId, breaking idempotent
 * convergence for keys minted under the old namespace.
 */
const INSTANTIATE_ACTOR_NAMESPACE = 'a3f1c2d4-5e6b-4a7c-8d9e-0f1a2b3c4d5e';

/**
 * Derive a STABLE bot/agent actor id from (userId, idempotencyKey).
 *
 * The blueprint-instantiate BOT branch sends `actorId` over the Traderton
 * boundary, and the boundary's request fingerprint hashes the FULL payload
 * (actorId included). A fresh random actorId per HTTP request would give a
 * different fingerprint on every retry — so a crash-retry (boundary succeeded,
 * local commit failed) or a concurrent same-key duplicate would hit the
 * boundary's four-tuple dedup as a CONFLICT instead of replaying the stored
 * `{botId}`. Deriving actorId deterministically from the same (userId, key)
 * herobids advisory-locks on makes the boundary payload stable, so retries
 * replay and concurrent duplicates collapse (docs/003 atomicity-split entry +
 * docs/001: "both sides agree on the caller-supplied actorId; a retry
 * converges").
 *
 * Implemented as an RFC 4122 v5 (name-based, SHA-1) UUID under a fixed
 * namespace. `uuid` is not a dependency (package.json), so this uses the
 * standard-library `node:crypto` SHA-1 primitive rather than adding one. The
 * result is always a syntactically valid UUID (required for the bots.id column).
 */
export function deriveInstantiateActorId(userId: string, idempotencyKey: string): string {
  // Length-prefix the userId so the (userId, idempotencyKey) pair maps to the
  // name UNAMBIGUOUSLY: a bare `${userId}:${key}` join would let ("a", "b:c")
  // and ("a:b", "c") collide (both → "a:b:c"). Prefixing with the userId's
  // byte length makes the encoding injective regardless of colons in either part.
  const userIdBytes = Buffer.byteLength(userId, 'utf-8');
  const name = `${userIdBytes}:${userId}:${idempotencyKey}`;
  return uuidV5(name, INSTANTIATE_ACTOR_NAMESPACE);
}

/**
 * RFC 4122 §4.3 name-based UUID (version 5, SHA-1). Hashes the 16 namespace
 * bytes followed by the UTF-8 name, then stamps the version (5) and variant
 * (RFC 4122) bits.
 */
function uuidV5(name: string, namespace: string): string {
  const nsBytes = uuidToBytes(namespace);
  const nameBytes = Buffer.from(name, 'utf-8');
  const hash = createHash('sha1')
    .update(nsBytes)
    .update(nameBytes)
    .digest();

  const bytes = hash.subarray(0, 16);
  // Version 5: high nibble of byte 6 = 0b0101.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  // Variant RFC 4122: high bits of byte 8 = 0b10.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Parse a canonical UUID string into its 16 raw bytes. */
function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/**
 * Compute a deterministic SHA-256 hash of an instantiation request for
 * idempotency comparison. The same user + idempotencyKey + identical
 * request payload must produce the same hash.
 *
 * Rules:
 * - Object keys are recursively sorted
 * - Arrays preserve order EXCEPT binding-ID sets which are deduplicated + sorted
 * - Numbers and strings are normalized (no whitespace trimming of values)
 * - Derived/preview/effective values and current operator defaults are excluded
 */
export function computeInstantiateRequestHash(params: {
  operation: string;
  blueprintId: string;
  revisionId: string;
  kind: string;
  edits?: Record<string, unknown> | null;
  bindingIds?: string[] | null;
  requestedMode?: string | null;
  liveOptIn?: boolean | null;
}): string {
  const bindingIds = params.bindingIds
    ? [...new Set(params.bindingIds)].sort()
    : [];

  const normalized: Record<string, unknown> = {
    operation: params.operation,
    blueprintId: params.blueprintId,
    revisionId: params.revisionId,
    kind: params.kind,
  };

  if (params.edits && Object.keys(params.edits).length > 0) {
    normalized.edits = sortKeysDeep(params.edits);
  }

  if (bindingIds.length > 0) {
    normalized.bindingIds = bindingIds;
  }

  if (params.requestedMode) {
    normalized.requestedMode = params.requestedMode;
  }

  if (params.liveOptIn != null) {
    normalized.liveOptIn = params.liveOptIn;
  }

  const json = JSON.stringify(normalized, (_, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return sortKeysDeep(value as Record<string, unknown>);
    }
    return value;
  });

  return createHash('sha256').update(json, 'utf-8').digest('hex');
}

/**
 * Recursively sort object keys for deterministic serialization.
 * Arrays are preserved in original order.
 */
function sortKeysDeep(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    const value = obj[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      sorted[key] = sortKeysDeep(value as Record<string, unknown>);
    } else {
      sorted[key] = value;
    }
  }
  return sorted;
}
