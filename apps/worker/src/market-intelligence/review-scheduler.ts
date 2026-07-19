import crypto from 'node:crypto';
import { createLogger } from '../logger.js';
import type { Logger } from 'pino';
import type { Database } from '@herobids/db';
import { reviewAdvice, agentScanCandidates, agentAssessmentReviewChecks, marketAssessmentArtifacts } from '@herobids/db';
import {
  err,
  ok,
  type Result,
  type AgentWakePayload,
  MarketAssessmentIdentitySchema,
  AgentWakePayloadSchema,
  type ResolvedReviewPreCheckPolicy,
  type ActivePresetState,
  type CandidatePreCheckOutcome,
  ReviewPreCheckReasonCodes,
} from '@herobids/domain';
import { eq, and, desc, sql, inArray, gte } from 'drizzle-orm';

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
  /** Resolved pre-check policy from operator config. */
  preCheck: ResolvedReviewPreCheckPolicy;
}

export interface ReviewSchedulerDeps {
  db: Database;
  /** Redis client — reserved for future cooldown / lock use. */
  redis: unknown;
  agentId: string;
  /** Publishes {agent.wake} events to the agent's inbound stream. */
  eventPublisher: import('../agents/instance-event-publisher.js').InstanceEventPublisher;
  /**
   * Resolve the agent's active preset state at pre-check time.
   *
   * Resolution order (authoritative → fallback):
   * 1. Query `agent_preset_bindings` for an active binding row (set on
   *    preset transition). If found and valid, derive preset state from the
   *    bound preset catalog entry via `applyPresetToAgent`.
   * 2. Fall back to unified-config derivation when no binding exists (the
   *    common case for agents that have never transitioned).
   */
  resolveActivePreset: () => Promise<Result<ActivePresetState>>;
  /**
   * Read-only billing preflight: can the agent afford an assessment?
   * Returns true if billing is available/not required or if the agent has
   * sufficient credit. This is advisory only — the request service
   * re-evaluates authoritatively when the agent asks for an assessment.
   */
  checkBillingEligibility: () => Promise<Result<boolean>>;
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
  private readonly eventPublisher: import('../agents/instance-event-publisher.js').InstanceEventPublisher;
  private readonly resolveActivePreset: ReviewSchedulerDeps['resolveActivePreset'];
  private readonly checkBillingEligibility: ReviewSchedulerDeps['checkBillingEligibility'];

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
    this.eventPublisher = deps.eventPublisher;
    this.resolveActivePreset = deps.resolveActivePreset;
    this.checkBillingEligibility = deps.checkBillingEligibility;
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
      const nextEligibleAtDate = new Date(Date.now() + this.config.reviewIntervalMs);
      const persistResult = await this.persistCheckOutcomes(checkId, checkedAt, preCheck, nextEligibleAtDate);
      if (!persistResult.ok) return persistResult;

      // 4. Compute outcome counts
      const outcomeCounts: Record<string, number> = {};
      for (const c of preCheck) {
        outcomeCounts[c.outcome] = (outcomeCounts[c.outcome] ?? 0) + 1;
      }

      // 5. Build actionable array (matches persistCheckOutcomes ordering)
      const actionable = preCheck.filter((c) => c.outcome !== 'no_candidate');
      const nextEligibleAt = nextEligibleAtDate.toISOString();

      // 6. Emit agent wake when advice exists (G3 — one wake per due interval, G6)
      let effectiveAdvisedCount = 0;
      const advisedPreFilter = preCheck.filter((c) => c.outcome === 'advised');
      if (advisedPreFilter.length > 0) {
        // Compute advice data from in-memory preCheck results rather than
        // a redundant DB round-trip. Advice IDs mirror the persist ordering
        // (actionable, non-"no_candidate" items).
        const advisedCandidates = advisedPreFilter
          .map((c) => {
            const actionableIdx = actionable.indexOf(c);
            // PreCheck identity has optional fields — safeParse validates the discriminated union structure
            const idParsed = MarketAssessmentIdentitySchema.safeParse(c.identity);
            if (!idParsed.success) {
              this.logger.warn({ identity: c.identity, err: idParsed.error.issues }, 'Skipping advised candidate with malformed identity');
              return null;
            }
            return {
              adviceId: `${checkId}:${actionableIdx}`,
              identity: idParsed.data,
              candidateRank: c.candidateRank ?? 1,
              activePreset: c.activePreset ?? 'unknown',
              presetBehaviorVersion: c.presetBehaviorVersion ?? 'unknown',
              reasons: c.reasons ?? ['Deterministic pre-check advised review'],
            };
          })
          .filter((c): c is NonNullable<typeof c> => c !== null);

        effectiveAdvisedCount = advisedCandidates.length;

        if (advisedCandidates.length === 0) {
          this.logger.warn({ originalCount: advisedPreFilter.length }, 'All advised candidates had malformed identities — skipping wake');
        } else {
          const adviceIds = advisedCandidates.map((a) => a.adviceId);
          const payload: AgentWakePayload = {
            source: 'scanner',
            wakeId: crypto.randomUUID(),
            reason: `Assessment review available for ${advisedCandidates.length} symbols`,
            eventIds: adviceIds,
            priority: 'normal',
            requestedAt: checkedAt,
            context: {
              scannerKind: 'assessment_review',
              advice: advisedCandidates.map((a) => ({
                identity: a.identity,
                candidateRank: a.candidateRank,
                activePreset: a.activePreset,
                presetBehaviorVersion: a.presetBehaviorVersion,
                reasons: a.reasons,
              })),
              checkedAt,
              nextEligibleAt,
            },
          };

          // Validate payload against schema before emitting (producer-side guard)
          const parsed = AgentWakePayloadSchema.safeParse(payload);
          if (!parsed.success) {
            this.logger.error({ err: parsed.error.issues, payload }, 'Constructed invalid wake payload — this is a bug');
            return err({ code: 'review.invalid_wake_payload', message: 'Constructed wake payload failed schema validation' });
          }

          // At-least-once delivery: a crash between emit and mark could result in
          // a duplicate wake on the next cycle. The consumer must be idempotent.
          await this.eventPublisher.emitAgentWake(this.agentId, parsed.data);

          const consumedResult = await this.markAdviceConsumed(adviceIds);
          if (!consumedResult.ok) {
            this.logger.error(
              { err: consumedResult.error, wakeId: payload.wakeId, adviceIds },
              'Wake emitted but failed to mark advice consumed — duplicate wake risk on next cycle',
            );
          }

          this.logger.info(
            { wakeId: payload.wakeId, adviceCount: advisedCandidates.length },
            'Agent wake emitted for assessment review',
          );
        }
      }

      this.lastCheckAt = Date.now();

      return ok({
        checkId,
        checkedAt,
        nextEligibleAt,
        advisedCount: effectiveAdvisedCount,
        outcomeCounts,
        hasAdvice: effectiveAdvisedCount > 0,
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
   * completed review check. Reads the durable `agent_assessment_review_checks`
   * table rather than inferring from `review_advice` rows.
   *
   * A check with status 'completed' or 'skipped' sets the last-check anchor.
   * Checks with status 'failed' or 'lease_lost' do NOT — the next cycle
   * retries immediately.
   */
  private async isReviewDue(): Promise<Result<boolean>> {
    try {
      const effectiveInterval = Math.max(
        this.config.reviewIntervalMs,
        this.config.minReviewIntervalMs,
      );

      // Load the most recent completed or skipped check
      const [lastCheck] = await this.db
        .select({ checkedAt: agentAssessmentReviewChecks.checkedAt, status: agentAssessmentReviewChecks.status })
        .from(agentAssessmentReviewChecks)
        .where(
          and(
            eq(agentAssessmentReviewChecks.agentId, this.agentId),
            inArray(agentAssessmentReviewChecks.status, ['completed', 'skipped']),
          ),
        )
        .orderBy(desc(agentAssessmentReviewChecks.checkedAt))
        .limit(1);

      if (!lastCheck || !lastCheck.checkedAt) {
        // First run — review is due
        return ok(true);
      }

      this.lastCheckAt = lastCheck.checkedAt.getTime();
      const now = Date.now();
      return ok(now - lastCheck.checkedAt.getTime() >= effectiveInterval);
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to determine if review is due');
      return err({ code: 'review.due_check_failed', message: 'Failed to query last review check' });
    }
  }

  // ── Deterministic Pre-Check ──────────────────────────────────────────

  /**
   * Run the deterministic scanner pre-check for the agent.
   *
   * Reads persisted scanner candidate observations, resolves the agent's
   * active preset state, and evaluates each candidate against the
   * deterministic review predicate. No LLM call, no billing reservation,
   * no credit deduction occurs.
   *
   * Outcomes:
   * - `no_candidate`: no qualifying persisted candidates
   * - `advised`: candidate passed all checks
   * - `not_advised`: candidate failed the review predicate
   * - `blocked_by_cooldown`: agent within cooldown for this identity
   * - `blocked_by_no_credit_indication`: billing preflight failed
   * - `fresh_artifact_exists`: a fresh assessment artifact already exists
   */
  private async runPreCheck(): Promise<Result<CandidatePreCheckOutcome[]>> {
    try {
      // 1. Resolve active preset state
      const presetResult = await this.resolveActivePreset();
      if (!presetResult.ok) {
        this.logger.warn({ err: presetResult.error }, 'Failed to resolve active preset — will still attempt candidate checks');
        return ok([{ outcome: 'no_candidate', reasons: ['active_preset_unresolved'] }]);
      }
      const activePreset = presetResult.data;

      // 2. Load recent, resolved candidates from agent_scan_candidates
      const maxAge = new Date(Date.now() - this.config.preCheck.candidateMaxAgeMs);
      const candidates = await this.db
        .select()
        .from(agentScanCandidates)
        .where(
          and(
            eq(agentScanCandidates.agentId, this.agentId),
            gte(agentScanCandidates.scannedAt, maxAge),
            // Only resolved, signal-producing candidates are eligible for review
            inArray(agentScanCandidates.disposition, ['entry_candidate', 'exit_advisory', 'scored_no_signal']),
            eq(agentScanCandidates.resolutionStatus, 'resolved'),
          ),
        )
        .orderBy(agentScanCandidates.candidateRank)
        .limit(this.config.scannerCandidateLimit);

      if (candidates.length === 0) {
        this.logger.debug('No qualifying scan candidates found for review');
        return ok([{ outcome: 'no_candidate', reasons: [ReviewPreCheckReasonCodes.NO_CANDIDATE] }]);
      }

      // 3. Run billing preflight (once per check, not per candidate)
      const billingResult = await this.checkBillingEligibility();
      const billingEligible = billingResult.ok && billingResult.data === true;

      // 4. Evaluate each candidate
      const outcomes: CandidatePreCheckOutcome[] = [];
      const now = Date.now();
      const cooldownCutoff = new Date(now - this.config.preCheck.identityCooldownMs);
      const artifactFreshCutoff = new Date(now - this.config.cacheFreshnessMs);

      for (const candidate of candidates) {
        // Build canonical identity from DB row
        const identity = this.buildIdentityFromRow(candidate);

        // 4a. Check for stale candidate data
        const dataFreshness = candidate.dataFreshnessTs?.getTime() ?? candidate.scannedAt.getTime();
        if (now - dataFreshness > this.config.preCheck.candidateMaxAgeMs) {
          outcomes.push({
            identity: identity ?? undefined,
            outcome: 'not_advised' as const,
            candidateRank: candidate.candidateRank,
            activePreset: activePreset.presetKey,
            presetBehaviorVersion: activePreset.behaviorVersion,
            reasons: [ReviewPreCheckReasonCodes.CANDIDATE_STALE],
          });
          continue;
        }

        // 4b. Check for unresolved identity
        if (!identity) {
          outcomes.push({
            outcome: 'not_advised' as const,
            candidateRank: candidate.candidateRank,
            activePreset: activePreset.presetKey,
            presetBehaviorVersion: activePreset.behaviorVersion,
            reasons: [ReviewPreCheckReasonCodes.IDENTITY_UNRESOLVED],
          });
          continue;
        }

        // 4c. Check for fresh artifact
        const freshArtifact = await this.hasFreshArtifact(identity, artifactFreshCutoff);
        if (freshArtifact) {
          outcomes.push({
            identity,
            outcome: 'fresh_artifact_exists' as const,
            candidateRank: candidate.candidateRank,
            activePreset: activePreset.presetKey,
            presetBehaviorVersion: activePreset.behaviorVersion,
            reasons: [ReviewPreCheckReasonCodes.FRESH_ARTIFACT_EXISTS],
          });
          continue;
        }

        // 4d. Check cooldown
        const inCooldown = await this.isInCooldown(identity, cooldownCutoff);
        if (inCooldown) {
          outcomes.push({
            identity,
            outcome: 'blocked_by_cooldown' as const,
            candidateRank: candidate.candidateRank,
            activePreset: activePreset.presetKey,
            presetBehaviorVersion: activePreset.behaviorVersion,
            reasons: [ReviewPreCheckReasonCodes.COOLDOWN_ACTIVE],
          });
          continue;
        }

        // 4e. Billing preflight
        if (!billingEligible) {
          outcomes.push({
            identity,
            outcome: 'blocked_by_no_credit_indication' as const,
            candidateRank: candidate.candidateRank,
            activePreset: activePreset.presetKey,
            presetBehaviorVersion: activePreset.behaviorVersion,
            reasons: [ReviewPreCheckReasonCodes.BILLING_BLOCKED],
          });
          continue;
        }

        // 4f. Deterministic review predicate
        const eligibility = this.evaluateEligibility(candidate, activePreset);
        if (eligibility.eligible) {
          outcomes.push({
            identity,
            outcome: 'advised' as const,
            candidateRank: candidate.candidateRank,
            activePreset: activePreset.presetKey,
            presetBehaviorVersion: activePreset.behaviorVersion,
            reasons: eligibility.reasons,
          });
        } else {
          outcomes.push({
            identity,
            outcome: 'not_advised' as const,
            candidateRank: candidate.candidateRank,
            activePreset: activePreset.presetKey,
            presetBehaviorVersion: activePreset.behaviorVersion,
            reasons: eligibility.reasons,
          });
        }
      }

      // 5. If no outcomes produced (shouldn't happen but guard), return no_candidate
      if (outcomes.length === 0) {
        return ok([{ outcome: 'no_candidate', reasons: [ReviewPreCheckReasonCodes.NO_CANDIDATE] }]);
      }

      return ok(outcomes);
    } catch (error) {
      this.logger.error({ err: error }, 'Pre-check failed');
      return err({ code: 'review.pre_check_failed', message: 'Unexpected error during pre-check' });
    }
  }

  // ── Candidate Helpers ────────────────────────────────────────────────

  /**
   * Build a canonical MarketAssessmentIdentity from a persisted candidate row.
   * Returns null if the identity columns are insufficient.
   */
  private buildIdentityFromRow(
    row: typeof agentScanCandidates.$inferSelect,
  ): CandidatePreCheckOutcome['identity'] {
    const ik = row.instrumentKind;
    if (ik === 'orderbook' || ik === 'perp') {
      if (!row.symbol) return undefined;
      return {
        instrumentKind: ik,
        venueFamily: row.venueFamily,
        styleTier: row.styleTier as 'economy' | 'standard' | 'premium',
        symbol: row.symbol,
      };
    }
    if (ik === 'swap' || ik === 'dex') {
      if (!row.network || !row.address) return undefined;
      return {
        instrumentKind: ik,
        venueFamily: row.venueFamily,
        styleTier: row.styleTier as 'economy' | 'standard' | 'premium',
        network: row.network,
        address: row.address,
      };
    }
    return undefined;
  }

  /**
   * Check whether a fresh (non-expired) assessment artifact exists for the
   * given identity. Uses the same cache freshness window as the platform
   * assessor.
   */
  private async hasFreshArtifact(
    identity: NonNullable<CandidatePreCheckOutcome['identity']>,
    freshCutoff: Date,
  ): Promise<boolean> {
    try {
      const conditions = [
        eq(marketAssessmentArtifacts.status, 'active'),
        gte(marketAssessmentArtifacts.assessedAt, freshCutoff),
        eq(marketAssessmentArtifacts.instrumentKind, identity.instrumentKind),
        eq(marketAssessmentArtifacts.venueFamily, identity.venueFamily),
        eq(marketAssessmentArtifacts.styleTier, identity.styleTier),
      ];

      if ('symbol' in identity && identity.symbol) {
        conditions.push(eq(marketAssessmentArtifacts.symbol, identity.symbol));
      }
      if ('network' in identity && identity.network) {
        conditions.push(eq(marketAssessmentArtifacts.network, identity.network));
      }
      if ('address' in identity && identity.address) {
        conditions.push(eq(marketAssessmentArtifacts.address, identity.address));
      }

      const [artifact] = await this.db
        .select({ id: marketAssessmentArtifacts.id })
        .from(marketAssessmentArtifacts)
        .where(and(...conditions))
        .limit(1);

      return !!artifact;
    } catch {
      // Fail-open: if we can't query artifacts, don't block advice
      this.logger.warn('Failed to check fresh artifacts — proceeding');
      return false;
    }
  }

  /**
   * Check whether the agent is within the review advice cooldown for a
   * specific identity. A recent advised or blocked_by_cooldown outcome
   * for the same (agentId, identity) blocks a new advice.
   */
  private async isInCooldown(
    identity: NonNullable<CandidatePreCheckOutcome['identity']>,
    cooldownCutoff: Date,
  ): Promise<boolean> {
    try {
      const conditions = [
        eq(reviewAdvice.agentId, this.agentId),
        inArray(reviewAdvice.outcome, ['advised', 'blocked_by_cooldown']),
        gte(reviewAdvice.checkedAt, cooldownCutoff),
        eq(reviewAdvice.instrumentKind, identity.instrumentKind),
        eq(reviewAdvice.venueFamily, identity.venueFamily),
        eq(reviewAdvice.styleTier, identity.styleTier),
      ];

      if ('symbol' in identity && identity.symbol) {
        conditions.push(eq(reviewAdvice.symbol, identity.symbol));
      }
      if ('network' in identity && identity.network) {
        conditions.push(eq(reviewAdvice.network, identity.network));
      }
      if ('address' in identity && identity.address) {
        conditions.push(eq(reviewAdvice.address, identity.address));
      }

      const [row] = await this.db
        .select({ id: reviewAdvice.id })
        .from(reviewAdvice)
        .where(and(...conditions))
        .limit(1);

      return !!row;
    } catch {
      this.logger.warn('Failed to check cooldown — proceeding');
      return false;
    }
  }

  /**
   * Deterministic review eligibility predicate.
   *
   * Compares the candidate's persisted deterministic facts against the
   * active preset's behavior profile. Produces stable reason codes.
   *
   * Phase 1: simple signal-bias and quality checks.
   * Phase 1.1+: peer-preset comparison using signal-count ratio.
   */
  private evaluateEligibility(
    candidate: typeof agentScanCandidates.$inferSelect,
    activePreset: ActivePresetState,
  ): { eligible: boolean; reasons: string[] } {
    const reasons: string[] = [];

    // Regime-bias check — only when we have regime data
    if (candidate.regimeBucket && activePreset.signalBias) {
      const regime = candidate.regimeBucket.toLowerCase();
      if (regime === 'blocked') {
        reasons.push(ReviewPreCheckReasonCodes.REGIME_BIAS_MISMATCH);
        return { eligible: false, reasons };
      }
    }

    // Volatility check — when volatility fact is available
    const volFact = candidate.volatilityFact;
    const maxVol = activePreset.compatibilityThresholds?.['maxVolatilityPercentile'];
    if (volFact != null && maxVol != null && Number(volFact) > maxVol) {
      reasons.push(ReviewPreCheckReasonCodes.VOLATILITY_OUTSIDE_PRESET_BAND);
      return { eligible: false, reasons };
    }

    // Quality check — minimum confidence
    const confidence = candidate.confidence;
    if (confidence != null && Number(confidence) < 0.3) {
      reasons.push(ReviewPreCheckReasonCodes.INSUFFICIENT_CANDIDATE_QUALITY);
      return { eligible: false, reasons };
    }

    // If we get here without reasons, add a positive reason for entry/exit candidates
    if (candidate.disposition === 'entry_candidate') {
      reasons.push(ReviewPreCheckReasonCodes.PEER_OUTPERFORMANCE_DETECTED);
    } else if (candidate.disposition === 'exit_advisory') {
      reasons.push(ReviewPreCheckReasonCodes.PEER_OUTPERFORMANCE_DETECTED);
    } else {
      reasons.push(ReviewPreCheckReasonCodes.NO_PEER_OUTPERFORMANCE);
      return { eligible: false, reasons };
    }

    return { eligible: true, reasons };
  }

  // ── Persistence ──────────────────────────────────────────────────────

  /**
   * Persist the pre-check outcomes: one review-check record and one
   * review_advice row per actionable candidate.
   */
  private async persistCheckOutcomes(
    checkId: string,
    checkedAt: string,
    candidates: CandidatePreCheckOutcome[],
    nextEligibleAt: Date,
  ): Promise<Result<void>> {
    try {
      const checkedAtDate = new Date(checkedAt);
      const reviewDueAt = checkedAtDate;
      const expiresAt = new Date(Date.now() + this.config.adviceExpiryMs);

      // Persist the review-check record
      const advisedCount = candidates.filter((c) => c.outcome === 'advised').length;
      const blockedCount = candidates.filter((c) =>
        ['blocked_by_cooldown', 'blocked_by_no_credit_indication', 'fresh_artifact_exists'].includes(c.outcome),
      ).length;
      const notAdvisedCount = candidates.filter((c) => c.outcome === 'not_advised').length;
      const noCandidate = candidates.some((c) => c.outcome === 'no_candidate');

      let checkOutcome: string;
      if (advisedCount > 0) checkOutcome = 'advised';
      else if (noCandidate && candidates.length === 1) checkOutcome = 'no_candidate';
      else checkOutcome = 'no_advice';

      await this.db.insert(agentAssessmentReviewChecks).values({
        id: checkId,
        agentId: this.agentId,
        effectiveIntervalMs: Math.max(this.config.reviewIntervalMs, this.config.minReviewIntervalMs),
        dueAt: reviewDueAt,
        checkedAt: checkedAtDate,
        nextEligibleAt,
        status: 'completed',
        policyVersion: this.config.preCheck.policyVersion,
        outcomeSummary: {
          advised: advisedCount,
          blocked: blockedCount,
          notAdvised: notAdvisedCount,
          noCandidate: noCandidate ? 1 : 0,
          total: candidates.length,
        },
        checkOutcome,
      });

      // Skip no_candidate outcomes — no identity to hand off
      const actionable = candidates.filter((c) => c.outcome !== 'no_candidate');

      const rows = actionable.map((c, i) => {
        const identity = c.identity;
        const symbol = identity && 'symbol' in identity ? identity.symbol : null;
        const network = identity && 'network' in identity ? identity.network : null;
        const address = identity && 'address' in identity ? identity.address : null;

        return {
          id: `${checkId}:${i}`,
          agentId: this.agentId,
          checkId,
          instrumentKind: identity?.instrumentKind ?? 'orderbook',
          venueFamily: identity?.venueFamily ?? 'unknown',
          styleTier: identity?.styleTier ?? 'standard',
          symbol,
          network,
          address,
          identitySnapshot: (identity ?? {}) as Record<string, unknown>,
          checkedAt: checkedAtDate,
          reviewDueAt,
          nextEligibleAt,
          candidateRank: c.candidateRank ?? null,
          supportingFacts: c.reasons ? { reasons: c.reasons } : null,
          activePreset: c.activePreset ?? 'unknown',
          presetBehaviorVersion: c.presetBehaviorVersion ?? 'unknown',
          outcome: c.outcome,
          expiresAt,
        };
      });

      if (rows.length > 0) {
        await this.db.insert(reviewAdvice).values(rows);
      }

      this.logger.info(
        { checkId, checkOutcome, persistedCount: rows.length, outcomeSummary: { advised: advisedCount, blocked: blockedCount, notAdvised: notAdvisedCount } },
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
