/**
 * Generates the shared 005 HMAC invocation signing vectors (Phase 3 T0.3).
 *
 * Output: packages/domain/src/traderton/__fixtures__/invocation-signing-vectors.json
 * The same bytes are copied (plain `cp`) to traderton
 * packages/boundary/src/__fixtures__/invocation-signing-vectors.json. herobids
 * asserts its signer emits these bytes; traderton asserts its verifier accepts
 * them. Both repos also pin the sha256 of the file (Phase 3 SEAM.md §3.1).
 *
 * The secret below is TEST-ONLY. It is not, and must never become, a real key.
 *
 * Usage (from the herobids repo root):
 *   pnpm --filter @herobids/scripts run generate-signing-vectors             # write the fixture
 *   pnpm --filter @herobids/scripts run generate-signing-vectors -- --check  # exit 1 if the on-disk bytes differ
 *
 * Regeneration procedure (deliberate contract change only, SEAM.md §4): run the
 * generator, `cp` the file to traderton, update SIGNING_VECTORS_SHA256 in both
 * signing-vectors.test.ts files and the digest in SEAM.md §3.1.
 *
 * NEVER regenerate to make a failing vector pass. A diff means the signer bytes
 * changed, and the REST bytes are frozen (Step 10 §5).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
// Source, not dist: tsx resolves `.js` → `.ts`. T1.1 must repoint this import AND FIXTURE_PATH
// when the directory is renamed (`rg -n "domain/src/traderton" scripts/`).
import {
  TRADERTON_INVOKE_PATH,
  TradertonClient,
  buildCanonicalString,
  signInvoke,
  signStatus,
  tradertonStatusPath,
  type SignedHeaders,
  type SigningIdentity,
  type TradertonSubject,
} from '../../packages/domain/src/traderton/index.js';

const FIXTURE_PATH = resolve(
  import.meta.dirname,
  '../../packages/domain/src/traderton/__fixtures__/invocation-signing-vectors.json',
);

const TIMESTAMP = '2026-10-02T12:00:00.000Z';
const DEADLINE_AT = '2026-10-02T12:00:30.000Z';
const IDENTITY: SigningIdentity = {
  consumerId: 'herobids',
  keyId: 'signing-vector-key',
  secret: 'phase3-signing-vector-test-secret',
};

interface SigningVectorCase {
  id: string;
  description: string;
  method: 'GET' | 'POST';
  requestPath: string;
  signedPath: string;
  timestamp: string;
  deadlineAt: string;
  consumerId: string;
  keyId: string;
  secret: string;
  body: string;
  bodyUtf8ByteLength: number;
  bodyUtf16Length: number;
  bodySha256: string;
  expectedCanonical: string;
  expectedSignature: string;
  expectedHeaders: SignedHeaders;
}

interface SigningVectorFile {
  formatVersion: 1;
  description: string;
  generator: string;
  secretIsTestOnly: true;
  cases: SigningVectorCase[];
}

const client = new TradertonClient({
  baseUrl: 'http://boundary.signing-vector.test',
  consumerId: IDENTITY.consumerId,
  keyId: IDENTITY.keyId,
  hmacSecret: IDENTITY.secret,
  requestTimeoutMs: 30_000,
});

function buildCase(
  meta: { id: string; description: string; method: 'GET' | 'POST'; requestPath: string; signedPath: string },
  body: string,
  headers: SignedHeaders,
): SigningVectorCase {
  const bodyBytes = Buffer.from(body, 'utf8');
  const signature = headers['x-traderton-signature'];
  if (signature === undefined) {
    throw new Error(`signer emitted no x-traderton-signature for ${meta.id}`);
  }
  return {
    ...meta,
    timestamp: TIMESTAMP,
    deadlineAt: DEADLINE_AT,
    consumerId: IDENTITY.consumerId,
    keyId: IDENTITY.keyId,
    secret: IDENTITY.secret,
    body,
    bodyUtf8ByteLength: bodyBytes.length,
    bodyUtf16Length: body.length,
    bodySha256: createHash('sha256').update(bodyBytes).digest('hex'),
    expectedCanonical: buildCanonicalString(meta.method, meta.signedPath, TIMESTAMP, bodyBytes),
    expectedSignature: signature,
    expectedHeaders: headers,
  };
}

function invokeCase(id: string, description: string, suffix: string, value: string): SigningVectorCase {
  const subject: TradertonSubject = {
    ownerId: `owner-vector-${suffix}`,
    actor: { type: 'agent', id: `agent-vector-${suffix}` },
  };
  const envelope = client.buildEnvelope({
    toolName: 'echo_vector',
    payload: { value },
    subject,
    deadlineAt: DEADLINE_AT,
    requestId: `req-vector-${suffix}`,
    idempotencyKey: `idem-vector-${suffix}`,
    correlationId: `corr-vector-${suffix}`,
    issuedAt: TIMESTAMP,
  });
  const { headers, rawBody } = signInvoke(IDENTITY, TRADERTON_INVOKE_PATH, envelope, { timestamp: TIMESTAMP });
  return buildCase(
    { id, description, method: 'POST', requestPath: TRADERTON_INVOKE_PATH, signedPath: TRADERTON_INVOKE_PATH },
    rawBody,
    headers,
  );
}

function statusCase(id: string, description: string, requestId: string, query: string): SigningVectorCase {
  const signedPath = tradertonStatusPath(requestId);
  const headers = signStatus(IDENTITY, signedPath, { timestamp: TIMESTAMP, deadlineAt: DEADLINE_AT });
  return buildCase({ id, description, method: 'GET', requestPath: signedPath + query, signedPath }, '', headers);
}

function generate(): string {
  const file: SigningVectorFile = {
    formatVersion: 1,
    description:
      'Shared 005 HMAC invocation signing vectors. Byte-identical in herobids and traderton. DO NOT EDIT BY HAND: regenerate with herobids scripts/ts/generate-signing-vectors.ts, copy to traderton, update the sha256 constant in both tests and SEAM.md §3.1.',
    generator: 'herobids scripts/ts/generate-signing-vectors.ts',
    secretIsTestOnly: true,
    cases: [
      invokeCase(
        'invoke-full-envelope',
        'POST tools:invoke with a full 005 envelope from TradertonClient.buildEnvelope (every identifier supplied).',
        '1',
        'hello',
      ),
      statusCase(
        'status-empty-body',
        'GET invocation status: empty body, so the canonical string hashes zero bytes.',
        'req-vector-2',
        '',
      ),
      statusCase(
        'status-query-stripped',
        'GET invocation status sent with a query string: the verifier strips the query, so the signature covers signedPath only.',
        'req-vector-3',
        '?wait=true&trace=1',
      ),
      invokeCase(
        'invoke-non-ascii-body',
        'POST tools:invoke whose payload holds 2-, 3- and 4-byte UTF-8 sequences: the body hash is over UTF-8 bytes, not UTF-16 code units.',
        '4',
        'naïve café – 日本語 – 🚀',
      ),
    ],
  };
  return JSON.stringify(file, null, 2) + '\n';
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function main(): void {
  const generated = Buffer.from(generate(), 'utf8');
  const digest = sha256Hex(generated);

  if (process.argv.includes('--check')) {
    const committed = existsSync(FIXTURE_PATH) ? readFileSync(FIXTURE_PATH) : null;
    if (committed === null || !committed.equals(generated)) {
      console.error(`signing vectors DIFFER from ${FIXTURE_PATH}`);
      console.error(`  regenerated sha256 = ${digest}`);
      console.error(`  committed   sha256 = ${committed === null ? '<missing>' : sha256Hex(committed)}`);
      console.error('A diff means the signer bytes changed (Step 10 §5). Do not regenerate to make it pass.');
      process.exit(1);
    }
    console.log(`signing vectors match ${FIXTURE_PATH}`);
    console.log(`sha256 = ${digest}`);
    return;
  }

  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, generated);
  console.log(`wrote ${FIXTURE_PATH}`);
  console.log(`sha256 = ${digest}`);
}

main();
