import crypto from 'node:crypto';
import { createLogger } from '../logger.js';
import type { Logger } from 'pino';
import type { Database } from '@herobids/db';
import { reviewAdvice } from '@herobids/db';
import { err, ok, type Result } from '@herobids/domain';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ReviewSchedulerConfig {
  /** Agent review interval in ms. Default: 24h (86_400_000). */
  reviewIntervalMs: number;
  /** Operator minimum floor for review interval. Default: 24h (86_400_000). */
  minReviewIntervalMs: number;
  /** Top N scanner candidates the deterministic pre-check considers. */
  scannerCandidateLimit: number;
  /** Cache freshness in ms — how long an artifact is considered "fresh". */
  cacheFreshnessMs: number;
  /** How long advice records remain deliverable after check (ms). */
  adviceExpiryMs: number;
}

export interface ReviewSchedulerDeps {
  db: Database;
  /** Redis client — reserved for future cooldown / lock use. */
  redis: unknown;
  agentId: string;
}

export interface ReviewCheckOutcome {
  /** Unique ID for this review check. */
  checkId: string;
  /** When the check ran. */
  checkedAt: string;
  /** When the next review is eligible. */
  nextEligibleAt: string;
  /** Number of candidates advised (0 = no advice). */
  advisedCount: number;
  /** Per-candidate outcome counts. */
  outcomeCounts: Record<string, number>;
  /** Whether advice was generated and a tick should be delivered. */
  hasAdvice: boolean;
}

// ── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Per-agent review scheduler.
 *
 * Worker-owned singleton per opted-in agent. Determines whether the agent's
 * review interval has elapsed, runs the deterministic scanner pre-check only
 * when review is due, persists the outcome, and signals that a dedicated
 * `assessment_review` tick should be delivered.
 *
 * The scheduler is a skeleton — the actual scanner/deterministic check logic
 * is wired later. Placeholder methods return structured results with no side
 * effects.
 */
export class ReviewScheduler {
  private readonly logger: Logger;
  private readonly db: Database;
  private readonly agentId: string;
  private readonly config: ReviewSchedulerConfig;

  /** Timestamp (ms) of the last completed review check. */
  private lastCheckAt: number = 0;
  /** Whether a review check is currently in flight. */
  private checkInFlight: boolean = false;
  /** Timer handle for the next scheduled check. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the scheduler is running. */
  private running: boolean = false;

  constructor(deps: ReviewSchedulerDeps, config: ReviewSchedulerConfig) {
    this.db = deps.db;
    this.agentId = deps.agentId;
    this.config = config;
    this.logger = createLogger(`review-scheduler:${deps.agentId}`);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Start the per-agent review scheduler loop.
   * Schedules the first check after `reviewIntervalMs` from now
   * (or immediately if no prior check is recorded).
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info({ reviewIntervalMs: this.config.reviewIntervalMs }, 'Review scheduler started');
    this.scheduleNext();
  }

  /**
   * Stop the scheduler. Cancels any pending timer.
   */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info('Review scheduler stopped');
  }

  // ── Scheduling ───────────────────────────────────────────────────────

  /**
   * Determine whether review is due and schedule the next check.
   * Reschedules on failure per AGENTS.md async-loop rules.
   */
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
        // Reschedule on success or failure — never let the loop die.
        if (this.running) {
          this.scheduleNext();
        }
      });
    }, delayMs);

    this.logger.debug({ delayMs, effectiveInterval, elapsed }, 'Next review check scheduled');
  }

  // ── Review Check ─────────────────────────────────────────────────────

  /**
   * Run a single review check cycle:
   * 1. Determine if review is due.
   * 2. Run the deterministic scanner pre-check.
   * 3. Persist the outcome.
   * 4. Signal whether a tick should be delivered.
   */
  async runReviewCheck(): Promise<Result<ReviewCheckOutcome>> {
    if (this.checkInFlight) {
      return err({ code: 'review.check_already_in_flight', message: 'A review check is already running' });
    }

    this.checkInFlight = true;
    const checkId = crypto.randomUUID();
    const checkedAt = new Date().toISOString();

    try {
      // 1. Determine if review is due
      const dueResult = await this.isReviewDue();
      if (!dueResult.ok) return dueResult;
      if (!dueResult.data) {
        this.lastCheckAt = Date.now();
        return ok({
          checkId,
          checkedAt,
          nextEligibleAt: new Date(Date.now() + this.config.reviewIntervalMs).toISOString(),
          advisedCount: 0,
          outcomeCounts: { not_due: 1 },
          hasAdvice: false,
        });
      }

      // 2. Run the deterministic scanner pre-check
      const preCheckResult = await this.runPreCheck();
      if (!preCheckResult.ok) return preCheckResult;
      const preCheck = preCheckResult.data;

      // 3. Persist outcomes
      const persistResult = await this.persistCheckOutcomes(checkId, checkedAt, preCheck);
      if (!persistResult.ok) return persistResult;

      // 4. Determine if advice should be delivered
      const advisedCount = preCheck.filter((c: { outcome: string }) => c.outcome === 'advised').length;
      const nextEligibleAt = new Date(Date.now() + this.config.reviewIntervalMs).toISOString();
      this.lastCheckAt = Date.now();

      const outcomeCounts: Record<string, number> = {};
      for (const c of preCheck) {
        outcomeCounts[c.outcome] = (outcomeCounts[c.outcome] ?? 0) + 1;
      }

      return ok({
        checkId,
        checkedAt,
        nextEligibleAt,
        advisedCount,
        outcomeCounts,
        hasAdvice: advisedCount > 0,
      });
    } catch (error) {
      this.logger.error({ err: error, checkId }, 'Review check failed');
      return err({ code: 'review.check_failed', message: 'Unexpected error during review check' });
    } finally {
      this.checkInFlight = false;
    }
  }

  // ── Due Check ────────────────────────────────────────────────────────

  /**
   * Check whether the agent's review interval has elapsed since the last
   * completed review check. Reads the persisted last-check timestamp.
   *
   * Placeholder: queries the review_advice table for the most recent check.
   * Returns false when no prior check exists (first run).
   */
  private async isReviewDue(): Promise<Result<boolean>> {
    try {
      const effectiveInterval = Math.max(
        this.config.reviewIntervalMs,
        this.config.minReviewIntervalMs,
      );

      // Load last check timestamp from DB
      const [lastRow] = await this.db
        .select({ checkedAt: reviewAdvice.checkedAt })
        .from(reviewAdvice)
        .where(eq(reviewAdvice.agentId, this.agentId))
        .orderBy(desc(reviewAdvice.checkedAt))
        .limit(1);

      if (!lastRow) {
        // First run — review is due
        return ok(true);
      }

      const lastCheckedAt = lastRow.checkedAt.getTime();
      this.lastCheckAt = lastCheckedAt;

      const now = Date.now();
      return ok(now - lastCheckedAt >= effectiveInterval);
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to determine if review is due');
      return err({ code: 'review.due_check_failed', message: 'Failed to query last review check' });
    }
  }

  // ── Deterministic Pre-Check ──────────────────────────────────────────

  /**
   * Run the deterministic scanner pre-check for the agent.
   *
   * For each symbol in the agent's top N scanner candidates, checks:
   * - Candidate resolves to a canonical per-symbol identity
   * - No fresh artifact exists for that identity (per cacheFreshnessMs)
   * - Agent is outside its review cooldown for that identity
   * - Non-reserving billing/credit eligibility check passes
   * - Cheap deterministic facts indicate possible preset-candidate mismatch
   *
   * **Placeholder**: returns an empty candidate list. The actual scanner
   * integration is wired later.
   *
   * This method must NOT use an LLM, create a run, reserve funds, or deduct credit.
   */
  private async runPreCheck(): Promise<
    Result<
      Array<{
        outcome: 'advised' | 'not_advised' | 'blocked_by_cooldown' | 'blocked_by_no_credit_indication' | 'fresh_artifact_exists' | 'no_candidate';
        /** Canonical identity — present when outcome is not 'no_candidate'. */
        identity?: {
          instrumentKind: 'orderbook' | 'perp' | 'swap' | 'dex';
          venueFamily: string;
          styleTier: 'economy' | 'standard' | 'premium';
          symbol?: string;
          network?: string;
          address?: string;
        };
        candidateRank?: number;
        activePreset?: string;
        presetBehaviorVersion?: string;
        reasons?: string[];
      }>
    >
  > {
    // TODO: Wire the actual scanner/deterministic check logic.
    // For now, return a single no_candidate entry to indicate the check
    // ran without finding any actionable candidates.
    return ok([
      { outcome: 'no_candidate' },
    ]);
  }

  // ── Persistence ──────────────────────────────────────────────────────

  /**
   * Persist the pre-check outcomes to the review_advice table.
   * One row per candidate checked. Expiry is set relative to checkedAt.
   */
  private async persistCheckOutcomes(
    checkId: string,
    checkedAt: string,
    candidates: Array<{
      outcome: 'advised' | 'not_advised' | 'blocked_by_cooldown' | 'blocked_by_no_credit_indication' | 'fresh_artifact_exists' | 'no_candidate';
      identity?: {
        instrumentKind: string;
        venueFamily: string;
        styleTier: string;
        symbol?: string;
        network?: string;
        address?: string;
      };
      candidateRank?: number;
      activePreset?: string;
      presetBehaviorVersion?: string;
      reasons?: string[];
    }>,
  ): Promise<Result<void>> {
    try {
      const checkedAtDate = new Date(checkedAt);
      const reviewDueAt = checkedAtDate; // review was due at check time
      const nextEligibleAt = new Date(Date.now() + this.config.reviewIntervalMs);
      const expiresAt = new Date(Date.now() + this.config.adviceExpiryMs);

      // Skip no_candidate outcomes — there is no candidate identity to hand off.
      const actionable = candidates.filter((c) => c.outcome !== 'no_candidate');

      const rows = actionable.map((c, i) => ({
        id: `${checkId}:${i}`,
        agentId: this.agentId,
        instrumentKind: c.identity?.instrumentKind ?? 'orderbook',
        venueFamily: c.identity?.venueFamily ?? 'unknown',
        styleTier: c.identity?.styleTier ?? 'standard',
        symbol: c.identity?.symbol ?? null,
        network: c.identity?.network ?? null,
        address: c.identity?.address ?? null,
        identitySnapshot: c.identity ?? {},
        checkedAt: checkedAtDate,
        reviewDueAt,
        nextEligibleAt,
        candidateRank: c.candidateRank ?? null,
        supportingFacts: c.reasons ? { reasons: c.reasons } : null,
        activePreset: c.activePreset ?? 'unknown',
        presetBehaviorVersion: c.presetBehaviorVersion ?? 'unknown',
        outcome: c.outcome,
        expiresAt,
      }));

      if (rows.length > 0) {
        await this.db.insert(reviewAdvice).values(rows);
      }

      this.logger.info(
        { checkId, persistedCount: rows.length, skippedNoCandidate: candidates.length - rows.length },
        'Review check outcomes persisted',
      );
      return ok(undefined);
    } catch (error) {
      this.logger.error({ err: error, checkId }, 'Failed to persist review check outcomes');
      return err({ code: 'review.persist_failed', message: 'Failed to persist review check outcomes' });
    }
  }

  // ── Tick Delivery Signal ─────────────────────────────────────────────

  /**
   * Query for unexpired, unconsumed advised records for this agent.
   * The runtime calls this to determine whether to deliver an
   * `assessment_review` tick.
   */
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
        .limit(this.config.scannerCandidateLimit); // bounded delivery

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

  /**
   * Mark advice records as consumed after delivering the assessment_review tick.
   */
  async markAdviceConsumed(adviceIds: string[]): Promise<Result<void>> {
    if (adviceIds.length === 0) return ok(undefined);

    try {
      const now = new Date();
      await this.db
        .update(reviewAdvice)
        .set({ consumedAt: now })
        .where(
          and(
            eq(reviewAdvice.agentId, this.agentId),
            inArray(reviewAdvice.id, adviceIds),
          ),
        );
      this.logger.info({ count: adviceIds.length }, 'Advice records marked consumed');
      return ok(undefined);
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to mark advice consumed');
      return err({ code: 'review.mark_consumed_failed', message: 'Failed to mark advice as consumed' });
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a ReviewScheduler with defaults from resolved operator + agent config.
 *
 * All default values come from resolved config, never hard-coded literals.
 */
export function createReviewScheduler(
  deps: ReviewSchedulerDeps,
  agentReviewIntervalMs: number,
  operatorConfig: {
    minReviewIntervalMs: number;
    scannerCandidateLimit: number;
    cacheFreshnessMs: number;
    adviceExpiryMs?: number;
  },
): ReviewScheduler {
  const config: ReviewSchedulerConfig = {
    reviewIntervalMs: Math.max(agentReviewIntervalMs, operatorConfig.minReviewIntervalMs),
    minReviewIntervalMs: operatorConfig.minReviewIntervalMs,
    scannerCandidateLimit: operatorConfig.scannerCandidateLimit,
    cacheFreshnessMs: operatorConfig.cacheFreshnessMs,
    adviceExpiryMs: operatorConfig.adviceExpiryMs ?? operatorConfig.cacheFreshnessMs,
  };

  return new ReviewScheduler(deps, config);
}
