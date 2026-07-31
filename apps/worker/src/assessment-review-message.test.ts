import { describe, it, expect } from 'vitest';
import { buildAssessmentReviewMessage } from './assessment-review-message.js';
import type { ScannerWakeContext } from '@herobids/domain';

describe('buildAssessmentReviewMessage', () => {
  it('produces unchanged scheduled-path message when no artifact IDs present', () => {
    const ctx: ScannerWakeContext & { scannerKind: 'assessment_review' } = {
      scannerKind: 'assessment_review',
      checkedAt: '2026-07-31T12:00:00.000Z',
      nextEligibleAt: '2026-08-01T12:00:00.000Z',
      advice: [
        {
          identity: {
            instrumentKind: 'orderbook',
            venueFamily: 'hyperliquid',
            styleTier: 'standard',
            symbol: 'BTC',
          },
          candidateRank: 1,
          activePreset: 'momentum',
          presetBehaviorVersion: 'v1',
          reasons: ['peer_outperformance_detected'],
        },
      ],
    };

    const message = buildAssessmentReviewMessage(ctx);

    // Key assertions — message should NOT mention artifacts or direct change_strategy_preset
    expect(message).toContain('Assessment Review Available');
    expect(message).not.toContain('Strategy Assessment Complete');
    expect(message).not.toContain('no further billing');
    expect(message).toContain('Call `assess_strategy_preset`');
    expect(message).toContain('no assessment has been run');
  });

  it('produces artifact-first message when assessmentArtifactId is present', () => {
    const ctx: ScannerWakeContext & { scannerKind: 'assessment_review' } = {
      scannerKind: 'assessment_review',
      checkedAt: '2026-07-31T12:00:00.000Z',
      nextEligibleAt: '2026-08-01T12:00:00.000Z',
      advice: [
        {
          identity: {
            instrumentKind: 'orderbook',
            venueFamily: 'hyperliquid',
            styleTier: 'standard',
            symbol: 'BTC',
          },
          candidateRank: 1,
          activePreset: 'momentum',
          presetBehaviorVersion: 'v1',
          reasons: ['peer_outperformance_detected'],
          assessmentArtifactId: 'artifact-abc-123',
          recommendedPreset: 'range',
          confidence: 0.85,
          expiresAt: '2026-07-31T18:00:00.000Z',
        },
      ],
    };

    const message = buildAssessmentReviewMessage(ctx);

    expect(message).toContain('Strategy Assessment Complete');
    expect(message).not.toContain('Assessment Review Available');
    expect(message).toContain('no further billing');
    expect(message).toContain('artifact-abc-123');
    expect(message).toContain('range');
    expect(message).toContain('0.85');
    expect(message).toContain('change_strategy_preset');
    expect(message).not.toContain('no assessment has been run');
  });

  it('handles mixed entries: some with artifacts, some without', () => {
    const ctx: ScannerWakeContext & { scannerKind: 'assessment_review' } = {
      scannerKind: 'assessment_review',
      checkedAt: '2026-07-31T12:00:00.000Z',
      nextEligibleAt: '2026-08-01T12:00:00.000Z',
      advice: [
        {
          identity: { instrumentKind: 'orderbook', venueFamily: 'hyperliquid', styleTier: 'standard', symbol: 'BTC' },
          candidateRank: 1, activePreset: 'momentum', presetBehaviorVersion: 'v1',
          reasons: ['peer_outperformance_detected'],
          assessmentArtifactId: 'artifact-1', recommendedPreset: 'range', confidence: 0.9,
          expiresAt: '2026-07-31T18:00:00.000Z',
        },
        {
          identity: { instrumentKind: 'orderbook', venueFamily: 'hyperliquid', styleTier: 'standard', symbol: 'ETH' },
          candidateRank: 2, activePreset: 'momentum', presetBehaviorVersion: 'v1',
          reasons: ['peer_outperformance_detected'],
          // No artifact — over capacity
        },
      ],
    };

    const message = buildAssessmentReviewMessage(ctx);

    expect(message).toContain('Strategy Assessment Complete');
    expect(message).toContain('not assessed in this batch');
    expect(message).toContain('artifact-1');
  });
});
