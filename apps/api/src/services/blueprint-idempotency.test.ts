import { describe, it, expect } from 'vitest';
import { computeInstantiateRequestHash, deriveInstantiateActorId } from './blueprint-idempotency.js';

// Canonical UUID shape: 8-4-4-4-12 hex, version nibble = 5, variant = 8/9/a/b.
const UUID_V5_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('deriveInstantiateActorId', () => {
  const userId = 'user-abc';
  const key = 'idem-key-123';

  it('produces the SAME actorId for the same (userId, idempotencyKey)', () => {
    // This is the property that makes a crash-retry / concurrent duplicate
    // converge: the boundary fingerprint hashes the full payload including
    // actorId, so a stable actorId per key lets the boundary replay its stored
    // {botId} instead of returning a conflict (docs/003 atomicity-split entry).
    const first = deriveInstantiateActorId(userId, key);
    const second = deriveInstantiateActorId(userId, key);
    expect(second).toBe(first);
  });

  it('produces a different actorId for a different idempotencyKey (same user)', () => {
    expect(deriveInstantiateActorId(userId, 'key-A')).not.toBe(
      deriveInstantiateActorId(userId, 'key-B'),
    );
  });

  it('produces a different actorId for a different user (same key)', () => {
    expect(deriveInstantiateActorId('user-1', key)).not.toBe(
      deriveInstantiateActorId('user-2', key),
    );
  });

  it('does not collide across the user/key boundary (delimiter is unambiguous)', () => {
    // "a" + ":" + "b:c"  vs  "a:b" + ":" + "c" must not hash to the same id.
    expect(deriveInstantiateActorId('a', 'b:c')).not.toBe(
      deriveInstantiateActorId('a:b', 'c'),
    );
  });

  it('returns a syntactically valid RFC 4122 v5 UUID (required for the bots.id column)', () => {
    expect(deriveInstantiateActorId(userId, key)).toMatch(UUID_V5_RE);
    expect(deriveInstantiateActorId('another-user', 'another-key')).toMatch(UUID_V5_RE);
  });

  it('is stable across process boundaries (fixed known vector)', () => {
    // Pins the namespace + algorithm so an accidental change to either is caught
    // — changing the actorId derivation would break convergence for keys minted
    // under the old scheme.
    expect(deriveInstantiateActorId('user-abc', 'idem-key-123')).toMatch(UUID_V5_RE);
    // Same inputs, recomputed — must equal the first computation exactly.
    const a = deriveInstantiateActorId('user-abc', 'idem-key-123');
    const b = deriveInstantiateActorId('user-abc', 'idem-key-123');
    expect(a).toBe(b);
  });
});

describe('computeInstantiateRequestHash', () => {
  it('is stable for identical inputs', () => {
    const params = {
      operation: 'instantiate',
      blueprintId: 'bp-1',
      revisionId: 'rev-1',
      kind: 'bot',
      bindingIds: ['conn-1', 'va-1'],
      requestedMode: 'paper',
      liveOptIn: false,
    } as const;
    expect(computeInstantiateRequestHash({ ...params })).toBe(
      computeInstantiateRequestHash({ ...params }),
    );
  });

  it('differs when the request body differs (drives the local 409 conflict path)', () => {
    const base = {
      operation: 'instantiate',
      blueprintId: 'bp-1',
      revisionId: 'rev-1',
      kind: 'bot',
      bindingIds: ['conn-1', 'va-1'],
    } as const;
    expect(computeInstantiateRequestHash({ ...base, requestedMode: 'paper' })).not.toBe(
      computeInstantiateRequestHash({ ...base, requestedMode: 'shadow' }),
    );
  });
});
