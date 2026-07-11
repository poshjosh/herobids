/**
 * Runtime policy propagation integration tests
 *
 * Verifies that per-agent runtime policy (style + overrides) resolves correctly
 * and that all style defaults are within operator ceilings.
 *
 * Pure tests — no DB/Redis required. These validate the resolution function
 * and constant data that the API, session manager, and agent container all depend on.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveAgentRuntimePolicy,
  AgentRuntimePolicyOverridesSchema,
  AgentStyleSchema,
  AGENT_STYLE_RUNTIME_DEFAULTS,
  RUNTIME_POLICY_CEILINGS,
  type AgentStyleValue,
} from './schema.js';

// ── Style resolution ────────────────────────────────────────────────────────

describe('resolveAgentRuntimePolicy', () => {
  it('resolves bold style with no overrides', () => {
    const policy = resolveAgentRuntimePolicy('bold', null);
    expect(policy.scoutMaxTurns).toBe(100);
    expect(policy.judgeMaxTurns).toBe(300);
    expect(policy.scoutMaxTokens).toBe(2048);
    expect(policy.judgeMaxTokens).toBe(8192);
    expect(policy.lightThinkingTokens).toBe(4096);
    expect(policy.deepThinkingTokens).toBe(20480);
    expect(policy.maxHistoryTokens).toBe(80000);
    expect(policy.maxHistoryMessages).toBe(40);
    expect(policy.maxRecentToolMessages).toBe(12);
    expect(policy.maxToolResultChars).toBe(8000);
    expect(policy.maxVisibleToolSchemas).toBe(128);
    expect(policy.maxContextBlockChars).toBe(8000);
    expect(policy.toolResultFullRetentionTurns).toBe(5);
    expect(policy.toolResultMaxStaleChars).toBe(1000);
    expect(policy.allowedHoursUtc).toEqual([]);
    expect(policy.weekendPause).toBe(false);
    expect(policy.maxHoldDurationMs).toBe(600_000);  // bold: 1 × tick interval
  });

  it('resolves careful style with no overrides', () => {
    const policy = resolveAgentRuntimePolicy('careful', null);
    expect(policy.scoutMaxTurns).toBe(10);
    expect(policy.judgeMaxTurns).toBe(25);
    expect(policy.scoutMaxTokens).toBe(512);
    expect(policy.judgeMaxTokens).toBe(2048);
    expect(policy.lightThinkingTokens).toBe(1024);
    expect(policy.deepThinkingTokens).toBe(4096);
    expect(policy.maxHistoryTokens).toBe(20000);
    expect(policy.maxHistoryMessages).toBe(10);
    expect(policy.allowedHoursUtc).toEqual([14, 15, 16, 17, 18, 19, 20]);
    expect(policy.weekendPause).toBe(false);
    expect(policy.maxHoldDurationMs).toBe(27_000_000);  // careful: 5 × tick interval
  });

  it('resolves balanced style with no overrides', () => {
    const policy = resolveAgentRuntimePolicy('balanced', null);
    expect(policy.scoutMaxTurns).toBe(30);
    expect(policy.judgeMaxTurns).toBe(75);
    expect(policy.scoutMaxTokens).toBe(1024);
    expect(policy.judgeMaxTokens).toBe(4096);
    expect(policy.maxHistoryTokens).toBe(40000);
    expect(policy.maxHistoryMessages).toBe(20);
    expect(policy.allowedHoursUtc).toEqual([]);
    expect(policy.weekendPause).toBe(false);
    expect(policy.maxHoldDurationMs).toBe(5_400_000);  // balanced: 3 × tick interval
  });

  it('falls back to balanced when style is undefined', () => {
    const policy = resolveAgentRuntimePolicy(undefined, null);
    expect(policy.scoutMaxTurns).toBe(30);
  });

  it('falls back to balanced when style is null', () => {
    const policy = resolveAgentRuntimePolicy(null, null);
    expect(policy.scoutMaxTurns).toBe(30);
  });

  it('falls back to balanced when style is invalid', () => {
    const policy = resolveAgentRuntimePolicy('aggressive', null);
    expect(policy.scoutMaxTurns).toBe(30);
  });

  it('falls back to balanced when style is empty string', () => {
    const policy = resolveAgentRuntimePolicy('', null);
    expect(policy.scoutMaxTurns).toBe(30);
  });
});

// ── Override merging ────────────────────────────────────────────────────────

describe('runtime policy override merging', () => {
  it('single override wins over style default', () => {
    const policy = resolveAgentRuntimePolicy('bold', { scoutMaxTurns: 25 });
    expect(policy.scoutMaxTurns).toBe(25); // override
    expect(policy.judgeMaxTurns).toBe(300); // bold default preserved
  });

  it('multiple overrides all win', () => {
    const policy = resolveAgentRuntimePolicy('balanced', {
      scoutMaxTurns: 15,
      maxHistoryTokens: 10000,
      weekendPause: false,
    });
    expect(policy.scoutMaxTurns).toBe(15);
    expect(policy.maxHistoryTokens).toBe(10000);
    expect(policy.weekendPause).toBe(false);
    // balanced defaults for non-overridden fields
    expect(policy.judgeMaxTurns).toBe(75);
    expect(policy.maxHistoryMessages).toBe(20);
  });

  it('overrides can tighten careful defaults further', () => {
    const policy = resolveAgentRuntimePolicy('careful', {
      scoutMaxTurns: 5,
      maxHistoryTokens: 5000,
    });
    expect(policy.scoutMaxTurns).toBe(5);
    expect(policy.maxHistoryTokens).toBe(5000);
    expect(policy.weekendPause).toBe(false);
    expect(policy.allowedHoursUtc).toEqual([14, 15, 16, 17, 18, 19, 20]);
  });

  it('empty overrides object leaves all style defaults intact', () => {
    const policy = resolveAgentRuntimePolicy('careful', {});
    expect(policy.scoutMaxTurns).toBe(10);
    expect(policy.maxHoldDurationMs).toBe(27_000_000);  // careful: 5 × tick interval
    expect(policy.allowedHoursUtc).toEqual([14, 15, 16, 17, 18, 19, 20]);
  });

  it('override to zero maxHoldDurationMs disables forced escalation', () => {
    const policy = resolveAgentRuntimePolicy('bold', { maxHoldDurationMs: 0 });
    expect(policy.maxHoldDurationMs).toBe(0);
  });

  it('trading hours override replaces entirely', () => {
    const policy = resolveAgentRuntimePolicy('careful', {
      allowedHoursUtc: [8, 9, 10],
      weekendPause: false,
    });
    expect(policy.allowedHoursUtc).toEqual([8, 9, 10]);
    expect(policy.weekendPause).toBe(false);
  });
});

// ── Operator ceilings ───────────────────────────────────────────────────────

describe('operator ceilings', () => {
  it('every style default is within its ceiling', () => {
    const styles: AgentStyleValue[] = ['careful', 'balanced', 'bold'];
    for (const style of styles) {
      const d = AGENT_STYLE_RUNTIME_DEFAULTS[style];
      expect(d.scoutMaxTurns).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.scoutMaxTurns);
      expect(d.judgeMaxTurns).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.judgeMaxTurns);
      expect(d.scoutMaxTokens).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.scoutMaxTokens);
      expect(d.judgeMaxTokens).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.judgeMaxTokens);
      expect(d.lightThinkingTokens).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.lightThinkingTokens);
      expect(d.deepThinkingTokens).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.deepThinkingTokens);
      expect(d.maxHistoryMessages).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.maxHistoryMessages);
      expect(d.maxHistoryTokens).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.maxHistoryTokens);
      expect(d.maxRecentToolMessages).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.maxRecentToolMessages);
      expect(d.maxToolResultChars).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.maxToolResultChars);
      expect(d.maxVisibleToolSchemas).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.maxVisibleToolSchemas);
      expect(d.maxContextBlockChars).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.maxContextBlockChars);
      expect(d.toolResultFullRetentionTurns).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.toolResultFullRetentionTurns);
      expect(d.toolResultMaxStaleChars).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.toolResultMaxStaleChars);
      expect(d.maxHoldDurationMs).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.maxHoldDurationMs);
    }
  });
});

// ── Schema validation ───────────────────────────────────────────────────────

describe('AgentRuntimePolicyOverridesSchema', () => {
  it('accepts overrides at operator ceiling', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      scoutMaxTurns: RUNTIME_POLICY_CEILINGS.scoutMaxTurns,
      judgeMaxTurns: RUNTIME_POLICY_CEILINGS.judgeMaxTurns,
    });
    expect(result.success).toBe(true);
  });

  it('rejects scoutMaxTurns one above ceiling', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      scoutMaxTurns: RUNTIME_POLICY_CEILINGS.scoutMaxTurns + 1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts null for any field (reset to default)', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      scoutMaxTurns: null,
      maxHoldDurationMs: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scoutMaxTurns).toBeNull();
      expect(result.data.maxHoldDurationMs).toBeNull();
    }
  });

  it('accepts weekendPause boolean override', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({ weekendPause: true });
    expect(result.success).toBe(true);
  });

  it('accepts allowedHoursUtc array override', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      allowedHoursUtc: [0, 12, 23],
    });
    expect(result.success).toBe(true);
  });

  it('rejects allowedHoursUtc with out-of-range hour', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      allowedHoursUtc: [24],
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxHistoryTokens at ceiling + 1', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      maxHistoryTokens: RUNTIME_POLICY_CEILINGS.maxHistoryTokens + 1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts maxHistoryTokens at exactly the ceiling', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      maxHistoryTokens: RUNTIME_POLICY_CEILINGS.maxHistoryTokens,
    });
    expect(result.success).toBe(true);
  });
});

// ── Style schema ─────────────────────────────────────────────────────────────

describe('AgentStyleSchema', () => {
  it('accepts all three valid styles', () => {
    expect(AgentStyleSchema.safeParse('careful').success).toBe(true);
    expect(AgentStyleSchema.safeParse('balanced').success).toBe(true);
    expect(AgentStyleSchema.safeParse('bold').success).toBe(true);
  });

  it('rejects unknown styles', () => {
    expect(AgentStyleSchema.safeParse('aggressive').success).toBe(false);
    expect(AgentStyleSchema.safeParse('risky').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(AgentStyleSchema.safeParse('').success).toBe(false);
  });
});

// ── Cross-style consistency ──────────────────────────────────────────────────

describe('style consistency', () => {
  it('careful ≤ balanced ≤ bold for all numeric fields', () => {
    const c = AGENT_STYLE_RUNTIME_DEFAULTS.careful;
    const b = AGENT_STYLE_RUNTIME_DEFAULTS.balanced;
    const o = AGENT_STYLE_RUNTIME_DEFAULTS.bold;

    expect(c.scoutMaxTurns).toBeLessThanOrEqual(b.scoutMaxTurns);
    expect(b.scoutMaxTurns).toBeLessThanOrEqual(o.scoutMaxTurns);
    expect(c.judgeMaxTurns).toBeLessThanOrEqual(b.judgeMaxTurns);
    expect(b.judgeMaxTurns).toBeLessThanOrEqual(o.judgeMaxTurns);

    expect(c.scoutMaxTokens).toBeLessThanOrEqual(b.scoutMaxTokens);
    expect(b.scoutMaxTokens).toBeLessThanOrEqual(o.scoutMaxTokens);
    expect(c.judgeMaxTokens).toBeLessThanOrEqual(b.judgeMaxTokens);
    expect(b.judgeMaxTokens).toBeLessThanOrEqual(o.judgeMaxTokens);

    expect(c.maxHistoryMessages).toBeLessThanOrEqual(b.maxHistoryMessages);
    expect(b.maxHistoryMessages).toBeLessThanOrEqual(o.maxHistoryMessages);
    expect(c.maxHistoryTokens).toBeLessThanOrEqual(b.maxHistoryTokens);
    expect(b.maxHistoryTokens).toBeLessThanOrEqual(o.maxHistoryTokens);

    // Scout hold — inverted: bold forces escalation SOONER (lower value)
    expect(o.maxHoldDurationMs).toBeLessThanOrEqual(b.maxHoldDurationMs);
    expect(b.maxHoldDurationMs).toBeLessThanOrEqual(c.maxHoldDurationMs);
  });

  it('cost presets match expected mapping', () => {
    expect(AGENT_STYLE_RUNTIME_DEFAULTS.careful.costPreset).toBe('minimal');
    expect(AGENT_STYLE_RUNTIME_DEFAULTS.balanced.costPreset).toBe('standard');
    expect(AGENT_STYLE_RUNTIME_DEFAULTS.bold.costPreset).toBe('premium');
  });
});

// ── Adaptive reasoning ──────────────────────────────────────────────────────

describe('adaptive reasoning resolution', () => {
  it('resolves balanced style with adaptive defaults (both true)', () => {
    const policy = resolveAgentRuntimePolicy('balanced', null);
    expect(policy.adaptScoutReasoning).toBe(true);
    expect(policy.adaptJudgeReasoning).toBe(true);
  });

  it('resolves careful style with adaptive defaults (both true)', () => {
    const policy = resolveAgentRuntimePolicy('careful', null);
    expect(policy.adaptScoutReasoning).toBe(true);
    expect(policy.adaptJudgeReasoning).toBe(true);
  });

  it('resolves bold style with adaptive defaults (both true)', () => {
    const policy = resolveAgentRuntimePolicy('bold', null);
    expect(policy.adaptScoutReasoning).toBe(true);
    expect(policy.adaptJudgeReasoning).toBe(true);
  });

  it('overrides can set adaptive flags to false', () => {
    const policy = resolveAgentRuntimePolicy('bold', {
      adaptScoutReasoning: false,
      adaptJudgeReasoning: false,
    });
    expect(policy.adaptScoutReasoning).toBe(false);
    expect(policy.adaptJudgeReasoning).toBe(false);
  });

  it('partial override: only adaptScoutReasoning set to false', () => {
    const policy = resolveAgentRuntimePolicy('balanced', {
      adaptScoutReasoning: false,
    });
    expect(policy.adaptScoutReasoning).toBe(false);
    expect(policy.adaptJudgeReasoning).toBe(true); // balanced default
  });

  it('null override falls back to style default (true)', () => {
    const policy = resolveAgentRuntimePolicy('bold', {
      adaptScoutReasoning: null,
      adaptJudgeReasoning: null,
    });
    expect(policy.adaptScoutReasoning).toBe(true);
    expect(policy.adaptJudgeReasoning).toBe(true);
  });
});
