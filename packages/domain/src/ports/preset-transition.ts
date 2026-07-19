import type { Result } from '../result.js';
import type { TransitionMode, PreparedPresetTransition } from '../market-assessment.js';

/**
 * Preset Transition Port — the public contract for @herobids/engine's PresetTransitionService.
 *
 * This port defines the two public operations: recommendTransition (read-only analysis)
 * and applyTransition (durable mutation with state machine lifecycle).
 *
 * The 7-step transition process (load artifact→resolve binding→verify policy→
 * prepare→persist intent→apply config→acknowledge) is internal to the service
 * implementation and not part of this port contract.
 */

/** Outcome of a transition recommendation. */
export interface PresetTransitionRecommendation {
  recommendedPreset: string | null;
  confidence: number;
  reasoningSummary: string;
  transitionMode: TransitionMode;
  /** The prepared transition, ready for application (null if no recommendation). */
  preparedTransition: PreparedPresetTransition | null;
}

/** Parameters for recommending a preset transition. */
export interface RecommendTransitionParams {
  agentId: string;
  assessmentArtifactId: string;
}

/** Outcome of applying a preset transition. */
export interface PresetTransitionApplicationResult {
  transitionId: string;
  state: 'applied' | 'deferred' | 'rejected' | 'failed' | 'partially_applied';
  positionActionResults: Array<{
    positionId: string;
    action: string;
    result: 'applied' | 'failed' | 'skipped';
    error?: string;
  }> | null;
  appliedAt: string;
}

/** Parameters for applying a preset transition. */
export interface ApplyTransitionParams {
  agentId: string;
  assessmentArtifactId: string;
  targetPreset: string;
  mode: TransitionMode;
  reason?: string;
  idempotencyKey: string;
}

/** Typed port for preset transition recommendation and application. */
export interface PresetTransitionPort {
  recommendTransition(
    params: RecommendTransitionParams,
  ): Promise<Result<PresetTransitionRecommendation>>;
  applyTransition(
    params: ApplyTransitionParams,
  ): Promise<Result<PresetTransitionApplicationResult>>;
}
