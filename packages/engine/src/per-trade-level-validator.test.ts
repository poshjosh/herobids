import { describe, expect, it } from 'vitest';
import { price } from '@herobids/domain';
import { validatePerTradeLevels } from './per-trade-level-validator.js';

const MARK = price('100');

describe('validatePerTradeLevels', () => {
  // ── Happy path ──────────────────────────────────────────────

  it('returns null for valid long stopLoss < mark and takeProfit > mark', () => {
    expect(validatePerTradeLevels({
      side: 'long',
      markPrice: MARK,
      stopLoss: price('90'),
      takeProfit: price('110'),
    })).toBeNull();
  });

  it('returns null for valid short stopLoss > mark and takeProfit < mark', () => {
    expect(validatePerTradeLevels({
      side: 'short',
      markPrice: MARK,
      stopLoss: price('110'),
      takeProfit: price('90'),
    })).toBeNull();
  });

  it('returns null when only stopLoss is set and valid (long)', () => {
    expect(validatePerTradeLevels({
      side: 'long',
      markPrice: MARK,
      stopLoss: price('90'),
    })).toBeNull();
  });

  it('returns null when only takeProfit is set and valid (long)', () => {
    expect(validatePerTradeLevels({
      side: 'long',
      markPrice: MARK,
      takeProfit: price('110'),
    })).toBeNull();
  });

  it('returns null when only stopLoss is set and valid (short)', () => {
    expect(validatePerTradeLevels({
      side: 'short',
      markPrice: MARK,
      stopLoss: price('110'),
    })).toBeNull();
  });

  it('returns null when only takeProfit is set and valid (short)', () => {
    expect(validatePerTradeLevels({
      side: 'short',
      markPrice: MARK,
      takeProfit: price('90'),
    })).toBeNull();
  });

  it('returns null when neither stopLoss nor takeProfit is set', () => {
    expect(validatePerTradeLevels({
      side: 'long',
      markPrice: MARK,
    })).toBeNull();
  });

  it('returns null for valid long with large spread (far OTM levels)', () => {
    expect(validatePerTradeLevels({
      side: 'long',
      markPrice: MARK,
      stopLoss: price('1'),
      takeProfit: price('999999'),
    })).toBeNull();
  });

  // ── 4 error cases ───────────────────────────────────────────

  it('rejects long stopLoss >= mark (above_mark_for_long)', () => {
    const result = validatePerTradeLevels({
      side: 'long',
      markPrice: MARK,
      stopLoss: price('150'),
    });
    expect(result).toEqual({
      field: 'stopLoss',
      reason: 'above_mark_for_long',
      markPrice: '100',
      level: '150',
    });
  });

  it('rejects short stopLoss <= mark (below_mark_for_short)', () => {
    const result = validatePerTradeLevels({
      side: 'short',
      markPrice: MARK,
      stopLoss: price('50'),
    });
    expect(result).toEqual({
      field: 'stopLoss',
      reason: 'below_mark_for_short',
      markPrice: '100',
      level: '50',
    });
  });

  it('rejects long takeProfit <= mark (below_mark_for_long)', () => {
    const result = validatePerTradeLevels({
      side: 'long',
      markPrice: MARK,
      takeProfit: price('99'),
    });
    expect(result).toEqual({
      field: 'takeProfit',
      reason: 'below_mark_for_long',
      markPrice: '100',
      level: '99',
    });
  });

  it('rejects short takeProfit >= mark (above_mark_for_short)', () => {
    const result = validatePerTradeLevels({
      side: 'short',
      markPrice: MARK,
      takeProfit: price('101'),
    });
    expect(result).toEqual({
      field: 'takeProfit',
      reason: 'above_mark_for_short',
      markPrice: '100',
      level: '101',
    });
  });

  // ── Edge case: level exactly equal to mark ──────────────────

  it('rejects stopLoss exactly equal to mark for long (gte catches equality)', () => {
    const result = validatePerTradeLevels({
      side: 'long',
      markPrice: MARK,
      stopLoss: price('100'),
    });
    expect(result).toEqual({
      field: 'stopLoss',
      reason: 'above_mark_for_long',
      markPrice: '100',
      level: '100',
    });
  });

  it('rejects stopLoss exactly equal to mark for short (lte catches equality)', () => {
    const result = validatePerTradeLevels({
      side: 'short',
      markPrice: MARK,
      stopLoss: price('100'),
    });
    expect(result).toEqual({
      field: 'stopLoss',
      reason: 'below_mark_for_short',
      markPrice: '100',
      level: '100',
    });
  });

  it('rejects takeProfit exactly equal to mark for long (lte catches equality)', () => {
    const result = validatePerTradeLevels({
      side: 'long',
      markPrice: MARK,
      takeProfit: price('100'),
    });
    expect(result).toEqual({
      field: 'takeProfit',
      reason: 'below_mark_for_long',
      markPrice: '100',
      level: '100',
    });
  });

  it('rejects takeProfit exactly equal to mark for short (gte catches equality)', () => {
    const result = validatePerTradeLevels({
      side: 'short',
      markPrice: MARK,
      takeProfit: price('100'),
    });
    expect(result).toEqual({
      field: 'takeProfit',
      reason: 'above_mark_for_short',
      markPrice: '100',
      level: '100',
    });
  });

  // ── Edge case: one level invalid, other valid ───────────────

  it('returns stopLoss error when stopLoss is invalid but takeProfit is valid', () => {
    const result = validatePerTradeLevels({
      side: 'long',
      markPrice: MARK,
      stopLoss: price('150'),  // invalid (above mark for long)
      takeProfit: price('110'), // valid
    });
    expect(result).toEqual({
      field: 'stopLoss',
      reason: 'above_mark_for_long',
      markPrice: '100',
      level: '150',
    });
  });

  it('returns takeProfit error when stopLoss is valid but takeProfit is invalid', () => {
    const result = validatePerTradeLevels({
      side: 'long',
      markPrice: MARK,
      stopLoss: price('90'),    // valid (below mark for long)
      takeProfit: price('50'),  // invalid (below mark for long)
    });
    expect(result).toEqual({
      field: 'takeProfit',
      reason: 'below_mark_for_long',
      markPrice: '100',
      level: '50',
    });
  });
});
