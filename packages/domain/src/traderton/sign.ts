// The shared HMAC signer for the Traderton REST boundary (005 §Authentication).
//
// It produces the EXACT 005 canonical string + signed headers the boundary's
// `authenticateRequest` verifies, so a request signed here byte-matches the
// verifier. This mirrors the committed Traderton dev signer
// (traderton/packages/boundary/src/dev/sign.ts) field-for-field: serialize the
// envelope ONCE, hash + sign THOSE bytes, and send the same bytes on the wire.
//
// Canonical string (005, exact):
//   METHOD + "\n" + PATH + "\n" + X-Traderton-Timestamp + "\n" + SHA256(rawBody)
// Signature: `sha256=` + HMAC-SHA256(secret, canonicalString) in LOWERCASE HEX.
//
// NOTE: herobids' OAuth helpers use base64url digests — that convention does
// NOT apply here. The Traderton verifier checks hex, so this signer emits hex.

import { createHash, createHmac } from 'node:crypto';

/** The signing material + caller identity a Traderton consumer holds. */
export interface SigningIdentity {
  consumerId: string;
  keyId: string;
  /** The resolved signing secret (never crosses the boundary — local only). */
  secret: string;
}

/** A request to sign. `rawBody` is empty for a GET (the status endpoint). */
export interface SignRequestInput {
  method: string;
  /** The PATH exactly as signed — NO query string (005; the boundary strips it). */
  path: string;
  /** The RAW request-body bytes the SHA256 hashes. Empty Buffer for GET. */
  rawBody?: Buffer;
  /** RFC3339/ISO timestamp for X-Traderton-Timestamp (defaults to now). */
  timestamp?: string;
  /**
   * The `X-Request-Deadline-At` header value. MUST equal the body's `deadlineAt`
   * for a `tools:invoke` call (005; the boundary asserts header ↔ body match).
   */
  deadlineAt: string;
}

/** The signed headers, lower-cased to match HTTP header handling. */
export type SignedHeaders = Record<string, string>;

/**
 * Fallback deadline window (ms) for a GET status request when the caller
 * supplies none. A GET has no body to match `X-Request-Deadline-At` against, so
 * the verifier only needs the header present; the real `poll()` path always
 * passes an explicit `deadlineAt`, making this a defensive default only.
 */
const STATUS_DEADLINE_FALLBACK_MS = 30_000;

/** Build the exact 005 canonical string for a request (matches the verifier). */
export function buildCanonicalString(
  method: string,
  path: string,
  timestamp: string,
  rawBody: Buffer,
): string {
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  return `${method}\n${path}\n${timestamp}\n${bodyHash}`;
}

/**
 * Build the signed headers for a request. Produces the 005 canonical string,
 * HMACs it with the caller's secret (lowercase hex, `sha256=` prefix), and
 * returns every required header (all lower-cased).
 */
export function signRequest(identity: SigningIdentity, input: SignRequestInput): SignedHeaders {
  const rawBody = input.rawBody ?? Buffer.alloc(0);
  const timestamp = input.timestamp ?? new Date().toISOString();

  const canonical = buildCanonicalString(input.method, input.path, timestamp, rawBody);
  const signature = 'sha256=' + createHmac('sha256', identity.secret).update(canonical).digest('hex');

  return {
    'content-type': 'application/json',
    'x-traderton-consumer-id': identity.consumerId,
    'x-traderton-key-id': identity.keyId,
    'x-traderton-timestamp': timestamp,
    'x-traderton-signature': signature,
    'x-request-deadline-at': input.deadlineAt,
  };
}

/**
 * Sign a `POST /internal/v1/tools:invoke` request from an invocation envelope.
 * Serializes the envelope ONCE to the raw bytes that are BOTH the signed body
 * and the wire payload (they MUST be identical — the SHA256 hashes these exact
 * bytes), and derives `X-Request-Deadline-At` from `body.deadlineAt`. Returns
 * the signed headers AND the exact raw body to send on the wire.
 */
export function signInvoke(
  identity: SigningIdentity,
  invokePath: string,
  envelope: { deadlineAt: string },
  opts: { timestamp?: string } = {},
): { headers: SignedHeaders; rawBody: string } {
  const rawBody = JSON.stringify(envelope);
  const headers = signRequest(identity, {
    method: 'POST',
    path: invokePath,
    rawBody: Buffer.from(rawBody, 'utf8'),
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    deadlineAt: envelope.deadlineAt,
  });
  return { headers, rawBody };
}

/**
 * Sign a `GET /internal/v1/invocations/:requestId` status request. GET has no
 * body → the canonical string hashes empty bytes. The verifier still requires
 * `X-Request-Deadline-At`; a caller-supplied value is used (there is no body to
 * match it against for a GET).
 */
export function signStatus(
  identity: SigningIdentity,
  statusPath: string,
  opts: { timestamp?: string; deadlineAt?: string } = {},
): SignedHeaders {
  return signRequest(identity, {
    method: 'GET',
    path: statusPath,
    rawBody: Buffer.alloc(0),
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    deadlineAt: opts.deadlineAt ?? new Date(Date.now() + STATUS_DEADLINE_FALLBACK_MS).toISOString(),
  });
}
