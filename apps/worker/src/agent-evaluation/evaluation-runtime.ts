import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { createLogger } from '../logger.js';
import type { Database } from '@herobids/db';
import { EVALUATION_QUEUE_NAME, markRunning, markTimedOut } from '@herobids/db';
import { agentEvaluations } from '@herobids/db';
import { eq, and, lt } from 'drizzle-orm';
import type { EvaluationJobData } from '@herobids/db';
import type { EvaluationThresholds } from '@herobids/domain';
import type { UsageBillingRepository } from '@herobids/db';
import type { TradertonClient } from '@herobids/domain/traderton';
import { runEvaluation } from './run-evaluation.js';
import { createRedisSnapshotClient, type RedisSnapshotClient } from './collectors/redis-snapshot.js';

// ── Config ──────────────────────────────────────────────────────────────────

export interface EvaluationRuntimeConfig {
  redis: { host: string; port: number; password?: string; username?: string; db?: number };
  concurrency?: number;
  /** Root directory for evaluation artifacts */
  storageRoot: string;
  /** Maximum runtime per job in milliseconds before timing out (default 120_000) */
  maxRuntimeMs?: number;
  /** Thresholds for deterministic analyzers */
  thresholds: EvaluationThresholds;
  /** Optional billing repository for recording narrative LLM usage */
  usageBillingRepo?: UsageBillingRepository;
  /**
   * Traderton read boundary client for sourcing agent trading evidence
   * (fills / journal / positions). When absent, the boundary is unconfigured
   * and evaluation of trading evidence fails closed at port-invocation time.
   */
  tradertonReadClient?: TradertonClient;
  /** Per-request deadline for boundary reads (ms). */
  tradertonReadTimeoutMs?: number;
}

// ── Logger ──────────────────────────────────────────────────────────────────

const logger = createLogger('evaluation-runtime');

// ── Runtime ─────────────────────────────────────────────────────────────────

/**
 * EvaluationRuntime — processes agent evaluation jobs via BullMQ.
 */
export class EvaluationRuntime {
  private worker: Worker<EvaluationJobData> | undefined;
  private reaperInterval: ReturnType<typeof setInterval> | undefined;
  private snapshotClient: RedisSnapshotClient | undefined;

  constructor(
    private readonly config: EvaluationRuntimeConfig,
    private readonly db: Database,
  ) {}

  start(): void {
    const maxRuntimeMs = this.config.maxRuntimeMs ?? 120_000;

    // Create a dedicated Redis client for snapshot collection (best-effort).
    // Uses the same connection config as BullMQ but is a separate connection
    // so snapshot queries don't interfere with job processing.
    try {
      const snapshotRedis = new Redis(this.config.redis);
      this.snapshotClient = createRedisSnapshotClient(snapshotRedis);
    } catch {
      logger.warn('Could not create Redis snapshot client — snapshots will be skipped');
    }

    this.worker = new Worker<EvaluationJobData>(
      EVALUATION_QUEUE_NAME,
      async (job) => {
        const { runId, agentId, resolvedScope, includeNarrative } = job.data;
        logger.info({ runId, agentId, scope: resolvedScope, attempt: job.attemptsMade + 1 }, 'Starting evaluation run');

        // Transition queued → running
        const started = await markRunning(this.db, runId);
        if (!started) {
          logger.warn({ runId }, 'Run was not in queued state — skipping');
          return;
        }

        // Run full evaluation pipeline. On failure, runEvaluation handles
        // the retry decision (markRetrying vs markFailed) based on attempt
        // count, then re-throws so BullMQ can schedule a retry if needed.
        await runEvaluation({
          db: this.db,
          runId,
          agentId,
          resolvedScope,
          includeNarrative,
          narrativeLlm: job.data.narrativeLlm,
          thresholds: this.config.thresholds,
          storageRoot: this.config.storageRoot,
          attemptNumber: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts ?? 3,
          redis: this.snapshotClient,
          usageBillingRepo: this.config.usageBillingRepo,
          tradertonReadClient: this.config.tradertonReadClient,
          tradertonReadTimeoutMs: this.config.tradertonReadTimeoutMs,
        });

        logger.info({ runId, agentId }, 'Evaluation completed');
      },
      {
        connection: this.config.redis,
        concurrency: this.config.concurrency ?? 2,
        lockDuration: maxRuntimeMs + 30_000,
        stalledInterval: 30_000,
      },
    );

    // Handle job timeouts via BullMQ's built-in stalled job detection
    this.worker.on('stalled', async (jobId) => {
      logger.warn({ jobId }, 'Evaluation job stalled');
      // The job's timeout will handle marking as timed_out
    });

    // Listen for completed jobs to handle timeouts
    this.worker.on('failed', async (job, err) => {
      if (err?.message?.includes('timed out') || err?.message?.includes('timeout')) {
        try {
          await markTimedOut(this.db, job?.data?.runId ?? '');
          logger.warn({ runId: job?.data?.runId }, 'Evaluation timed out');
        } catch {
          // Best-effort
        }
      }
    });

    logger.info({ concurrency: this.config.concurrency ?? 2, maxRuntimeMs }, 'Evaluation runtime started');

    // ── Dead-run reaper ──────────────────────────────────────────────────
    // Periodically marks runs stuck in 'running' for > 2× maxRuntimeMs as timed_out
    const reaperIntervalMs = 60_000;
    const staleThresholdMs = 2 * maxRuntimeMs;

    this.reaperInterval = setInterval(async () => {
      try {
        const staleCutoff = new Date(Date.now() - staleThresholdMs);
        const staleRuns = await this.db
          .select({ id: agentEvaluations.id, agentId: agentEvaluations.agentId })
          .from(agentEvaluations)
          .where(and(
            eq(agentEvaluations.status, 'running'),
            lt(agentEvaluations.startedAt, staleCutoff),
          ));

        for (const run of staleRuns) {
          await markTimedOut(this.db, run.id);
          logger.warn({ runId: run.id, agentId: run.agentId }, 'Reaped stale evaluation run — marked as timed_out');
        }
      } catch (err) {
        logger.warn({ err }, 'Dead-run reaper cycle failed');
      }
    }, reaperIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = undefined;
    }
    if (this.worker) {
      await this.worker.close();
      this.worker = undefined;
    }
    logger.info('Evaluation runtime stopped');
  }
}
