import { describe, it, expect, beforeEach } from 'vitest';
import { CandleFetchBreaker, type BreakerConfig, type BreakerRedisStore } from './candle-fetch-breaker.js';
import { candleBreakerKey } from './redis-keys.js';

/** In-memory fake Redis for testing — no external dependency. */
class FakeRedisStore implements BreakerRedisStore {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ..._extraArgs: (string | number)[]): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    const existed = this.store.has(key);
    this.store.delete(key);
    return existed ? 1 : 0;
  }

  /** For assertions in tests. */
  has(key: string): boolean {
    return this.store.has(key);
  }

  getRaw(key: string): string | undefined {
    return this.store.get(key);
  }
}

function makeConfig(overrides: Partial<BreakerConfig> = {}): BreakerConfig {
  return {
    failScansBeforeOpen: 3,
    baseSkipScans: 2,
    maxSkipScans: 8,
    breakerStateTtlSeconds: 86400,
    ...overrides,
  };
}

const AGENT_ID = 'agent-1';
const SYMBOL = 'BTCUSDT';
const KEY = candleBreakerKey(AGENT_ID, SYMBOL);

describe('CandleFetchBreaker', () => {
  let redis: FakeRedisStore;
  let breaker: CandleFetchBreaker;

  beforeEach(() => {
    redis = new FakeRedisStore();
  });

  describe('shouldSkip', () => {
    it('returns false (fail-open) when key is absent', async () => {
      breaker = new CandleFetchBreaker(redis, makeConfig());
      const skip = await breaker.shouldSkip(AGENT_ID, SYMBOL, 100);
      expect(skip).toBe(false);
    });

    it('returns false when skipUntilScanEpoch is in the past', async () => {
      breaker = new CandleFetchBreaker(redis, makeConfig());
      // Manually store an expired breaker state
      await redis.set(
        KEY,
        JSON.stringify({ failCount: 0, skipUntilScanEpoch: 50, timesOpened: 1 }),
      );

      const skip = await breaker.shouldSkip(AGENT_ID, SYMBOL, 100);
      expect(skip).toBe(false);
    });

    it('returns true when current epoch is before skipUntilScanEpoch', async () => {
      breaker = new CandleFetchBreaker(redis, makeConfig());
      await redis.set(
        KEY,
        JSON.stringify({ failCount: 0, skipUntilScanEpoch: 100, timesOpened: 1 }),
      );

      const skip = await breaker.shouldSkip(AGENT_ID, SYMBOL, 50);
      expect(skip).toBe(true);
    });

    it('returns false for corrupt JSON state', async () => {
      breaker = new CandleFetchBreaker(redis, makeConfig());
      await redis.set(KEY, '{not valid json');

      const skip = await breaker.shouldSkip(AGENT_ID, SYMBOL, 50);
      expect(skip).toBe(false);
    });
  });

  describe('recordSuccess', () => {
    it('clears breaker state from Redis', async () => {
      breaker = new CandleFetchBreaker(redis, makeConfig());
      await redis.set(
        KEY,
        JSON.stringify({ failCount: 2, skipUntilScanEpoch: null, timesOpened: 0 }),
      );

      await breaker.recordSuccess(AGENT_ID, SYMBOL);

      const raw = await redis.get(KEY);
      expect(raw).toBeNull();
    });
  });

  describe('recordFailure', () => {
    it('increments failCount but does not open when below threshold', async () => {
      breaker = new CandleFetchBreaker(redis, makeConfig({ failScansBeforeOpen: 3 }));

      await breaker.recordFailure(AGENT_ID, SYMBOL, 100);

      const raw = await redis.get(KEY);
      const state = JSON.parse(raw!);
      expect(state.failCount).toBe(1);
      expect(state.skipUntilScanEpoch).toBeNull();
      expect(state.timesOpened).toBe(0);
    });

    it('opens the breaker when failCount reaches threshold', async () => {
      breaker = new CandleFetchBreaker(redis, makeConfig({ failScansBeforeOpen: 2 }));

      await breaker.recordFailure(AGENT_ID, SYMBOL, 100); // failCount=1
      await breaker.recordFailure(AGENT_ID, SYMBOL, 100); // failCount=2 → opens

      const raw = await redis.get(KEY);
      const state = JSON.parse(raw!);
      expect(state.skipUntilScanEpoch).toBe(102); // 100 + baseSkipScans(2)
      expect(state.timesOpened).toBe(1);
      expect(state.failCount).toBe(0); // reset after opening
    });

    it('skipUntilScanEpoch causes shouldSkip to return true', async () => {
      breaker = new CandleFetchBreaker(redis, makeConfig({ failScansBeforeOpen: 2 }));

      await breaker.recordFailure(AGENT_ID, SYMBOL, 100);
      await breaker.recordFailure(AGENT_ID, SYMBOL, 100); // opens, skipUntil=102

      // At epoch 101, should be skipped
      const skip = await breaker.shouldSkip(AGENT_ID, SYMBOL, 101);
      expect(skip).toBe(true);

      // At epoch 103, breaker should be expired
      const skip2 = await breaker.shouldSkip(AGENT_ID, SYMBOL, 103);
      expect(skip2).toBe(false);
    });

    it('exponential backoff increases skip duration with each opening', async () => {
      breaker = new CandleFetchBreaker(redis, makeConfig({
        failScansBeforeOpen: 1, // opens every failure
        baseSkipScans: 2,
        maxSkipScans: 100,
      }));

      // First opening
      await breaker.recordFailure(AGENT_ID, SYMBOL, 0); // opens, skipUntil=2 (0+2)
      let state = JSON.parse((await redis.get(KEY))!);
      expect(state.skipUntilScanEpoch).toBe(2);
      expect(state.timesOpened).toBe(1);

      // Second opening — baseSkipScans × 2^1 = 4
      await breaker.recordFailure(AGENT_ID, SYMBOL, 10); // opens, skipUntil=14 (10+4)
      state = JSON.parse((await redis.get(KEY))!);
      expect(state.skipUntilScanEpoch).toBe(14);
      expect(state.timesOpened).toBe(2);

      // Third opening — baseSkipScans × 2^2 = 8
      await breaker.recordFailure(AGENT_ID, SYMBOL, 20); // opens, skipUntil=28 (20+8)
      state = JSON.parse((await redis.get(KEY))!);
      expect(state.skipUntilScanEpoch).toBe(28);
      expect(state.timesOpened).toBe(3);
    });

    it('caps skip duration at maxSkipScans', async () => {
      breaker = new CandleFetchBreaker(redis, makeConfig({
        failScansBeforeOpen: 1,
        baseSkipScans: 2,
        maxSkipScans: 3,
      }));

      // First: 2, second: 4→capped to 3, third: 8→capped to 3
      await breaker.recordFailure(AGENT_ID, SYMBOL, 0);
      let state = JSON.parse((await redis.get(KEY))!);
      expect(state.skipUntilScanEpoch).toBe(2);

      await breaker.recordFailure(AGENT_ID, SYMBOL, 10);
      state = JSON.parse((await redis.get(KEY))!);
      expect(state.skipUntilScanEpoch).toBe(13); // 10 + min(4, 3)

      await breaker.recordFailure(AGENT_ID, SYMBOL, 20);
      state = JSON.parse((await redis.get(KEY))!);
      expect(state.skipUntilScanEpoch).toBe(23); // 20 + min(8, 3)
    });

    it('handles corrupt state gracefully by resetting', async () => {
      breaker = new CandleFetchBreaker(redis, makeConfig({ failScansBeforeOpen: 1 }));
      // Corrupt the key before the breaker reads it
      await redis.set(KEY, '{corrupt');

      await breaker.recordFailure(AGENT_ID, SYMBOL, 100);

      const raw = await redis.get(KEY);
      const state = JSON.parse(raw!);
      // Should reset and treat as first failure → opens immediately (threshold=1)
      expect(state.skipUntilScanEpoch).toBe(102);
      expect(state.timesOpened).toBe(1);
    });
  });

  describe('breaker cycle', () => {
    it('full cycle: fail → open → skip → expire → fail again → open again', async () => {
      breaker = new CandleFetchBreaker(redis, makeConfig({ failScansBeforeOpen: 2 }));

      // Fail twice to open
      await breaker.recordFailure(AGENT_ID, SYMBOL, 10);
      await breaker.recordFailure(AGENT_ID, SYMBOL, 10); // opens, skipUntil=12

      // Should skip at epoch 11
      expect(await breaker.shouldSkip(AGENT_ID, SYMBOL, 11)).toBe(true);

      // Expire at epoch 13
      expect(await breaker.shouldSkip(AGENT_ID, SYMBOL, 13)).toBe(false);

      // Fail twice again to re-open
      await breaker.recordFailure(AGENT_ID, SYMBOL, 20);
      await breaker.recordFailure(AGENT_ID, SYMBOL, 20); // opens, skipUntil=24 (20 + 2*2)

      // Should skip with extended duration
      expect(await breaker.shouldSkip(AGENT_ID, SYMBOL, 21)).toBe(true);
    });

    it('recordSuccess resets state so future failures start from zero', async () => {
      breaker = new CandleFetchBreaker(redis, makeConfig({ failScansBeforeOpen: 3 }));

      // Build up 2 failures
      await breaker.recordFailure(AGENT_ID, SYMBOL, 100);
      await breaker.recordFailure(AGENT_ID, SYMBOL, 100);

      // Success clears it
      await breaker.recordSuccess(AGENT_ID, SYMBOL);

      // Fail again — count should restart at 1
      await breaker.recordFailure(AGENT_ID, SYMBOL, 200);
      const state = JSON.parse((await redis.get(KEY))!);
      expect(state.failCount).toBe(1);
      expect(state.skipUntilScanEpoch).toBeNull();
    });
  });
});
