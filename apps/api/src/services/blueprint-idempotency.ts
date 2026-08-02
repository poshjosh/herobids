import { createHash } from 'node:crypto';

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
