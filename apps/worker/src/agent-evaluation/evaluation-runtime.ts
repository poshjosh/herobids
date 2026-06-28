import { Worker } from 'bullmq';
import pino from 'pino';
import type { Database } from '@herobids/db';
import { EVALUATION_QUEUE_NAME, markRunning, markTimedOut } from '@herobids/db';
import type { EvaluationJobData } from '@herobids/db';
import type { EvaluationThresholds } from '@herobids/domain';
import { runEvaluation } from './run-evaluation.js';

// ── Config ──────────────────────────────────────────────────────────────────

export interface EvaluationRuntimeConfig {
  redis: { host: string; port: number; password?: string; username?: string; db?: number };
  concurrency?: number;
  /** Maximum runtime per job in milliseconds before timing out (default 120_000) */
  maxRuntimeMs?: number;
  /** Thresholds for deterministic analyzers */
  thresholds: EvaluationThresholds;
}

// ── Logger ──────────────────────────────────────────────────────────────────

const logger = pino({ name: 'evaluation-runtime' });

// ── Runtime ─────────────────────────────────────────────────────────────────

/**
 * EvaluationRuntime — processes agent evaluation jobs via BullMQ.
 * Follows the same pattern as BacktestRuntime.
 */
export class EvaluationRuntime {
  private worker: Worker<EvaluationJobData> | undefined;

  constructor(
    private readonly config: EvaluationRuntimeConfig,
    private readonly db: Database,
  ) {}

  start(): void {
    const maxRuntimeMs = this.config.maxRuntimeMs ?? 120_000;

    this.worker = new Worker<EvaluationJobData>(
      EVALUATION_QUEUE_NAME,
      async (job) => {
        const { runId, agentId, resolvedScope, includeNarrative } = job.data;
        logger.info({ runId, agentId, scope: resolvedScope }, 'Starting evaluation run');

        // Transition queued → running
        const started = await markRunning(this.db, runId);
        if (!started) {
          logger.warn({ runId }, 'Run was not in queued state — skipping');
          return;
        }

        // Run full evaluation pipeline
        await runEvaluation({
          db: this.db,
          runId,
          agentId,
          resolvedScope,
          includeNarrative,
          thresholds: this.config.thresholds,
        });

        logger.info({ runId, agentId }, 'Evaluation completed');
      },
      {
        connection: this.config.redis,
        concurrency: this.config.concurrency ?? 2,
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
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = undefined;
    }
    logger.info('Evaluation runtime stopped');
  }
}
