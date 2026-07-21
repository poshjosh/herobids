import { Worker } from 'bullmq';
import { createLogger } from './logger.js';
import type { Database } from '@herobids/db';
import {
  MANUAL_REVIEW_QUEUE_NAME,
  markManualReviewRunning,
  markManualReviewSucceeded,
  markManualReviewFailed,
} from '@herobids/db';
import type { ManualReviewJobData, ManualReviewResultSummary } from '@herobids/db';
import type { Result } from '@herobids/domain';
import type {
  AssessmentReviewRunner,
} from './market-intelligence/assessment-review-runner.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ManualReviewRuntimeConfig {
  redis: { host: string; port: number; password?: string; username?: string; db?: number };
  concurrency?: number;
  /** Maximum runtime per job in milliseconds before timing out (default 120_000) */
  maxRuntimeMs?: number;
}

/**
 * Factory for creating a per-agent AssessmentReviewRunner.
 * Called once per job with the agent's ID, constructs the deps and config
 * needed for the runner, and returns it for one-shot execution.
 */
export type ManualReviewRunnerFactory = (
  agentId: string,
) => Promise<Result<{ runner: AssessmentReviewRunner }>>;

// ── Logger ──────────────────────────────────────────────────────────────────

const logger = createLogger('manual-review-runtime');

// ── Runtime ─────────────────────────────────────────────────────────────────

/**
 * ManualReviewRuntime — processes user-triggered platform assessment review
 * jobs via BullMQ. Each job creates a per-agent runner and executes with
 * force:true (bypassing the due-interval gate).
 */
export class ManualReviewRuntime {
  private worker: Worker<ManualReviewJobData> | undefined;
  private reaperInterval: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly config: ManualReviewRuntimeConfig,
    private readonly db: Database,
    private readonly runnerFactory: ManualReviewRunnerFactory,
  ) {}

  start(): void {
    const maxRuntimeMs = this.config.maxRuntimeMs ?? 120_000;

    this.worker = new Worker<ManualReviewJobData>(
      MANUAL_REVIEW_QUEUE_NAME,
      async (job) => {
        const { runId, agentId } = job.data;
        logger.info({ runId, agentId, attempt: job.attemptsMade + 1 }, 'Starting manual review run');

        // Transition queued → running
        const started = await markManualReviewRunning(this.db, runId);
        if (!started) {
          logger.warn({ runId }, 'Run was not in queued state — skipping');
          return;
        }

        try {
          // Create per-agent runner via factory
          const factoryResult = await this.runnerFactory(agentId);
          if (!factoryResult.ok) {
            await markManualReviewFailed(this.db, runId, 'review.runner_factory_failed', factoryResult.error.message);
            logger.error({ runId, agentId, err: factoryResult.error }, 'Failed to create review runner');
            return;
          }

          const { runner } = factoryResult.data;

          // Execute with force:true — bypass due gate only
          const outcome = await runner.run({ trigger: 'manual', force: true });

          if (!outcome.ok) {
            await markManualReviewFailed(this.db, runId, outcome.error.code, outcome.error.message);
            logger.error({ runId, agentId, err: outcome.error }, 'Manual review check failed');
            return;
          }

          // Persist terminal success
          const resultSummary: ManualReviewResultSummary = {
            hasAdvice: outcome.data.hasAdvice,
            advisedCount: outcome.data.advisedCount,
            outcomeCounts: outcome.data.outcomeCounts,
            checkOutcome: outcome.data.outcomeCounts['advised'] ? 'advised' : (outcome.data.advisedCount === 0 ? 'no_advice' : 'completed'),
            checkedAt: outcome.data.checkedAt,
            nextEligibleAt: outcome.data.nextEligibleAt,
            checkId: outcome.data.checkId,
          };

          await markManualReviewSucceeded(this.db, runId, resultSummary);
          logger.info({ runId, agentId, hasAdvice: outcome.data.hasAdvice, advisedCount: outcome.data.advisedCount }, 'Manual review completed');
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          await markManualReviewFailed(this.db, runId, 'review.unexpected_error', message);
          logger.error({ runId, agentId, err: error }, 'Manual review run failed unexpectedly');
        }
      },
      {
        connection: this.config.redis,
        concurrency: this.config.concurrency ?? 2,
        lockDuration: maxRuntimeMs + 30_000,
        stalledInterval: 30_000,
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    );

    this.worker.on('failed', async (job, err) => {
      if (err?.message?.includes('timed out') || err?.message?.includes('timeout')) {
        const runId = job?.data?.runId;
        if (!runId) {
          logger.warn({ jobId: job?.id }, 'Manual review job failed but runId is missing — cannot update run row');
          return;
        }
        try {
          await markManualReviewFailed(this.db, runId, 'review.timed_out', 'Job exceeded maximum runtime');
          logger.warn({ runId }, 'Manual review timed out');
        } catch {
          // Best-effort
        }
      }
    });

    logger.info({ concurrency: this.config.concurrency ?? 2, maxRuntimeMs }, 'Manual review runtime started');
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
    logger.info('Manual review runtime stopped');
  }
}
