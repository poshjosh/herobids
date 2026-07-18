import crypto from 'node:crypto';
import { createLogger } from '../logger.js';
import type { Logger } from 'pino';
import type { Database } from '@herobids/db';
import {
  resolveAssessmentIdentity,
  err,
  ok,
  type Result,
  type MarketAssessmentIdentity,
  type PlatformAssessorConfig,
} from '@herobids/domain';

// ── Outcome Types ───────────────────────────────────────────────────────────

export type AssessmentRequestOutcome =
  | { kind: 'billing_blocked'; reason: string }
  | { kind: 'cooldown_blocked'; nextEligibleAt: string }
  | { kind: 'identity_unresolved'; reason: string }
  | { kind: 'provider_failed'; error: string }
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

// ── Identity Key Serialization ──────────────────────────────────────────────

/**
 * Serialize a canonical `MarketAssessmentIdentity` into a deterministic
 * string key for lease tracking and idempotency scoping.
 */
function identityKey(identity: MarketAssessmentIdentity): string {
  if (identity.instrumentKind === 'orderbook' || identity.instrumentKind === 'perp') {
    return `${identity.instrumentKind}|${identity.venueFamily}|${identity.styleTier}|${identity.symbol}`;
  }
  return `${identity.instrumentKind}|${identity.venueFamily}|${identity.styleTier}|${identity.network}|${identity.address}`;
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

  constructor(
    private readonly db: Database,
    private readonly operatorConfig: PlatformAssessorConfig,
  ) {
    this.log = createLogger('assessment-request-service');
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
    // resolve via resolveAssessmentConfig, and validate enabled + mode.

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

    const leasePromise = this.runAssessorStub(identity, params.agentId);
    this.inFlightLeases.set(key, leasePromise);

    try {
      const outcome = await leasePromise;
      this.cacheIdempotency(params.idempotencyKey, outcome);
      return ok(outcome);
    } finally {
      this.inFlightLeases.delete(key);
    }
  }

  // ── Assessor Stub ────────────────────────────────────────────────────

  /**
   * Placeholder assessor that returns a synthetic completed artifact.
   *
   * In Step 7 this is replaced by the real PlatformAssessor on-demand
   * execution path: collect evidence → call LLM → persist run + artifact.
   */
  private async runAssessorStub(
    identity: MarketAssessmentIdentity,
    _agentId: string,
  ): Promise<AssessmentRequestOutcome> {
    const artifactId = crypto.randomUUID();

    this.log.info(
      { identityKey: identityKey(identity), artifactId },
      'Assessor stub completed (placeholder)',
    );

    return {
      kind: 'assessment_completed',
      assessmentArtifactId: artifactId,
      billed: true,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

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
