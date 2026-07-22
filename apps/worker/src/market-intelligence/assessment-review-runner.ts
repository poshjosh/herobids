import crypto from 'node:crypto';
import { createLogger } from '../logger.js';
import type { Logger } from 'pino';
import type { Database } from '@herobids/db';
import {
  reviewAdvice,
  agentScanCandidates,
  agentAssessmentReviewChecks,
  marketAssessmentArtifacts,
} from '@herobids/db';
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
import { eq, and, desc, inArray, gte } from 'drizzle-orm';

// ── Types ───────────────────────────────────────────────────────────────────

export interface AssessmentReviewRunnerConfig {
  /** Agent review interval in ms. */
  reviewIntervalMs: number;
  /** Operator minimum floor for review interval. */
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

export interface AssessmentReviewRunnerDeps {
  db: Database;
  agentId: string;
  /** Publishes {agent.wake} events to the agent's inbound stream. */
  eventPublisher: import('../agents/instance-event-publisher.js').InstanceEventPublisher;
  /** Resolve the agent's active preset state at pre-check time. */
  resolveActivePreset: () => Promise<Result<ActivePresetState>>;
  /** Read-only billing preflight. */
  checkBillingEligibility: () => Promise<Result<boolean>>;
}

export interface ReviewCheckOutcome {
  checkId: string;
  checkedAt: string;
  nextEligibleAt: string;
  advisedCount: number;
  outcomeCounts: Record<string, number>;
  hasAdvice: boolean;
}

export interface ReviewRunParams {
  /** 'scheduled' for timer-driven, 'manual' for user-triggered. */
  trigger: 'scheduled' | 'manual';
  /** When true, bypass the due-interval gate. Manual path always sets true. */
  force: boolean;
}

// ── Runner ──────────────────────────────────────────────────────────────────

/**
 * Reusable one-shot review execution service.
 *
 * Extracted from ReviewScheduler so both the scheduled timer loop and the
 * manual (user-triggered) runtime can share the same pre-check, persistence,
 * and wake emission logic.
 *
 * Behavior:
 * - `scheduled + force:false` — preserves current due-gated behavior.
 * - `manual + force:true` — skips only the due check; all other rules
 *   (candidate staleness, identity cooldown, fresh-artifact suppression)
 *   still apply.
 */
export class AssessmentReviewRunner {
  private readonly logger: Logger;
  private readonly db: Database;
  private readonly agentId: string;
  private readonly config: AssessmentReviewRunnerConfig;
  private readonly eventPublisher: AssessmentReviewRunnerDeps['eventPublisher'];
  private readonly resolveActivePreset: AssessmentReviewRunnerDeps['resolveActivePreset'];
  private readonly checkBillingEligibility: AssessmentReviewRunnerDeps['checkBillingEligibility'];

  constructor(deps: AssessmentReviewRunnerDeps, config: AssessmentReviewRunnerConfig) {
    this.db = deps.db;
    this.agentId = deps.agentId;
    this.config = config;
    this.eventPublisher = deps.eventPublisher;
    this.resolveActivePreset = deps.resolveActivePreset;
    this.checkBillingEligibility = deps.checkBillingEligibility;
    this.logger = createLogger(`review-runner:${deps.agentId}`);
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Run a review check.
   *
   * When `force` is true (manual trigger), the due-interval gate is skipped.
   * All other rules (candidate staleness, identity cooldown, fresh-artifact
   * suppression, billing preflight) still apply.
   */
  async run(params: ReviewRunParams): Promise<Result<ReviewCheckOutcome>> {
    const checkId = crypto.randomUUID();
    const checkedAt = new Date().toISOString();

    try {
      // 1. Due gate (only for scheduled, non-forced path)
      if (params.trigger === 'scheduled' && !params.force) {
        const dueResult = await this.isReviewDue();
        if (!dueResult.ok) return dueResult;
        if (!dueResult.data) {
          this.logger.debug('Review not due — skipping');
          return ok({
            checkId,
            checkedAt,
            nextEligibleAt: new Date(Date.now() + this.config.reviewIntervalMs).toISOString(),
            advisedCount: 0,
            outcomeCounts: { not_due: 1 },
            hasAdvice: false,
          });
        }
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

      // 5. Build actionable array
      const actionable = preCheck.filter((c) => c.outcome !== 'no_candidate');
      const nextEligibleAt = nextEligibleAtDate.toISOString();

      // 6. Emit agent wake when advice exists
      let effectiveAdvisedCount = 0;
      const advisedPreFilter = preCheck.filter((c) => c.outcome === 'advised');
      if (advisedPreFilter.length > 0) {
        const advisedCandidates = advisedPreFilter
          .map((c) => {
            const actionableIdx = actionable.indexOf(c);
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

          const parsed = AgentWakePayloadSchema.safeParse(payload);
          if (!parsed.success) {
            this.logger.error({ err: parsed.error.issues, payload }, 'Constructed invalid wake payload — this is a bug');
            return err({ code: 'review.invalid_wake_payload', message: 'Constructed wake payload failed schema validation' });
          }

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
    }
  }

  // ── Due Check ────────────────────────────────────────────────────────

  private async isReviewDue(): Promise<Result<boolean>> {
    try {
      const effectiveInterval = Math.max(
        this.config.reviewIntervalMs,
        this.config.minReviewIntervalMs,
      );

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
        return ok(true);
      }

      const now = Date.now();
      return ok(now - lastCheck.checkedAt.getTime() >= effectiveInterval);
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to determine if review is due');
      return err({ code: 'review.due_check_failed', message: 'Failed to query last review check' });
    }
  }

  // ── Deterministic Pre-Check ──────────────────────────────────────────

  private async runPreCheck(): Promise<Result<CandidatePreCheckOutcome[]>> {
    try {
      const presetResult = await this.resolveActivePreset();
      if (!presetResult.ok) {
        this.logger.warn({ err: presetResult.error }, 'Failed to resolve active preset — will still attempt candidate checks');
        return ok([{ outcome: 'no_candidate', reasons: ['active_preset_unresolved'] }]);
      }
      const activePreset = presetResult.data;

      const maxAge = new Date(Date.now() - this.config.preCheck.candidateMaxAgeMs);
      const candidates = await this.db
        .select()
        .from(agentScanCandidates)
        .where(
          and(
            eq(agentScanCandidates.agentId, this.agentId),
            gte(agentScanCandidates.scannedAt, maxAge),
            inArray(agentScanCandidates.disposition, ['entry_candidate', 'exit_advisory', 'scored_no_signal']),
            eq(agentScanCandidates.resolutionStatus, 'resolved'),
          ),
        )
        .orderBy(desc(agentScanCandidates.scannedAt), agentScanCandidates.candidateRank)
        .limit(this.config.scannerCandidateLimit);

      if (candidates.length === 0) {
        this.logger.debug('No qualifying scan candidates found for review');
        return ok([{ outcome: 'no_candidate', reasons: [ReviewPreCheckReasonCodes.NO_CANDIDATE] }]);
      }

      const billingResult = await this.checkBillingEligibility();
      const billingEligible = billingResult.ok && billingResult.data === true;

      const outcomes: CandidatePreCheckOutcome[] = [];
      const now = Date.now();
      const cooldownCutoff = new Date(now - this.config.preCheck.identityCooldownMs);
      const artifactFreshCutoff = new Date(now - this.config.cacheFreshnessMs);

      for (const candidate of candidates) {
        const identity = this.buildIdentityFromRow(candidate);

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

        const evalResult = this.evaluateEligibility(candidate, activePreset);
        outcomes.push({
          identity,
          outcome: evalResult.eligible ? 'advised' : 'not_advised',
          candidateRank: candidate.candidateRank,
          activePreset: activePreset.presetKey,
          presetBehaviorVersion: activePreset.behaviorVersion,
          reasons: evalResult.reasons,
        });
      }

      return ok(outcomes);
    } catch (error) {
      this.logger.error({ err: error }, 'Pre-check execution failed');
      return err({ code: 'review.precheck_failed', message: 'Pre-check execution encountered an unexpected error' });
    }
  }

  // ── Identity helpers ─────────────────────────────────────────────────

  private buildIdentityFromRow(
    candidate: typeof agentScanCandidates.$inferSelect,
  ): CandidatePreCheckOutcome['identity'] | null {
    try {
      const symbolOrNull = candidate.symbol ?? null;
      const networkOrNull = candidate.network ?? null;
      const addressOrNull = candidate.address ?? null;

      if (symbolOrNull && !networkOrNull && !addressOrNull) {
        return {
          instrumentKind: 'orderbook' as const,
          venueFamily: (candidate.venueFamily ?? 'hyperliquid') as string,
          styleTier: (candidate.styleTier ?? 'standard') as string,
          symbol: symbolOrNull,
        } as CandidatePreCheckOutcome['identity'];
      }

      if (networkOrNull && addressOrNull && !symbolOrNull) {
        return {
          instrumentKind: 'swap' as const,
          venueFamily: (candidate.venueFamily ?? 'jupiter') as string,
          styleTier: (candidate.styleTier ?? 'standard') as string,
          network: networkOrNull,
          address: addressOrNull,
        } as CandidatePreCheckOutcome['identity'];
      }

      return null;
    } catch {
      this.logger.warn({ candidateId: candidate.id }, 'Failed to build identity from candidate row');
      return null;
    }
  }

  // ── Cooldown & artifact checks ───────────────────────────────────────

  private async hasFreshArtifact(
    identity: NonNullable<CandidatePreCheckOutcome['identity']>,
    freshCutoff: Date,
  ): Promise<boolean> {
    try {
      const conditions = [
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
      this.logger.warn('Failed to check fresh artifacts — proceeding');
      return false;
    }
  }

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

  // ── Eligibility predicate ────────────────────────────────────────────

  private evaluateEligibility(
    candidate: typeof agentScanCandidates.$inferSelect,
    activePreset: ActivePresetState,
  ): { eligible: boolean; reasons: string[] } {
    const reasons: string[] = [];

    if (candidate.regimeBucket && activePreset.signalBias) {
      const regime = candidate.regimeBucket.toLowerCase();
      if (regime === 'blocked') {
        reasons.push(ReviewPreCheckReasonCodes.REGIME_BIAS_MISMATCH);
        return { eligible: false, reasons };
      }
    }

    const volFact = candidate.volatilityFact;
    const maxVol = activePreset.compatibilityThresholds?.['maxVolatilityPercentile'];
    if (volFact != null && maxVol != null && Number(volFact) > maxVol) {
      reasons.push(ReviewPreCheckReasonCodes.VOLATILITY_OUTSIDE_PRESET_BAND);
      return { eligible: false, reasons };
    }

    const confidence = candidate.confidence;
    if (confidence != null && Number(confidence) < 0.3) {
      reasons.push(ReviewPreCheckReasonCodes.INSUFFICIENT_CANDIDATE_QUALITY);
      return { eligible: false, reasons };
    }

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
        { checkId, checkOutcome, persistedCount: rows.length },
        'Review check outcomes persisted',
      );
      return ok(undefined);
    } catch (error) {
      this.logger.error({ err: error, checkId }, 'Failed to persist review check outcomes');
      return err({ code: 'review.persist_failed', message: 'Failed to persist review check outcomes' });
    }
  }

  // ── Advice lifecycle ─────────────────────────────────────────────────

  private async markAdviceConsumed(adviceIds: string[]): Promise<Result<void>> {
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
