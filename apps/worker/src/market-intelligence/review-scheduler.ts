import { createLogger } from '../logger.js';
import type { Logger } from 'pino';
import type { Database } from '@herobids/db';
import { reviewAdvice } from '@herobids/db';
import {
  err,
  ok,
  type Result,
  type ResolvedReviewPreCheckPolicy,
  type ActivePresetState,
} from '@herobids/domain';
import { eq, and, sql } from 'drizzle-orm';
import {
  AssessmentReviewRunner,
  type AssessmentReviewRunnerConfig,
  type AssessmentReviewRunnerDeps,
  type ReviewCheckOutcome,
} from './assessment-review-runner.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ReviewSchedulerConfig {
  reviewIntervalMs: number;
  minReviewIntervalMs: number;
  scannerCandidateLimit: number;
  cacheFreshnessMs: number;
  adviceExpiryMs: number;
  preCheck: ResolvedReviewPreCheckPolicy;
}

export interface ReviewSchedulerDeps {
  db: Database;
  redis: unknown;
  agentId: string;
  eventPublisher: import('../agents/instance-event-publisher.js').InstanceEventPublisher;
  resolveActivePreset: () => Promise<Result<ActivePresetState>>;
  checkBillingEligibility: () => Promise<Result<boolean>>;
}

// ── Scheduler ───────────────────────────────────────────────────────────────

export class ReviewScheduler {
  private readonly logger: Logger;
  private readonly db: Database;
  private readonly agentId: string;
  private readonly config: ReviewSchedulerConfig;
  private readonly runner: AssessmentReviewRunner;

  private lastCheckAt: number = 0;
  private checkInFlight: boolean = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: boolean = false;

  constructor(deps: ReviewSchedulerDeps, config: ReviewSchedulerConfig) {
    this.db = deps.db;
    this.agentId = deps.agentId;
    this.config = config;
    this.logger = createLogger(`review-scheduler:${deps.agentId}`);

    const runnerConfig: AssessmentReviewRunnerConfig = {
      reviewIntervalMs: config.reviewIntervalMs,
      minReviewIntervalMs: config.minReviewIntervalMs,
      scannerCandidateLimit: config.scannerCandidateLimit,
      cacheFreshnessMs: config.cacheFreshnessMs,
      adviceExpiryMs: config.adviceExpiryMs,
      preCheck: config.preCheck,
    };

    const runnerDeps: AssessmentReviewRunnerDeps = {
      db: deps.db,
      agentId: deps.agentId,
      eventPublisher: deps.eventPublisher,
      resolveActivePreset: deps.resolveActivePreset,
      checkBillingEligibility: deps.checkBillingEligibility,
    };

    this.runner = new AssessmentReviewRunner(runnerDeps, runnerConfig);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info({ reviewIntervalMs: this.config.reviewIntervalMs }, 'Review scheduler started');
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info('Review scheduler stopped');
  }

  private scheduleNext(): void {
    if (!this.running) return;

    const now = Date.now();
    const effectiveInterval = Math.max(
      this.config.reviewIntervalMs,
      this.config.minReviewIntervalMs,
    );
    const elapsed = now - this.lastCheckAt;
    const delayMs = Math.max(0, effectiveInterval - elapsed);

    this.timer = setTimeout(() => {
      this.timer = null;
      this.runReviewCheck().finally(() => {
        if (this.running) {
          this.scheduleNext();
        }
      });
    }, delayMs);

    this.logger.debug({ delayMs, effectiveInterval, elapsed }, 'Next review check scheduled');
  }

  async runReviewCheck(): Promise<Result<ReviewCheckOutcome>> {
    if (this.checkInFlight) {
      return err({ code: 'review.check_already_in_flight', message: 'A review check is already running' });
    }

    this.checkInFlight = true;

    try {
      const result = await this.runner.run({ trigger: 'scheduled', force: false });
      if (result.ok) {
        this.lastCheckAt = Date.now();
      }
      return result;
    } finally {
      this.checkInFlight = false;
    }
  }

  async getPendingAdvice(): Promise<
    Result<
      Array<{
        adviceId: string;
        identity: Record<string, unknown>;
        candidateRank: number | null;
        activePreset: string;
        presetBehaviorVersion: string;
        reasons: string[];
        checkedAt: string;
      }>
    >
  > {
    try {
      const now = new Date();
      const rows = await this.db
        .select()
        .from(reviewAdvice)
        .where(
          and(
            eq(reviewAdvice.agentId, this.agentId),
            eq(reviewAdvice.outcome, 'advised'),
            sql`${reviewAdvice.expiresAt} > ${now.toISOString()}`,
            sql`${reviewAdvice.consumedAt} IS NULL`,
          ),
        )
        .orderBy(reviewAdvice.candidateRank)
        .limit(this.config.scannerCandidateLimit);

      return ok(
        rows.map((r) => ({
          adviceId: r.id,
          identity: r.identitySnapshot as Record<string, unknown>,
          candidateRank: r.candidateRank,
          activePreset: r.activePreset,
          presetBehaviorVersion: r.presetBehaviorVersion,
          reasons: (r.supportingFacts as Record<string, unknown> | null)?.reasons as string[] ?? [],
          checkedAt: r.checkedAt.toISOString(),
        })),
      );
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to query pending advice');
      return err({ code: 'review.query_failed', message: 'Failed to query pending advice' });
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createReviewScheduler(
  deps: ReviewSchedulerDeps,
  agentReviewIntervalMs: number,
  operatorConfig: {
    minReviewIntervalMs: number;
    scannerCandidateLimit: number;
    cacheFreshnessMs: number;
    adviceExpiryMs?: number;
    preCheck: ResolvedReviewPreCheckPolicy;
  },
): ReviewScheduler {
  const config: ReviewSchedulerConfig = {
    reviewIntervalMs: Math.max(agentReviewIntervalMs, operatorConfig.minReviewIntervalMs),
    minReviewIntervalMs: operatorConfig.minReviewIntervalMs,
    scannerCandidateLimit: operatorConfig.scannerCandidateLimit,
    cacheFreshnessMs: operatorConfig.cacheFreshnessMs,
    adviceExpiryMs: operatorConfig.adviceExpiryMs ?? operatorConfig.cacheFreshnessMs,
    preCheck: operatorConfig.preCheck,
  };

  return new ReviewScheduler(deps, config);
}
