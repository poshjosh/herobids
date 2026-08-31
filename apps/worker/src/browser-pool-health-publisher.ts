import {
  SERVER_HEALTH_PUBLISH_INTERVAL_MS,
  SERVER_HEALTH_TTL_SECONDS,
  serverHealthKey,
  type ServerHealthSnapshot,
} from '@herobids/domain';
import type { ServerHealthRedisClient, ServerHealthLogger } from '@herobids/domain';
import type { NomadClient } from './agents/nomad-client.js';

// ── Browserless response shapes ─────────────────────────────────────────────

interface BrowserlessPressure {
  pressure: {
    cpu: number;
    memory: number;
    isAvailable: boolean;
    maxConcurrent: number;
    maxQueued: number;
    running: number;
    queued: number;
    recentlyRejected: number;
  };
}

interface BrowserlessConfig {
  concurrent: number;
}

interface BrowserlessSession {
  // Only the array length is used (running session count).
  [key: string]: unknown;
}

// ── Timeout helper ──────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 5_000;

function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timeout));
}

// ── Config subset ───────────────────────────────────────────────────────────

export interface BrowserPoolConfig {
  enabled: boolean;
  url: string;
}

// ── Publisher ───────────────────────────────────────────────────────────────

export interface BrowserPoolHealthPublisherOptions {
  redis: ServerHealthRedisClient;
  browserPool: BrowserPoolConfig;
  nomadClient: NomadClient | undefined;
  logger: ServerHealthLogger;
  appVersion: string;
}

/**
 * Periodically polls Browserless instances and publishes a
 * {@link ServerHealthSnapshot} per instance to Redis.
 *
 * In dev (static URL from config), a single instance is polled.
 * In production (Nomad), all instances are discovered via the service catalog.
 *
 * Metrics come from the Browserless `/pressure` endpoint. If `/pressure` is
 * unavailable (404 or error), falls back to `/config` + `/sessions`.
 */
export class BrowserPoolHealthPublisher {
  private readonly redis: ServerHealthRedisClient;
  private readonly browserPool: BrowserPoolConfig;
  private readonly nomadClient: NomadClient | undefined;
  private readonly logger: ServerHealthLogger;
  private readonly appVersion: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: BrowserPoolHealthPublisherOptions) {
    this.redis = options.redis;
    this.browserPool = options.browserPool;
    this.nomadClient = options.nomadClient;
    this.logger = options.logger;
    this.appVersion = options.appVersion;
  }

  start(): void {
    if (!this.browserPool.enabled) return;
    if (this.timer) return;

    void this.publishAll();
    this.timer = setInterval(() => void this.publishAll(), SERVER_HEALTH_PUBLISH_INTERVAL_MS);
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── Core loop ───────────────────────────────────────────────────────────

  private async publishAll(): Promise<void> {
    try {
      const instances = await this.resolveInstances();
      await Promise.allSettled(instances.map(url => this.publishInstance(url)));
    } catch (err: unknown) {
      this.logger.warn({ err }, 'Browser-pool health publish cycle failed');
    }
  }

  private async resolveInstances(): Promise<string[]> {
    // Static URL from config takes precedence (dev / simple deployments).
    if (this.browserPool.url) {
      return [this.browserPool.url.replace(/\/+$/, '')];
    }

    // Nomad service discovery — resolve all healthy instances.
    if (this.nomadClient) {
      const entries = await this.nomadClient.resolveAllServices('browser-pool');
      return entries.map(e => `http://${e.address}:${e.port}`);
    }

    return [];
  }

  // ── Per-instance publishing ─────────────────────────────────────────────

  private async publishInstance(baseUrl: string): Promise<void> {
    try {
      const metrics = await this.collectMetrics(baseUrl);
      if (!metrics) return;

      const serverId = this.deriveServerId(baseUrl);
      const snapshot: ServerHealthSnapshot = {
        serverType: 'browser-pool',
        serverId,
        hostname: serverId,
        memory: {
          totalBytes: 100,
          usedBytes: Math.round(metrics.memoryPressure),
          freeBytes: 100 - Math.round(metrics.memoryPressure),
        },
        disk: null,
        cpuPct: Math.round(metrics.cpuPressure),
        loadAvg: [0, 0, 0],
        uptimeSeconds: 0,
        version: this.appVersion,
        updatedAt: new Date().toISOString(),
        metadata: {
          activeSessions: metrics.running,
          maxConcurrentSessions: metrics.maxConcurrent,
          queuedRequests: metrics.queued,
          recentlyRejected: metrics.recentlyRejected,
          isAvailable: metrics.isAvailable,
          cpuPressure: metrics.cpuPressure,
          memoryPressure: metrics.memoryPressure,
        },
      };

      const key = serverHealthKey('browser-pool', serverId);
      await this.redis.set(key, JSON.stringify(snapshot), 'EX', SERVER_HEALTH_TTL_SECONDS);
    } catch (err: unknown) {
      this.logger.warn({ err, baseUrl }, 'Failed to publish browser-pool health for instance');
    }
  }

  // ── Metrics collection ──────────────────────────────────────────────────

  private async collectMetrics(baseUrl: string): Promise<BrowserPoolMetrics | null> {
    const pressureMetrics = await this.tryPressure(baseUrl);
    if (pressureMetrics) return pressureMetrics;

    // Fallback: /config + /sessions
    return this.tryConfigAndSessions(baseUrl);
  }

  private async tryPressure(baseUrl: string): Promise<BrowserPoolMetrics | null> {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/pressure`);
      if (!res.ok) return null;

      const data = (await res.json()) as BrowserlessPressure;
      const p = data.pressure;
      return {
        cpuPressure: p.cpu,
        memoryPressure: p.memory,
        isAvailable: p.isAvailable,
        maxConcurrent: p.maxConcurrent,
        running: p.running,
        queued: p.queued,
        recentlyRejected: p.recentlyRejected,
      };
    } catch {
      return null;
    }
  }

  private async tryConfigAndSessions(baseUrl: string): Promise<BrowserPoolMetrics | null> {
    try {
      const [configRes, sessionsRes] = await Promise.all([
        fetchWithTimeout(`${baseUrl}/config`),
        fetchWithTimeout(`${baseUrl}/sessions`),
      ]);

      if (!configRes.ok || !sessionsRes.ok) return null;

      const config = (await configRes.json()) as BrowserlessConfig;
      const sessions = (await sessionsRes.json()) as BrowserlessSession[];

      return {
        cpuPressure: 0,
        memoryPressure: 0,
        isAvailable: true,
        maxConcurrent: config.concurrent,
        running: sessions.length,
        queued: 0,
        recentlyRejected: 0,
      };
    } catch {
      return null;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private deriveServerId(baseUrl: string): string {
    try {
      const url = new URL(baseUrl);
      return `bp-${url.hostname}:${url.port || '3000'}`;
    } catch {
      return `bp-${baseUrl}`;
    }
  }
}

// ── Internal types ──────────────────────────────────────────────────────────

interface BrowserPoolMetrics {
  cpuPressure: number;
  memoryPressure: number;
  isAvailable: boolean;
  maxConcurrent: number;
  running: number;
  queued: number;
  recentlyRejected: number;
}
