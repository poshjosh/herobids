import { Worker, Queue, Job } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import pino from 'pino';
import type { InstanceLease } from './instance-lease.js';

const QUEUE_NAME = 'trading-instance-lifecycle';

export type LifecycleCommand = 'start' | 'stop' | 'restart';

export interface LifecycleJob {
  command: LifecycleCommand;
  tradingInstanceId: string;
  config?: Record<string, unknown>;
}

export interface WorkerRuntimeConfig {
  redis: ConnectionOptions;
  /** Interval in ms between strategy scan ticks. Default: 5000 */
  scanIntervalMs?: number;
  /** Concurrency — number of instances this worker can run simultaneously. Default: 10 */
  concurrency?: number;
  /** Interval in ms between reclaim sweeps for orphaned instances. Default: 15000 (half of lease TTL) */
  reclaimIntervalMs?: number;
}

/** Persisted instance record needed for rehydration */
export interface PersistedInstance {
  id: string;
  config: Record<string, unknown>;
}

/**
 * InstanceActor — manages one running trading instance.
 * Owns the scan loop, heartbeat, and graceful stop.
 */
export interface InstanceActor {
  tradingInstanceId: string;
  start(): void | Promise<void>;
  stop(): Promise<void>;
}

export type ActorFactory = (tradingInstanceId: string, config: Record<string, unknown>) => InstanceActor;

/** Function that loads all instances marked 'running' from the DB */
export type InstanceLoader = () => Promise<PersistedInstance[]>;

/**
 * WorkerRuntime — manages BullMQ worker + active instance actors.
 * Lifecycle commands (start/stop/restart) come as BullMQ jobs.
 * Instances run as long-lived leased actors with internal scan timers.
 */
export class WorkerRuntime {
  private readonly logger = pino({ name: 'worker-runtime' });
  private readonly actors = new Map<string, InstanceActor>();
  private readonly queue: Queue;
  private readonly worker: Worker;
  private readonly instanceLoader?: InstanceLoader;
  private readonly lease?: InstanceLease;
  private readonly reclaimIntervalMs: number;
  private reclaimTimer?: ReturnType<typeof setInterval>;

  constructor(
    config: WorkerRuntimeConfig,
    private readonly actorFactory: ActorFactory,
    instanceLoader?: InstanceLoader,
    lease?: InstanceLease,
  ) {
    this.instanceLoader = instanceLoader;
    this.lease = lease;
    this.reclaimIntervalMs = config.reclaimIntervalMs ?? 15_000;

    this.queue = new Queue(QUEUE_NAME, { connection: config.redis });

    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job<LifecycleJob>) => this.processJob(job),
      {
        connection: config.redis,
        concurrency: config.concurrency ?? 10,
      },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'Job failed');
    });
  }

  /** Start the runtime — rehydrate running instances, begin reclaim loop, then process lifecycle jobs */
  async start(): Promise<void> {
    this.logger.info('Worker runtime started');

    // Initial rehydration: attempt to claim all instances marked 'running'
    await this.reclaimOrphans();

    // Periodic reclaim loop: sweep for instances whose leases expired (peer worker died)
    if (this.instanceLoader && this.lease) {
      this.reclaimTimer = setInterval(() => void this.reclaimOrphans(), this.reclaimIntervalMs);
    }
  }

  /** Graceful shutdown — stop all actors, release leases, close worker */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down worker runtime...');

    // Stop reclaim loop
    if (this.reclaimTimer) {
      clearInterval(this.reclaimTimer);
      this.reclaimTimer = undefined;
    }

    // Stop all actors gracefully
    const stopPromises = Array.from(this.actors.keys()).map((id) => this.stopInstance(id));
    await Promise.allSettled(stopPromises);

    if (this.lease) this.lease.shutdown();
    await this.worker.close();
    await this.queue.close();
    this.logger.info('Worker runtime shut down');
  }

  /** Get IDs of currently running instances */
  get activeInstances(): string[] {
    return Array.from(this.actors.keys());
  }

  /**
   * Reclaim sweep — load all instances marked 'running' in the DB
   * and attempt to acquire a lease on any that are not currently owned by this worker.
   * This handles both initial rehydration and ongoing peer-death recovery.
   */
  private async reclaimOrphans(): Promise<void> {
    if (!this.instanceLoader) return;

    try {
      const persisted = await this.instanceLoader();
      let claimed = 0;
      for (const instance of persisted) {
        // Skip instances we already own
        if (this.actors.has(instance.id)) continue;
        const started = await this.startInstance(instance.id, instance.config);
        if (started) claimed++;
      }
      if (claimed > 0) {
        this.logger.info({ claimed }, 'Reclaimed orphaned instances');
      }
    } catch (err) {
      this.logger.error({ err }, 'Reclaim sweep failed');
    }
  }

  private async processJob(job: Job<LifecycleJob>): Promise<void> {
    const { command, tradingInstanceId, config } = job.data;
    this.logger.info({ command, tradingInstanceId }, 'Processing lifecycle command');

    switch (command) {
      case 'start':
        await this.startInstance(tradingInstanceId, config ?? {});
        break;
      case 'stop':
        await this.stopInstance(tradingInstanceId);
        break;
      case 'restart':
        await this.stopInstance(tradingInstanceId);
        await this.startInstance(tradingInstanceId, config ?? {});
        break;
    }
  }

  private async startInstance(id: string, config: Record<string, unknown>): Promise<boolean> {
    if (this.actors.has(id)) {
      this.logger.warn({ tradingInstanceId: id }, 'Instance already running, skipping start');
      return false;
    }

    // Acquire distributed lease before starting
    if (this.lease) {
      const acquired = await this.lease.acquire(id);
      if (!acquired) {
        this.logger.info({ tradingInstanceId: id }, 'Lease held by another worker, skipping');
        return false;
      }
    }

    const actor = this.actorFactory(id, config);
    this.actors.set(id, actor);
    await actor.start();
    this.logger.info({ tradingInstanceId: id }, 'Instance started');
    return true;
  }

  private async stopInstance(id: string): Promise<void> {
    const actor = this.actors.get(id);
    if (!actor) {
      this.logger.warn({ tradingInstanceId: id }, 'Instance not running, skipping stop');
      return;
    }
    await actor.stop();
    this.actors.delete(id);

    // Release distributed lease
    if (this.lease) {
      await this.lease.release(id);
    }

    this.logger.info({ tradingInstanceId: id }, 'Instance stopped');
  }
}

export { QUEUE_NAME };
