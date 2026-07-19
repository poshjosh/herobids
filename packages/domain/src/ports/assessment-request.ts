import type { Result } from '../result.js';
import type { MarketAssessmentIdentity } from '../market-assessment.js';

/** Outcome of a single assessment request through the port. */
export interface AssessmentRequestPortOutcome {
  kind:
    | 'cache_hit'
    | 'assessment_completed'
    | 'billing_blocked'
    | 'cooldown_blocked'
    | 'identity_unresolved'
    | 'provider_failed'
    | 'request_in_flight';
  assessmentArtifactId?: string;
  requestId?: string;
  error?: string;
  errorCode?: string;
  nextEligibleAt?: string;
  reason?: string;
  message?: string;
}

/** Parameters for a single assessment request through the port. */
export interface AssessmentRequestPortParams {
  agentId: string;
  symbol: string;
  identity: MarketAssessmentIdentity;
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
