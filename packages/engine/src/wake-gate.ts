import type { MarketAssessmentArtifact, MarketAssessmentPresetRanking } from '@herobids/domain';
import type { WakeGateConfig } from '@herobids/domain';

export interface WakeGateInput {
  artifact: MarketAssessmentArtifact;
  agentId: string;
  agentCurrentPreset: string;
  agentStyleTier: 'economy' | 'standard' | 'premium';
  hasOpenPositions: boolean;
  /** Timestamp of the agent's last preset-review wake, if any. */
  lastWakeTimestamp?: string;
  /** Number of preset-review wakes emitted for this agent today. */
  wakesToday: number;
  /** The last N assessment artifact IDs for this segment, for deduplication. */
  previousArtifactIds: string[];
  /** The last N assessment outcomes for this agent+segment, ordered most-recent-first. */
  recentAssessmentOutcomes?: Array<{
    artifactId: string;
    recommendedPreset: string;
    timestamp: string;
  }>;
  /** Current time in ms since epoch (for testability). Defaults to Date.now(). */
  nowMs?: number;
}

export interface WakeGateResult {
  decision: 'wake_emitted' | 'wake_suppressed';
  suppressionReason: string | null;
  scoreUplift: number | null;
  recommendedPreset: string;
}

function suppress(
  reason: string,
  recommendedPreset?: string,
  scoreUplift?: number,
): WakeGateResult {
  return {
    decision: 'wake_suppressed',
    suppressionReason: reason,
    scoreUplift: scoreUplift ?? null,
    recommendedPreset: recommendedPreset ?? '',
  };
}

function findTopAlternative(
  rankings: MarketAssessmentPresetRanking[],
  currentPreset: string,
): MarketAssessmentPresetRanking | undefined {
  const sorted = [...rankings].sort((a, b) => a.rank - b.rank);
  return sorted.find((r) => r.presetKey !== currentPreset);
}

/**
 * Evaluate whether a market assessment should trigger a preset-review wake
 * for a specific agent.
 */
export function evaluateWakeGate(
  config: WakeGateConfig,
  input: WakeGateInput,
): WakeGateResult {
  const nowMs = input.nowMs ?? Date.now();

  // Rule 1: Segment and style-tier compatibility
  if (input.artifact.styleTier !== input.agentStyleTier) {
    return suppress('wake.style_tier_mismatch');
  }

  // Rule 2: Confidence threshold
  if (input.artifact.confidence < config.minConfidence) {
    return suppress('wake.confidence_below_threshold');
  }

  // Rule 3: Deduplicate — same artifact already triggered a wake
  if (input.previousArtifactIds.includes(input.artifact.id)) {
    return suppress('wake.duplicate');
  }

  // Find the top-ranked allowed preset that isn't the agent's current
  const topRanking = findTopAlternative(input.artifact.presetRankings, input.agentCurrentPreset);
  if (!topRanking) {
    return suppress('wake.no_alternative');
  }

  // Rule 4: Score uplift threshold
  const currentRanking = input.artifact.presetRankings.find(
    (r) => r.presetKey === input.agentCurrentPreset,
  );
  const scoreUplift = currentRanking
    ? (topRanking.score - currentRanking.score) / Math.max(currentRanking.score, config.minScoreFloorForUpliftCalc)
    : 1.0; // If current preset not ranked, treat as maximum uplift

  const effectiveMinUplift = input.hasOpenPositions
    ? config.minScoreUplift * config.openPositionUpliftMultiplier
    : config.minScoreUplift;

  if (scoreUplift < effectiveMinUplift) {
    // Rule 4b: Current preset below minimum — emit wake even if uplift insufficient
    if (currentRanking && currentRanking.score < config.minCurrentPresetScore) {
      // Fall through to emit wake below
    } else {
      return suppress('wake.uplift_insufficient', topRanking.presetKey, scoreUplift);
    }
  }

  // Rule 5: Rate limiting — max wakes per day
  if (input.wakesToday >= config.maxWakesPerAgentPerDay) {
    return suppress('wake.daily_limit', topRanking.presetKey, scoreUplift);
  }

  // Rule 6: Rate limiting — minimum interval between wakes
  if (input.lastWakeTimestamp) {
    const lastWakeMs = Date.parse(input.lastWakeTimestamp);
    const elapsed = nowMs - lastWakeMs;
    if (elapsed < config.minIntervalBetweenWakesMs) {
      return suppress('wake.interval_too_short', topRanking.presetKey, scoreUplift);
    }
  }

  // Rule 7: Consecutive confirmation (noisy market guard)
  if (config.requireConsecutiveConfirmation && input.recentAssessmentOutcomes) {
    const required = config.consecutiveConfirmationCount;
    const recent = input.recentAssessmentOutcomes.slice(0, required - 1); // -1 because current assessment counts as 1
    const allSameRecommendation = recent.every(
      (o) => o.recommendedPreset === topRanking.presetKey,
    );
    if (recent.length >= required - 1 && !allSameRecommendation) {
      return suppress('wake.confirmation_not_met', topRanking.presetKey, scoreUplift);
    }
  }

  // All rules passed — emit the wake
  return {
    decision: 'wake_emitted',
    suppressionReason: null,
    scoreUplift,
    recommendedPreset: topRanking.presetKey,
  };
}
