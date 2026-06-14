import { describe, it, expect } from 'vitest';
import { quantity } from '@herobids/domain';
import { SwapPositionTracker } from './swap-position-tracker.js';

describe('SwapPositionTracker', () => {
  it('starts with no asset projections', () => {
    const tracker = new SwapPositionTracker();
    expect(tracker.getAssetProjections()).toEqual([]);
  });

  it('rehydrates from initial fill projections', () => {
    const tracker = new SwapPositionTracker([
      { asset: 'SOL', projectedBalanceDelta: quantity('10'), lastUpdatedMs: 1000 },
    ]);
    expect(tracker.getAssetProjections()).toHaveLength(1);
    expect(tracker.getProjectedBalanceDelta('SOL').toString()).toBe('10');
  });

  it('records a swap fill — decreases input, increases output', () => {
    const tracker = new SwapPositionTracker([
      { asset: 'SOL', projectedBalanceDelta: quantity('100'), lastUpdatedMs: 1000 },
    ]);

    tracker.recordSwapFill({
      inputAsset: 'SOL',
      inputAmount: quantity('5'),
      outputAsset: 'USDC',
      outputAmount: quantity('750'),
      timestamp: 2000,
    });

    expect(tracker.getProjectedBalanceDelta('SOL').toString()).toBe('95');
    expect(tracker.getProjectedBalanceDelta('USDC').toString()).toBe('750');
  });

  it('accumulates multiple swaps correctly', () => {
    const tracker = new SwapPositionTracker([
      { asset: 'SOL', projectedBalanceDelta: quantity('100'), lastUpdatedMs: 1000 },
      { asset: 'USDC', projectedBalanceDelta: quantity('0'), lastUpdatedMs: 1000 },
    ]);

    tracker.recordSwapFill({
      inputAsset: 'SOL',
      inputAmount: quantity('10'),
      outputAsset: 'USDC',
      outputAmount: quantity('1500'),
      timestamp: 2000,
    });

    tracker.recordSwapFill({
      inputAsset: 'SOL',
      inputAmount: quantity('5'),
      outputAsset: 'USDC',
      outputAmount: quantity('740'),
      timestamp: 3000,
    });

    expect(tracker.getProjectedBalanceDelta('SOL').toString()).toBe('85');
    expect(tracker.getProjectedBalanceDelta('USDC').toString()).toBe('2240');
  });

  it('handles reverse swap (buy back)', () => {
    const tracker = new SwapPositionTracker([
      { asset: 'SOL', projectedBalanceDelta: quantity('90'), lastUpdatedMs: 1000 },
      { asset: 'USDC', projectedBalanceDelta: quantity('1500'), lastUpdatedMs: 1000 },
    ]);

    // Buy SOL with USDC
    tracker.recordSwapFill({
      inputAsset: 'USDC',
      inputAmount: quantity('750'),
      outputAsset: 'SOL',
      outputAmount: quantity('5'),
      timestamp: 2000,
    });

    expect(tracker.getProjectedBalanceDelta('SOL').toString()).toBe('95');
    expect(tracker.getProjectedBalanceDelta('USDC').toString()).toBe('750');
  });

  it('filters zero-value projections from getAssetProjections', () => {
    const tracker = new SwapPositionTracker([
      { asset: 'SOL', projectedBalanceDelta: quantity('10'), lastUpdatedMs: 1000 },
      { asset: 'USDC', projectedBalanceDelta: quantity('0'), lastUpdatedMs: 1000 },
    ]);

    const projections = tracker.getAssetProjections();
    expect(projections).toHaveLength(1);
    expect(projections[0]!.asset).toBe('SOL');
  });

  describe('compareToObservedBalances', () => {
    it('returns empty when observed balances match the fill projection', () => {
      const tracker = new SwapPositionTracker([
        { asset: 'SOL', projectedBalanceDelta: quantity('100'), lastUpdatedMs: 1000 },
      ]);

      const observed = new Map([['SOL', quantity('100')]]);
      const variance = tracker.compareToObservedBalances(observed);
      expect(variance).toEqual([]);
    });

    it('detects positive variance when observed balance exceeds the fill projection', () => {
      const tracker = new SwapPositionTracker([
        { asset: 'SOL', projectedBalanceDelta: quantity('100'), lastUpdatedMs: 1000 },
      ]);

      const observed = new Map([['SOL', quantity('110')]]);
      const variance = tracker.compareToObservedBalances(observed);
      expect(variance).toHaveLength(1);
      expect(variance[0]!.asset).toBe('SOL');
      expect(variance[0]!.variance.toString()).toBe('10');
      expect(variance[0]!.variancePct).toBeCloseTo(10);
    });

    it('detects negative variance when observed balance is below the fill projection', () => {
      const tracker = new SwapPositionTracker([
        { asset: 'SOL', projectedBalanceDelta: quantity('100'), lastUpdatedMs: 1000 },
      ]);

      const observed = new Map([['SOL', quantity('90')]]);
      const variance = tracker.compareToObservedBalances(observed);
      expect(variance).toHaveLength(1);
      expect(variance[0]!.variance.toString()).toBe('-10');
      expect(variance[0]!.variancePct).toBeCloseTo(10);
    });

    it('handles observed asset balances that were not present in the fill projection', () => {
      const tracker = new SwapPositionTracker();

      const observed = new Map([['NEW_TOKEN', quantity('500')]]);
      const variance = tracker.compareToObservedBalances(observed);
      expect(variance).toHaveLength(1);
      expect(variance[0]!.asset).toBe('NEW_TOKEN');
      expect(variance[0]!.variance.toString()).toBe('500');
      expect(variance[0]!.variancePct).toBe(100);
    });

    it('evaluates multiple assets independently', () => {
      const tracker = new SwapPositionTracker([
        { asset: 'SOL', projectedBalanceDelta: quantity('100'), lastUpdatedMs: 1000 },
        { asset: 'USDC', projectedBalanceDelta: quantity('1000'), lastUpdatedMs: 1000 },
      ]);

      const observed = new Map([
        ['SOL', quantity('105')],
        ['USDC', quantity('1000')], // no drift
      ]);
      const variance = tracker.compareToObservedBalances(observed);
      expect(variance).toHaveLength(1);
      expect(variance[0]!.asset).toBe('SOL');
    });
  });
});
