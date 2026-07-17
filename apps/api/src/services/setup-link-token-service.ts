import crypto from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Build the full setup-link callback URL.
 */
export function makeSetupLinkUrl(token: string, publicBaseUrl: string): string {
  const url = new URL('/auth/setup-link/callback', publicBaseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Store a one-time setup-link token → userId mapping in Redis and return the token.
 */
export async function createAndStoreSetupLinkToken(
  redis: Redis,
  userId: string,
  ttlSecs: number,
): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const payload = { userId };
  await redis.set(`auth:setup-link:token:${token}`, JSON.stringify(payload), 'EX', ttlSecs);
  return token;
}

/**
 * Read a one-time setup-link token without deleting it.
 * Returns the userId or null if the token was invalid/expired.
 *
 * The token is NOT consumed here — callers must explicitly delete the key
 * after a successful session is issued. This prevents link previews and
 * accidental GETs from burning the token before the user clicks.
 */
export async function consumeSetupLinkToken(
  redis: Redis,
  token: string,
): Promise<string | null> {
  const key = `auth:setup-link:token:${token}`;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as { userId: string };
    return payload.userId ?? null;
  } catch {
    return null;
  }
}

/**
 * Delete a setup-link token after it has been successfully used.
 */
export async function deleteSetupLinkToken(
  redis: Redis,
  token: string,
): Promise<void> {
  await redis.del(`auth:setup-link:token:${token}`);
}
