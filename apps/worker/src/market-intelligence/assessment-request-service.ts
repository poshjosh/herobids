import crypto from 'node:crypto';
import { eq, and, gte, desc, sql } from 'drizzle-orm';
import { createLogger } from '../logger.js';
import type { Logger } from 'pino';
import type { Database } from '@herobids/db';
import { agents } from '@herobids/db';
import {
  marketAssessmentRequests,
  marketAssessmentRuns,
  marketAssessmentArtifacts,
} from '@herobids/db';
import { UsageBillingRepository } from '@herobids/db';
import {
  resolveAssessmentIdentity,
  resolveAssessmentConfig,
  ok,
  err,
  type Result,
  type MarketAssessmentIdentity,
  type PlatformAssessorConfig,
  type PlatformAssessmentOptIn,
  type AssessmentRequestPortOutcome,
  type AssessmentRequestPortParams,
  type AssessmentArtifactSummary,
} from '@herobids/domain';
import { PlatformAssessor } from './platform-assessor.js';

// ── Outcome Types ───────────────────────────────────────────────────────────

export type AssessmentRequestOutcome =
  | { kind: 'request_in_flight'; message: string; canonicalIdentity?: MarketAssessmentIdentity }
  | { kind: 'billing_blocked'; reason: string; requestId?: string; canonicalIdentity?: MarketAssessmentIdentity }
  | { kind: 'cooldown_blocked'; nextEligibleAt: string; requestId?: string; canonicalIdentity?: MarketAssessmentIdentity }
  | { kind: 'identity_unresolved'; reason: string; requestId?: string }
  | { kind: 'provider_failed'; error: string; errorCode?: string; requestId: string; canonicalIdentity?: MarketAssessmentIdentity }
  | { kind: 'cache_hit'; assessmentArtifactId: string; billed: true; requestId: string; canonicalIdentity: MarketAssessmentIdentity; artifact: AssessmentArtifactSummary }
  | { kind: 'assessment_completed'; assessmentArtifactId: string; billed: true; requestId: string; canonicalIdentity: MarketAssessmentIdentity; artifact: AssessmentArtifactSummary };

// ── Request Params ──────────────────────────────────────────────────────────

export interface AssessmentRequestParams {
  agentId: string;
  symbol: string;
  venueFamily?: string;
  instrumentKind?: 'orderbook' | 'perp' | 'swap' | 'dex';
  styleTier?: 'economy' | 'standard' | 'premium';
  idempotencyKey?: string;
  /** For orderbook/perp: set of known venue symbols (already normalized). */
  knownSymbols?: Set<string>;
  /** For swap/dex: mapping from user-facing symbol to canonical {network, address}. */
  tokenResolutions?: Map<string, { network: string; address: string }>;
}

// ── Batch Types ─────────────────────────────────────────────────────────────

/** Per-instrument result from a batch assessment request. */
export interface BatchInstrumentResult {
  symbol: string;
  outcome: AssessmentRequestOutcome;
}

/** Outcome of a batch assessment request. */
export interface BatchAssessmentResult {
  /** Results per accepted instrument, in request order. */
  results: BatchInstrumentResult[];
  /** Number of instruments requested. */
  requestedCount: number;
  /** Number of instruments actually assessed (may be less due to cap). */
  assessedCount: number;
  /** The cap that was enforced. */
  maxInstrumentsPerRequest: number;
  /** Human-readable truncation message, if applicable. */
  truncationMessage?: string;
}

// ── Private Types ───────────────────────────────────────────────────────────

interface ResolvedBillableContext {
  billingAccountId: string;
  billingPeriodId: string;
  rateCardId: string;
  userId: string;
}

// ── Request Group Key ───────────────────────────────────────────────────────

function isSwapIdentity(identity: MarketAssessmentIdentity): identity is MarketAssessmentIdentity & { instrumentKind: 'swap' | 'dex'; network: string; address: string } {
  return identity.instrumentKind === 'swap' || identity.instrumentKind === 'dex';
}

function computeRequestGroupKey(
  agentId: string,
  identity: MarketAssessmentIdentity,
  idempotencyKey: string,
): string {
  const parts = [agentId, identity.instrumentKind, identity.venueFamily, identity.styleTier];
  if (isSwapIdentity(identity)) {
    parts.push(identity.network, identity.address, idempotencyKey);
  } else {
    parts.push(identity.symbol, idempotencyKey);
  }
  return parts.join('|');
}

// ── Identity Key Serialization ──────────────────────────────────────────────

/**
 * Serialize a canonical `MarketAssessmentIdentity` into a deterministic
 * string key for lease tracking.
 */
function identityKey(identity: MarketAssessmentIdentity): string {
  if (isSwapIdentity(identity)) {
    return `${identity.instrumentKind}|${identity.venueFamily}|${identity.styleTier}|${identity.network}|${identity.address}`;
  }
  return `${identity.instrumentKind}|${identity.venueFamily}|${identity.styleTier}|${identity.symbol}`;
}

// ── Identity Where Clause Builder ───────────────────────────────────────────

/**
 * Build drizzle where conditions for canonical identity columns.
 */
function identityWhereConditions(
  identity: MarketAssessmentIdentity,
  table: typeof marketAssessmentRequests | typeof marketAssessmentArtifacts | typeof marketAssessmentRuns,
) {
  if (isSwapIdentity(identity)) {
    return [
      eq(table.instrumentKind, identity.instrumentKind),
      eq(table.venueFamily, identity.venueFamily),
      eq(table.styleTier, identity.styleTier),
      eq(table.network, identity.network),
      eq(table.address, identity.address),
    ];
  }
  return [
    eq(table.instrumentKind, identity.instrumentKind),
    eq(table.venueFamily, identity.venueFamily),
    eq(table.styleTier, identity.styleTier),
    eq(table.symbol, identity.symbol),
  ];
}

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * Single service boundary for on-demand assessment requests.
 *
 * Every agent-initiated assessment flows through `requestAssessment`.
 * The service handles identity resolution, DB-backed idempotency, cooldown,
 * daily cap enforcement, billing reservation, cache lookup, and cross-worker
 * safety via the `uq_market_assessment_requests_group_in_progress` partial
 * unique index.
 */
export class AssessmentRequestService {
  private readonly log: Logger;
  private readonly config: PlatformAssessorConfig;

  /**
   * In-flight leases keyed by `identityKey(identity)`.
   * Same-process optimization — the DB partial unique index on
   * request_group_key WHERE status='in_progress' is the cross-worker authority.
   */
  private readonly inFlightLeases = new Map<string, Promise<AssessmentRequestOutcome>>();

  /** Maximum instruments accepted per batch request. */
  private readonly _maxInstrumentsPerRequest: number;

  constructor(
    private readonly db: Database,
    private readonly billingRepo: UsageBillingRepository,
    operatorConfig: PlatformAssessorConfig,
    private readonly assessor: PlatformAssessor,
  ) {
    this.log = createLogger('assessment-request-service');
    this.config = operatorConfig;
    this._maxInstrumentsPerRequest = operatorConfig.maxInstrumentsPerRequest;

    // Validate settlement policy at construction time — logs error if misconfigured.
    // Uses createLogger directly since `this.log` is assigned after the constructor body.
    void (async () => {
      const { validateSettlementPolicy } = await import('./assessment-settlement-policy.js');
      if (!validateSettlementPolicy()) {
        createLogger('assessment-request-service').error('Assessment settlement policy validation failed');
      }
    })();
  }

  // ── Public API ────────────────────────────────────────────────────────

  /** Expose the per-request instrument cap so tools can read it without reaching into config. */
  get maxInstrumentsPerRequest(): number {
    return this._maxInstrumentsPerRequest;
  }

  /**
   * Process an on-demand assessment request with billing, DB-backed
   * idempotency, daily cap enforcement, cache lookup, and cross-worker safety.
   */
  async requestAssessment(
    params: AssessmentRequestParams,
  ): Promise<Result<AssessmentRequestOutcome>> {
    const now = new Date();

    // ── 1. Resolve canonical identity ─────────────────────────────────
    const identityResult = resolveAssessmentIdentity({
      instrumentKind: params.instrumentKind ?? 'orderbook',
      venueFamily: params.venueFamily ?? 'hyperliquid',
      styleTier: params.styleTier ?? 'standard',
      symbol: params.symbol,
      knownSymbols: params.knownSymbols,
      tokenResolutions: params.tokenResolutions,
    });

    if (!identityResult.ok) {
      const requestId = await this.persistTerminalRequest(params, null, now, {
        status: 'identity_unresolved',
        billingOutcome: 'none',
        failureCode: identityResult.error.code,
        failureMessage: identityResult.error.message,
      });
      const outcome: AssessmentRequestOutcome = {
        kind: 'identity_unresolved',
        reason: identityResult.error.message,
        requestId,
      };
      this.log.warn({ symbol: params.symbol, error: identityResult.error }, 'Assessment identity unresolved');
      return ok(outcome);
    }

    const identity = identityResult.data;

    // ── 2. Resolve agent owner ────────────────────────────────────────
    const [agentRow] = await this.db
      .select({ userId: agents.userId, unifiedConfig: agents.unifiedConfig })
      .from(agents)
      .where(eq(agents.id, params.agentId))
      .limit(1);

    if (!agentRow) {
      return err({ code: 'assessment.agent_not_found', message: `Agent ${params.agentId} not found` });
    }

    const userId = agentRow.userId;

    // ── 3. Resolve platform assessment config ─────────────────────────
    const agentOptIn: PlatformAssessmentOptIn | undefined =
      agentRow.unifiedConfig?.platformAssessment;
    const configResult = resolveAssessmentConfig(agentOptIn, this.config);
    if (!configResult.ok) {
      this.log.warn({ err: configResult.error, agentId: params.agentId }, 'Assessment config resolution failed — using operator defaults');
    }
    const resolvedConfig = configResult.ok ? configResult.data : {
      enabled: true,
      reviewIntervalMs: this.config.minReviewIntervalMs,
      minConfidenceThreshold: 0.6,
      minScoreUpliftThreshold: 15,
      cacheFreshnessMs: this.config.cacheFreshnessMs,
      scannerCandidateLimit: this.config.scannerCandidateLimit,
      maxReviewRequestsPerDay: this.config.maxReviewRequestsPerDay,
      minReviewIntervalMs: this.config.minReviewIntervalMs,
    };

    // ── 3a. Enforce enabled gates (operator + agent) ──────────────────
    // Both the operator-level platform assessor master switch and the
    // per-agent opt-in must be enabled for any assessment work to proceed.
    if (!this.config.enabled) {
      this.log.info({ agentId: params.agentId }, 'Platform assessor disabled at operator level — assessment blocked');
      return ok({
        kind: 'identity_unresolved',
        reason: 'Platform assessment is not available',
      });
    }
    if (!resolvedConfig.enabled) {
      this.log.info({ agentId: params.agentId }, 'Agent has not opted into platform assessment — assessment blocked');
      return ok({
        kind: 'identity_unresolved',
        reason: 'Agent has not opted into platform assessment',
      });
    }

    // ── 4. Enforce cooldown ───────────────────────────────────────────
    const cooldownCutoff = new Date(now.getTime() - resolvedConfig.reviewIntervalMs);

    const [recentRequest] = await this.db
      .select({ id: marketAssessmentRequests.id, requestedAt: marketAssessmentRequests.requestedAt })
      .from(marketAssessmentRequests)
      .where(and(
        eq(marketAssessmentRequests.agentId, params.agentId),
        ...identityWhereConditions(identity, marketAssessmentRequests),
        gte(marketAssessmentRequests.requestedAt, cooldownCutoff),
        sql`${marketAssessmentRequests.status} NOT IN ('identity_unresolved', 'cooldown_blocked', 'billing_blocked')`,
      ))
      .orderBy(desc(marketAssessmentRequests.requestedAt))
      .limit(1);

    if (recentRequest) {
      const nextEligibleAt = new Date(
        recentRequest.requestedAt.getTime() + resolvedConfig.reviewIntervalMs,
      );
      const requestId = await this.persistTerminalRequest(params, identity, now, {
        status: 'cooldown_blocked',
        billingOutcome: 'none',
      });
      return ok({
        kind: 'cooldown_blocked',
        nextEligibleAt: nextEligibleAt.toISOString(),
        requestId,
      });
    }

    // ── 5. Enforce daily cap ──────────────────────────────────────────
    const dailyCapCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const dailyCap = resolvedConfig.maxReviewRequestsPerDay ?? this.config.maxReviewRequestsPerDay;

    const [dailyCountRow] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(marketAssessmentRequests)
      .where(and(
        eq(marketAssessmentRequests.agentId, params.agentId),
        gte(marketAssessmentRequests.requestedAt, dailyCapCutoff),
        sql`${marketAssessmentRequests.billingOutcome} IS NOT NULL`,
        sql`${marketAssessmentRequests.billingOutcome} != 'none'`,
      ));

    const dailyCount = dailyCountRow?.count ?? 0;
    if (dailyCount >= dailyCap) {
      const requestId = await this.persistTerminalRequest(params, identity, now, {
        status: 'billing_blocked',
        billingOutcome: 'none',
        failureCode: 'billing.daily_cap_exceeded',
        failureMessage: `Daily assessment cap of ${dailyCap} reached`,
      });
      return ok({
        kind: 'billing_blocked',
        reason: `Daily assessment cap of ${dailyCap} reached (${dailyCount} already used)`,
        requestId,
      });
    }

    // ── 6. Compute request group key ──────────────────────────────────
    const requestGroupKey = computeRequestGroupKey(
      params.agentId,
      identity,
      params.idempotencyKey ?? crypto.randomUUID(),
    );

    // ── 7. Check for existing completed/cached outcome ────────────────
    const [existingCompleted] = await this.db
      .select({
        status: marketAssessmentRequests.status,
        assessmentArtifactId: marketAssessmentRequests.assessmentArtifactId,
        id: marketAssessmentRequests.id,
      })
      .from(marketAssessmentRequests)
      .where(and(
        eq(marketAssessmentRequests.requestGroupKey, requestGroupKey),
        sql`${marketAssessmentRequests.status} IN ('cache_hit', 'assessment_completed')`,
      ))
      .orderBy(desc(marketAssessmentRequests.attemptNumber))
      .limit(1);

    if (existingCompleted?.assessmentArtifactId) {
      const artifactSummary = await this.loadArtifactSummary(existingCompleted.assessmentArtifactId);
      return ok({
        kind: existingCompleted.status as 'cache_hit' | 'assessment_completed',
        assessmentArtifactId: existingCompleted.assessmentArtifactId,
        billed: true,
        requestId: existingCompleted.id,
        canonicalIdentity: identity,
        artifact: artifactSummary,
      });
    }

    // ── 8. Resolve billing context ────────────────────────────────────
    let billingCtx: ResolvedBillableContext;
    try {
      billingCtx = await this.resolveBillingContext(userId);
    } catch (billingErr) {
      const message = billingErr instanceof Error ? billingErr.message : String(billingErr);
      this.log.error({ err: billingErr, userId, agentId: params.agentId }, 'Failed to resolve billing context');
      const requestId = await this.persistTerminalRequest(params, identity, now, {
        status: 'billing_blocked',
        billingOutcome: 'none',
        failureCode: 'billing.context_resolution_failed',
        failureMessage: message,
      });
      return ok({ kind: 'billing_blocked', reason: message, requestId });
    }

    // ── 9. Quote the meter charge ─────────────────────────────────────
    const quotedAmount: number = await this.billingRepo.quoteMeterCharge({
      rateCardId: billingCtx.rateCardId,
      meterKey: 'assessment.request',
      quantity: 1,
    });

    // ── 10. Check account status ──────────────────────────────────────
    const spendState = await this.billingRepo.getSpendState(billingCtx.billingAccountId);
    if (spendState?.status === 'hard_limited') {
      const requestId = await this.persistTerminalRequest(params, identity, now, {
        status: 'billing_blocked',
        billingOutcome: 'none',
        billingAccountId: billingCtx.billingAccountId,
        billingPeriodId: billingCtx.billingPeriodId,
        rateCardId: billingCtx.rateCardId,
        failureCode: 'billing.limit_exceeded',
        failureMessage: 'Account is hard-limited',
      });
      return ok({ kind: 'billing_blocked', reason: 'Account is hard-limited', requestId });
    }
    if (spendState?.status === 'suspended') {
      const requestId = await this.persistTerminalRequest(params, identity, now, {
        status: 'billing_blocked',
        billingOutcome: 'none',
        billingAccountId: billingCtx.billingAccountId,
        billingPeriodId: billingCtx.billingPeriodId,
        rateCardId: billingCtx.rateCardId,
        failureCode: 'billing.account_suspended',
        failureMessage: 'Account is suspended',
      });
      return ok({ kind: 'billing_blocked', reason: 'Account is suspended', requestId });
    }

    // ── 11. Create the request row (cross-worker dedup) ───────────────
    const requestId = crypto.randomUUID();
    // Determine attempt number from existing requests in the group
    const [maxAttemptRow] = await this.db
      .select({ maxAttempt: sql<number>`COALESCE(MAX(${marketAssessmentRequests.attemptNumber}), -1)` })
      .from(marketAssessmentRequests)
      .where(eq(marketAssessmentRequests.requestGroupKey, requestGroupKey));

    const attemptNumber = (maxAttemptRow?.maxAttempt ?? -1) + 1;

    try {
      await this.db.insert(marketAssessmentRequests).values({
        id: requestId,
        agentId: params.agentId,
        userId: billingCtx.userId,
        billingAccountId: billingCtx.billingAccountId,
        billingPeriodId: billingCtx.billingPeriodId,
        rateCardId: billingCtx.rateCardId,
        instrumentKind: identity.instrumentKind,
        venueFamily: identity.venueFamily,
        styleTier: identity.styleTier,
        symbol: this.identitySymbol(identity),
        network: this.identityNetwork(identity),
        address: this.identityAddress(identity),
        identitySnapshot: this.serializeIdentity(identity),
        idempotencyKey: params.idempotencyKey ?? null,
        attemptNumber,
        requestGroupKey,
        status: 'in_progress',
        reservationAmountMicrousd: quotedAmount,
        requestedAt: now,
      });
    } catch (insertErr: unknown) {
      // Check if this is a unique constraint violation on the in_progress partial index (R2)
      if (
        insertErr instanceof Error &&
        'code' in insertErr &&
        (insertErr as Record<string, unknown>).code === '23505'
      ) {
        this.log.info({ requestGroupKey }, 'Duplicate in_progress request blocked by unique index');
        return ok({ kind: 'request_in_flight', message: 'A request for this group is already in progress' });
      }
      throw insertErr;
    }

    // ── 12. Reserve credit ────────────────────────────────────────────
    const reservationId = `led_res_${requestId}`;
    try {
      await this.billingRepo.reserveCharge({
        accountId: billingCtx.billingAccountId,
        periodId: billingCtx.billingPeriodId,
        amountMicrousd: quotedAmount,
        reservationId,
        description: `Assessment request reservation for ${requestId}`,
      });
    } catch (reserveErr: unknown) {
      const message = reserveErr instanceof Error ? reserveErr.message : String(reserveErr);
      const errCode =
        reserveErr instanceof Error && 'code' in reserveErr
          ? String((reserveErr as Record<string, unknown>).code)
          : 'billing.reservation_failed';
      this.log.warn({ err: reserveErr, requestId }, 'Credit reservation failed');
      await this.updateRequestRow(requestId, {
        status: 'billing_blocked',
        billingOutcome: 'none',
        failureCode: errCode,
        failureMessage: message,
        completedAt: new Date(),
      }).catch((e) => this.log.error({ err: e, requestId }, 'Failed to update request after reservation failure'));
      return ok({ kind: 'billing_blocked', reason: message, requestId });
    }

    // ── 13. Recheck fresh artifact cache ──────────────────────────────
    const [freshArtifact] = await this.db
      .select({
        id: marketAssessmentArtifacts.id,
        assessedAt: marketAssessmentArtifacts.assessedAt,
        expiresAt: marketAssessmentArtifacts.expiresAt,
        currentMarketSummary: marketAssessmentArtifacts.currentMarketSummary,
        regimeSummary: marketAssessmentArtifacts.regimeSummary,
        scanHealthSummary: marketAssessmentArtifacts.scanHealthSummary,
        presetRankings: marketAssessmentArtifacts.presetRankings,
        recommendedPreset: marketAssessmentArtifacts.recommendedPreset,
        allowedPresets: marketAssessmentArtifacts.allowedPresets,
        confidence: marketAssessmentArtifacts.confidence,
        urgency: marketAssessmentArtifacts.urgency,
      })
      .from(marketAssessmentArtifacts)
      .where(and(
        ...identityWhereConditions(identity, marketAssessmentArtifacts),
        eq(marketAssessmentArtifacts.status, 'active'),
        gte(marketAssessmentArtifacts.expiresAt, now),
      ))
      .orderBy(desc(marketAssessmentArtifacts.assessedAt))
      .limit(1);

    if (freshArtifact) {
      // Cache hit — capture the reservation
      try {
        const captureResult = await this.billingRepo.captureReservedAssessmentCharge({
          accountId: billingCtx.billingAccountId,
          periodId: billingCtx.billingPeriodId,
          rateCardId: billingCtx.rateCardId,
          amountMicrousd: quotedAmount,
          requestId,
          userId: billingCtx.userId,
          agentId: params.agentId,
          meterKey: 'assessment.request',
          quantity: 1,
          unit: 'request',
          reservationLedgerEntryId: reservationId,
          description: `Assessment request cache hit for ${requestId}`,
        });

        await this.updateRequestRow(requestId, {
          status: 'cache_hit',
          billingOutcome: 'captured',
          assessmentArtifactId: freshArtifact.id,
          captureUsageEventId: captureResult.usageEventId,
          captureLedgerEntryId: captureResult.captureLedgerEntryId,
          reservationLedgerEntryId: reservationId,
          completedAt: new Date(),
        }).catch((e) => this.log.error({ err: e, requestId }, 'Failed to update request for cache hit'));

        return ok({
          kind: 'cache_hit',
          assessmentArtifactId: freshArtifact.id,
          billed: true,
          requestId,
          canonicalIdentity: identity,
          artifact: {
            assessedAt: freshArtifact.assessedAt.toISOString(),
            expiresAt: freshArtifact.expiresAt.toISOString(),
            currentMarketSummary: freshArtifact.currentMarketSummary,
            regimeSummary: freshArtifact.regimeSummary,
            scanHealthSummary: freshArtifact.scanHealthSummary,
            presetRankings: freshArtifact.presetRankings as AssessmentArtifactSummary['presetRankings'],
            recommendedPreset: freshArtifact.recommendedPreset,
            allowedPresets: freshArtifact.allowedPresets as string[],
            confidence: Number(freshArtifact.confidence),
            urgency: freshArtifact.urgency as AssessmentArtifactSummary['urgency'],
          },
        });
      } catch (captureErr: unknown) {
        const message = captureErr instanceof Error ? captureErr.message : String(captureErr);
        this.log.error({ err: captureErr, requestId }, 'Cache hit capture failed');
        await this.releaseReservationSafely(billingCtx, reservationId, quotedAmount, requestId);
        await this.updateRequestRow(requestId, {
          status: 'provider_failed',
          billingOutcome: 'released',
          failureCode: 'billing.capture_failed',
          failureMessage: message,
          completedAt: new Date(),
        }).catch((e) => this.log.error({ err: e, requestId }, 'Failed to update request after capture failure'));
        return ok({ kind: 'provider_failed', error: message, requestId });
      }
    }

    // ── 14. Cache miss — acquire per-identity lease ───────────────────
    const leaseKey = identityKey(identity);
    const existingLease = this.inFlightLeases.get(leaseKey);
    if (existingLease) {
      this.log.debug({ leaseKey }, 'Reusing in-flight assessment lease');
      // Release our reservation since the existing lease will settle billing
      await this.releaseReservationSafely(billingCtx, reservationId, quotedAmount, requestId);
      return ok(await existingLease);
    }

    const leasePromise = this.runAssessorWithBilling(
      identity,
      params.agentId,
      requestId,
      billingCtx,
      quotedAmount,
      reservationId,
      now,
    );
    this.inFlightLeases.set(leaseKey, leasePromise);

    try {
      const outcome = await leasePromise;
      return ok(outcome);
    } finally {
      this.inFlightLeases.delete(leaseKey);
    }
  }

  /**
   * Port-compliant batch assessment entry point.
   * Accepts pre-resolution AssessmentRequestPortParams and processes each serially.
   */
  async requestBatchAssessment(
    params: AssessmentRequestPortParams[],
  ): Promise<Result<AssessmentRequestPortOutcome[]>> {
    const results: AssessmentRequestPortOutcome[] = [];

    for (const p of params) {
      const result = await this.requestAssessment({
        agentId: p.agentId,
        symbol: p.symbol,
        venueFamily: p.venueFamily,
        instrumentKind: p.instrumentKind,
        styleTier: p.styleTier,
        idempotencyKey: p.idempotencyKey,
      });

      if (result.ok) {
        results.push(this.mapInternalToPortOutcome(result.data));
      } else {
        results.push({
          kind: 'provider_failed',
          error: result.error.message,
          errorCode: result.error.code,
          requestId: crypto.randomUUID(),
        });
      }
    }

    return ok(results);
  }

  /**
   * Process a batch of symbols sharing the same venue/instrument context.
   * Each symbol is processed serially through requestAssessment.
   * Partial success is allowed — some symbols may succeed while others fail.
   */
  async requestBatchAssessmentBySymbols(
    symbols: string[],
    sharedParams: Omit<AssessmentRequestParams, 'symbol'>,
    maxInstrumentsPerRequest: number = this.maxInstrumentsPerRequest,
  ): Promise<BatchAssessmentResult> {
    const cap = Math.max(1, maxInstrumentsPerRequest);

    if (symbols.length === 0) {
      return {
        results: [],
        requestedCount: 0,
        assessedCount: 0,
        maxInstrumentsPerRequest: cap,
        truncationMessage: undefined,
      };
    }

    const requestedCount = symbols.length;
    const acceptedSymbols = symbols.slice(0, cap);
    const assessedCount = acceptedSymbols.length;

    let truncationMessage: string | undefined;
    if (requestedCount > cap) {
      truncationMessage = `Requested ${requestedCount} instruments; only the first ${assessedCount} were assessed because the per-request maximum is ${cap}.`;
      this.log.info({ requestedCount, assessedCount, maxInstrumentsPerRequest: cap }, 'Assessment batch truncated');
    }

    const results: BatchInstrumentResult[] = [];

    for (const symbol of acceptedSymbols) {
      try {
        const result = await this.requestAssessment({
          ...sharedParams,
          symbol,
        });

        if (result.ok) {
          results.push({ symbol, outcome: result.data });
        } else {
          results.push({
            symbol,
            outcome: {
              kind: 'provider_failed',
              error: result.error.message,
              errorCode: result.error.code,
              requestId: crypto.randomUUID(),
            },
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn({ err, symbol }, 'Assessment request threw — captured as provider_failed');
        results.push({
          symbol,
          outcome: {
            kind: 'provider_failed',
            error: message,
            requestId: crypto.randomUUID(),
          },
        });
      }
    }

    return {
      results,
      requestedCount,
      assessedCount,
      maxInstrumentsPerRequest: cap,
      truncationMessage,
    };
  }

  // ── Assessor with Billing ────────────────────────────────────────────

  /**
   * Run the platform assessor with full billing lifecycle:
   * persist run, call assessor, supersede old artifacts, insert new artifact,
   * capture reservation on success or release on failure, and update
   * the request row.
   */
  private async runAssessorWithBilling(
    identity: MarketAssessmentIdentity,
    agentId: string,
    requestId: string,
    billingCtx: ResolvedBillableContext,
    quotedAmount: number,
    reservationId: string,
    now: Date,
  ): Promise<AssessmentRequestOutcome> {
    const runId = crypto.randomUUID();

    // ── Create run record ─────────────────────────────────────────────
    try {
      await this.db.insert(marketAssessmentRuns).values({
        id: runId,
        instrumentKind: identity.instrumentKind,
        venueFamily: identity.venueFamily,
        styleTier: identity.styleTier,
        symbol: this.identitySymbol(identity),
        network: this.identityNetwork(identity),
        address: this.identityAddress(identity),
        identitySnapshot: this.serializeIdentity(identity),
        startedAt: now,
        status: 'in_progress',
        evidenceRefs: [],
      });
    } catch (err) {
      this.log.error({ err, runId }, 'Failed to create assessment run record');
      await this.releaseReservationSafely(billingCtx, reservationId, quotedAmount, requestId);
      await this.updateRequestRow(requestId, {
        status: 'provider_failed',
        billingOutcome: 'released',
        assessmentRunId: runId,
        failureCode: 'assessment.run_persist_failed',
        failureMessage: 'Failed to persist run intent',
        completedAt: new Date(),
      }).catch((e) => this.log.error({ err: e, requestId }, 'Failed to update request after run persist failure'));
      return { kind: 'provider_failed', error: 'Failed to persist run intent', requestId };
    }

    // Link the request to the run
    await this.updateRequestRow(requestId, {
      assessmentRunId: runId,
    }).catch((e) => this.log.warn({ err: e, requestId }, 'Failed to link request to run'));

    // ── Call the assessor ─────────────────────────────────────────────
    const result = await this.assessor.assessIdentity(identity, runId);

    if (!result.ok) {
      // ── Assessor failed — release reservation ───────────────────────
      await this.updateRunStatus(runId, 'failed', result.error.message);
      await this.releaseReservationSafely(billingCtx, reservationId, quotedAmount, requestId);
      await this.updateRequestRow(requestId, {
        status: 'provider_failed',
        billingOutcome: 'released',
        releaseLedgerEntryId: `led_rel_${requestId}`,
        failureCode: result.error.code,
        failureMessage: result.error.message,
        estimatedLlmCostMicrousd: 0,
        llmInputTokens: 0,
        llmOutputTokens: 0,
        llmReasoningTokens: 0,
        llmCallCount: 0,
        completedAt: new Date(),
      }).catch((e) => this.log.error({ err: e, requestId }, 'Failed to update request after assessor failure'));
      return { kind: 'provider_failed', error: result.error.message, errorCode: result.error.code, requestId };
    }

    const { artifact, llmUsage } = result.data;

    // ── Supersede old active artifacts ────────────────────────────────
    try {
      if (isSwapIdentity(identity)) {
        await this.db.update(marketAssessmentArtifacts)
          .set({ status: 'superseded' })
          .where(and(
            eq(marketAssessmentArtifacts.instrumentKind, identity.instrumentKind),
            eq(marketAssessmentArtifacts.venueFamily, identity.venueFamily),
            eq(marketAssessmentArtifacts.styleTier, identity.styleTier),
            eq(marketAssessmentArtifacts.network, identity.network),
            eq(marketAssessmentArtifacts.address, identity.address),
            eq(marketAssessmentArtifacts.status, 'active'),
          ));
      } else {
        await this.db.update(marketAssessmentArtifacts)
          .set({ status: 'superseded' })
          .where(and(
            eq(marketAssessmentArtifacts.instrumentKind, identity.instrumentKind),
            eq(marketAssessmentArtifacts.venueFamily, identity.venueFamily),
            eq(marketAssessmentArtifacts.styleTier, identity.styleTier),
            eq(marketAssessmentArtifacts.symbol, identity.symbol),
            eq(marketAssessmentArtifacts.status, 'active'),
          ));
      }
    } catch (err) {
      this.log.warn({ err, identity: identityKey(identity) }, 'Failed to supersede old artifacts — continuing');
    }

    // ── Persist new artifact ──────────────────────────────────────────
    try {
      await this.db.insert(marketAssessmentArtifacts).values({
        id: artifact.id,
        instrumentKind: identity.instrumentKind,
        venueFamily: identity.venueFamily,
        styleTier: identity.styleTier,
        symbol: this.identitySymbol(identity),
        network: this.identityNetwork(identity),
        address: this.identityAddress(identity),
        identitySnapshot: this.serializeIdentity(identity),
        assessmentRunId: runId,
        assessedAt: new Date(artifact.assessedAt),
        expiresAt: new Date(artifact.expiresAt),
        maxActorUseAge: artifact.maxActorUseAge,
        maxWakeAge: artifact.maxWakeAge,
        assessmentVersion: artifact.assessmentVersion,
        artifactVersion: artifact.artifactVersion,
        rankingPolicyVersion: artifact.rankingPolicyVersion,
        status: artifact.status,
        allowedPresets: artifact.allowedPresets,
        currentMarketSummary: artifact.currentMarketSummary,
        regimeSummary: artifact.regimeSummary,
        scanHealthSummary: artifact.scanHealthSummary,
        presetRankings: artifact.presetRankings,
        recommendedPreset: artifact.recommendedPreset,
        relativeUplift: artifact.relativeUplift != null ? String(artifact.relativeUplift) : null,
        confidence: String(artifact.confidence),
        urgency: artifact.urgency,
        reasoningSummary: artifact.reasoningSummary,
        evidenceRefs: artifact.evidenceRefs,
      });
    } catch (insertErr) {
      this.log.error({ err: insertErr, artifactId: artifact.id }, 'Failed to persist assessment artifact');
      await this.updateRunStatus(runId, 'failed', 'Failed to persist artifact');
      await this.releaseReservationSafely(billingCtx, reservationId, quotedAmount, requestId);
      await this.updateRequestRow(requestId, {
        status: 'provider_failed',
        billingOutcome: 'released',
        releaseLedgerEntryId: `led_rel_${requestId}`,
        failureCode: 'assessment.artifact_persist_failed',
        failureMessage: 'Failed to persist assessment artifact',
        estimatedLlmCostMicrousd: 0,
        llmInputTokens: 0,
        llmOutputTokens: 0,
        llmReasoningTokens: 0,
        llmCallCount: 0,
        completedAt: new Date(),
      }).catch((e) => this.log.error({ err: e, requestId }, 'Failed to update request after artifact persist failure'));
      return { kind: 'provider_failed', error: 'Failed to persist assessment artifact', requestId };
    }

    // ── Update run to completed ───────────────────────────────────────
    await this.updateRunStatus(runId, 'completed');

    // ── Capture reservation ───────────────────────────────────────────
    try {
      const captureResult = await this.billingRepo.captureReservedAssessmentCharge({
        accountId: billingCtx.billingAccountId,
        periodId: billingCtx.billingPeriodId,
        rateCardId: billingCtx.rateCardId,
        amountMicrousd: quotedAmount,
        requestId,
        userId: billingCtx.userId,
        agentId,
        meterKey: 'assessment.request',
        quantity: 1,
        unit: 'request',
        reservationLedgerEntryId: reservationId,
        description: `Assessment request completed for ${requestId}`,
      });

      // ── Update request row to completed ─────────────────────────────
      await this.updateRequestRow(requestId, {
        status: 'assessment_completed',
        billingOutcome: 'captured',
        assessmentArtifactId: artifact.id,
        captureUsageEventId: captureResult.usageEventId,
        captureLedgerEntryId: captureResult.captureLedgerEntryId,
        reservationLedgerEntryId: reservationId,
        estimatedLlmCostMicrousd: llmUsage.estimatedCostMicrousd,
        llmInputTokens: llmUsage.totalInputTokens,
        llmOutputTokens: llmUsage.totalOutputTokens,
        llmReasoningTokens: llmUsage.totalReasoningTokens,
        llmCallCount: llmUsage.callCount,
        completedAt: new Date(),
      }).catch((e) => this.log.error({ err: e, requestId }, 'Failed to update request after assessor completion'));

      this.log.info(
        { identityKey: identityKey(identity), artifactId: artifact.id, runId, requestId },
        'Assessment completed, billed, and persisted',
      );

      return {
        kind: 'assessment_completed',
        assessmentArtifactId: artifact.id,
        billed: true,
        requestId,
        canonicalIdentity: identity,
        artifact: {
          assessedAt: artifact.assessedAt,
          expiresAt: artifact.expiresAt,
          currentMarketSummary: artifact.currentMarketSummary,
          regimeSummary: artifact.regimeSummary,
          scanHealthSummary: artifact.scanHealthSummary,
          presetRankings: artifact.presetRankings,
          recommendedPreset: artifact.recommendedPreset,
          allowedPresets: artifact.allowedPresets,
          confidence: artifact.confidence,
          urgency: artifact.urgency,
        },
      };
    } catch (captureErr: unknown) {
      const message = captureErr instanceof Error ? captureErr.message : String(captureErr);
      this.log.error({ err: captureErr, requestId }, 'Capture after assessment completion failed');
      // Release instead since capture failed
      await this.releaseReservationSafely(billingCtx, reservationId, quotedAmount, requestId);
      await this.updateRequestRow(requestId, {
        status: 'provider_failed',
        billingOutcome: 'released',
        releaseLedgerEntryId: `led_rel_${requestId}`,
        failureCode: 'billing.capture_failed',
        failureMessage: message,
        estimatedLlmCostMicrousd: 0,
        llmInputTokens: 0,
        llmOutputTokens: 0,
        llmReasoningTokens: 0,
        llmCallCount: 0,
        completedAt: new Date(),
      }).catch((e) => this.log.error({ err: e, requestId }, 'Failed to update request after capture failure'));
      return { kind: 'provider_failed', error: message, requestId };
    }
  }

  // ── Billing Helpers ──────────────────────────────────────────────────

  private async resolveBillingContext(userId: string): Promise<ResolvedBillableContext> {
    const account = await this.billingRepo.getOrCreateBillingAccountForUser(userId, 'default');
    const rateCard = await this.billingRepo.ensureActiveRateCard('default');
    const period = await this.billingRepo.getOrCreateOpenPeriod(
      account.id,
      new Date(),
      account.activePlanId,
      rateCard.id,
      0, // includedCreditMicrousd — plan-based credits are not yet wired
      account.softCapMicrousd,
      account.hardCapMicrousd,
    );

    return {
      billingAccountId: account.id,
      billingPeriodId: period.id,
      rateCardId: rateCard.id,
      userId,
    };
  }

  private async releaseReservationSafely(
    billingCtx: ResolvedBillableContext,
    reservationId: string,
    quotedAmount: number,
    requestId: string,
  ): Promise<void> {
    try {
      await this.billingRepo.releaseReservedCharge({
        accountId: billingCtx.billingAccountId,
        periodId: billingCtx.billingPeriodId,
        amountMicrousd: quotedAmount,
        releaseId: `led_rel_${requestId}`,
        reservationLedgerEntryId: reservationId,
        description: `Assessment request reservation release for ${requestId}`,
      });
      await this.updateRequestRow(requestId, {
        releaseLedgerEntryId: `led_rel_${requestId}`,
      }).catch((e) => this.log.warn({ err: e, requestId }, 'Failed to record release ledger entry on request'));
    } catch (releaseErr) {
      this.log.error({ err: releaseErr, requestId, reservationId }, 'Failed to release reservation — ledger may be orphaned');
    }
  }

  // ── DB Helpers ───────────────────────────────────────────────────────

  private async persistTerminalRequest(
    params: AssessmentRequestParams,
    identity: MarketAssessmentIdentity | null,
    now: Date,
    fields: {
      status: string;
      billingOutcome: string;
      billingAccountId?: string;
      billingPeriodId?: string;
      rateCardId?: string;
      failureCode?: string;
      failureMessage?: string;
    },
  ): Promise<string> {
    const requestId = crypto.randomUUID();
    const requestGroupKey = identity
      ? computeRequestGroupKey(
          params.agentId,
          identity,
          params.idempotencyKey ?? crypto.randomUUID(),
        )
      : `unresolved_${requestId}`;

    try {
      await this.db.insert(marketAssessmentRequests).values({
        id: requestId,
        agentId: params.agentId,
        userId: '', // will be filled on next attempt; identity_unresolved may not have user resolved
        billingAccountId: fields.billingAccountId ?? '',
        billingPeriodId: fields.billingPeriodId ?? null,
        rateCardId: fields.rateCardId ?? null,
        instrumentKind: identity?.instrumentKind ?? (params.instrumentKind ?? 'orderbook'),
        venueFamily: identity?.venueFamily ?? (params.venueFamily ?? 'hyperliquid'),
        styleTier: identity?.styleTier ?? (params.styleTier ?? 'standard'),
        symbol: identity ? this.identitySymbol(identity) : params.symbol,
        network: identity ? this.identityNetwork(identity) : null,
        address: identity ? this.identityAddress(identity) : null,
        identitySnapshot: identity ? this.serializeIdentity(identity) : {},
        idempotencyKey: params.idempotencyKey ?? null,
        attemptNumber: 0,
        requestGroupKey,
        status: fields.status,
        billingOutcome: fields.billingOutcome,
        failureCode: fields.failureCode ?? null,
        failureMessage: fields.failureMessage ?? null,
        requestedAt: now,
        completedAt: now,
      });
    } catch (err) {
      this.log.error({ err, requestId }, 'Failed to persist terminal request row');
    }
    return requestId;
  }

  private async updateRequestRow(
    requestId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .update(marketAssessmentRequests)
      .set(fields)
      .where(eq(marketAssessmentRequests.id, requestId));
  }

  private async updateRunStatus(
    runId: string,
    status: string,
    errorMessage?: string,
  ): Promise<void> {
    try {
      const updateFields: Record<string, unknown> = { status };
      if (status === 'completed' || status === 'failed') {
        updateFields.completedAt = new Date();
      }
      if (errorMessage) {
        updateFields.errorMessage = errorMessage;
      }
      await this.db
        .update(marketAssessmentRuns)
        .set(updateFields)
        .where(eq(marketAssessmentRuns.id, runId));
    } catch (err) {
      this.log.error({ err, runId, status }, 'Failed to update run status');
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Load an artifact summary from the DB for a cache-hit path
   * where we only have the artifact ID.
   */
  private async loadArtifactSummary(artifactId: string): Promise<AssessmentArtifactSummary> {
    const [row] = await this.db
      .select({
        assessedAt: marketAssessmentArtifacts.assessedAt,
        expiresAt: marketAssessmentArtifacts.expiresAt,
        currentMarketSummary: marketAssessmentArtifacts.currentMarketSummary,
        regimeSummary: marketAssessmentArtifacts.regimeSummary,
        scanHealthSummary: marketAssessmentArtifacts.scanHealthSummary,
        presetRankings: marketAssessmentArtifacts.presetRankings,
        recommendedPreset: marketAssessmentArtifacts.recommendedPreset,
        allowedPresets: marketAssessmentArtifacts.allowedPresets,
        confidence: marketAssessmentArtifacts.confidence,
        urgency: marketAssessmentArtifacts.urgency,
      })
      .from(marketAssessmentArtifacts)
      .where(eq(marketAssessmentArtifacts.id, artifactId))
      .limit(1);

    if (!row || !row.assessedAt) {
      // Artifact not found (or row missing key fields) — return a stub with
      // sentinel values so consumers can distinguish "missing data" from
      // a real low-confidence assessment.
      this.log.warn({ artifactId }, 'Cache-hit artifact not found or incomplete — returning stub summary');
      return {
        assessedAt: '1970-01-01T00:00:00.000Z',
        expiresAt: '1970-01-01T00:00:00.000Z',
        currentMarketSummary: 'Artifact data unavailable',
        regimeSummary: 'Artifact data unavailable',
        scanHealthSummary: 'Artifact data unavailable',
        presetRankings: [],
        recommendedPreset: null,
        allowedPresets: [],
        confidence: -1,
        urgency: 'low',
      };
    }

    return {
      assessedAt: row.assessedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      currentMarketSummary: row.currentMarketSummary,
      regimeSummary: row.regimeSummary,
      scanHealthSummary: row.scanHealthSummary,
      presetRankings: row.presetRankings as AssessmentArtifactSummary['presetRankings'],
      recommendedPreset: row.recommendedPreset,
      allowedPresets: (row.allowedPresets as string[]) ?? [],
      confidence: Number(row.confidence),
      urgency: row.urgency as AssessmentArtifactSummary['urgency'],
    };
  }

  /**
   * Map an internal AssessmentRequestOutcome to the port-level discriminated union.
   * Strips the `billed` field and ensures the shape matches AssessmentRequestPortOutcome.
   */
  private mapInternalToPortOutcome(outcome: AssessmentRequestOutcome): AssessmentRequestPortOutcome {
    switch (outcome.kind) {
      case 'cache_hit':
      case 'assessment_completed':
        return {
          kind: outcome.kind,
          requestId: outcome.requestId,
          assessmentArtifactId: outcome.assessmentArtifactId,
          canonicalIdentity: outcome.canonicalIdentity,
          artifact: outcome.artifact,
        };
      case 'request_in_flight':
        return { kind: 'request_in_flight', message: outcome.message, canonicalIdentity: outcome.canonicalIdentity };
      case 'billing_blocked':
        return { kind: 'billing_blocked', reason: outcome.reason, requestId: outcome.requestId, canonicalIdentity: outcome.canonicalIdentity };
      case 'cooldown_blocked':
        return { kind: 'cooldown_blocked', nextEligibleAt: outcome.nextEligibleAt, requestId: outcome.requestId, canonicalIdentity: outcome.canonicalIdentity };
      case 'identity_unresolved':
        return { kind: 'identity_unresolved', reason: outcome.reason, requestId: outcome.requestId };
      case 'provider_failed':
        return { kind: 'provider_failed', error: outcome.error, errorCode: outcome.errorCode, requestId: outcome.requestId, canonicalIdentity: outcome.canonicalIdentity };
    }
  }

  private identitySymbol(identity: MarketAssessmentIdentity): string | null {
    if (identity.instrumentKind === 'orderbook' || identity.instrumentKind === 'perp') {
      return identity.symbol;
    }
    return null;
  }

  private identityNetwork(identity: MarketAssessmentIdentity): string | null {
    if (identity.instrumentKind === 'swap' || identity.instrumentKind === 'dex') {
      return identity.network;
    }
    return null;
  }

  private identityAddress(identity: MarketAssessmentIdentity): string | null {
    if (identity.instrumentKind === 'swap' || identity.instrumentKind === 'dex') {
      return identity.address;
    }
    return null;
  }

  private serializeIdentity(identity: MarketAssessmentIdentity): Record<string, unknown> {
    return { ...identity };
  }
}
