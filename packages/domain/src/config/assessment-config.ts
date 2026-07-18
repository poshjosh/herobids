import { ok, err, type Result } from '../result.js';
import type { PlatformAssessmentOptIn, PlatformAssessorConfig } from './schema.js';
import { validateReviewInterval } from './schema.js';

export interface ResolvedAssessmentConfig {
  enabled: boolean;
  mode: 'recommend_only' | 'auto_apply';
  reviewIntervalMs: number;
  minConfidenceThreshold: number;
  minScoreUpliftThreshold: number;
  cacheFreshnessMs: number;
  scannerCandidateLimit: number;
  maxReviewRequestsPerDay?: number;
  minReviewIntervalMs: number;
}

/**
 * Resolves an agent's per-agent assessment opt-in against operator defaults
 * to produce the final runtime assessment configuration.
 */
export function resolveAssessmentConfig(
  agentOptIn: PlatformAssessmentOptIn | undefined,
  operatorConfig: PlatformAssessorConfig,
): Result<ResolvedAssessmentConfig> {
  // Validate review interval against operator floor
  const validated = validateReviewInterval(
    agentOptIn?.reviewIntervalMs,
    operatorConfig.minReviewIntervalMs,
  );
  if (!validated.success) return validated;

  return ok({
    enabled: agentOptIn?.enabled ?? false,
    mode: agentOptIn?.mode ?? 'recommend_only',
    reviewIntervalMs: agentOptIn?.reviewIntervalMs ?? operatorConfig.minReviewIntervalMs,
    minConfidenceThreshold: agentOptIn?.minConfidenceThreshold ?? 0.6,
    minScoreUpliftThreshold: agentOptIn?.minScoreUpliftThreshold ?? 15,
    cacheFreshnessMs: operatorConfig.cacheFreshnessMs,
    scannerCandidateLimit: operatorConfig.scannerCandidateLimit,
    maxReviewRequestsPerDay: operatorConfig.maxReviewRequestsPerDay,
    minReviewIntervalMs: operatorConfig.minReviewIntervalMs,
  });
}
