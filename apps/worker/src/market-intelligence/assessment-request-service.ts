import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createLogger } from '../logger.js';
import type { Logger } from 'pino';
import type { Database } from '@herobids/db';
import { marketAssessmentRuns, marketAssessmentArtifacts } from '@herobids/db';
import {
  resolveAssessmentIdentity,
  ok,
  type Result,
  type MarketAssessmentIdentity,
  type PlatformAssessorConfig,
} from '@herobids/domain';
import { PlatformAssessor } from './platform-assessor.js';

// ── Outcome Types ───────────────────────────────────────────────────────────

export type AssessmentRequestOutcome =
  | { kind: 'billing_blocked'; reason: string }
  | { kind: 'cooldown_blocked'; nextEligibleAt: string }
  | { kind: 'identity_unresolved'; reason: string }
  | { kind: 'provider_failed'; error: string; errorCode?: string }
  | { kind: 'cache_hit'; assessmentArtifactId: string; billed: true }
  | { kind: 'assessment_completed'; assessmentArtifactId: string; billed: true };

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

// ── Identity Key Serialization ──────────────────────────────────────────────

/**
 * Serialize a canonical `MarketAssessmentIdentity` into a deterministic
 * string key for lease tracking and idempotency scoping.
 */
function identityKey(identity: MarketAssessmentIdentity): string {
  if (identity.instrumentKind === 'swap' || identity.instrumentKind === 'dex') {
    const { network, address } = identity as Extract<MarketAssessmentIdentity, { instrumentKind: 'swap' | 'dex' }>;
    return `${identity.instrumentKind}|${identity.venueFamily}|${identity.styleTier}|${network}|${address}`;
  }
  const { symbol } = identity as Extract<MarketAssessmentIdentity, { instrumentKind: 'orderbook' | 'perp' }>;
  return `${identity.instrumentKind}|${identity.venueFamily}|${identity.styleTier}|${symbol}`;
}

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * Single service boundary for on-demand assessment requests.
 *
 * Every agent-initiated assessment flows through `requestAssessment`.
 * The service handles identity resolution, idempotency, cooldown,
 * cache lookup, billing reservation, and per-identity lease acquisition
 * so that at most one provider run is in-flight per canonical identity.
 */
export class AssessmentRequestService {
  private readonly log: Logger;

  /**
   * In-flight leases keyed by `identityKey(identity)`.
   * When a request sees an existing lease it awaits the same Promise
   * instead of starting a duplicate provider run.
   */
  private readonly inFlightLeases = new Map<string, Promise<AssessmentRequestOutcome>>();

  /**
   * Idempotency cache keyed by `idempotencyKey`.
   * A repeat request with the same key returns the previously computed outcome.
   * Scope: (agentId, canonical identity, idempotencyKey) — the key alone is
   * sufficient for the skeleton; Step 7 narrows scope.
   */
  private readonly idempotencyCache = new Map<string, AssessmentRequestOutcome>();

  /** Maximum instruments accepted per batch request. */
  private readonly maxInstrumentsPerRequest: number;

  // NOTE: This uses the domain PlatformAssessorConfig (@herobids/domain)
  // which includes scheduling fields (minReviewIntervalMs, etc.) not present
  // in the local PlatformAssessorConfig (platform-assessor.ts).
  // When billing is wired (Step 7), use the domain type.
  constructor(
    private readonly db: Database,
    operatorConfig: PlatformAssessorConfig,
    private readonly assessor: PlatformAssessor,
  ) {
    this.log = createLogger('assessment-request-service');
    this.maxInstrumentsPerRequest = operatorConfig.maxInstrumentsPerRequest;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Process an on-demand assessment request.
   *
   * Steps:
   * 1. Idempotency check (same key → same outcome)
   * 2. Resolve canonical identity via `resolveAssessmentIdentity`
   * 3. Validate opt-in and mode (stub — always passes)
   * 4. Enforce cooldown (stub — always passes)
   * 5. Re-check cache (stub — always miss)
   * 6. Bill (stub — always returns success; Step 7 wires real billing)
   * 7. Cache-hit path: return billed artifact
   * 8. Cache-miss path: acquire per-identity lease → run assessor (stub)
   */
  async requestAssessment(
    params: AssessmentRequestParams,
  ): Promise<Result<AssessmentRequestOutcome>> {
    // ── 1. Idempotency check ──────────────────────────────────────────
    if (params.idempotencyKey) {
      const cached = this.idempotencyCache.get(params.idempotencyKey);
      if (cached) {
        this.log.debug({ idempotencyKey: params.idempotencyKey }, 'Idempotency cache hit');
        return ok(cached);
      }
    }

    // ── 2. Resolve canonical identity ─────────────────────────────────
    const identityResult = resolveAssessmentIdentity({
      instrumentKind: params.instrumentKind ?? 'orderbook',
      venueFamily: params.venueFamily ?? 'hyperliquid',
      styleTier: params.styleTier ?? 'standard',
      symbol: params.symbol,
      knownSymbols: params.knownSymbols,
      tokenResolutions: params.tokenResolutions,
    });

    if (!identityResult.ok) {
      const outcome: AssessmentRequestOutcome = {
        kind: 'identity_unresolved',
        reason: identityResult.error.message,
      };
      this.cacheIdempotency(params.idempotencyKey, outcome);
      this.log.warn(
        { symbol: params.symbol, error: identityResult.error },
        'Assessment identity unresolved',
      );
      return ok(outcome);
    }

    const identity = identityResult.data;
    const key = identityKey(identity);

    // ── 3. Validate opt-in and mode (stub) ────────────────────────────
    // TODO(Step 7): Query agent's PlatformAssessmentOptIn from DB,
    // resolve via resolveAssessmentConfig, and validate enabled.

    // ── 4. Enforce cooldown (stub) ────────────────────────────────────
    // TODO(Step 7): Check last assessment time per (agentId, key).
    // If within cooldown window, return { kind: 'cooldown_blocked', ... }.

    // ── 5. Re-check cache (stub) ──────────────────────────────────────
    // TODO(Step 7): Query marketAssessmentArtifacts for a fresh active
    // artifact matching this identity. If found and not expired,
    // return { kind: 'cache_hit', assessmentArtifactId, billed: true }.

    // ── 6. Bill (stub — always succeeds) ──────────────────────────────
    // TODO(Step 7): Wire real billing via BillingRepository.
    // Reserve credit, validate balance. On failure, return billing_blocked.

    // ── 7. Acquire per-identity lease ─────────────────────────────────
    const existingLease = this.inFlightLeases.get(key);
    if (existingLease) {
      this.log.debug({ key }, 'Reusing in-flight assessment lease');
      return ok(await existingLease);
    }

    const leasePromise = this.runAssessor(identity, params.agentId);
    this.inFlightLeases.set(key, leasePromise);

    try {
      const outcome = await leasePromise;
      this.cacheIdempotency(params.idempotencyKey, outcome);
      return ok(outcome);
    } finally {
      this.inFlightLeases.delete(key);
    }
  }

  /**
   * Process a batch of symbols sharing the same venue/instrument context.
   * Each symbol is processed serially through requestAssessment.
   * Partial success is allowed — some symbols may succeed while others fail.
   *
   * @param symbols - Array of trading symbols to assess (e.g. ["BTC", "ETH"])
   * @param sharedParams - Shared venue/instrument context for all symbols
   * @param maxInstrumentsPerRequest - Configured max per request (default: from operator config)
   * @returns BatchAssessmentResult with per-symbol outcomes
   */
  async requestBatchAssessment(
    symbols: string[],
    sharedParams: Omit<AssessmentRequestParams, 'symbol'>,
    maxInstrumentsPerRequest: number = this.maxInstrumentsPerRequest,
  ): Promise<BatchAssessmentResult> {
    // Guard against misconfigured zero or negative cap.
    const cap = Math.max(1, maxInstrumentsPerRequest);

    // Guard against empty symbols array.
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

    // Process serially in request order
    for (const symbol of acceptedSymbols) {
      // Defensive: requestAssessment currently always returns ok(), but
      // future changes may return err(). We also wrap in try/catch so a
      // thrown exception in one iteration doesn't abandon remaining symbols.
      try {
        const result = await this.requestAssessment({
          ...sharedParams,
          symbol,
        });

        if (result.ok) {
          results.push({ symbol, outcome: result.data });
        } else {
          // Wrap error as a provider_failed outcome, preserving the error code.
          results.push({
            symbol,
            outcome: {
              kind: 'provider_failed',
              error: result.error.message,
              errorCode: result.error.code,
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

  // ── Assessor ─────────────────────────────────────────────────────────

  /**
   * Run the real platform assessor: persist a run record, call the assessor,
   * persist the resulting artifact, and update run lifecycle.
   */
  private async runAssessor(
    identity: MarketAssessmentIdentity,
    _agentId: string,
  ): Promise<AssessmentRequestOutcome> {
    const runId = crypto.randomUUID();
    const now = new Date();

    // Create run record.
    // NOTE: The run insert + assessor call + artifact insert are
    // eventually-consistent — the assessor call is long-lived and cannot be
    // wrapped in a DB transaction.  A stale-run reconciliation mechanism
    // (e.g. periodic sweep of in_progress runs older than a threshold)
    // should be added to clean up orphaned runs.
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
      return { kind: 'provider_failed', error: 'Failed to persist run intent' };
    }

    // Call the real assessor
    const result = await this.assessor.assessIdentity(identity);

    if (!result.ok) {
      // Update run to failed
      try {
        await this.db.update(marketAssessmentRuns)
          .set({ status: 'failed', errorMessage: result.error.message, completedAt: new Date() })
          .where(eq(marketAssessmentRuns.id, runId));
      } catch (err) {
        this.log.error({ err, runId }, 'Failed to update run status to failed');
      }
      return { kind: 'provider_failed', error: result.error.message, errorCode: result.error.code };
    }

    const artifact = result.data;

    // Persist artifact
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
    } catch (err) {
      this.log.error({ err, artifactId: artifact.id }, 'Failed to persist assessment artifact');
      // Update run to failed
      try {
        await this.db.update(marketAssessmentRuns)
          .set({ status: 'failed', errorMessage: 'Failed to persist artifact', completedAt: new Date() })
          .where(eq(marketAssessmentRuns.id, runId));
      } catch (err2) {
        this.log.error({ err: err2, runId }, 'Failed to update run status after artifact persistence failure');
      }
      return { kind: 'provider_failed', error: 'Failed to persist assessment artifact' };
    }

    // Update run to completed
    try {
      await this.db.update(marketAssessmentRuns)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(marketAssessmentRuns.id, runId));
    } catch (err) {
      this.log.warn({ err, runId }, 'Artifact persisted but run completion update failed — run may need manual reconciliation');
    }

    this.log.info(
      { identityKey: identityKey(identity), artifactId: artifact.id, runId },
      'Assessment completed and persisted',
    );

    return {
      kind: 'assessment_completed',
      assessmentArtifactId: artifact.id,
      billed: true,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private identitySymbol(identity: MarketAssessmentIdentity): string | null {
    if (identity.instrumentKind === 'orderbook' || identity.instrumentKind === 'perp') {
      return (identity as Extract<MarketAssessmentIdentity, { instrumentKind: 'orderbook' | 'perp' }>).symbol;
    }
    return null;
  }

  private identityNetwork(identity: MarketAssessmentIdentity): string | null {
    if (identity.instrumentKind === 'swap' || identity.instrumentKind === 'dex') {
      return (identity as Extract<MarketAssessmentIdentity, { instrumentKind: 'swap' | 'dex' }>).network;
    }
    return null;
  }

  private identityAddress(identity: MarketAssessmentIdentity): string | null {
    if (identity.instrumentKind === 'swap' || identity.instrumentKind === 'dex') {
      return (identity as Extract<MarketAssessmentIdentity, { instrumentKind: 'swap' | 'dex' }>).address;
    }
    return null;
  }

  private serializeIdentity(identity: MarketAssessmentIdentity): Record<string, unknown> {
    return { ...identity };
  }

  /**
   * Store an outcome in the idempotency cache so repeat requests with
   * the same idempotency key return the same result.
   */
  private cacheIdempotency(
    idempotencyKey: string | undefined,
    outcome: AssessmentRequestOutcome,
  ): void {
    if (idempotencyKey) {
      this.idempotencyCache.set(idempotencyKey, outcome);
    }
  }
}
