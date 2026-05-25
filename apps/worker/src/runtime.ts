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
  /** Called when an instance fails to start (factory or actor.start threw). Use to persist status. */
  onStartFailed?: (tradingInstanceId: string, error: Error) => Promise<void>;
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

export type ActorFactory = (tradingInstanceId: string, config: Record<string, unknown>) => InstanceActor | Promise<InstanceActor>;

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
  /** IDs currently in-flight (factory running). Only these can accept pending stops. */
  private readonly startingInstances = new Set<string>();
  /** IDs for which a stop was requested while the factory was still in-flight */
  private readonly pendingStops = new Set<string>();

  private readonly onStartFailed?: (tradingInstanceId: string, error: Error) => Promise<void>;

  constructor(
    config: WorkerRuntimeConfig,
    private readonly actorFactory: ActorFactory,
    instanceLoader?: InstanceLoader,
    lease?: InstanceLease,
  ) {
    this.instanceLoader = instanceLoader;
    this.lease = lease;
    this.reclaimIntervalMs = config.reclaimIntervalMs ?? 15_000;
    this.onStartFailed = config.onStartFailed;

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
   * Remove a crashed actor from the runtime's internal state and release its lease.
   * Called by the actor's onCrashed callback after persisting crashed status to DB.
   * Does NOT call actor.stop() (the actor already stopped itself).
   */
  async handleActorCrash(id: string): Promise<void> {
    this.actors.delete(id);
    if (this.lease) {
      await this.lease.release(id);
    }
    this.logger.warn({ tradingInstanceId: id }, 'Actor crash handled — removed from runtime');
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
        try {
          const started = await this.startInstance(instance.id, instance.config);
          if (started) claimed++;
        } catch (err) {
          this.logger.error({ err, tradingInstanceId: instance.id }, 'Failed to reclaim instance');
          if (this.onStartFailed) {
            await this.onStartFailed(instance.id, err instanceof Error ? err : new Error(String(err)));
          }
        }
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
        try {
          await this.startInstance(tradingInstanceId, config ?? {});
        } catch (err) {
          if (this.onStartFailed) {
            await this.onStartFailed(tradingInstanceId, err instanceof Error ? err : new Error(String(err)));
          }
          throw err;
        }
        break;
      case 'stop':
        await this.stopInstance(tradingInstanceId);
        break;
      case 'restart':
        await this.stopInstance(tradingInstanceId);
        try {
          await this.startInstance(tradingInstanceId, config ?? {});
        } catch (err) {
          if (this.onStartFailed) {
            await this.onStartFailed(tradingInstanceId, err instanceof Error ? err : new Error(String(err)));
          }
          throw err;
        }
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

    let actor: InstanceActor;
    this.startingInstances.add(id);
    try {
      actor = await this.actorFactory(id, config);
    } catch (err) {
      // Factory failed — release the lease so another worker (or retry) can claim the instance
      this.startingInstances.delete(id);
      this.pendingStops.delete(id);
      if (this.lease) {
        await this.lease.release(id);
      }
      throw err;
    }
    this.startingInstances.delete(id);

    // If a stop was requested while the factory was in-flight, abort before starting
    if (this.pendingStops.has(id)) {
      this.pendingStops.delete(id);
      this.logger.info({ tradingInstanceId: id }, 'Stop requested during factory — aborting start');
      if (this.lease) {
        await this.lease.release(id);
      }
      return false;
    }

    // Register early so concurrent stop/restart commands can find the actor during startup
    this.actors.set(id, actor);
    try {
      await actor.start();
      this.logger.info({ tradingInstanceId: id }, 'Instance started');
      return true;
    } catch (err) {
      this.actors.delete(id);
      try {
        await actor.stop();
      } catch (stopErr) {
        this.logger.error({ err: stopErr, tradingInstanceId: id }, 'Failed to clean up actor after startup error');
      }

      if (this.lease) {
        await this.lease.release(id);
      }

      throw err;
    }
  }

  private async stopInstance(id: string): Promise<void> {
    const actor = this.actors.get(id);
    if (!actor) {
      // Only queue a pending stop if there's actually an in-flight factory for this ID.
      // Without this guard, a stale stop (e.g. duplicate command) would poison the next start.
      if (this.startingInstances.has(id)) {
        this.pendingStops.add(id);
        this.logger.warn({ tradingInstanceId: id }, 'Instance starting — queued pending stop');
      } else {
        this.logger.warn({ tradingInstanceId: id }, 'Instance not running, skipping stop');
      }
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
