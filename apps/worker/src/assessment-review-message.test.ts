import { describe, it, expect } from 'vitest';
import { buildAssessmentReviewMessage } from './assessment-review-message.js';
import type { ScannerWakeContext } from '@herobids/domain';

describe('buildAssessmentReviewMessage', () => {
  it('guides the agent through the data-only assessment flow', () => {
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

    // No billing language, no platform-assessor artifact path.
    expect(message).toContain('Assessment Review Available');
    expect(message).not.toContain('Strategy Assessment Complete');
    expect(message).not.toContain('billing');
    expect(message).toContain('Call `assess_strategy_preset`');
    expect(message).toContain('data-only and free');
    expect(message).toContain('creatorAllowed');
    expect(message).toContain('signalsVsCurrent');
    expect(message).toContain('change_strategy_preset');
    expect(message).toContain('no assessment has been run');
  });

  it('renders each advised candidate with identity, active preset, and reasons', () => {
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
        {
          identity: {
            instrumentKind: 'swap',
            venueFamily: 'jupiter',
            styleTier: 'economy',
            network: 'solana',
            address: 'So11111111111111111111111111111111111111112',
          },
          candidateRank: 2,
          activePreset: 'range',
          presetBehaviorVersion: 'v2',
          reasons: ['regime_mismatch'],
        },
      ],
    };

    const message = buildAssessmentReviewMessage(ctx);

    expect(message).toContain('BTC');
    expect(message).toContain('momentum');
    expect(message).toContain('peer_outperformance_detected');
    // swap/dex identity renders as network/address
    expect(message).toContain('solana/So11111111111111111111111111111111111111112');
    expect(message).toContain('range');
  });
});