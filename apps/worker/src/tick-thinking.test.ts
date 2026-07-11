import { describe, expect, it } from 'vitest';
import { classifyTickThinking, extractDrawdownPct, applyReasoningCeiling, toReasoningLevel, resolveScoutReasoningLevel, resolveJudgeThinkingLevel } from './tick-thinking.js';

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

// ── Adaptive reasoning toggle: resolveScoutReasoningLevel ──────────────────

describe('resolveScoutReasoningLevel', () => {
  describe('adaptive ON (default) — ceiling applied', () => {
    it('passes system level through when under user ceiling', () => {
      expect(resolveScoutReasoningLevel('none', 'high', true)).toBe('none');
      expect(resolveScoutReasoningLevel('light', 'high', true)).toBe('low');
      expect(resolveScoutReasoningLevel('light', 'medium', true)).toBe('low');
    });

    it('caps system level when it exceeds user ceiling', () => {
      expect(resolveScoutReasoningLevel('deep', 'none', true)).toBe('none');
      expect(resolveScoutReasoningLevel('deep', 'low', true)).toBe('low');
      expect(resolveScoutReasoningLevel('light', 'none', true)).toBe('none');
    });

    it('regime flip (deep → high) passes through when user ceiling is high', () => {
      expect(resolveScoutReasoningLevel('deep', 'high', true)).toBe('high');
    });

    it('regime flip (deep) capped to low when user ceiling is low', () => {
      expect(resolveScoutReasoningLevel('deep', 'low', true)).toBe('low');
    });
  });

  describe('adaptive OFF — direct level, no ceiling', () => {
    it('returns user level directly for all system levels', () => {
      // Adaptive off: ceiling is never applied — user level is used as-is
      expect(resolveScoutReasoningLevel('deep', 'none', false)).toBe('none');
      expect(resolveScoutReasoningLevel('deep', 'low', false)).toBe('low');
      expect(resolveScoutReasoningLevel('deep', 'medium', false)).toBe('medium');
      expect(resolveScoutReasoningLevel('deep', 'high', false)).toBe('high');

      // Same user level returned regardless of system thinking
      expect(resolveScoutReasoningLevel('none', 'medium', false)).toBe('medium');
      expect(resolveScoutReasoningLevel('light', 'medium', false)).toBe('medium');
      expect(resolveScoutReasoningLevel('deep', 'medium', false)).toBe('medium');
    });

    it('regime flip does NOT escalate when adaptive is off', () => {
      // With adaptive off, system should NOT escalate — user's level is used directly
      expect(resolveScoutReasoningLevel('deep', 'none', false)).toBe('none');
      expect(resolveScoutReasoningLevel('deep', 'low', false)).toBe('low');
    });
  });
});

// ── Adaptive reasoning toggle: resolveJudgeThinkingLevel ────────────────────

describe('resolveJudgeThinkingLevel', () => {
  describe('adaptive ON (default) — ceiling applied', () => {
    it('passes system level through when under user ceiling', () => {
      expect(resolveJudgeThinkingLevel('none', 'high', true)).toBe('none');
      expect(resolveJudgeThinkingLevel('light', 'medium', true)).toBe('light');
      expect(resolveJudgeThinkingLevel('light', 'high', true)).toBe('light');
    });

    it('caps system level when it exceeds user ceiling', () => {
      expect(resolveJudgeThinkingLevel('deep', 'none', true)).toBe('none');
      expect(resolveJudgeThinkingLevel('deep', 'low', true)).toBe('light');
      expect(resolveJudgeThinkingLevel('light', 'none', true)).toBe('none');
    });

    it('preserves existing applyReasoningCeiling behavior', () => {
      // These should match what applyReasoningCeiling returns directly
      expect(resolveJudgeThinkingLevel('deep', 'high', true)).toBe('deep');
      expect(resolveJudgeThinkingLevel('deep', 'medium', true)).toBe('deep');
      expect(resolveJudgeThinkingLevel('none', 'none', true)).toBe('none');
      expect(resolveJudgeThinkingLevel('light', 'low', true)).toBe('light');
    });
  });

  describe('adaptive OFF — direct mapping, no ceiling', () => {
    it('maps user level directly: none → none', () => {
      expect(resolveJudgeThinkingLevel('deep', 'none', false)).toBe('none');
      expect(resolveJudgeThinkingLevel('light', 'none', false)).toBe('none');
      expect(resolveJudgeThinkingLevel('none', 'none', false)).toBe('none');
    });

    it('maps user level directly: low → light', () => {
      expect(resolveJudgeThinkingLevel('deep', 'low', false)).toBe('light');
      expect(resolveJudgeThinkingLevel('light', 'low', false)).toBe('light');
      expect(resolveJudgeThinkingLevel('none', 'low', false)).toBe('light');
    });

    it('maps user level directly: medium → deep', () => {
      expect(resolveJudgeThinkingLevel('deep', 'medium', false)).toBe('deep');
      expect(resolveJudgeThinkingLevel('light', 'medium', false)).toBe('deep');
      expect(resolveJudgeThinkingLevel('none', 'medium', false)).toBe('deep');
    });

    it('maps user level directly: high → deep', () => {
      expect(resolveJudgeThinkingLevel('deep', 'high', false)).toBe('deep');
      expect(resolveJudgeThinkingLevel('light', 'high', false)).toBe('deep');
      expect(resolveJudgeThinkingLevel('none', 'high', false)).toBe('deep');
    });

    it('system thinking (regime flip, drawdown) is ignored when adaptive is off', () => {
      // Regardless of what the system thinks, the user's level maps directly
      expect(resolveJudgeThinkingLevel('deep', 'low', false)).toBe('light');
      expect(resolveJudgeThinkingLevel('deep', 'none', false)).toBe('none');
    });

    it('medium and high both map to deep (existing behavior preserved)', () => {
      expect(resolveJudgeThinkingLevel('none', 'medium', false)).toBe('deep');
      expect(resolveJudgeThinkingLevel('none', 'high', false)).toBe('deep');
    });
  });
});
