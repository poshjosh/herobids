import { Worker } from 'bullmq';
import pino from 'pino';
import type { Database } from '@herobids/db';
import { EVALUATION_QUEUE_NAME, markRunning, markSucceeded, markFailed, markTimedOut } from '@herobids/db';
import type { EvaluationJobData } from '@herobids/db';
import type { EvaluationRunResult } from '@herobids/domain';

// ── Config ──────────────────────────────────────────────────────────────────

export interface EvaluationRuntimeConfig {
  redis: { host: string; port: number; password?: string; username?: string; db?: number };
  concurrency?: number;
  /** Maximum runtime per job in milliseconds before timing out (default 120_000) */
  maxRuntimeMs?: number;
}

// ── Logger ──────────────────────────────────────────────────────────────────

const logger = pino({ name: 'evaluation-runtime' });

// ── Runtime ─────────────────────────────────────────────────────────────────

/**
 * EvaluationRuntime — processes agent evaluation jobs via BullMQ.
 * Follows the same pattern as BacktestRuntime.
 *
 * Phase 3: no-op handler that transitions queued → running → succeeded.
 * Later phases will wire in evidence collection, analysis, and reporting.
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

        try {
          // Transition queued → running
          const started = await markRunning(this.db, runId);
          if (!started) {
            logger.warn({ runId }, 'Run was not in queued state — skipping');
            return;
          }

          // ── Phase 3: no-op placeholder ──
          // Later phases will add: collect evidence → analyze → render → persist
          const placeholderResult: EvaluationRunResult = {
            scorecard: { overallScore: 100, sections: [] },
            artifactManifest: [],
            summary: { totalFindings: 0, criticalCount: 0, highCount: 0 },
          };

          await markSucceeded(this.db, runId, placeholderResult);
          logger.info({ runId, agentId }, 'Evaluation completed (no-op)');
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          const code = err instanceof Error && 'code' in err ? (err as Error & { code?: string }).code : 'evaluation.internal_error';
          await markFailed(this.db, runId, code ?? 'evaluation.internal_error', error.message);
          logger.error({ runId, agentId, err: error.message }, 'Evaluation failed');
          throw error;
        }
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
