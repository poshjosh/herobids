import { describe, it, expect } from 'vitest';
import { buildAssessmentReviewMessage } from './assessment-review-message.js';
import type { ScannerWakeContext } from '@herobids/domain';

function makeScannerWakeContext(overrides?: Partial<ScannerWakeContext & { scannerKind: 'assessment_review' }>): ScannerWakeContext & { scannerKind: 'assessment_review' } {
  return {
    scannerKind: 'assessment_review',
    advice: [
      {
        identity: {
          instrumentKind: 'orderbook' as const,
          venueFamily: 'hyperliquid',
          styleTier: 'standard' as const,
          symbol: 'BTC',
        },
        candidateRank: 1,
        activePreset: 'momentum_v1',
        presetBehaviorVersion: 'abc123def0',
        reasons: ['Low signal-to-noise ratio with current preset', 'Scanner detected 40% fewer signals than peer presets'],
      },
      {
        identity: {
          instrumentKind: 'perp' as const,
          venueFamily: 'bybit',
          styleTier: 'economy' as const,
          symbol: 'ETH',
        },
        candidateRank: 2,
        activePreset: 'mean_reversion_v2',
        presetBehaviorVersion: '1112223334',
        reasons: ['High volatility regime — mean reversion underperforms'],
      },
    ],
    checkedAt: '2026-07-19T10:00:00.000Z',
    nextEligibleAt: '2026-07-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('buildAssessmentReviewMessage', () => {
  it('renders the assessment review header', () => {
    const msg = buildAssessmentReviewMessage(makeScannerWakeContext());
    expect(msg).toContain('🔔 **Assessment Review Available**');
  });

  it('includes the number of advised symbols', () => {
    const msg = buildAssessmentReviewMessage(makeScannerWakeContext());
    expect(msg).toContain('**2** symbol(s)');
  });

  it('includes the checkedAt timestamp', () => {
    const ctx = makeScannerWakeContext();
    const msg = buildAssessmentReviewMessage(ctx);
    expect(msg).toContain(ctx.checkedAt);
  });

  it('includes the nextEligibleAt timestamp', () => {
    const ctx = makeScannerWakeContext();
    const msg = buildAssessmentReviewMessage(ctx);
    expect(msg).toContain(ctx.nextEligibleAt);
  });

  it('renders orderbook identity with symbol', () => {
    const ctx = makeScannerWakeContext();
    const msg = buildAssessmentReviewMessage(ctx);
    expect(msg).toContain('BTC');
    expect(msg).toContain('hyperliquid');
  });

  it('renders perp identity with symbol', () => {
    const ctx = makeScannerWakeContext();
    const msg = buildAssessmentReviewMessage(ctx);
    expect(msg).toContain('ETH');
    expect(msg).toContain('bybit');
  });

  it('renders swap identity with network/address', () => {
    const ctx = makeScannerWakeContext({
      advice: [
        {
          identity: {
            instrumentKind: 'swap' as const,
            venueFamily: 'jupiter',
            styleTier: 'standard' as const,
            network: 'solana',
            address: 'So11111111111111111111111111111111111111112',
          },
          candidateRank: 1,
          activePreset: 'trend_v1',
          presetBehaviorVersion: 'deadbeef00',
          reasons: ['Low liquidity on swap venue'],
        },
      ],
    });
    const msg = buildAssessmentReviewMessage(ctx);
    expect(msg).toContain('solana');
    expect(msg).toContain('So11111111111111111111111111111111111111112');
    expect(msg).toContain('jupiter');
  });

  it('renders dex identity with network/address', () => {
    const ctx = makeScannerWakeContext({
      advice: [
        {
          identity: {
            instrumentKind: 'dex' as const,
            venueFamily: 'uniswap',
            styleTier: 'premium' as const,
            network: 'ethereum',
            address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          },
          candidateRank: 1,
          activePreset: 'arbitrage_v1',
          presetBehaviorVersion: 'cafebabe01',
          reasons: ['Arbitrage spread below threshold'],
        },
      ],
    });
    const msg = buildAssessmentReviewMessage(ctx);
    expect(msg).toContain('ethereum');
    expect(msg).toContain('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(msg).toContain('uniswap');
  });

  it('includes candidate rank', () => {
    const msg = buildAssessmentReviewMessage(makeScannerWakeContext());
    expect(msg).toContain('#1');
    expect(msg).toContain('#2');
  });

  it('includes reasons for each candidate', () => {
    const msg = buildAssessmentReviewMessage(makeScannerWakeContext());
    expect(msg).toContain('Low signal-to-noise ratio with current preset');
    expect(msg).toContain('Scanner detected 40% fewer signals than peer presets');
    expect(msg).toContain('High volatility regime — mean reversion underperforms');
  });

  it('includes active preset and version for each candidate', () => {
    const msg = buildAssessmentReviewMessage(makeScannerWakeContext());
    expect(msg).toContain('momentum_v1');
    expect(msg).toContain('vabc123def0');
    expect(msg).toContain('mean_reversion_v2');
    expect(msg).toContain('v1112223334');
  });

  it('guides the agent to use assess_strategy_preset', () => {
    const msg = buildAssessmentReviewMessage(makeScannerWakeContext());
    expect(msg).toContain('assess_strategy_preset');
  });

  it('warns that each assessed symbol incurs a billing charge', () => {
    const msg = buildAssessmentReviewMessage(makeScannerWakeContext());
    expect(msg).toContain('Each assessed symbol incurs a billing charge');
  });

  it('states that no billing has occurred from the wake alone', () => {
    const msg = buildAssessmentReviewMessage(makeScannerWakeContext());
    expect(msg).toContain('no billing has occurred');
  });

  it('renders correctly with a single advice entry', () => {
    const ctx = makeScannerWakeContext({
      advice: [
        {
          identity: {
            instrumentKind: 'orderbook' as const,
            venueFamily: 'hyperliquid',
            styleTier: 'standard' as const,
            symbol: 'SOL',
          },
          candidateRank: 1,
          activePreset: 'scalper_v1',
          presetBehaviorVersion: '0123456789',
          reasons: ['Tight spreads favor scalping'],
        },
      ],
    });
    const msg = buildAssessmentReviewMessage(ctx);
    expect(msg).toContain('**1** symbol(s)');
    expect(msg).toContain('SOL');
    expect(msg).not.toContain('#2'); // no second candidate
  });
});
