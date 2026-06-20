import { describe, it, expect } from 'vitest';
import { translateMomentumToMechanicalParams } from './momentum-to-mechanical.js';

describe('translateMomentumToMechanicalParams', () => {
  it('fills defaults when empty config is given', () => {
    const result = translateMomentumToMechanicalParams({});
    expect(result.candleInterval).toBe('15m');
    expect(result.candleLimit).toBe(100);
    expect(result.signalBias).toBe('trend-following');
    expect(result.positionSize).toBe('1');
    expect(result.positionSizeMode).toBe('fixed');
    expect(result.indicators).toBeUndefined();
  });

  it('maps lookbackPeriod to candleLimit with minimum floor of 20', () => {
    const result = translateMomentumToMechanicalParams({ lookbackPeriod: 14 });
    expect(result.candleLimit).toBe(20);
  });

  it('passes through lookbackPeriod >= 20 directly', () => {
    const result = translateMomentumToMechanicalParams({ lookbackPeriod: 50 });
    expect(result.candleLimit).toBe(50);
  });

  it('ignores lookbackPeriod < 2 (invalid) and uses default of 100', () => {
    const result = translateMomentumToMechanicalParams({ lookbackPeriod: 1 });
    expect(result.candleLimit).toBe(100);
  });

  it('ignores non-integer lookbackPeriod and uses default of 100', () => {
    const result = translateMomentumToMechanicalParams({ lookbackPeriod: 3.5 });
    expect(result.candleLimit).toBe(100);
  });

  it('maps threshold to minConfidence with 5x multiplier', () => {
    const result = translateMomentumToMechanicalParams({ threshold: 0.02 });
    expect(result.indicators).toEqual({ confidence: { minConfidence: 0.10 } });
  });

  it('clamps minConfidence to [0.01, 1]', () => {
    const below = translateMomentumToMechanicalParams({ threshold: 0 });
    expect(below.indicators).toEqual({ confidence: { minConfidence: 0.01 } });

    const above = translateMomentumToMechanicalParams({ threshold: 1 });
    expect(above.indicators).toEqual({ confidence: { minConfidence: 1 } });
  });

  it('omits indicators block when threshold is not provided', () => {
    const result = translateMomentumToMechanicalParams({});
    expect(result.indicators).toBeUndefined();
  });

  it('carries over positionSize', () => {
    const result = translateMomentumToMechanicalParams({ positionSize: '2.5' });
    expect(result.positionSize).toBe('2.5');
  });

  it('defaults positionSize to "1" when not provided', () => {
    const result = translateMomentumToMechanicalParams({});
    expect(result.positionSize).toBe('1');
  });

  it('ignores empty positionSize string and uses default', () => {
    const result = translateMomentumToMechanicalParams({ positionSize: '' });
    expect(result.positionSize).toBe('1');
  });

  it('passes through valid candleInterval', () => {
    const result = translateMomentumToMechanicalParams({ candleInterval: '1H' });
    expect(result.candleInterval).toBe('1H');
  });

  it('defaults candleInterval to 15m when invalid value given', () => {
    const result = translateMomentumToMechanicalParams({ candleInterval: '7m' });
    expect(result.candleInterval).toBe('15m');
  });

  it('combines all provided momentum params correctly', () => {
    const result = translateMomentumToMechanicalParams({
      lookbackPeriod: 30,
      threshold: 0.04,
      positionSize: '0.5',
      candleInterval: '4H',
    });
    expect(result.candleLimit).toBe(30);
    expect(result.indicators).toEqual({ confidence: { minConfidence: 0.20 } });
    expect(result.positionSize).toBe('0.5');
    expect(result.candleInterval).toBe('4H');
    expect(result.signalBias).toBe('trend-following');
    expect(result.positionSizeMode).toBe('fixed');
  });

  it('ignores unknown extra fields', () => {
    const result = translateMomentumToMechanicalParams({
      lookbackPeriod: 20,
      unknownField: 'should be ignored',
    });
    expect(result.candleLimit).toBe(20);
    expect(Object.keys(result)).not.toContain('unknownField');
  });
});
