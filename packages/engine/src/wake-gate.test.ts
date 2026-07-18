import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { evaluateWakeGate } from './wake-gate.js';
import type { WakeGateConfig, WakeGateInput } from '@herobids/domain';
import type { MarketAssessmentArtifact } from '@herobids/domain';

function makeConfig(overrides?: Partial<WakeGateConfig>): WakeGateConfig {
  return {
    minIntervalBetweenWakesMs: 14_400_000, // 4 hours
    maxWakesPerAgentPerDay: 6,
    minScoreUplift: 0.15,
    minConfidence: 0.6,
    openPositionUpliftMultiplier: 1.5,
    requireConsecutiveConfirmation: false,
    consecutiveConfirmationCount: 2,
    minCurrentPresetScore: 0.0,
    minScoreFloorForUpliftCalc: 0.01,
    ...overrides,
  };
}

function makeArtifact(overrides?: Partial<MarketAssessmentArtifact>): MarketAssessmentArtifact {
  return {
    id: 'artifact-1',
    segmentKey: {
      venueFamily: 'hyperliquid-orderbook',
      styleTier: 'standard',
      universeScopeHash: 'abc123',
    },
    venueFamily: 'hyperliquid-orderbook',
    styleTier: 'standard',
    universeScopeHash: 'abc123',
    assessmentRunId: 'run-1',
    assessedAt: '2026-07-18T10:00:00.000Z',
    expiresAt: '2026-07-19T10:00:00.000Z',
    maxActorUseAge: '2026-07-18T16:00:00.000Z',
    maxWakeAge: '2026-07-18T14:00:00.000Z',
    assessmentVersion: 1,
    artifactVersion: 0,
    rankingPolicyVersion: 1,
    status: 'active',
    allowedPresets: ['preset-a', 'preset-b', 'preset-c'],
    currentMarketSummary: 'Market is bullish',
    regimeSummary: 'Trending up',
    scanHealthSummary: 'All scans healthy',
    presetRankings: [
      {
        presetKey: 'preset-a',
        presetBehaviorVersion: 'v1',
        rank: 1,
        score: 0.85,
        scoreBand: 'top',
        pros: ['Good momentum'],
        cons: [],
        fitNotes: null,
      },
      {
        presetKey: 'preset-b',
        presetBehaviorVersion: 'v1',
        rank: 2,
        score: 0.60,
        scoreBand: 'mid',
        pros: ['Stable'],
        cons: ['Lower returns'],
        fitNotes: null,
      },
      {
        presetKey: 'preset-c',
        presetBehaviorVersion: 'v1',
        rank: 3,
        score: 0.40,
        scoreBand: 'low',
        pros: [],
        cons: ['Poor fit'],
        fitNotes: null,
      },
    ],
    recommendedPreset: 'preset-a',
    relativeUplift: 0.25,
    confidence: 0.8,
    urgency: 'medium',
    reasoningSummary: 'Preset A best fit',
    evidenceRefs: ['ev-1'],
    ...overrides,
  };
}

function makeInput(overrides?: Partial<WakeGateInput>): WakeGateInput {
  return {
    artifact: makeArtifact(),
    agentId: 'agent-1',
    agentCurrentPreset: 'preset-b',
    agentStyleTier: 'standard',
    hasOpenPositions: false,
    wakesToday: 0,
    previousArtifactIds: [],
    ...overrides,
  };
}

describe('evaluateWakeGate', () => {
  // ── Happy path ──────────────────────────────────────────────────────────

  it('emits wake when all rules pass', () => {
    const result = evaluateWakeGate(makeConfig(), makeInput());
    expect(result.decision).toBe('wake_emitted');
    expect(result.suppressionReason).toBeNull();
    expect(result.recommendedPreset).toBe('preset-a');
    expect(result.scoreUplift).toBeGreaterThan(0);
  });

  // ── Rule 1: Style tier mismatch ─────────────────────────────────────────

  it('suppresses wake when style tier does not match', () => {
    const input = makeInput({ agentStyleTier: 'economy' });
    const result = evaluateWakeGate(makeConfig(), input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.style_tier_mismatch');
  });

  it('allows wake when style tier matches', () => {
    const artifact = makeArtifact({ styleTier: 'economy' });
    const input = makeInput({ artifact, agentStyleTier: 'economy' });
    const result = evaluateWakeGate(makeConfig(), input);
    expect(result.decision).toBe('wake_emitted');
  });

  // ── Rule 2: Confidence threshold ────────────────────────────────────────

  it('suppresses wake when confidence is below threshold', () => {
    const artifact = makeArtifact({ confidence: 0.5 });
    const input = makeInput({ artifact });
    const result = evaluateWakeGate(makeConfig({ minConfidence: 0.6 }), input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.confidence_below_threshold');
  });

  it('emits wake when confidence equals threshold', () => {
    const artifact = makeArtifact({ confidence: 0.6 });
    const input = makeInput({ artifact });
    const result = evaluateWakeGate(makeConfig({ minConfidence: 0.6 }), input);
    expect(result.decision).toBe('wake_emitted');
  });

  it('emits wake when confidence exceeds threshold', () => {
    const artifact = makeArtifact({ confidence: 0.9 });
    const input = makeInput({ artifact });
    const result = evaluateWakeGate(makeConfig({ minConfidence: 0.6 }), input);
    expect(result.decision).toBe('wake_emitted');
  });

  // ── Rule 3: Duplicate artifact ──────────────────────────────────────────

  it('suppresses wake when artifact already triggered a wake', () => {
    const input = makeInput({ previousArtifactIds: ['artifact-1', 'artifact-2'] });
    const result = evaluateWakeGate(makeConfig(), input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.duplicate');
  });

  it('emits wake when artifact is not a duplicate', () => {
    const input = makeInput({ previousArtifactIds: ['artifact-2', 'artifact-3'] });
    const result = evaluateWakeGate(makeConfig(), input);
    expect(result.decision).toBe('wake_emitted');
  });

  // ── Rule 4: No better alternative ───────────────────────────────────────

  it('suppresses wake when agent current is top-ranked (alternative has lower score)', () => {
    // preset-b is rank 1, score 0.85. preset-a is rank 2, score 0.60.
    // findTopAlternative returns preset-a, but uplift is negative → suppressed via wake.uplift_insufficient
    const artifact = makeArtifact({
      presetRankings: [
        {
          presetKey: 'preset-b',
          presetBehaviorVersion: 'v1',
          rank: 1,
          score: 0.85,
          scoreBand: 'top',
          pros: ['Best'],
          cons: [],
          fitNotes: null,
        },
        {
          presetKey: 'preset-a',
          presetBehaviorVersion: 'v1',
          rank: 2,
          score: 0.60,
          scoreBand: 'mid',
          pros: [],
          cons: [],
          fitNotes: null,
        },
      ],
    });
    const input = makeInput({ artifact, agentCurrentPreset: 'preset-b' });
    const result = evaluateWakeGate(makeConfig(), input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.uplift_insufficient');
    expect(result.scoreUplift).toBeLessThan(0);
  });

  it('suppresses wake when rankings are empty', () => {
    const artifact = makeArtifact({ presetRankings: [] });
    const input = makeInput({ artifact });
    const result = evaluateWakeGate(makeConfig(), input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.no_alternative');
  });

  it('suppresses wake when only preset is agent current', () => {
    const artifact = makeArtifact({
      presetRankings: [
        {
          presetKey: 'preset-b',
          presetBehaviorVersion: 'v1',
          rank: 1,
          score: 0.50,
          scoreBand: 'mid',
          pros: [],
          cons: [],
          fitNotes: null,
        },
      ],
    });
    const input = makeInput({ artifact, agentCurrentPreset: 'preset-b' });
    const result = evaluateWakeGate(makeConfig(), input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.no_alternative');
  });

  // ── Rule 5: Score uplift threshold ──────────────────────────────────────

  it('suppresses wake when score uplift is below threshold', () => {
    // preset-b score = 0.80, preset-a score = 0.85
    // uplift = (0.85 - 0.80) / 0.80 = 0.0625 < 0.15
    const artifact = makeArtifact({
      presetRankings: [
        {
          presetKey: 'preset-a',
          presetBehaviorVersion: 'v1',
          rank: 1,
          score: 0.85,
          scoreBand: 'top',
          pros: ['Good'],
          cons: [],
          fitNotes: null,
        },
        {
          presetKey: 'preset-b',
          presetBehaviorVersion: 'v1',
          rank: 2,
          score: 0.80,
          scoreBand: 'high-mid',
          pros: [],
          cons: [],
          fitNotes: null,
        },
      ],
    });
    const input = makeInput({ artifact, agentCurrentPreset: 'preset-b' });
    const result = evaluateWakeGate(makeConfig({ minScoreUplift: 0.15 }), input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.uplift_insufficient');
    expect(result.scoreUplift).toBeCloseTo(0.0625, 4);
  });

  it('emits wake when score uplift exceeds threshold', () => {
    // preset-b score = 0.50, preset-a score = 0.85
    // uplift = (0.85 - 0.50) / 0.50 = 0.70 > 0.15
    const artifact = makeArtifact({
      presetRankings: [
        {
          presetKey: 'preset-a',
          presetBehaviorVersion: 'v1',
          rank: 1,
          score: 0.85,
          scoreBand: 'top',
          pros: ['Good'],
          cons: [],
          fitNotes: null,
        },
        {
          presetKey: 'preset-b',
          presetBehaviorVersion: 'v1',
          rank: 2,
          score: 0.50,
          scoreBand: 'mid',
          pros: [],
          cons: [],
          fitNotes: null,
        },
      ],
    });
    const input = makeInput({ artifact, agentCurrentPreset: 'preset-b' });
    const result = evaluateWakeGate(makeConfig({ minScoreUplift: 0.15 }), input);
    expect(result.decision).toBe('wake_emitted');
    expect(result.scoreUplift).toBeCloseTo(0.70, 4);
  });

  // ── Rule 5b: Stricter uplift with open positions ────────────────────────

  it('suppresses wake when uplift is below stricter threshold with open positions', () => {
    // preset-b score = 0.60, preset-a score = 0.85
    // uplift = (0.85 - 0.60) / 0.60 ≈ 0.4167
    // effective min uplift = 0.15 * 1.5 = 0.225
    // 0.4167 > 0.225 → wake should be emitted... let me adjust numbers
    // Actually preset-b = 0.75, uplift = (0.85-0.75)/0.75 = 0.133 < 0.225
    const artifact = makeArtifact({
      presetRankings: [
        {
          presetKey: 'preset-a',
          presetBehaviorVersion: 'v1',
          rank: 1,
          score: 0.85,
          scoreBand: 'top',
          pros: ['Good'],
          cons: [],
          fitNotes: null,
        },
        {
          presetKey: 'preset-b',
          presetBehaviorVersion: 'v1',
          rank: 2,
          score: 0.75,
          scoreBand: 'mid',
          pros: [],
          cons: [],
          fitNotes: null,
        },
      ],
    });
    const input = makeInput({ artifact, agentCurrentPreset: 'preset-b', hasOpenPositions: true });
    const result = evaluateWakeGate(makeConfig({ minScoreUplift: 0.15, openPositionUpliftMultiplier: 1.5 }), input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.uplift_insufficient');
  });

  it('emits wake when uplift exceeds stricter threshold with open positions', () => {
    // preset-b score = 0.40, preset-a score = 0.85
    // uplift = (0.85 - 0.40) / 0.40 = 1.125
    // effective min uplift = 0.15 * 1.5 = 0.225
    const artifact = makeArtifact({
      presetRankings: [
        {
          presetKey: 'preset-a',
          presetBehaviorVersion: 'v1',
          rank: 1,
          score: 0.85,
          scoreBand: 'top',
          pros: ['Good'],
          cons: [],
          fitNotes: null,
        },
        {
          presetKey: 'preset-b',
          presetBehaviorVersion: 'v1',
          rank: 2,
          score: 0.40,
          scoreBand: 'low',
          pros: [],
          cons: [],
          fitNotes: null,
        },
      ],
    });
    const input = makeInput({ artifact, agentCurrentPreset: 'preset-b', hasOpenPositions: true });
    const result = evaluateWakeGate(makeConfig({ minScoreUplift: 0.15, openPositionUpliftMultiplier: 1.5 }), input);
    expect(result.decision).toBe('wake_emitted');
  });

  // ── Rule 5c: Current preset not in rankings → maximum uplift ────────────

  it('treats current preset not in rankings as maximum uplift', () => {
    const input = makeInput({ agentCurrentPreset: 'preset-unknown' });
    const result = evaluateWakeGate(makeConfig(), input);
    expect(result.decision).toBe('wake_emitted');
    expect(result.scoreUplift).toBe(1.0);
  });

  // ── Rule 6: Max daily wakes ─────────────────────────────────────────────

  it('suppresses wake when daily limit is reached', () => {
    const input = makeInput({ wakesToday: 6 });
    const result = evaluateWakeGate(makeConfig({ maxWakesPerAgentPerDay: 6 }), input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.daily_limit');
  });

  it('emits wake when one below the daily limit', () => {
    const input = makeInput({ wakesToday: 5 });
    const result = evaluateWakeGate(makeConfig({ maxWakesPerAgentPerDay: 6 }), input);
    expect(result.decision).toBe('wake_emitted');
  });

  // ── Rule 7: Minimum interval between wakes ──────────────────────────────

  it('suppresses wake when minimum interval not met', () => {
    const now = Date.now();
    const recentTimestamp = new Date(now - 3_600_000).toISOString(); // 1 hour ago
    const input = makeInput({ lastWakeTimestamp: recentTimestamp });
    const result = evaluateWakeGate(makeConfig({ minIntervalBetweenWakesMs: 14_400_000 }), input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.interval_too_short');
  });

  it('emits wake when minimum interval has elapsed', () => {
    const now = Date.now();
    const oldTimestamp = new Date(now - 20_000_000).toISOString(); // ~5.5 hours ago
    const input = makeInput({ lastWakeTimestamp: oldTimestamp });
    const result = evaluateWakeGate(makeConfig({ minIntervalBetweenWakesMs: 14_400_000 }), input);
    expect(result.decision).toBe('wake_emitted');
  });

  it('emits wake when no previous wake exists', () => {
    const input = makeInput({ lastWakeTimestamp: undefined });
    const result = evaluateWakeGate(makeConfig(), input);
    expect(result.decision).toBe('wake_emitted');
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  it('suppresses when confidence is zero', () => {
    const artifact = makeArtifact({ confidence: 0 });
    const input = makeInput({ artifact });
    const result = evaluateWakeGate(makeConfig({ minConfidence: 0.6 }), input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.confidence_below_threshold');
  });

  it('emits wake when minConfidence is zero', () => {
    const artifact = makeArtifact({ confidence: 0.01 });
    const input = makeInput({ artifact });
    const result = evaluateWakeGate(makeConfig({ minConfidence: 0 }), input);
    expect(result.decision).toBe('wake_emitted');
  });

  it('suppresses when score uplift is exactly zero (equal scores)', () => {
    const artifact = makeArtifact({
      presetRankings: [
        {
          presetKey: 'preset-a',
          presetBehaviorVersion: 'v1',
          rank: 1,
          score: 0.5,
          scoreBand: 'mid',
          pros: [],
          cons: [],
          fitNotes: null,
        },
        {
          presetKey: 'preset-b',
          presetBehaviorVersion: 'v1',
          rank: 2,
          score: 0.5,
          scoreBand: 'mid',
          pros: [],
          cons: [],
          fitNotes: null,
        },
      ],
    });
    const input = makeInput({ artifact, agentCurrentPreset: 'preset-b' });
    const result = evaluateWakeGate(makeConfig({ minScoreUplift: 0.15 }), input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.uplift_insufficient');
    expect(result.scoreUplift).toBe(0);
  });

  it('handles negative score uplift (current preset better than alternatives)', () => {
    const artifact = makeArtifact({
      presetRankings: [
        {
          presetKey: 'preset-a',
          presetBehaviorVersion: 'v1',
          rank: 1,
          score: 0.3,
          scoreBand: 'low',
          pros: [],
          cons: [],
          fitNotes: null,
        },
        {
          presetKey: 'preset-b',
          presetBehaviorVersion: 'v1',
          rank: 2,
          score: 0.8,
          scoreBand: 'top',
          pros: [],
          cons: [],
          fitNotes: null,
        },
      ],
    });
    // agent is on preset-b (score 0.8), top alternative is preset-a (score 0.3)
    // uplift = (0.3 - 0.8) / 0.8 = -0.625 → negative uplift < threshold → suppressed
    const input = makeInput({ artifact, agentCurrentPreset: 'preset-b' });
    const result = evaluateWakeGate(makeConfig({ minScoreUplift: 0.15 }), input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.uplift_insufficient');
    expect(result.scoreUplift).toBeLessThan(0);
  });

  // ── Rule priority verification ──────────────────────────────────────────

  it('checks style tier before confidence (higher priority rule fires first)', () => {
    const artifact = makeArtifact({ confidence: 0.1, styleTier: 'standard' });
    const input = makeInput({ artifact, agentStyleTier: 'economy' });
    const result = evaluateWakeGate(makeConfig({ minConfidence: 0.6 }), input);
    // style tier mismatch is checked first
    expect(result.suppressionReason).toBe('wake.style_tier_mismatch');
  });

  it('checks confidence before uplift (higher priority rule fires first)', () => {
    const artifact = makeArtifact({ confidence: 0.3 });
    const input = makeInput({ artifact, agentCurrentPreset: 'preset-b' });
    // Even though uplift may also fail, confidence is checked first
    const result = evaluateWakeGate(makeConfig({ minConfidence: 0.6 }), input);
    expect(result.suppressionReason).toBe('wake.confidence_below_threshold');
  });

  // ── H2: Consecutive confirmation (noisy market guard) ───────────────────

  it('suppresses wake when required consecutive confirmation is not met', () => {
    const recentOutcomes = [
      { artifactId: 'art-1', recommendedPreset: 'preset-c', timestamp: '2026-07-18T08:00:00.000Z' },
      { artifactId: 'art-2', recommendedPreset: 'preset-a', timestamp: '2026-07-18T09:00:00.000Z' },
    ];
    const input = makeInput({
      recentAssessmentOutcomes: recentOutcomes,
    });
    const config = makeConfig({
      requireConsecutiveConfirmation: true,
      consecutiveConfirmationCount: 3,
    });
    const result = evaluateWakeGate(config, input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.confirmation_not_met');
  });

  it('emits wake when consecutive confirmation is met (all recent agree)', () => {
    const recentOutcomes = [
      { artifactId: 'art-1', recommendedPreset: 'preset-a', timestamp: '2026-07-18T08:00:00.000Z' },
      { artifactId: 'art-2', recommendedPreset: 'preset-a', timestamp: '2026-07-18T09:00:00.000Z' },
    ];
    const input = makeInput({
      recentAssessmentOutcomes: recentOutcomes,
    });
    const config = makeConfig({
      requireConsecutiveConfirmation: true,
      consecutiveConfirmationCount: 3,
    });
    const result = evaluateWakeGate(config, input);
    expect(result.decision).toBe('wake_emitted');
  });

  it('emits wake when not enough recent outcomes to require confirmation', () => {
    const recentOutcomes = [
      { artifactId: 'art-1', recommendedPreset: 'preset-c', timestamp: '2026-07-18T08:00:00.000Z' },
    ];
    const input = makeInput({
      recentAssessmentOutcomes: recentOutcomes,
    });
    const config = makeConfig({
      requireConsecutiveConfirmation: true,
      consecutiveConfirmationCount: 3,
    });
    const result = evaluateWakeGate(config, input);
    expect(result.decision).toBe('wake_emitted');
  });

  it('skips consecutive confirmation check when config is disabled', () => {
    const recentOutcomes = [
      { artifactId: 'art-1', recommendedPreset: 'preset-c', timestamp: '2026-07-18T08:00:00.000Z' },
    ];
    const input = makeInput({
      recentAssessmentOutcomes: recentOutcomes,
    });
    const config = makeConfig({
      requireConsecutiveConfirmation: false,
      consecutiveConfirmationCount: 2,
    });
    const result = evaluateWakeGate(config, input);
    expect(result.decision).toBe('wake_emitted');
  });

  // ── H3: Current preset below minimum score ──────────────────────────────

  it('emits wake when current preset score is below minimum even if uplift is insufficient', () => {
    // preset-b (current) score = 0.10, preset-a (top alt) score = 0.12
    // uplift = (0.12 - 0.10) / 0.10 = 0.20, but min uplift = 0.30 so uplift is insufficient
    // however minCurrentPresetScore = 0.15 and current score = 0.10 < 0.15, so emit wake
    const artifact = makeArtifact({
      presetRankings: [
        {
          presetKey: 'preset-a',
          presetBehaviorVersion: 'v1',
          rank: 1,
          score: 0.12,
          scoreBand: 'low',
          pros: [],
          cons: [],
          fitNotes: null,
        },
        {
          presetKey: 'preset-b',
          presetBehaviorVersion: 'v1',
          rank: 2,
          score: 0.10,
          scoreBand: 'low',
          pros: [],
          cons: [],
          fitNotes: null,
        },
      ],
    });
    const input = makeInput({ artifact, agentCurrentPreset: 'preset-b' });
    const config = makeConfig({
      minScoreUplift: 0.30,
      minCurrentPresetScore: 0.15,
    });
    const result = evaluateWakeGate(config, input);
    expect(result.decision).toBe('wake_emitted');
    expect(result.suppressionReason).toBeNull();
  });

  it('suppresses wake when current preset score is above minimum and uplift is insufficient', () => {
    // preset-b (current) score = 0.40, preset-a (top alt) score = 0.45
    // uplift = (0.45 - 0.40) / 0.40 = 0.125, min uplift = 0.30 so uplift is insufficient
    // minCurrentPresetScore = 0.15 and current score = 0.40 > 0.15, so suppress normally
    const artifact = makeArtifact({
      presetRankings: [
        {
          presetKey: 'preset-a',
          presetBehaviorVersion: 'v1',
          rank: 1,
          score: 0.45,
          scoreBand: 'mid',
          pros: [],
          cons: [],
          fitNotes: null,
        },
        {
          presetKey: 'preset-b',
          presetBehaviorVersion: 'v1',
          rank: 2,
          score: 0.40,
          scoreBand: 'mid',
          pros: [],
          cons: [],
          fitNotes: null,
        },
      ],
    });
    const input = makeInput({ artifact, agentCurrentPreset: 'preset-b' });
    const config = makeConfig({
      minScoreUplift: 0.30,
      minCurrentPresetScore: 0.15,
    });
    const result = evaluateWakeGate(config, input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.uplift_insufficient');
  });

  it('emits wake when current preset score equals minimum and uplift is sufficient', () => {
    // The rule only kicks in when score < min, not when score === min
    // We test that normal uplift logic still applies at the boundary
    const artifact = makeArtifact({
      presetRankings: [
        {
          presetKey: 'preset-a',
          presetBehaviorVersion: 'v1',
          rank: 1,
          score: 0.85,
          scoreBand: 'top',
          pros: [],
          cons: [],
          fitNotes: null,
        },
        {
          presetKey: 'preset-b',
          presetBehaviorVersion: 'v1',
          rank: 2,
          score: 0.15,
          scoreBand: 'low',
          pros: [],
          cons: [],
          fitNotes: null,
        },
      ],
    });
    const input = makeInput({ artifact, agentCurrentPreset: 'preset-b' });
    const config = makeConfig({
      minScoreUplift: 0.15,
      minCurrentPresetScore: 0.15,
    });
    // uplift = (0.85 - 0.15) / 0.15 ≈ 4.67 > 0.15 → normal wake
    const result = evaluateWakeGate(config, input);
    expect(result.decision).toBe('wake_emitted');
  });

  // ── M5: Explicit nowMs ─────────────────────────────────────────────────

  it('uses explicit nowMs for min-interval check', () => {
    const fixedNow = Date.parse('2026-07-18T12:00:00.000Z');
    // last wake was 1 hour ago (11:00)
    const lastWakeTimestamp = '2026-07-18T11:00:00.000Z';
    const input = makeInput({
      lastWakeTimestamp,
      nowMs: fixedNow,
    });
    const config = makeConfig({ minIntervalBetweenWakesMs: 14_400_000 }); // 4 hours
    // elapsed = 1 hour < 4 hours → suppressed
    const result = evaluateWakeGate(config, input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.interval_too_short');
  });

  it('uses explicit nowMs and allows wake when enough time has passed', () => {
    const fixedNow = Date.parse('2026-07-18T16:00:00.000Z');
    // last wake was 5 hours ago
    const lastWakeTimestamp = '2026-07-18T11:00:00.000Z';
    const input = makeInput({
      lastWakeTimestamp,
      nowMs: fixedNow,
    });
    const config = makeConfig({ minIntervalBetweenWakesMs: 14_400_000 }); // 4 hours
    // elapsed = 5 hours > 4 hours → emit
    const result = evaluateWakeGate(config, input);
    expect(result.decision).toBe('wake_emitted');
  });

  // ── M6: Custom minScoreFloorForUpliftCalc ───────────────────────────────

  it('uses minScoreFloorForUpliftCalc as floor when current preset score is very low', () => {
    // preset-b (current) score = 0.001, preset-a (top alt) score = 0.01
    // Without floor: uplift = (0.01 - 0.001) / 0.001 = 9 → huge
    // With floor 0.01: uplift = (0.01 - 0.001) / 0.01 = 0.9
    // Also, minCurrentPresetScore default is 0.0, so currentScore=0.001 is not below it
    const artifact = makeArtifact({
      presetRankings: [
        {
          presetKey: 'preset-a',
          presetBehaviorVersion: 'v1',
          rank: 1,
          score: 0.01,
          scoreBand: 'low',
          pros: [],
          cons: [],
          fitNotes: null,
        },
        {
          presetKey: 'preset-b',
          presetBehaviorVersion: 'v1',
          rank: 2,
          score: 0.001,
          scoreBand: 'low',
          pros: [],
          cons: [],
          fitNotes: null,
        },
      ],
    });
    const input = makeInput({ artifact, agentCurrentPreset: 'preset-b' });
    const config = makeConfig({
      minScoreUplift: 0.15,
      minScoreFloorForUpliftCalc: 0.01,
      minCurrentPresetScore: 0.0,
    });
    const result = evaluateWakeGate(config, input);
    // uplift = (0.01 - 0.001) / 0.01 = 0.9 > 0.15 → wake emitted
    expect(result.decision).toBe('wake_emitted');
    expect(result.scoreUplift).toBeCloseTo(0.9, 5);
  });

  it('suppresses when uplift with floor is still below threshold', () => {
    // preset-b (current) score = 0.01, preset-a (top alt) score = 0.011
    // With floor 0.01: uplift = (0.011 - 0.01) / 0.01 = 0.1
    // minScoreUplift = 0.15 → suppressed
    const artifact = makeArtifact({
      presetRankings: [
        {
          presetKey: 'preset-a',
          presetBehaviorVersion: 'v1',
          rank: 1,
          score: 0.011,
          scoreBand: 'low',
          pros: [],
          cons: [],
          fitNotes: null,
        },
        {
          presetKey: 'preset-b',
          presetBehaviorVersion: 'v1',
          rank: 2,
          score: 0.01,
          scoreBand: 'low',
          pros: [],
          cons: [],
          fitNotes: null,
        },
      ],
    });
    const input = makeInput({ artifact, agentCurrentPreset: 'preset-b' });
    const config = makeConfig({
      minScoreUplift: 0.15,
      minScoreFloorForUpliftCalc: 0.01,
      minCurrentPresetScore: 0.0,
    });
    const result = evaluateWakeGate(config, input);
    expect(result.decision).toBe('wake_suppressed');
    expect(result.suppressionReason).toBe('wake.uplift_insufficient');
    expect(result.scoreUplift).toBeCloseTo(0.1, 5);
  });
});
