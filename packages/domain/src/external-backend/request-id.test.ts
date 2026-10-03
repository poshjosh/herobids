import { describe, it, expect } from 'vitest';
import { deriveRequestId, type RequestIdKey } from './request-id.js';

const KEY: RequestIdKey = {
  consumerId: 'herobids',
  ownerId: 'owner-1',
  toolName: 'submit_decision',
  idempotencyKey: 'dec-1',
};

describe('deriveRequestId', () => {
  it('derives the same requestId for the same consumer, owner, tool and idempotency key', () => {
    expect(deriveRequestId({ ...KEY })).toBe(deriveRequestId({ ...KEY }));
  });

  it.each<keyof RequestIdKey>(['consumerId', 'ownerId', 'toolName', 'idempotencyKey'])(
    'derives a different requestId when only %s differs',
    (field) => {
      expect(deriveRequestId({ ...KEY, [field]: `${KEY[field]}-other` })).not.toBe(deriveRequestId(KEY));
    },
  );

  it('does not collide when a separator moves between fields', () => {
    const left = deriveRequestId({ ...KEY, ownerId: 'owner:1', toolName: 'submit_decision' });
    const right = deriveRequestId({ ...KEY, ownerId: 'owner', toolName: '1:submit_decision' });
    const quoted = deriveRequestId({ ...KEY, ownerId: 'owner","1', toolName: 'submit_decision' });
    expect(new Set([left, right, quoted]).size).toBe(3);
  });

  it('returns an RFC 4122 version-5 UUID', () => {
    expect(deriveRequestId(KEY)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('keeps the derivation stable across releases for an already-persisted key', () => {
    // Pins the namespace + encoding (cross-checked against Python's uuid.uuid5):
    // a change here would orphan in-flight writes derived by an earlier build.
    expect(deriveRequestId(KEY)).toBe('23477ae1-fd77-5f64-9e2c-1ac0f5b2d716');
  });
});
