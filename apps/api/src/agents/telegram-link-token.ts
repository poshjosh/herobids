import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { err, ok, type DomainError, type Result } from '@herobids/domain';

/** Single-use link lifetime. The start payload "link_" + 43 base64url characters stays within Telegram's 64-character limit. */
export const TELEGRAM_LINK_TOKEN_TTL_SECS = 600;
/** Link tokens one user may create per TTL window. */
export const TELEGRAM_LINK_TOKEN_RATE_LIMIT = 5;
/** Longest in-app path a link may return to. */
export const TELEGRAM_RETURN_PATH_MAX_LENGTH = 200;

/** Path characters only. No "#", no backslash, and no scheme or host, because the path must start with a single "/". */
const RETURN_PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%\/?-]*$/;

const TOKEN_KEY_PREFIX = 'tg-link:';
const RATE_KEY_PREFIX = 'tg-link-rate:';

export interface TelegramLinkToken {
  token: string;
  expiresAt: Date;
}

export interface TelegramLinkConsumed {
  userId: string;
  returnTo: string;
}

/** Returns the path when it is a safe in-app path, otherwise "/". Used on create and again on read from Redis. */
export function normalizeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > TELEGRAM_RETURN_PATH_MAX_LENGTH) return '/';
  if (value.startsWith('//') || !RETURN_PATH_PATTERN.test(value)) return '/';
  return value;
}

/** The raw token is never stored as a key, so Redis keys and monitoring output do not expose live tokens. */
function tokenKey(token: string): string {
  return `${TOKEN_KEY_PREFIX}${crypto.createHash('sha256').update(token).digest('hex')}`;
}

/** Issues a single-use token that maps to the user and the path to return to. Returns `auth.telegram_link.rate_limited` past the per-user limit. */
export async function createTelegramLinkToken(
  redis: Pick<Redis, 'multi' | 'set' | 'getdel'>,
  userId: string,
  returnTo: string = '/',
): Promise<Result<TelegramLinkToken, DomainError>> {
  const rateKey = `${RATE_KEY_PREFIX}${userId}`;
  // SET NX EX and INCR run as one MULTI, so the counter never exists without its window TTL.
  const results = await redis.multi()
    .set(rateKey, '0', 'EX', TELEGRAM_LINK_TOKEN_TTL_SECS, 'NX')
    .incr(rateKey)
    .exec();
  const incrResult = results?.[1];
  if (!incrResult || incrResult[0]) throw new Error('Telegram link rate counter failed');
  const attempts = Number(incrResult[1]);
  if (attempts > TELEGRAM_LINK_TOKEN_RATE_LIMIT) {
    return err({
      code: 'auth.telegram_link.rate_limited',
      message: 'Too many Telegram link requests. Try again later.',
    });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const stored = JSON.stringify({ userId, returnTo: normalizeReturnTo(returnTo) });
  await redis.set(tokenKey(token), stored, 'EX', TELEGRAM_LINK_TOKEN_TTL_SECS);
  return ok({ token, expiresAt: new Date(Date.now() + TELEGRAM_LINK_TOKEN_TTL_SECS * 1000) });
}

/**
 * Atomically takes the token, so a replayed link gets null. Returns the user id and a re-validated return path,
 * or null when the token is unknown, expired or unreadable.
 */
export async function consumeTelegramLinkToken(
  redis: Pick<Redis, 'getdel'>,
  token: string,
): Promise<TelegramLinkConsumed | null> {
  const raw = await redis.getdel(tokenKey(token));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { userId, returnTo } = parsed as { userId?: unknown; returnTo?: unknown };
  if (typeof userId !== 'string' || userId === '') return null;
  return { userId, returnTo: normalizeReturnTo(returnTo) };
}
