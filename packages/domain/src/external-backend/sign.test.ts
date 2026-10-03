import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import {
  buildCanonicalString,
  signRequest,
  signInvoke,
  signStatus,
  type SigningIdentity,
} from './sign.js';

/**
 * Signer self-consistency against an inline replica of the verifier algorithm.
 *
 * NOT a cross-repo guard. `verifierCanonical` / `verifierSignature` below are a
 * hand-copied snapshot of traderton/packages/boundary/src/auth.ts: if that file
 * changes, these tests still pass, so they cannot detect signer/verifier drift.
 * The cross-repo guard is the shared fixture
 * `./__fixtures__/invocation-signing-vectors.json`, asserted here by
 * `./signing-vectors.test.ts` and in traderton by
 * packages/boundary/src/signing-vectors.test.ts against the real
 * `authenticateRequest` (Phase 3 SEAM.md §2, §3.1). Test logic is intentionally
 * unchanged: this file must pass unmodified after the T1.1 rename (Step 10 §5).
 */

const IDENTITY: SigningIdentity = {
  consumerId: 'herobids',
  keyId: 'current',
  secret: 'test-signing-secret',
};

/** Inline snapshot of the verifier's canonical string (auth.ts) — not a drift guard; see header. */
function verifierCanonical(method: string, path: string, timestamp: string, rawBody: Buffer): string {
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  return `${method}\n${path}\n${timestamp}\n${bodyHash}`;
}

/** Inline snapshot of the verifier's expected signature (auth.ts) — not a drift guard; see header. */
function verifierSignature(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

describe('buildCanonicalString', () => {
  it('produces METHOD\\nPATH\\nTIMESTAMP\\nSHA256(body) matching the verifier', () => {
    const method = 'POST';
    const path = '/internal/v1/tools:invoke';
    const timestamp = '2026-09-10T12:00:00.000Z';
    const rawBody = Buffer.from('{"hello":"world"}', 'utf8');

    const canonical = buildCanonicalString(method, path, timestamp, rawBody);

    expect(canonical).toBe(verifierCanonical(method, path, timestamp, rawBody));
    // Spell the expected shape out so a drift is obvious.
    const expectedHash = createHash('sha256').update(rawBody).digest('hex');
    expect(canonical).toBe(`POST\n/internal/v1/tools:invoke\n${timestamp}\n${expectedHash}`);
  });

  it('hashes empty bytes for an empty body', () => {
    const canonical = buildCanonicalString('GET', '/x', '2026-01-01T00:00:00.000Z', Buffer.alloc(0));
    const emptyHash = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
    expect(canonical.endsWith(emptyHash)).toBe(true);
  });
});

describe('signRequest', () => {
  it('emits a lowercase hex signature prefixed sha256= that verifies against the replica', () => {
    const timestamp = '2026-09-10T12:00:00.000Z';
    const rawBody = Buffer.from('{"a":1}', 'utf8');
    const headers = signRequest(IDENTITY, {
      method: 'POST',
      path: '/internal/v1/tools:invoke',
      rawBody,
      timestamp,
      deadlineAt: '2026-09-10T12:00:30.000Z',
    });

    const signature = headers['x-traderton-signature']!;
    expect(signature.startsWith('sha256=')).toBe(true);
    const presented = signature.slice('sha256='.length);
    expect(presented).toMatch(/^[0-9a-f]+$/); // lowercase hex, not base64url

    const canonical = verifierCanonical('POST', '/internal/v1/tools:invoke', timestamp, rawBody);
    expect(presented).toBe(verifierSignature(IDENTITY.secret, canonical));
  });

  it('emits every required 005 header', () => {
    const headers = signRequest(IDENTITY, {
      method: 'POST',
      path: '/internal/v1/tools:invoke',
      rawBody: Buffer.from('{}', 'utf8'),
      timestamp: '2026-09-10T12:00:00.000Z',
      deadlineAt: '2026-09-10T12:00:30.000Z',
    });

    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-traderton-consumer-id']).toBe('herobids');
    expect(headers['x-traderton-key-id']).toBe('current');
    expect(headers['x-traderton-timestamp']).toBe('2026-09-10T12:00:00.000Z');
    expect(headers['x-request-deadline-at']).toBe('2026-09-10T12:00:30.000Z');
    expect(headers['x-traderton-signature']).toBeDefined();
  });
});

describe('signInvoke', () => {
  it('serializes the envelope once and signs those exact bytes', () => {
    const envelope = { deadlineAt: '2026-09-10T12:00:30.000Z', toolName: 'get_positions', payload: { x: 1 } };
    const { headers, rawBody } = signInvoke(IDENTITY, '/internal/v1/tools:invoke', envelope, {
      timestamp: '2026-09-10T12:00:00.000Z',
    });

    // The wire bytes are exactly what was hashed.
    expect(rawBody).toBe(JSON.stringify(envelope));
    const canonical = verifierCanonical(
      'POST',
      '/internal/v1/tools:invoke',
      '2026-09-10T12:00:00.000Z',
      Buffer.from(rawBody, 'utf8'),
    );
    const presented = headers['x-traderton-signature']!.slice('sha256='.length);
    expect(presented).toBe(verifierSignature(IDENTITY.secret, canonical));
  });

  it('sets X-Request-Deadline-At equal to the envelope deadlineAt', () => {
    const envelope = { deadlineAt: '2026-09-10T12:00:30.000Z' };
    const { headers } = signInvoke(IDENTITY, '/internal/v1/tools:invoke', envelope);
    expect(headers['x-request-deadline-at']).toBe(envelope.deadlineAt);
  });
});

describe('signStatus', () => {
  it('signs an empty body for a GET and verifies against the replica', () => {
    const timestamp = '2026-09-10T12:00:00.000Z';
    const path = '/internal/v1/invocations/req-123';
    const headers = signStatus(IDENTITY, path, {
      timestamp,
      deadlineAt: '2026-09-10T12:00:30.000Z',
    });

    const canonical = verifierCanonical('GET', path, timestamp, Buffer.alloc(0));
    const presented = headers['x-traderton-signature']!.slice('sha256='.length);
    expect(presented).toBe(verifierSignature(IDENTITY.secret, canonical));
  });

  it('signs the path without a query string', () => {
    // The 005 PATH is the path only. A signer given a query-bearing path would
    // hash different bytes than the verifier (which strips the query), so the
    // caller must pass the bare path — assert the canonical reflects exactly it.
    const path = '/internal/v1/invocations/req-123';
    const timestamp = '2026-09-10T12:00:00.000Z';
    const canonical = buildCanonicalString('GET', path, timestamp, Buffer.alloc(0));
    expect(canonical.includes('?')).toBe(false);
    expect(canonical.split('\n')[1]).toBe(path);
  });
});
