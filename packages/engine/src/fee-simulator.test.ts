import { describe, it, expect } from 'vitest';
import { price, Decimal } from '@herobids/domain';
import { simulateFee, applyPaperSlippage } from './fee-simulator.js';

describe('Fee Simulator', () => {
  describe('simulateFee', () => {
    it('fee is proportional to notional', () => {
      const fee = simulateFee({ takerFeePct: 0.001, makerFeePct: 0.0005 }, price('10000'));
      // 10000 * 0.001 = 10
      expect(fee.eq(new Decimal(10))).toBe(true);
    });

    it('returns zero fee for zero notional', () => {
      const fee = simulateFee({ takerFeePct: 0.001, makerFeePct: 0.0005 }, price('0'));
      expect(fee.isZero()).toBe(true);
    });

    it('handles large notional values', () => {
      const fee = simulateFee({ takerFeePct: 0.001, makerFeePct: 0.0005 }, price('1000000'));
      expect(fee.eq(new Decimal(1000))).toBe(true);
    });
  });

  describe('applyPaperSlippage', () => {
    it('buy moves price higher (adverse)', () => {
      const slipped = applyPaperSlippage({ takerFeePct: 0.001, makerFeePct: 0.0005, paperSlippageBps: 5 }, price('10000'), 'buy');
      // 10000 * (1 + 5/10000) = 10000 * 1.0005 = 10005
      expect(slipped.eq(new Decimal(10005))).toBe(true);
    });

    it('sell moves price lower (adverse)', () => {
      const slipped = applyPaperSlippage({ takerFeePct: 0.001, makerFeePct: 0.0005, paperSlippageBps: 5 }, price('10000'), 'sell');
      // 10000 * (1 - 5/10000) = 10000 * 0.9995 = 9995
      expect(slipped.eq(new Decimal(9995))).toBe(true);
    });

    it('zero bps means no slippage', () => {
      const slipped = applyPaperSlippage({ takerFeePct: 0.001, makerFeePct: 0.0005, paperSlippageBps: 0 }, price('10000'), 'buy');
      expect(slipped.eq(new Decimal(10000))).toBe(true);
    });

    it('undefined bps means no slippage', () => {
      const slipped = applyPaperSlippage({ takerFeePct: 0.001, makerFeePct: 0.0005 }, price('10000'), 'sell');
      expect(slipped.eq(new Decimal(10000))).toBe(true);
    });
  });
});
