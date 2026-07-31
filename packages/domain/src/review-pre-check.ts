import type { MarketAssessmentIdentity } from './market-assessment.js';

// ── Active Preset State Contract ────────────────────────────────────────────

/**
 * The agent's active preset state resolved at pre-check time.
 *
 * This is a read-only projection — the pre-check never mutates the binding.
 * Plan 012 defines the authoritative active-preset state; until then this
 * contract is satisfied by reading the agent's unified config and deriving
 * the current preset from the strategy configuration.
 */
export interface ActivePresetState {
  /** The agent's active preset key. */
  presetKey: string;
  /** Mechanically-derived behavior version of the active preset. */
  behaviorVersion: string;
  /** Style tier the agent is operating in. */
  styleTier: 'economy' | 'standard' | 'premium';
  /** The scan interval configured for this preset. */
  scanInterval?: string;
  /** Signal bias: bullish | bearish | neutral. */
  signalBias?: 'bullish' | 'bearish' | 'neutral';
  /** Indicator requirements enabled for this preset. */
  enabledIndicators: string[];
  /** Compatibility thresholds configured for this preset. */
  compatibilityThresholds?: Record<string, number>;
}

// ── Persisted Scanner Candidate Contract ────────────────────────────────────

/**
 * A persisted scanner candidate observation that the review pre-check reads.
 * This is the shape returned by the candidate lookup repository.
 */
export interface PersistedScannerCandidate {
  /** Row ID in agent_scan_candidates. */
  id: string;
  agentId: string;
  scannedAt: string;
  scanVersion: string;
  activePresetKey: string;
  presetBehaviorVersion: string;

  // ── Canonical identity ──
  identity: MarketAssessmentIdentity;

  // ── Candidate metadata ──
  candidateRank: number;
  scanScope?: string;

  // ── Deterministic facts ──
  signalFacts: Record<string, unknown>;
  confidence?: number;
  regimeBucket?: string;
  volatilityFact?: number;
  dataFreshnessTs?: string;

  // ── Disposition ──
  disposition: 'discovered' | 'scored_no_signal' | 'entry_candidate' | 'exit_advisory' | 'rejected' | 'unresolved';
}

// ── Resolved Review Pre-Check Policy ────────────────────────────────────────

/**
 * Resolved policy for the deterministic review pre-check.
 * Derived from operator config (`PlatformAssessorConfig.preCheck`).
 */
export interface ResolvedReviewPreCheckPolicy {
  signalRatioThreshold: number;
  scanMetricsLookbackMs: number;
  minSignalsForActive: number;
  identityCooldownMs: number;
  candidateMaxAgeMs: number;
  policyVersion: string;
  enablePeerComparison: boolean;
}

// ── Eligibility Evaluation ──────────────────────────────────────────────────

/**
 * Input for the deterministic review eligibility evaluation.
 */
export interface AssessmentReviewEligibilityInput {
  candidate: PersistedScannerCandidate;
  activePreset: ActivePresetState;
  policy: ResolvedReviewPreCheckPolicy;
}

/**
 * Output of the deterministic review eligibility evaluation.
 * Produces stable, explainable reason codes.
 */
export interface AssessmentReviewEligibilityOutput {
  /** Whether the candidate is eligible for review advice. */
  eligible: boolean;
  /**
   * Explainable reason codes for the decision. Examples:
   * - `regime_bias_mismatch`: candidate regime does not match preset bias
   * - `volatility_outside_preset_band`: volatility exceeds preset threshold
   * - `insufficient_candidate_quality`: confidence below minimum
   * - `no_peer_outperformance`: no peer preset generates more signals
   * - `peer_outperformance_detected`: peer preset has significantly more signals
   * - `candidate_stale`: candidate data is older than max age
   * - `identity_unresolved`: candidate identity could not be resolved
   * - `fresh_artifact_exists`: a fresh assessment artifact already exists
   * - `cooldown_active`: agent is within cooldown for this identity
   * - `billing_blocked`: non-reserving credit preflight failed
   */
  reasons: string[];
  /** Version of the policy and predicate algorithm applied. */
  policyVersion: string;
  /** Timestamp when the evaluation was computed. */
  evaluatedAt: string;
}

/**
 * Known reason codes for the deterministic review predicate.
 * New codes must be added here and versioned.
 */
export const ReviewPreCheckReasonCodes = {
  REGIME_BIAS_MISMATCH: 'regime_bias_mismatch',
  VOLATILITY_OUTSIDE_PRESET_BAND: 'volatility_outside_preset_band',
  INSUFFICIENT_CANDIDATE_QUALITY: 'insufficient_candidate_quality',
  NO_PEER_OUTPERFORMANCE: 'no_peer_outperformance',
  PEER_OUTPERFORMANCE_DETECTED: 'peer_outperformance_detected',
  CANDIDATE_STALE: 'candidate_stale',
  IDENTITY_UNRESOLVED: 'identity_unresolved',
  FRESH_ARTIFACT_EXISTS: 'fresh_artifact_exists',
  COOLDOWN_ACTIVE: 'cooldown_active',
  BILLING_BLOCKED: 'billing_blocked',
  AGENT_DISABLED: 'agent_disabled',
  NO_CANDIDATE: 'no_candidate',
} as const;

export const ReviewPreCheckReasonDescriptions: Record<ReviewPreCheckReasonCode, string> = {
  regime_bias_mismatch: 'Market regime does not match this preset\'s bias',
  volatility_outside_preset_band: 'Volatility is outside this preset\'s acceptable range',
  insufficient_candidate_quality: 'Signal confidence is below the minimum threshold',
  no_peer_outperformance: 'No other preset is outperforming the current one here',
  peer_outperformance_detected: 'A different preset is generating more signals on this instrument',
  candidate_stale: 'Scanner data for this instrument is too old to act on',
  identity_unresolved: 'Could not resolve a canonical identity for this instrument',
  fresh_artifact_exists: 'A recent assessment already exists for this instrument',
  cooldown_active: 'This instrument was reviewed too recently to review again',
  billing_blocked: 'Assessment was skipped due to a billing restriction',
  agent_disabled: 'This agent is disabled',
  no_candidate: 'No scanner candidates were available to review',
};

export type ReviewPreCheckReasonCode = (typeof ReviewPreCheckReasonCodes)[keyof typeof ReviewPreCheckReasonCodes];

// ── Review Check Result ─────────────────────────────────────────────────────

/**
 * Outcome of a single candidate's pre-check evaluation.
 * This is the shape persisted as review_advice rows.
 */
export interface CandidatePreCheckOutcome {
  /** The canonical identity (null for no_candidate). */
  identity?: MarketAssessmentIdentity;
  /** Outcome classification. */
  outcome: 'advised' | 'not_advised' | 'blocked_by_cooldown' | 'blocked_by_no_credit_indication' | 'fresh_artifact_exists' | 'no_candidate';
  /** Position in the deterministic scanner ranking. */
  candidateRank?: number;
  /** Agent's active preset at check time. */
  activePreset?: string;
  /** Mechanically-derived behavior version. */
  presetBehaviorVersion?: string;
  /** Deterministic reason codes. */
  reasons?: string[];
}
