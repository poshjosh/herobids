import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  SERVER_HEALTH_PUBLISH_INTERVAL_MS,
  SERVER_HEALTH_TTL_SECONDS,
  serverHealthKey,
  type ServerType,
  type ServerHealthSnapshot,
} from './server-health.js';

/** Minimal Redis client interface — only the SET command is needed. */
export interface ServerHealthRedisClient {
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
}

/** Minimal logger interface — warn-level only for error reporting. */
export interface ServerHealthLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ServerHealthPublisherOptions {
  redis: ServerHealthRedisClient;
  serverType: ServerType;
  serverId?: string;
  version: string;
  collectMetadata: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  logger?: ServerHealthLogger;
}

/**
 * Periodically publishes a {@link ServerHealthSnapshot} to Redis.
 *
 * Each server process instantiates one publisher. The publisher collects
 * OS-level metrics (memory, disk, CPU%, load average, uptime) and
 * type-specific metadata via a callback, then writes a JSON snapshot
 * to a TTL-guarded Redis key.
 *
 * CPU% is computed as a delta of `process.cpuUsage()` between ticks —
 * same approach used by agent containers (see `getResourceUsage()` in
 * `apps/worker/src/agent.ts`).
 */
export class ServerHealthPublisher {
  private readonly redis: ServerHealthRedisClient;
  private readonly serverType: ServerType;
  private readonly serverId: string;
  private readonly hostname: string;
  private readonly version: string;
  private readonly collectMetadata: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  private readonly logger: ServerHealthLogger;

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastCpuTime: [number, number] | null = null;

  constructor(options: ServerHealthPublisherOptions) {
    this.redis = options.redis;
    this.serverType = options.serverType;
    this.serverId = options.serverId ?? os.hostname();
    this.hostname = os.hostname();
    this.version = options.version;
    this.collectMetadata = options.collectMetadata;
    this.logger = options.logger ?? {
      warn(_obj: Record<string, unknown>, msg: string) {
        // eslint-disable-next-line no-console
        console.warn(`[ServerHealthPublisher] ${msg}`);
      },
    };
  }

  start(): void {
    if (this.timer) return;
    // Publish immediately on start, then on the interval.
    void this.publish();
    this.timer = setInterval(() => void this.publish(), SERVER_HEALTH_PUBLISH_INTERVAL_MS);
    // Allow the process to exit even if the timer is still running.
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

  private async publish(): Promise<void> {
    try {
      const snapshot = await this.collectSnapshot();
      const key = serverHealthKey(this.serverType, this.serverId);
      await this.redis.set(key, JSON.stringify(snapshot), 'EX', SERVER_HEALTH_TTL_SECONDS);
    } catch (err: unknown) {
      this.logger.warn({ err }, 'Failed to publish server health snapshot');
    }
  }

  private async collectSnapshot(): Promise<ServerHealthSnapshot> {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = totalBytes - freeBytes;

    const disk = this.collectDisk();
    const cpuPct = this.collectCpuPct();
    const [l1, l5, l15] = os.loadavg();
    const metadata = await this.collectMetadata();

    return {
      serverType: this.serverType,
      serverId: this.serverId,
      hostname: this.hostname,
      memory: { totalBytes, usedBytes, freeBytes },
      disk,
      cpuPct,
      loadAvg: [l1 ?? 0, l5 ?? 0, l15 ?? 0],
      uptimeSeconds: Math.round(process.uptime()),
      version: this.version,
      updatedAt: new Date().toISOString(),
      metadata,
    };
  }

  private collectDisk(): ServerHealthSnapshot['disk'] {
    try {
      const stat = fs.statfsSync('/');
      const totalBytes = stat.blocks * stat.bsize;
      const freeBytes = stat.bfree * stat.bsize;
      return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
    } catch {
      return null;
    }
  }

  /** Compute CPU% from the delta of process.cpuUsage() since the last measurement. */
  private collectCpuPct(): number | null {
    try {
      const now = process.hrtime();
      const currentCpu = process.cpuUsage();

      if (this.lastCpuUsage && this.lastCpuTime) {
        const cpuDeltaUs =
          (currentCpu.user - this.lastCpuUsage.user) +
          (currentCpu.system - this.lastCpuUsage.system);
        const elapsedSec =
          (now[0] - this.lastCpuTime[0]) +
          (now[1] - this.lastCpuTime[1]) / 1e9;

        if (elapsedSec > 0) {
          this.lastCpuUsage = currentCpu;
          this.lastCpuTime = now;
          // cpuDeltaUs is in microseconds; convert to fraction of a second then to %.
          return Math.round((cpuDeltaUs / 1_000_000 / elapsedSec) * 100);
        }
      }

      // First call — seed the baseline, return null (no delta yet).
      this.lastCpuUsage = currentCpu;
      this.lastCpuTime = now;
      return null;
    } catch {
      return null;
    }
  }
}
