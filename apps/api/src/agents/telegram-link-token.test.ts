import crypto from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import {
  createTelegramLinkToken,
  consumeTelegramLinkToken,
  TELEGRAM_LINK_TOKEN_TTL_SECS,
  TELEGRAM_LINK_TOKEN_RATE_LIMIT,
} from './telegram-link-token.js';

/** The Redis key the module stores a token under. Keys hold a sha256 of the token, never the token itself. */
function tokenKeyFor(token: string): string {
  return `tg-link:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

/**
 * In-memory stand-in for the Redis commands the token module uses. `multi` queues commands and runs them
 * together on exec, and `set` honours NX. `expireKey` simulates TTL expiry.
 */
function fakeRedis() {
  const values = new Map<string, string>();
  const counters = new Map<string, number>();
  const ttls = new Map<string, number>();
  const multiCommands: unknown[][] = [];

  const set = vi.fn(async (...args: unknown[]) => {
    const [key, value, , ttlSecs] = args as [string, string, string, number];
    values.set(key, value);
    ttls.set(key, ttlSecs);
    return 'OK' as const;
  });
  const getdel = vi.fn(async (...args: unknown[]) => {
    const [key] = args as [string];
    const value = values.get(key) ?? null;
    values.delete(key);
    return value;
  });
  const multi = vi.fn(() => {
    const queued: Array<() => unknown> = [];
    const chain = {
      set(key: string, value: string, ...options: unknown[]) {
        multiCommands.push(['set', key, value, ...options]);
        queued.push(() => {
          if (options.includes('NX') && counters.has(key)) return null;
          counters.set(key, Number(value));
          ttls.set(key, options[1] as number);
          return 'OK';
        });
        return chain;
      },
      incr(key: string) {
        multiCommands.push(['incr', key]);
        queued.push(() => {
          const next = (counters.get(key) ?? 0) + 1;
          counters.set(key, next);
          return next;
        });
        return chain;
      },
      async exec() {
        return queued.map((run) => [null, run()]);
      },
    };
    return chain;
  });

  const redis = { multi, set, getdel } as unknown as Pick<Redis, 'multi' | 'set' | 'getdel'>;
  return {
    redis,
    spies: { set, getdel, multi },
    multiCommands,
    ttls,
    counters,
    expireKey(key: string) {
      values.delete(key);
      counters.delete(key);
      ttls.delete(key);
    },
  };
}

describe('createTelegramLinkToken', () => {
  it('issues a token of URL-safe characters that fits Telegram\'s start payload limit', async () => {
    const { redis } = fakeRedis();

    const created = await createTelegramLinkToken(redis, 'user-1');

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(`link_${created.data.token}`.length).toBeLessThanOrEqual(64);
  });

  it('issues a different token on each call', async () => {
    const { redis } = fakeRedis();

    const first = await createTelegramLinkToken(redis, 'user-1');
    const second = await createTelegramLinkToken(redis, 'user-1');

    expect(first.ok && second.ok && first.data.token !== second.data.token).toBe(true);
  });

  it('stores the token against the user with a 10 minute TTL, keyed by its sha256 hash', async () => {
    const { redis, spies, ttls } = fakeRedis();

    const created = await createTelegramLinkToken(redis, 'user-1');

    if (!created.ok) throw new Error('expected a token');
    expect(spies.set).toHaveBeenCalledWith(tokenKeyFor(created.data.token), 'user-1', 'EX', 600);
    expect(ttls.get(tokenKeyFor(created.data.token))).toBe(TELEGRAM_LINK_TOKEN_TTL_SECS);
    expect(TELEGRAM_LINK_TOKEN_TTL_SECS).toBe(600);
  });

  it('never stores the raw token as a Redis key', async () => {
    const { redis, spies } = fakeRedis();

    const created = await createTelegramLinkToken(redis, 'user-1');

    if (!created.ok) throw new Error('expected a token');
    const storedKeys = spies.set.mock.calls.map((call) => String(call[0]));
    expect(storedKeys.every((key) => !key.includes(created.data.token))).toBe(true);
  });

  it('reports an expiry 10 minutes ahead', async () => {
    const { redis } = fakeRedis();
    const before = Date.now();

    const created = await createTelegramLinkToken(redis, 'user-1');

    if (!created.ok) throw new Error('expected a token');
    const expiresInMs = created.data.expiresAt.getTime() - before;
    expect(expiresInMs).toBeGreaterThanOrEqual(600_000);
    expect(expiresInMs).toBeLessThanOrEqual(600_000 + 5_000);
  });

  it('allows up to the per-user limit within one window', async () => {
    const { redis } = fakeRedis();

    for (let i = 0; i < TELEGRAM_LINK_TOKEN_RATE_LIMIT; i += 1) {
      const created = await createTelegramLinkToken(redis, 'user-1');
      expect(created.ok).toBe(true);
    }
  });

  it('refuses the request past the per-user limit with a rate-limited error', async () => {
    const { redis, spies } = fakeRedis();
    for (let i = 0; i < TELEGRAM_LINK_TOKEN_RATE_LIMIT; i += 1) {
      await createTelegramLinkToken(redis, 'user-1');
    }

    const refused = await createTelegramLinkToken(redis, 'user-1');

    expect(refused).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'auth.telegram_link.rate_limited' }),
    });
    expect(spies.set).toHaveBeenCalledTimes(TELEGRAM_LINK_TOKEN_RATE_LIMIT);
  });

  it('keeps the rate limit separate for each user', async () => {
    const { redis } = fakeRedis();
    for (let i = 0; i < TELEGRAM_LINK_TOKEN_RATE_LIMIT; i += 1) {
      await createTelegramLinkToken(redis, 'user-1');
    }

    const otherUser = await createTelegramLinkToken(redis, 'user-2');

    expect(otherUser.ok).toBe(true);
  });

  it('counts each request in one MULTI that sets the window TTL with NX and then increments', async () => {
    const { redis, spies, multiCommands } = fakeRedis();

    await createTelegramLinkToken(redis, 'user-1');

    expect(spies.multi).toHaveBeenCalledTimes(1);
    expect(multiCommands).toEqual([
      ['set', 'tg-link-rate:user-1', '0', 'EX', 600, 'NX'],
      ['incr', 'tg-link-rate:user-1'],
    ]);
  });

  it('gives the rate-limit counter a 10 minute TTL on the first request and never removes it', async () => {
    const { redis, ttls, counters } = fakeRedis();

    await createTelegramLinkToken(redis, 'user-1');
    await createTelegramLinkToken(redis, 'user-1');

    expect(ttls.get('tg-link-rate:user-1')).toBe(600);
    expect(counters.get('tg-link-rate:user-1')).toBe(2);
  });

  it('does not restart the window on later requests, so the first request still sets its TTL', async () => {
    const { redis, ttls } = fakeRedis();
    await createTelegramLinkToken(redis, 'user-1');
    ttls.set('tg-link-rate:user-1', 42);

    await createTelegramLinkToken(redis, 'user-1');

    expect(ttls.get('tg-link-rate:user-1')).toBe(42);
  });

  it('allows new requests again once the rate-limit window has expired', async () => {
    const { redis, expireKey } = fakeRedis();
    for (let i = 0; i < TELEGRAM_LINK_TOKEN_RATE_LIMIT; i += 1) {
      await createTelegramLinkToken(redis, 'user-1');
    }
    expireKey('tg-link-rate:user-1');

    const afterWindow = await createTelegramLinkToken(redis, 'user-1');

    expect(afterWindow.ok).toBe(true);
  });
});

describe('consumeTelegramLinkToken', () => {
  it('returns the user id for a fresh token', async () => {
    const { redis } = fakeRedis();
    const created = await createTelegramLinkToken(redis, 'user-1');
    if (!created.ok) throw new Error('expected a token');

    const userId = await consumeTelegramLinkToken(redis, created.data.token);

    expect(userId).toBe('user-1');
  });

  it('returns null on replay, because the first consume removed the token', async () => {
    const { redis } = fakeRedis();
    const created = await createTelegramLinkToken(redis, 'user-1');
    if (!created.ok) throw new Error('expected a token');
    await consumeTelegramLinkToken(redis, created.data.token);

    const replayed = await consumeTelegramLinkToken(redis, created.data.token);

    expect(replayed).toBeNull();
  });

  it('returns null for a token that was never issued', async () => {
    const { redis } = fakeRedis();

    const userId = await consumeTelegramLinkToken(redis, 'never-issued');

    expect(userId).toBeNull();
  });

  it('returns null once the token has expired', async () => {
    const { redis, expireKey } = fakeRedis();
    const created = await createTelegramLinkToken(redis, 'user-1');
    if (!created.ok) throw new Error('expected a token');
    expireKey(tokenKeyFor(created.data.token));

    const userId = await consumeTelegramLinkToken(redis, created.data.token);

    expect(userId).toBeNull();
  });

  it('consumes with GETDEL, keyed by the sha256 hash, so the read and the delete are one atomic step', async () => {
    const { redis, spies } = fakeRedis();

    await consumeTelegramLinkToken(redis, 'abc');

    expect(spies.getdel).toHaveBeenCalledWith(tokenKeyFor('abc'));
  });
});
