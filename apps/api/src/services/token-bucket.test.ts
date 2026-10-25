import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { consumeTokenBucketToken, type TokenBucketSpec } from './token-bucket.js';

const SPEC: TokenBucketSpec = { key: 'ratelimit:agent-create:user-1', capacity: 5, refillPerMinute: 10 };

function fakeRedis(evalImpl: () => Promise<unknown>) {
  const evalMock = vi.fn(async (..._args: unknown[]) => evalImpl());
  const redis: Pick<Redis, 'eval'> = { eval: evalMock };
  return { redis, evalMock };
}

describe('consumeTokenBucketToken arguments', () => {
  it('passes the script, one key, and the capacity and refill per minute as strings', async () => {
    const { redis, evalMock } = fakeRedis(async () => 1);

    await consumeTokenBucketToken(redis, SPEC);

    expect(evalMock).toHaveBeenCalledWith(expect.any(String), 1, SPEC.key, '5', '10');
  });

  it('encodes a zero capacity as "0" so a disabled bucket is refused by the script', async () => {
    const { redis, evalMock } = fakeRedis(async () => 0);

    const result = await consumeTokenBucketToken(redis, { ...SPEC, capacity: 0 });

    expect(evalMock).toHaveBeenCalledWith(expect.any(String), 1, SPEC.key, '0', '10');
    expect(result).toEqual({ ok: true, data: false });
  });

  it('sends the bucket script that reads the key and the capacity and refill from its arguments', async () => {
    const { redis, evalMock } = fakeRedis(async () => 1);

    await consumeTokenBucketToken(redis, SPEC);

    const script = evalMock.mock.calls[0]?.[0];
    expect(script).toContain('KEYS[1]');
    expect(script).toContain('ARGV[1]');
    expect(script).toContain('ARGV[2]');
  });
});

describe('consumeTokenBucketToken result', () => {
  it('reports an allowed attempt as ok with true', async () => {
    const { redis } = fakeRedis(async () => 1);

    expect(await consumeTokenBucketToken(redis, SPEC)).toEqual({ ok: true, data: true });
  });

  it('reports an empty bucket as ok with false', async () => {
    const { redis } = fakeRedis(async () => 0);

    expect(await consumeTokenBucketToken(redis, SPEC)).toEqual({ ok: true, data: false });
  });

  it('treats any reply other than 1 as not allowed', async () => {
    const { redis } = fakeRedis(async () => null);

    expect(await consumeTokenBucketToken(redis, SPEC)).toEqual({ ok: true, data: false });
  });

  it('reports a rejected call as an error carrying the error message', async () => {
    const { redis } = fakeRedis(async () => {
      throw new Error('connection refused');
    });

    expect(await consumeTokenBucketToken(redis, SPEC)).toEqual({ ok: false, error: 'connection refused' });
  });

  it('reports a rejection that is not an Error as an error carrying its string form', async () => {
    const { redis } = fakeRedis(async () => {
      throw 'socket closed';
    });

    expect(await consumeTokenBucketToken(redis, SPEC)).toEqual({ ok: false, error: 'socket closed' });
  });
});
