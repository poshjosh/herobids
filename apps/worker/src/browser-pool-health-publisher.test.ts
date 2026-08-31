import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_HEALTH_TTL_SECONDS } from '@herobids/domain';
import {
  BrowserPoolHealthPublisher,
  type BrowserPoolConfig,
  type BrowserPoolHealthPublisherOptions,
} from './browser-pool-health-publisher.js';
import type { NomadClient } from './agents/nomad-client.js';
import type { ServerHealthRedisClient, ServerHealthLogger } from '@herobids/domain';

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockRedis(): ServerHealthRedisClient & { set: ReturnType<typeof vi.fn> } {
  return { set: vi.fn().mockResolvedValue('OK') };
}

function mockLogger(): ServerHealthLogger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

function mockNomadClient(entries: { address: string; port: number }[] = []): NomadClient {
  return {
    resolveAllServices: vi.fn().mockResolvedValue(entries),
  } as unknown as NomadClient;
}

const PRESSURE_RESPONSE = {
  pressure: {
    cpu: 25,
    memory: 42,
    isAvailable: true,
    maxConcurrent: 10,
    maxQueued: 5,
    running: 3,
    queued: 1,
    recentlyRejected: 0,
  },
};

const CONFIG_RESPONSE = { concurrent: 8 };
const SESSIONS_RESPONSE = [{ id: 's1' }, { id: 's2' }];

function createOptions(overrides: Partial<BrowserPoolHealthPublisherOptions> = {}): BrowserPoolHealthPublisherOptions {
  return {
    redis: mockRedis(),
    browserPool: { enabled: true, url: 'http://browserless:3000' },
    nomadClient: undefined,
    logger: mockLogger(),
    appVersion: '1.0.0-test',
    ...overrides,
  };
}

// ── Fetch stub ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('BrowserPoolHealthPublisher', () => {
  describe('start / stop lifecycle', () => {
    it('is a no-op when browserPool.enabled is false', async () => {
      const redis = mockRedis();
      const publisher = new BrowserPoolHealthPublisher(
        createOptions({ redis, browserPool: { enabled: false, url: '' } }),
      );

      publisher.start();
      // Advance past several intervals — nothing should happen.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(redis.set).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not start a second timer if start() is called twice', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify(PRESSURE_RESPONSE), { status: 200 }));
      const redis = mockRedis();
      const publisher = new BrowserPoolHealthPublisher(createOptions({ redis }));

      publisher.start();
      publisher.start();

      // Let the initial publishAll() resolve.
      await vi.advanceTimersByTimeAsync(0);

      // Only one immediate publish call, not two.
      expect(redis.set).toHaveBeenCalledTimes(1);
      publisher.stop();
    });

    it('stop() clears the timer so no further publishes occur', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify(PRESSURE_RESPONSE), { status: 200 }));
      const redis = mockRedis();
      const publisher = new BrowserPoolHealthPublisher(createOptions({ redis }));

      publisher.start();
      await vi.advanceTimersByTimeAsync(0); // flush initial publish
      expect(redis.set).toHaveBeenCalledTimes(1);

      publisher.stop();

      // Advance past several intervals.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(redis.set).toHaveBeenCalledTimes(1); // no additional calls
    });

    it('stop() is safe to call when not started', () => {
      const publisher = new BrowserPoolHealthPublisher(createOptions());
      expect(() => publisher.stop()).not.toThrow();
    });
  });

  describe('instance resolution', () => {
    it('uses static URL from config when url is present', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify(PRESSURE_RESPONSE), { status: 200 }));
      const redis = mockRedis();
      const publisher = new BrowserPoolHealthPublisher(
        createOptions({ redis, browserPool: { enabled: true, url: 'http://my-browser:4000/' } }),
      );

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      // fetch should be called with the static URL (trailing slash stripped), /pressure appended.
      const calledUrl = (mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl).toBe('http://my-browser:4000/pressure');
      publisher.stop();
    });

    it('uses Nomad discovery when url is empty and nomadClient is provided', async () => {
      mockFetch.mockImplementation(async () =>
        new Response(JSON.stringify(PRESSURE_RESPONSE), { status: 200 }),
      );
      const redis = mockRedis();
      const nomad = mockNomadClient([
        { address: '10.0.0.1', port: 3000 },
        { address: '10.0.0.2', port: 3001 },
      ]);
      const publisher = new BrowserPoolHealthPublisher(
        createOptions({ redis, browserPool: { enabled: true, url: '' }, nomadClient: nomad }),
      );

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(nomad.resolveAllServices).toHaveBeenCalledWith('browser-pool');
      // Two instances → two snapshots published.
      expect(redis.set).toHaveBeenCalledTimes(2);
      // Verify both instance URLs were fetched.
      const fetchedUrls = mockFetch.mock.calls.map(c => c[0] as string);
      expect(fetchedUrls).toContain('http://10.0.0.1:3000/pressure');
      expect(fetchedUrls).toContain('http://10.0.0.2:3001/pressure');
      publisher.stop();
    });

    it('resolves zero instances when url is empty and no nomadClient', async () => {
      const redis = mockRedis();
      const publisher = new BrowserPoolHealthPublisher(
        createOptions({ redis, browserPool: { enabled: true, url: '' }, nomadClient: undefined }),
      );

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
      publisher.stop();
    });
  });

  describe('/pressure success path', () => {
    it('publishes a correct snapshot from /pressure data', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify(PRESSURE_RESPONSE), { status: 200 }));
      const redis = mockRedis();
      const publisher = new BrowserPoolHealthPublisher(
        createOptions({
          redis,
          browserPool: { enabled: true, url: 'http://bp-host:3000' },
          appVersion: '2.5.0',
        }),
      );

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(redis.set).toHaveBeenCalledTimes(1);
      const [key, json, exFlag, ttl] = redis.set.mock.calls[0]!;

      expect(key).toBe('herobids:server-health:browser-pool:bp-bp-host:3000');
      expect(exFlag).toBe('EX');
      expect(ttl).toBe(SERVER_HEALTH_TTL_SECONDS);

      const snapshot = JSON.parse(json as string);
      expect(snapshot.serverType).toBe('browser-pool');
      expect(snapshot.serverId).toBe('bp-bp-host:3000');
      expect(snapshot.hostname).toBe('bp-bp-host:3000');
      expect(snapshot.version).toBe('2.5.0');

      // Memory is encoded as percentage: total=100, used=memoryPressure, free=100-memory.
      expect(snapshot.memory).toEqual({
        totalBytes: 100,
        usedBytes: 42,
        freeBytes: 58,
      });
      expect(snapshot.cpuPct).toBe(25);
      expect(snapshot.disk).toBeNull();
      expect(snapshot.loadAvg).toEqual([0, 0, 0]);
      expect(snapshot.uptimeSeconds).toBe(0);

      // Metadata carries raw Browserless metrics.
      expect(snapshot.metadata).toEqual({
        activeSessions: 3,
        maxConcurrentSessions: 10,
        queuedRequests: 1,
        recentlyRejected: 0,
        isAvailable: true,
        cpuPressure: 25,
        memoryPressure: 42,
      });

      expect(snapshot.updatedAt).toBeDefined();
      publisher.stop();
    });
  });

  describe('/pressure fallback to /config + /sessions', () => {
    it('falls back to /config and /sessions when /pressure returns non-ok', async () => {
      mockFetch.mockImplementation(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/pressure')) return new Response('Not Found', { status: 404 });
        if (url.endsWith('/config')) return new Response(JSON.stringify(CONFIG_RESPONSE), { status: 200 });
        if (url.endsWith('/sessions')) return new Response(JSON.stringify(SESSIONS_RESPONSE), { status: 200 });
        return new Response('Not Found', { status: 404 });
      });

      const redis = mockRedis();
      const publisher = new BrowserPoolHealthPublisher(
        createOptions({ redis, browserPool: { enabled: true, url: 'http://bp:3000' } }),
      );

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(redis.set).toHaveBeenCalledTimes(1);
      const snapshot = JSON.parse(redis.set.mock.calls[0]![1] as string);

      // Fallback metrics: cpu/memory=0, sessions from array length.
      expect(snapshot.metadata.activeSessions).toBe(2);
      expect(snapshot.metadata.maxConcurrentSessions).toBe(8);
      expect(snapshot.metadata.cpuPressure).toBe(0);
      expect(snapshot.metadata.memoryPressure).toBe(0);
      expect(snapshot.metadata.isAvailable).toBe(true);
      expect(snapshot.metadata.queuedRequests).toBe(0);
      publisher.stop();
    });

    it('falls back when /pressure fetch throws an error', async () => {
      let pressureCalled = false;
      mockFetch.mockImplementation(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/pressure')) {
          pressureCalled = true;
          throw new Error('connection refused');
        }
        if (url.endsWith('/config')) return new Response(JSON.stringify(CONFIG_RESPONSE), { status: 200 });
        if (url.endsWith('/sessions')) return new Response(JSON.stringify(SESSIONS_RESPONSE), { status: 200 });
        return new Response('Not Found', { status: 404 });
      });

      const redis = mockRedis();
      const publisher = new BrowserPoolHealthPublisher(
        createOptions({ redis, browserPool: { enabled: true, url: 'http://bp:3000' } }),
      );

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(pressureCalled).toBe(true);
      expect(redis.set).toHaveBeenCalledTimes(1);
      const snapshot = JSON.parse(redis.set.mock.calls[0]![1] as string);
      expect(snapshot.metadata.activeSessions).toBe(2);
      publisher.stop();
    });
  });

  describe('both /pressure and fallback failure', () => {
    it('skips instance silently when all endpoints fail', async () => {
      mockFetch.mockRejectedValue(new Error('all endpoints down'));

      const redis = mockRedis();
      const logger = mockLogger();
      const publisher = new BrowserPoolHealthPublisher(
        createOptions({ redis, logger, browserPool: { enabled: true, url: 'http://dead:3000' } }),
      );

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      // No snapshot should be published.
      expect(redis.set).not.toHaveBeenCalled();
      publisher.stop();
    });

    it('publishes for healthy instances even when one fails', async () => {
      const nomad = mockNomadClient([
        { address: '10.0.0.1', port: 3000 },
        { address: '10.0.0.2', port: 3001 },
      ]);

      mockFetch.mockImplementation(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        // First instance healthy, second completely down.
        if (url.startsWith('http://10.0.0.1:3000')) {
          return new Response(JSON.stringify(PRESSURE_RESPONSE), { status: 200 });
        }
        throw new Error('host unreachable');
      });

      const redis = mockRedis();
      const publisher = new BrowserPoolHealthPublisher(
        createOptions({
          redis,
          browserPool: { enabled: true, url: '' },
          nomadClient: nomad,
        }),
      );

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      // Only the healthy instance gets published.
      expect(redis.set).toHaveBeenCalledTimes(1);
      const key = redis.set.mock.calls[0]![0] as string;
      expect(key).toContain('10.0.0.1');
      publisher.stop();
    });
  });

  describe('deriveServerId', () => {
    it('derives serverId as bp-{hostname}:{port} from instance URL', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify(PRESSURE_RESPONSE), { status: 200 }));
      const redis = mockRedis();
      const publisher = new BrowserPoolHealthPublisher(
        createOptions({
          redis,
          browserPool: { enabled: true, url: 'http://my-host:4200' },
        }),
      );

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      const snapshot = JSON.parse(redis.set.mock.calls[0]![1] as string);
      expect(snapshot.serverId).toBe('bp-my-host:4200');
      publisher.stop();
    });

    it('defaults port to 3000 when URL has no explicit port', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify(PRESSURE_RESPONSE), { status: 200 }));
      const redis = mockRedis();
      const publisher = new BrowserPoolHealthPublisher(
        createOptions({
          redis,
          browserPool: { enabled: true, url: 'http://my-host' },
        }),
      );

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      const snapshot = JSON.parse(redis.set.mock.calls[0]![1] as string);
      expect(snapshot.serverId).toBe('bp-my-host:3000');
      publisher.stop();
    });

    it('uses Nomad-resolved address in serverId', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify(PRESSURE_RESPONSE), { status: 200 }));
      const redis = mockRedis();
      const nomad = mockNomadClient([{ address: '192.168.1.50', port: 9222 }]);
      const publisher = new BrowserPoolHealthPublisher(
        createOptions({
          redis,
          browserPool: { enabled: true, url: '' },
          nomadClient: nomad,
        }),
      );

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      const snapshot = JSON.parse(redis.set.mock.calls[0]![1] as string);
      expect(snapshot.serverId).toBe('bp-192.168.1.50:9222');
      publisher.stop();
    });
  });

  describe('never throws', () => {
    it('logs a warning when Redis.set fails but does not throw', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify(PRESSURE_RESPONSE), { status: 200 }));
      const redis = mockRedis();
      redis.set.mockRejectedValue(new Error('Redis connection lost'));
      const logger = mockLogger();

      const publisher = new BrowserPoolHealthPublisher(
        createOptions({ redis, logger, browserPool: { enabled: true, url: 'http://bp:3000' } }),
      );

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(logger.warn).toHaveBeenCalled();
      publisher.stop();
    });
  });
});
