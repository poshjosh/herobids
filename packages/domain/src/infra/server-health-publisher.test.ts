import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import {
  ServerHealthPublisher,
  type ServerHealthRedisClient,
  type ServerHealthLogger,
} from './server-health-publisher.js';
import { SERVER_HEALTH_TTL_SECONDS, SERVER_HEALTH_PUBLISH_INTERVAL_MS } from './server-health.js';
import type { ServerHealthSnapshot } from './server-health.js';

/**
 * Mock the `node:fs` module so we can control `statfsSync` in ESM.
 * `vi.mock` is hoisted above imports, making the namespace configurable.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statfsSync: vi.fn(actual.statfsSync) };
});
// Import the mocked version *after* `vi.mock` declaration (vitest hoists automatically).
const fs = await import('node:fs');

// ---------------------------------------------------------------------------
// Fakes / Helpers
// ---------------------------------------------------------------------------

class FakeRedis implements ServerHealthRedisClient {
  readonly calls: Array<{ key: string; value: string; args: unknown[] }> = [];
  shouldThrow = false;

  async set(key: string, value: string, ...args: unknown[]): Promise<unknown> {
    if (this.shouldThrow) throw new Error('Redis SET failed');
    this.calls.push({ key, value, args });
    return 'OK';
  }

  /** Return the last published snapshot parsed as JSON, or undefined. */
  lastSnapshot(): ServerHealthSnapshot | undefined {
    const last = this.calls.at(-1);
    return last ? (JSON.parse(last.value) as ServerHealthSnapshot) : undefined;
  }
}

function fakeLogger(): ServerHealthLogger & { warnings: Array<{ obj: Record<string, unknown>; msg: string }> } {
  const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return {
    warnings,
    warn(obj: Record<string, unknown>, msg: string) {
      warnings.push({ obj, msg });
    },
  };
}

function makePublisher(overrides: Partial<ConstructorParameters<typeof ServerHealthPublisher>[0]> = {}) {
  const redis = new FakeRedis();
  const logger = fakeLogger();
  const collectMetadata = vi.fn().mockResolvedValue({ runningSessions: 3 });

  const publisher = new ServerHealthPublisher({
    redis,
    serverType: 'control-plane',
    serverId: 'test-srv',
    version: '1.2.3',
    collectMetadata,
    logger,
    ...overrides,
  });

  return { publisher, redis, logger, collectMetadata };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ServerHealthPublisher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ---- Constructor --------------------------------------------------------

  describe('constructor', () => {
    it('defaults serverId to os.hostname() when not provided', async () => {
      const redis = new FakeRedis();
      const publisher = new ServerHealthPublisher({
        redis,
        serverType: 'agent-server',
        version: '0.1.0',
        collectMetadata: () => ({}),
      });

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      const snap = redis.lastSnapshot();
      expect(snap).toBeDefined();
      expect(snap!.serverId).toBe(os.hostname());
      publisher.stop();
    });
  });

  // ---- start / stop -------------------------------------------------------

  describe('start', () => {
    it('publishes a snapshot immediately on start', async () => {
      const { publisher, redis } = makePublisher();
      publisher.start();

      await vi.advanceTimersByTimeAsync(0);

      expect(redis.calls).toHaveLength(1);
      publisher.stop();
    });

    it('publishes subsequent snapshots on the configured interval', async () => {
      const { publisher, redis } = makePublisher();
      publisher.start();

      // Immediate publish.
      await vi.advanceTimersByTimeAsync(0);
      expect(redis.calls).toHaveLength(1);

      // Advance by one interval.
      await vi.advanceTimersByTimeAsync(SERVER_HEALTH_PUBLISH_INTERVAL_MS);
      expect(redis.calls).toHaveLength(2);

      // Advance again.
      await vi.advanceTimersByTimeAsync(SERVER_HEALTH_PUBLISH_INTERVAL_MS);
      expect(redis.calls).toHaveLength(3);

      publisher.stop();
    });

    it('does not create duplicate intervals when called twice', async () => {
      const { publisher, redis } = makePublisher();
      publisher.start();
      publisher.start(); // second call — should be a no-op

      await vi.advanceTimersByTimeAsync(0);
      // Only one immediate publish, not two.
      expect(redis.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(SERVER_HEALTH_PUBLISH_INTERVAL_MS);
      // One interval tick, not two.
      expect(redis.calls).toHaveLength(2);

      publisher.stop();
    });
  });

  describe('stop', () => {
    it('clears the interval so no further publishes occur', async () => {
      const { publisher, redis } = makePublisher();
      publisher.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(redis.calls).toHaveLength(1);

      publisher.stop();

      await vi.advanceTimersByTimeAsync(SERVER_HEALTH_PUBLISH_INTERVAL_MS * 5);
      // No additional publishes after stop.
      expect(redis.calls).toHaveLength(1);
    });

    it('is safe to call when not started', () => {
      const { publisher } = makePublisher();
      // Should not throw.
      expect(() => publisher.stop()).not.toThrow();
    });
  });

  // ---- Snapshot contents --------------------------------------------------

  describe('published snapshot', () => {
    it('contains all required ServerHealthSnapshot fields', async () => {
      const { publisher, redis } = makePublisher();
      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      const snap = redis.lastSnapshot()!;
      expect(snap.serverType).toBe('control-plane');
      expect(snap.serverId).toBe('test-srv');
      expect(snap.hostname).toBe(os.hostname());
      expect(snap.version).toBe('1.2.3');
      expect(snap.memory).toEqual(
        expect.objectContaining({
          totalBytes: expect.any(Number),
          usedBytes: expect.any(Number),
          freeBytes: expect.any(Number),
        }),
      );
      expect(snap.loadAvg).toHaveLength(3);
      expect(typeof snap.uptimeSeconds).toBe('number');
      expect(snap.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(snap.metadata).toEqual({ runningSessions: 3 });

      publisher.stop();
    });

    it('writes to the correct Redis key with EX TTL', async () => {
      const { publisher, redis } = makePublisher();
      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      const call = redis.calls[0]!;
      expect(call.key).toBe('herobids:server-health:control-plane:test-srv');
      expect(call.args).toEqual(['EX', SERVER_HEALTH_TTL_SECONDS]);

      publisher.stop();
    });

    it('includes metadata from the collectMetadata callback', async () => {
      const collectMetadata = vi.fn().mockResolvedValue({ customField: 'abc', count: 7 });
      const { publisher, redis } = makePublisher({ collectMetadata });
      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(redis.lastSnapshot()!.metadata).toEqual({ customField: 'abc', count: 7 });
      publisher.stop();
    });
  });

  // ---- CPU% ---------------------------------------------------------------

  describe('cpuPct', () => {
    it('returns null on the first tick (no delta baseline)', async () => {
      const { publisher, redis } = makePublisher();
      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(redis.lastSnapshot()!.cpuPct).toBeNull();
      publisher.stop();
    });

    it('returns a number on subsequent ticks', async () => {
      const { publisher, redis } = makePublisher();
      publisher.start();

      // First tick — seeds baseline.
      await vi.advanceTimersByTimeAsync(0);
      expect(redis.lastSnapshot()!.cpuPct).toBeNull();

      // Second tick — delta available.
      await vi.advanceTimersByTimeAsync(SERVER_HEALTH_PUBLISH_INTERVAL_MS);
      const cpuPct = redis.lastSnapshot()!.cpuPct;
      expect(cpuPct).not.toBeNull();
      expect(typeof cpuPct).toBe('number');

      publisher.stop();
    });
  });

  // ---- Disk collection ----------------------------------------------------

  describe('disk', () => {
    it('returns null when fs.statfsSync throws', async () => {
      vi.mocked(fs.statfsSync).mockImplementation(() => {
        throw new Error('statfsSync not available');
      });

      const { publisher, redis } = makePublisher();
      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(redis.lastSnapshot()!.disk).toBeNull();
      publisher.stop();
    });

    it('returns disk stats when fs.statfsSync succeeds', async () => {
      vi.mocked(fs.statfsSync).mockReturnValue({
        blocks: 1000,
        bsize: 4096,
        bfree: 400,
        bavail: 350,
        files: 0,
        ffree: 0,
        type: 0,
      } as unknown as fs.StatsFsResult);

      const { publisher, redis } = makePublisher();
      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      const disk = redis.lastSnapshot()!.disk;
      expect(disk).not.toBeNull();
      expect(disk!.totalBytes).toBe(1000 * 4096);
      expect(disk!.freeBytes).toBe(400 * 4096);
      expect(disk!.usedBytes).toBe((1000 - 400) * 4096);

      publisher.stop();
    });
  });

  // ---- Error handling -----------------------------------------------------

  describe('error handling', () => {
    it('catches Redis SET errors and logs a warning', async () => {
      const { publisher, redis, logger } = makePublisher();
      redis.shouldThrow = true;

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(logger.warnings).toHaveLength(1);
      expect(logger.warnings[0]!.msg).toBe('Failed to publish server health snapshot');
      publisher.stop();
    });

    it('catches errors in collectMetadata and logs a warning', async () => {
      const collectMetadata = vi.fn().mockRejectedValue(new Error('metadata boom'));
      const { publisher, logger } = makePublisher({ collectMetadata });

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(logger.warnings).toHaveLength(1);
      expect(logger.warnings[0]!.msg).toBe('Failed to publish server health snapshot');
      publisher.stop();
    });

    it('continues publishing after a transient error', async () => {
      const { publisher, redis, logger } = makePublisher();
      redis.shouldThrow = true;

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(logger.warnings).toHaveLength(1);

      // Fix Redis and advance — should publish successfully.
      redis.shouldThrow = false;
      await vi.advanceTimersByTimeAsync(SERVER_HEALTH_PUBLISH_INTERVAL_MS);
      expect(redis.calls).toHaveLength(1);

      publisher.stop();
    });
  });

  // ---- Timer unref --------------------------------------------------------

  describe('timer unref', () => {
    it('calls unref on the interval timer so it does not block process exit', () => {
      const { publisher } = makePublisher();
      // Spy on global setInterval to intercept the timer handle.
      const unrefSpy = vi.fn();
      const originalSetInterval = globalThis.setInterval;
      vi.spyOn(globalThis, 'setInterval').mockImplementation((...args: Parameters<typeof setInterval>) => {
        const handle = originalSetInterval(...args);
        handle.unref = unrefSpy;
        return handle;
      });

      publisher.start();
      expect(unrefSpy).toHaveBeenCalled();

      publisher.stop();
    });
  });
});
