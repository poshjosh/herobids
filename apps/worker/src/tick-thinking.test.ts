import { describe, expect, it } from 'vitest';
import { classifyTickThinking, extractDrawdownPct, applyReasoningCeiling, toReasoningLevel } from './tick-thinking.js';

describe('classifyTickThinking', () => {
  it('uses deep thinking for a regime flip', () => {
    expect(classifyTickThinking({
      hasOpenPositions: false,
      previousRegimePass: false,
      regimePass: true,
      incomingMessagesCount: 0,
      drawdownThresholdPct: -2,
    })).toEqual({ thinking: 'deep', reason: 'regime_flip' });
  });

  it('uses deep thinking for large drawdown', () => {
    expect(classifyTickThinking({
      hasOpenPositions: true,
      incomingMessagesCount: 0,
      drawdownPct: -2.5,
      drawdownThresholdPct: -2,
    })).toEqual({ thinking: 'deep', reason: 'drawdown_threshold' });
  });

  it('uses light thinking when managing open positions without major events', () => {
    expect(classifyTickThinking({
      hasOpenPositions: true,
      incomingMessagesCount: 0,
      drawdownThresholdPct: -2,
    })).toEqual({ thinking: 'light', reason: 'open_positions' });
  });

  it('uses none for routine flat ticks', () => {
    expect(classifyTickThinking({
      hasOpenPositions: false,
      incomingMessagesCount: 0,
      drawdownThresholdPct: -2,
    })).toEqual({ thinking: 'none', reason: 'routine_tick' });
  });

  describe('drawdownThresholdPct parameter', () => {
    it('triggers deep thinking at the custom threshold', () => {
      expect(classifyTickThinking({
        hasOpenPositions: true,
        incomingMessagesCount: 0,
        drawdownPct: -5.1,
        drawdownThresholdPct: -5,
      })).toEqual({ thinking: 'deep', reason: 'drawdown_threshold' });
    });

    it('does not trigger deep thinking when drawdown is above the custom threshold', () => {
      expect(classifyTickThinking({
        hasOpenPositions: true,
        incomingMessagesCount: 0,
        drawdownPct: -3,
        drawdownThresholdPct: -5,
      })).toEqual({ thinking: 'light', reason: 'open_positions' });
    });

    it('triggers at exactly the threshold value (inclusive)', () => {
      expect(classifyTickThinking({
        hasOpenPositions: true,
        incomingMessagesCount: 0,
        drawdownPct: -5,
        drawdownThresholdPct: -5,
      })).toEqual({ thinking: 'deep', reason: 'drawdown_threshold' });
    });

    it('uses configured threshold of -2', () => {
      // -1.9 is above -2, so should not trigger
      expect(classifyTickThinking({
        hasOpenPositions: true,
        incomingMessagesCount: 0,
        drawdownPct: -1.9,
        drawdownThresholdPct: -2,
      })).toEqual({ thinking: 'light', reason: 'open_positions' });

      // -2.0 is at -2, so should trigger
      expect(classifyTickThinking({
        hasOpenPositions: true,
        incomingMessagesCount: 0,
        drawdownPct: -2.0,
        drawdownThresholdPct: -2,
      })).toEqual({ thinking: 'deep', reason: 'drawdown_threshold' });
    });

    it('uses a tighter threshold (closer to 0) to require more extreme drawdown', () => {
      // drawdownPct = -2 would trigger at default -2 but not at -0.5
      expect(classifyTickThinking({
        hasOpenPositions: true,
        incomingMessagesCount: 0,
        drawdownPct: -2,
        drawdownThresholdPct: -0.5,
      })).toEqual({ thinking: 'deep', reason: 'drawdown_threshold' });
    });
  });
});

describe('extractDrawdownPct', () => {
  it('extracts percentage values from pnl strings', () => {
    expect(extractDrawdownPct('Net P&L: -2.4% today')).toBe(-2.4);
    expect(extractDrawdownPct('+$12.00')).toBeNull();
  });
});

describe('toReasoningLevel', () => {
  it('maps none → none', () => expect(toReasoningLevel('none')).toBe('none'));
  it('maps light → low', () => expect(toReasoningLevel('light')).toBe('low'));
  it('maps deep → high', () => expect(toReasoningLevel('deep')).toBe('high'));
});

describe('applyReasoningCeiling', () => {
  // System level is at or under the user ceiling → pass through unchanged
  it('passes none through when user ceiling is none', () =>
    expect(applyReasoningCeiling('none', 'none')).toBe('none'));

  it('passes none through when user ceiling is high (none < high)', () =>
    expect(applyReasoningCeiling('none', 'high')).toBe('none'));

  it('passes light through when user ceiling is low (equal order)', () =>
    expect(applyReasoningCeiling('light', 'low')).toBe('light'));

  it('passes light through when user ceiling is medium (light < medium)', () =>
    expect(applyReasoningCeiling('light', 'medium')).toBe('light'));

  it('passes deep through when user ceiling is high (equal order)', () =>
    expect(applyReasoningCeiling('deep', 'high')).toBe('deep'));

  // System level exceeds the user ceiling → cap downward
  it('caps deep to none when user ceiling is none', () =>
    expect(applyReasoningCeiling('deep', 'none')).toBe('none'));

  it('caps light to none when user ceiling is none', () =>
    expect(applyReasoningCeiling('light', 'none')).toBe('none'));

  it('caps deep to light when user ceiling is low', () =>
    expect(applyReasoningCeiling('deep', 'low')).toBe('light'));

  it('caps deep to deep when user ceiling is medium (medium maps to deep)', () =>
    expect(applyReasoningCeiling('deep', 'medium')).toBe('deep'));
});
