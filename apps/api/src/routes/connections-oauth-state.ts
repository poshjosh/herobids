import crypto from 'node:crypto';

/**
 * Generate an HMAC-signed OAuth state token for connection authorization.
 * Encodes the userId so the callback can verify the authenticated user matches
 * the user who initiated the OAuth flow.
 *
 * @param userId - Must not contain '.' characters (UUID format expected).
 *
 * Format: `{userId}.{nonce}.{signature}`
 */
export function generateConnectionOAuthState(userId: string, secret: string): string {
  if (!userId || !secret) throw new Error('userId and secret are required');
  const nonce = crypto.randomBytes(32).toString('base64url');
  const payload = `${userId}.${nonce}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verify the state token and extract the userId.
 * Returns the userId if valid, or null if invalid/tampered.
 *
 * Deliberately returns `string | null` (extracted userId) rather than a
 * boolean — this avoids redundant userId parsing in callers that need the
 * userId after verification.
 *
 * The userId embedded in the state token must not contain '.' characters
 * (UUID format expected).
 */
export function verifyConnectionOAuthState(
  state: string,
  cookieState: string,
  secret: string,
): string | null {
  if (!state || !cookieState || state !== cookieState) return null;

  // Find the second dot (userId.nonce.sig)
  const firstDot = state.indexOf('.');
  const lastDot = state.lastIndexOf('.');
  if (firstDot < 0 || lastDot < 0 || firstDot === lastDot) return null;

  const userId = state.slice(0, firstDot);
  const payload = state.slice(0, lastDot); // userId.nonce
  const sig = state.slice(lastDot + 1);

  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  // Use timingSafeEqual to prevent timing attacks
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  return userId;
}

/** Cookie name for connection OAuth CSRF state. */
export const OAUTH_CONNECTION_STATE_COOKIE = 'oauth_connection_state';
