import type { Result } from '../result.js';
import type { MarketAssessmentIdentity, MarketAssessmentPresetRanking } from '../market-assessment.js';

/** Summary subset of assessment artifact fields returned in port outcomes. */
export interface AssessmentArtifactSummary {
  assessedAt: string;
  expiresAt: string;
  currentMarketSummary: string;
  regimeSummary: string;
  scanHealthSummary: string;
  presetRankings: MarketAssessmentPresetRanking[];
  recommendedPreset: string | null;
  allowedPresets: string[];
  confidence: number;
  urgency: 'low' | 'medium' | 'high';
}

/** Outcome of a single assessment request through the port — discriminated union. */
export type AssessmentRequestPortOutcome =
  | {
      kind: 'cache_hit' | 'assessment_completed';
      requestId: string;
      assessmentArtifactId: string;
      canonicalIdentity: MarketAssessmentIdentity;
      artifact: AssessmentArtifactSummary;
    }
  | {
      kind: 'request_in_flight';
      message: string;
      /** Provided when identity resolution succeeded before the in-flight detection. */
      canonicalIdentity?: MarketAssessmentIdentity;
    }
  | {
      kind: 'billing_blocked';
      reason: string;
      requestId?: string;
      /** Provided when identity resolution succeeded before billing checks. */
      canonicalIdentity?: MarketAssessmentIdentity;
    }
  | {
      kind: 'cooldown_blocked';
      nextEligibleAt: string;
      requestId?: string;
      /** Provided when identity resolution succeeded before cooldown checks. */
      canonicalIdentity?: MarketAssessmentIdentity;
    }
  | {
      kind: 'identity_unresolved';
      reason: string;
      requestId?: string;
    }
  | {
      kind: 'provider_failed';
      error: string;
      errorCode?: string;
      requestId: string;
      /** Provided when identity resolution succeeded before the failure. */
      canonicalIdentity?: MarketAssessmentIdentity;
    };

/**
 * Parameters for a single assessment request through the port.
 *
 * This is the pre-resolution boundary: callers provide the user-facing symbol
 * plus venue/instrument context, and the service resolves the canonical
 * `MarketAssessmentIdentity` internally.
 */
export interface AssessmentRequestPortParams {
  agentId: string;
  symbol: string;
  venueFamily?: string;
  instrumentKind?: 'orderbook' | 'perp' | 'swap' | 'dex';
  styleTier?: 'economy' | 'standard' | 'premium';
  idempotencyKey?: string;
}

/** Typed port for billable assessment request operations. Implemented by AssessmentRequestService. */
export interface AssessmentRequestPort {
  requestAssessment(
    params: AssessmentRequestPortParams,
  ): Promise<Result<AssessmentRequestPortOutcome>>;
  /** Process a batch of assessment requests. Bounded by maxInstrumentsPerRequest. */
  requestBatchAssessment(params: AssessmentRequestPortParams[]): Promise<Result<AssessmentRequestPortOutcome[]>>;
  /** Expose the per-request instrument cap so tools can read it. */
  readonly maxInstrumentsPerRequest: number;
}
