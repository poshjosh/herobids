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

  // Preservation baseline (spec preset-tools-dropped-no-local-registry, requirement 3.7):
  // the exact wake text observed before the preset proxy tools were added. The fix must not change it.
  it('keeps the wake text byte-identical for a mixed orderbook and dex candidate list', () => {
    const ctx: ScannerWakeContext & { scannerKind: 'assessment_review' } = {
      scannerKind: 'assessment_review',
      checkedAt: '2026-07-31T12:00:00.000Z',
      nextEligibleAt: '2026-08-01T12:00:00.000Z',
      advice: [
        {
          identity: { instrumentKind: 'orderbook', venueFamily: 'hyperliquid', styleTier: 'standard', symbol: 'BTC' },
          candidateRank: 1,
          activePreset: 'momentum',
          presetBehaviorVersion: '1',
          reasons: ['peer_outperformance_detected', 'regime_mismatch'],
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
          presetBehaviorVersion: '2',
          reasons: ['regime_mismatch'],
        },
      ],
    };

    expect(buildAssessmentReviewMessage(ctx)).toBe(
      [
        '🔔 **Assessment Review Available**',
        '',
        'The platform scanner ran a deterministic pre-check at `2026-07-31T12:00:00.000Z` and found **2** symbol(s) where your current preset may be sub-optimal for current market conditions.',
        '',
        '**Candidates:**',
        '- **#1** `BTC` (hyperliquid, standard) — peer_outperformance_detected, regime_mismatch',
        '  Active Preset: `momentum` (v1)',
        '- **#2** `solana/So11111111111111111111111111111111111111112` (jupiter, economy) — regime_mismatch',
        '  Active Preset: `range` (v2)',
        '',
        '**What to do:**',
        '1. Call `assess_strategy_preset` for one or more candidate symbols (e.g. `["BTC", "ETH"]`). Assessment is now data-only and free.',
        '2. Read the flags per symbol per preset: `creatorAllowed`, `evidenceFresh`, `regimeMatch`, `signalsVsCurrent`. More signals is NOT better fit.',
        '3. Change your preset with `change_strategy_preset` only when the data clearly shows a better fit, and give a reason (it is shown on the review screen).',
        '',
        'Next review eligible after: `2026-08-01T12:00:00.000Z`',
        '',
        '**Important:** This is an informational review — no assessment has been run. You are the final decision-maker.',
      ].join('\n'),
    );
  });

  it('keeps the wake text byte-identical for a single orderbook candidate without a symbol', () => {
    const ctx: ScannerWakeContext & { scannerKind: 'assessment_review' } = {
      scannerKind: 'assessment_review',
      checkedAt: '2026-09-01T00:00:00.000Z',
      nextEligibleAt: '2026-09-02T00:00:00.000Z',
      advice: [
        {
          identity: { instrumentKind: 'perp', venueFamily: 'hyperliquid', styleTier: 'premium' },
          candidateRank: 1,
          activePreset: 'breakout',
          presetBehaviorVersion: '3',
          reasons: ['signals_stale'],
        },
      ],
    };

    expect(buildAssessmentReviewMessage(ctx)).toBe(
      [
        '🔔 **Assessment Review Available**',
        '',
        'The platform scanner ran a deterministic pre-check at `2026-09-01T00:00:00.000Z` and found **1** symbol(s) where your current preset may be sub-optimal for current market conditions.',
        '',
        '**Candidates:**',
        '- **#1** `unknown` (hyperliquid, premium) — signals_stale',
        '  Active Preset: `breakout` (v3)',
        '',
        '**What to do:**',
        '1. Call `assess_strategy_preset` for one or more candidate symbols (e.g. `["BTC", "ETH"]`). Assessment is now data-only and free.',
        '2. Read the flags per symbol per preset: `creatorAllowed`, `evidenceFresh`, `regimeMatch`, `signalsVsCurrent`. More signals is NOT better fit.',
        '3. Change your preset with `change_strategy_preset` only when the data clearly shows a better fit, and give a reason (it is shown on the review screen).',
        '',
        'Next review eligible after: `2026-09-02T00:00:00.000Z`',
        '',
        '**Important:** This is an informational review — no assessment has been run. You are the final decision-maker.',
      ].join('\n'),
    );
  });
});