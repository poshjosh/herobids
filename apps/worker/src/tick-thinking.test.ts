import { describe, expect, it } from 'vitest';
import { classifyTickThinking, extractDrawdownPct } from './tick-thinking.js';

describe('classifyTickThinking', () => {
  it('uses deep thinking for a regime flip', () => {
    expect(classifyTickThinking({
      hasOpenPositions: false,
      previousRegimePass: false,
      regimePass: true,
      incomingMessagesCount: 0,
    })).toEqual({ thinking: 'deep', reason: 'regime_flip' });
  });

  it('uses deep thinking for large drawdown', () => {
    expect(classifyTickThinking({
      hasOpenPositions: true,
      incomingMessagesCount: 0,
      drawdownPct: -2.5,
    })).toEqual({ thinking: 'deep', reason: 'drawdown_threshold' });
  });

  it('uses light thinking when managing open positions without major events', () => {
    expect(classifyTickThinking({
      hasOpenPositions: true,
      incomingMessagesCount: 0,
    })).toEqual({ thinking: 'light', reason: 'open_positions' });
  });

  it('uses none for routine flat ticks', () => {
    expect(classifyTickThinking({
      hasOpenPositions: false,
      incomingMessagesCount: 0,
    })).toEqual({ thinking: 'none', reason: 'routine_tick' });
  });
});

describe('extractDrawdownPct', () => {
  it('extracts percentage values from pnl strings', () => {
    expect(extractDrawdownPct('Net P&L: -2.4% today')).toBe(-2.4);
    expect(extractDrawdownPct('+$12.00')).toBeNull();
  });
});