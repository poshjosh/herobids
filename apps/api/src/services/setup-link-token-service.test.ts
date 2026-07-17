import { describe, it, expect, vi } from 'vitest';
import {
  makeSetupLinkUrl,
  createAndStoreSetupLinkToken,
  consumeSetupLinkToken,
  deleteSetupLinkToken,
} from './setup-link-token-service.js';

function makeRedisMock(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

describe('setup-link-token-service', () => {
  describe('makeSetupLinkUrl', () => {
    it('builds the full callback URL with token query param', () => {
      const url = makeSetupLinkUrl('test-token-abc', 'https://app.example.com');
      expect(url).toBe('https://app.example.com/auth/setup-link/callback?token=test-token-abc');
    });

    it('uses the provided publicBaseUrl (not frontend origin)', () => {
      const url = makeSetupLinkUrl('xyz', 'https://api.herobids.com');
      expect(url).toContain('https://api.herobids.com/auth/setup-link/callback');
    });
  });

  describe('createAndStoreSetupLinkToken', () => {
    it('stores the token→userId mapping with the given TTL', async () => {
      const redis = makeRedisMock();
      const token = await createAndStoreSetupLinkToken(redis, 'user-1', 3600);

      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);

      expect(redis.set).toHaveBeenCalledTimes(1);
      const [key, rawPayload, expiryFlag, ttl] = redis.set.mock.calls[0] as [string, string, string, number];
      expect(key).toMatch(/^auth:setup-link:token:/);
      expect(key).toContain(token);
      expect(JSON.parse(rawPayload)).toEqual({ userId: 'user-1' });
      expect(expiryFlag).toBe('EX');
      expect(ttl).toBe(3600);
    });

    it('generates a unique token on each call', async () => {
      const redis = makeRedisMock();
      const t1 = await createAndStoreSetupLinkToken(redis, 'user-1', 600);
      const t2 = await createAndStoreSetupLinkToken(redis, 'user-2', 600);
      expect(t1).not.toBe(t2);
    });
  });

  describe('consumeSetupLinkToken', () => {
    it('uses redis.get — NOT getdel — to read the token', async () => {
      const redis = makeRedisMock({
        get: vi.fn().mockResolvedValue(JSON.stringify({ userId: 'user-1' })),
      });
      // Add a getdel spy to assert it's never called
      const getdelSpy = vi.fn();
      (redis as any).getdel = getdelSpy;

      const userId = await consumeSetupLinkToken(redis as any, 'valid-token');

      expect(userId).toBe('user-1');
      expect(redis.get).toHaveBeenCalledWith('auth:setup-link:token:valid-token');
      expect(getdelSpy).not.toHaveBeenCalled();
    });

    it('returns the userId when the token is valid', async () => {
      const redis = makeRedisMock({
        get: vi.fn().mockResolvedValue(JSON.stringify({ userId: 'user-42' })),
      });

      const userId = await consumeSetupLinkToken(redis, 'valid-token');

      expect(userId).toBe('user-42');
    });

    it('returns null for an expired / unknown token', async () => {
      const redis = makeRedisMock({
        get: vi.fn().mockResolvedValue(null),
      });

      const userId = await consumeSetupLinkToken(redis, 'expired-token');

      expect(userId).toBeNull();
      expect(redis.get).toHaveBeenCalledWith('auth:setup-link:token:expired-token');
    });

    it('returns null when the stored payload is not valid JSON', async () => {
      const redis = makeRedisMock({
        get: vi.fn().mockResolvedValue('not-json{{{'),
      });

      const userId = await consumeSetupLinkToken(redis, 'corrupt-token');

      expect(userId).toBeNull();
    });

    it('returns null when the stored payload lacks a userId', async () => {
      const redis = makeRedisMock({
        get: vi.fn().mockResolvedValue(JSON.stringify({ otherField: 'foo' })),
      });

      const userId = await consumeSetupLinkToken(redis, 'bad-token');

      expect(userId).toBeNull();
    });

    // Regression: token must NOT be deleted by consumeSetupLinkToken.
    // The caller is responsible for deleting the token only after a
    // successful session is issued. This prevents link previews and
    // accidental GETs from burning the token.
    it('does NOT delete the token from Redis (only reads)', async () => {
      const redis = makeRedisMock({
        get: vi.fn().mockResolvedValue(JSON.stringify({ userId: 'user-1' })),
      });

      await consumeSetupLinkToken(redis, 'valid-token');

      expect(redis.del).not.toHaveBeenCalled();
      expect(redis.get).toHaveBeenCalledTimes(1);
    });

    // Regression: the token must survive multiple reads (link preview
    // followed by the real user click).
    it('survives multiple reads — token is still readable after consume', async () => {
      const storedPayload = JSON.stringify({ userId: 'user-1' });
      const redis = makeRedisMock({
        get: vi.fn().mockResolvedValue(storedPayload),
      });

      const first = await consumeSetupLinkToken(redis, 'multi-read-token');
      const second = await consumeSetupLinkToken(redis, 'multi-read-token');

      expect(first).toBe('user-1');
      expect(second).toBe('user-1');
      expect(redis.get).toHaveBeenCalledTimes(2);
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  describe('deleteSetupLinkToken', () => {
    it('deletes the token key from Redis', async () => {
      const redis = makeRedisMock();

      await deleteSetupLinkToken(redis, 'used-token');

      expect(redis.del).toHaveBeenCalledTimes(1);
      expect(redis.del).toHaveBeenCalledWith('auth:setup-link:token:used-token');
    });

    it('is idempotent — calling del on a missing key is safe', async () => {
      const redis = makeRedisMock({
        del: vi.fn().mockResolvedValue(0), // key already gone
      });

      await expect(
        deleteSetupLinkToken(redis, 'already-deleted-token'),
      ).resolves.toBeUndefined();

      expect(redis.del).toHaveBeenCalledWith('auth:setup-link:token:already-deleted-token');
    });
  });
});
