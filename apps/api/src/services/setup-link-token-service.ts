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
 * Consume (read-and-delete) a one-time setup-link token.
 * Returns the userId or null if the token was invalid/expired.
 */
export async function consumeSetupLinkToken(
  redis: Redis,
  token: string,
): Promise<string | null> {
  const raw = await redis.getdel(`auth:setup-link:token:${token}`);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as { userId: string };
    return payload.userId ?? null;
  } catch {
    return null;
  }
}
