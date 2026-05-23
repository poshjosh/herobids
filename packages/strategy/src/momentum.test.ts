import { describe, it, expect } from 'vitest';
import { MomentumStrategy } from './momentum.js';
import { price } from '@herobids/domain';
import type { MarketSnapshot } from '@herobids/domain';

let idSeq = 0;
const idGen = () => `dec-${++idSeq}`;

function snap(p: string, ts?: string): MarketSnapshot {
  return { symbol: 'BTC/USD:USD', price: price(p), timestamp: ts ?? '2026-01-01T00:00:00Z' };
}

const config = { lookbackPeriod: 3, threshold: 0.02, positionSize: '1', instrumentId: 'ins-1' };

describe('MomentumStrategy', () => {
  it('returns null until lookback is filled', async () => {
    const strat = new MomentumStrategy(idGen);
    const r1 = await strat.evaluate(snap('100'), config);
    expect(r1.ok && r1.data).toBeNull();
    const r2 = await strat.evaluate(snap('101'), config);
    expect(r2.ok && r2.data).toBeNull();
  });

  it('signals go_long on upward momentum above threshold', async () => {
    const strat = new MomentumStrategy(idGen);
    await strat.evaluate(snap('100'), config);
    await strat.evaluate(snap('101'), config);
    // 3rd snapshot: 100 → 103 = +3% > 2% threshold
    const r = await strat.evaluate(snap('103'), config);
    expect(r.ok).toBe(true);
    if (r.ok && r.data) {
      expect(r.data.intent).toBe('go_long');
      expect(r.data.targetSize.eq(1)).toBe(true);
    } else {
      throw new Error('Expected a decision');
    }
  });

  it('signals go_short on downward momentum below threshold', async () => {
    const strat = new MomentumStrategy(idGen);
    await strat.evaluate(snap('100'), config);
    await strat.evaluate(snap('99'), config);
    // 3rd: 100 → 97 = -3% < -2% threshold
    const r = await strat.evaluate(snap('97'), config);
    expect(r.ok).toBe(true);
    if (r.ok && r.data) {
      expect(r.data.intent).toBe('go_short');
    } else {
      throw new Error('Expected a decision');
    }
  });

  it('returns null when momentum within threshold (hold)', async () => {
    const strat = new MomentumStrategy(idGen);
    await strat.evaluate(snap('100'), config);
    await strat.evaluate(snap('100.5'), config);
    // 3rd: 100 → 101 = +1% < 2%
    const r = await strat.evaluate(snap('101'), config);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toBeNull();
    }
  });

  it('trims price history to lookback window', async () => {
    const strat = new MomentumStrategy(idGen);
    await strat.evaluate(snap('100'), config);
    await strat.evaluate(snap('101'), config);
    await strat.evaluate(snap('102'), config);
    // Now window is [100, 101, 102]. Add one more → window becomes [101, 102, 103]
    // momentum = (103-101)/101 = ~1.98% → right at threshold boundary
    const r = await strat.evaluate(snap('103.03'), config);
    expect(r.ok).toBe(true);
    // (103.03-101)/101 = 2.009% > 2% → long
    if (r.ok && r.data) {
      expect(r.data.intent).toBe('go_long');
    }
  });
});
