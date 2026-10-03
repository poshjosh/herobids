import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { buildCanonicalString, signRequest, signInvoke, signStatus, type SigningIdentity } from './sign.js';

/**
 * The cross-repo signer/verifier guard (Phase 3 SEAM.md §2, §3.1). The fixture
 * is byte-identical to traderton packages/boundary/src/__fixtures__/, where the
 * real `authenticateRequest` must accept every case. This file imports only
 * `./sign.js` so it passes unmodified through the T1.1 rename (Step 10 §5).
 */

/** sha256 of the fixture file bytes. Same constant in traderton's signing-vectors.test.ts. */
const SIGNING_VECTORS_SHA256 = '1d4a04b8e92c2baddea4fc8fef787a310d756cfa621d88c11609ad0f9d0520ef';

const FIXTURE_URL = new URL('./__fixtures__/invocation-signing-vectors.json', import.meta.url);

const REQUIRED_CASE_IDS = [
  'invoke-full-envelope',
  'status-empty-body',
  'status-query-stripped',
  'invoke-non-ascii-body',
];

const SigningVectorCaseSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    method: z.enum(['GET', 'POST']),
    requestPath: z.string(),
    signedPath: z.string(),
    timestamp: z.string(),
    deadlineAt: z.string(),
    consumerId: z.string(),
    keyId: z.string(),
    secret: z.string(),
    body: z.string(),
    bodyUtf8ByteLength: z.number().int(),
    bodyUtf16Length: z.number().int(),
    bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
    expectedCanonical: z.string(),
    expectedSignature: z.string().regex(/^sha256=[0-9a-f]{64}$/),
    expectedHeaders: z.record(z.string()),
  })
  .strict();

const SigningVectorFileSchema = z
  .object({
    formatVersion: z.literal(1),
    description: z.string(),
    generator: z.string(),
    secretIsTestOnly: z.literal(true),
    cases: z.array(SigningVectorCaseSchema),
  })
  .strict();

type SigningVectorCase = z.infer<typeof SigningVectorCaseSchema>;

const fixtureBytes = readFileSync(FIXTURE_URL);
const vectors = SigningVectorFileSchema.parse(JSON.parse(fixtureBytes.toString('utf8')));
const cases = vectors.cases;
const postCases = cases.filter((c) => c.method === 'POST');
const getCases = cases.filter((c) => c.method === 'GET');

function identityOf(c: SigningVectorCase): SigningIdentity {
  return { consumerId: c.consumerId, keyId: c.keyId, secret: c.secret };
}

function caseById(id: string): SigningVectorCase {
  const found = cases.find((c) => c.id === id);
  if (!found) throw new Error(`fixture is missing case ${id}`);
  return found;
}

/**
 * Narrow the parsed body without rebuilding it. A Zod object parse would build a
 * new object (key order follows the schema), and `signInvoke` must re-serialize
 * the ORIGINAL key order to reproduce the recorded bytes.
 */
function hasDeadlineAt(value: unknown): value is { deadlineAt: string } {
  return typeof value === 'object' && value !== null && 'deadlineAt' in value && typeof value.deadlineAt === 'string';
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('invocation signing vectors (shared with traderton)', () => {
  it('fixture file digest equals the recorded constant', () => {
    expect(sha256Hex(fixtureBytes)).toBe(SIGNING_VECTORS_SHA256);
  });

  it('contains exactly the four required cases', () => {
    expect(cases.map((c) => c.id).sort()).toEqual([...REQUIRED_CASE_IDS].sort());
  });

  it.each(cases)('buildCanonicalString reproduces the canonical string for $id', (c) => {
    const bodyBytes = Buffer.from(c.body, 'utf8');
    expect(sha256Hex(bodyBytes)).toBe(c.bodySha256);
    expect(c.expectedCanonical).toBe([c.method, c.signedPath, c.timestamp, c.bodySha256].join('\n'));
    expect(buildCanonicalString(c.method, c.signedPath, c.timestamp, bodyBytes)).toBe(c.expectedCanonical);
  });

  it.each(cases)('signRequest emits the recorded signature and headers for $id', (c) => {
    const headers = signRequest(identityOf(c), {
      method: c.method,
      path: c.signedPath,
      rawBody: Buffer.from(c.body, 'utf8'),
      timestamp: c.timestamp,
      deadlineAt: c.deadlineAt,
    });
    expect(headers['x-traderton-signature']).toBe(c.expectedSignature);
    expect(headers).toEqual(c.expectedHeaders);
  });

  it.each(postCases)('signInvoke serializes $id to the recorded body and headers', (c) => {
    const envelope: unknown = JSON.parse(c.body);
    if (!hasDeadlineAt(envelope)) throw new Error(`${c.id} body has no string deadlineAt`);

    const { headers, rawBody } = signInvoke(identityOf(c), c.signedPath, envelope, { timestamp: c.timestamp });

    expect(rawBody).toBe(c.body);
    expect(headers).toEqual(c.expectedHeaders);
  });

  it.each(getCases)('signStatus emits the recorded headers for $id', (c) => {
    const headers = signStatus(identityOf(c), c.signedPath, { timestamp: c.timestamp, deadlineAt: c.deadlineAt });
    expect(headers).toEqual(c.expectedHeaders);
  });

  it('query case: signedPath is requestPath without its query, and signing the query path does not match', () => {
    const c = caseById('status-query-stripped');
    expect(c.requestPath).toContain('?');
    expect(c.requestPath.split('?')[0]).toBe(c.signedPath);

    const signedOverQuery = signStatus(identityOf(c), c.requestPath, {
      timestamp: c.timestamp,
      deadlineAt: c.deadlineAt,
    });
    expect(signedOverQuery['x-traderton-signature']).not.toBe(c.expectedSignature);
  });

  it('non-ASCII case: hash is over UTF-8 bytes, whose length differs from the UTF-16 length', () => {
    const c = caseById('invoke-non-ascii-body');
    const utf8 = Buffer.from(c.body, 'utf8');

    expect(utf8.length).toBe(c.bodyUtf8ByteLength);
    expect(c.body.length).toBe(c.bodyUtf16Length);
    expect(c.bodyUtf8ByteLength).not.toBe(c.bodyUtf16Length);
    expect(sha256Hex(utf8)).toBe(c.bodySha256);
    // Hashing the UTF-16 code units instead would not match the recorded digest.
    expect(sha256Hex(Buffer.from(c.body, 'utf16le'))).not.toBe(c.bodySha256);
  });
});
