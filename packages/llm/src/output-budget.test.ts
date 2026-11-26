import { describe, expect, it } from 'vitest';
import { isOutputLimitFinishReason, lowerReasoningLevel, resolveLlmCallOutputBudget, resolveModelMaxOutputTokens, scaleTimeoutForOutput, type OutputBudgetConfig } from './output-budget.js';

const config: OutputBudgetConfig = {
  timeoutMsPerOutputToken: 6,
  maxCallTimeoutMs: 600_000,
  defaultMaxOutputTokens: 32_000,
  maxOutputTokensByModel: {
    'claude-opus-4': 32_000,
    'claude-opus-4-5': 64_000,
    'claude-sonnet-4-5': 64_000,
    'claude-haiku-3-5': 8_192,
    // Non-Claude models use a token thinking budget (`reasoning.max_tokens`).
    'acme-reasoner': 32_000,
    'acme-mini': 8_192,
  },
};
const thinking = { lightBudgetTokens: 4_096, deepBudgetTokens: 20_480 };
// Bold style: light 8,192, deep 32,768 (medium = 20,480).
const boldThinking = { lightBudgetTokens: 8_192, deepBudgetTokens: 32_768 };

describe('resolveModelMaxOutputTokens', () => {
  it('uses the table entry for a known model, with or without a provider prefix', () => {
    expect(resolveModelMaxOutputTokens('anthropic/claude-sonnet-4-5', config)).toBe(64_000);
    expect(resolveModelMaxOutputTokens('claude-sonnet-4-5-20250929', config)).toBe(64_000);
  });

  it('matches a dotted model ID to a dashed key', () => {
    expect(resolveModelMaxOutputTokens('anthropic/claude-sonnet-4.5', config)).toBe(64_000);
  });

  it('matches a dashed model ID to a dotted key', () => {
    const dottedKey = { defaultMaxOutputTokens: 32_000, maxOutputTokensByModel: { 'claude-sonnet-4.5': 64_000 } };
    expect(resolveModelMaxOutputTokens('anthropic/claude-sonnet-4-5', dottedKey)).toBe(64_000);
    expect(resolveModelMaxOutputTokens('claude-sonnet-4.5', dottedKey)).toBe(64_000);
  });

  it('prefers the most specific matching key', () => {
    expect(resolveModelMaxOutputTokens('claude-opus-4-5', config)).toBe(64_000);
    expect(resolveModelMaxOutputTokens('claude-opus-4-20250514', config)).toBe(32_000);
  });

  it('matches a key only up to a separator or the end of the model ID', () => {
    const table = { defaultMaxOutputTokens: 32_000, maxOutputTokensByModel: { 'gpt-4': 8_192 } };
    expect(resolveModelMaxOutputTokens('openai/gpt-4o', table)).toBe(32_000);
    expect(resolveModelMaxOutputTokens('openai/gpt-4', table)).toBe(8_192);
    expect(resolveModelMaxOutputTokens('gpt-4:extended', table)).toBe(8_192);
    expect(resolveModelMaxOutputTokens('gpt-4@2024', table)).toBe(8_192);
  });

  it('matches a key only from the start of the model ID or after a separator', () => {
    const table = { defaultMaxOutputTokens: 32_000, maxOutputTokensByModel: { 'gpt-4': 8_192 } };
    expect(resolveModelMaxOutputTokens('chatgpt-4', table)).toBe(32_000);
    expect(resolveModelMaxOutputTokens('openai/gpt-4', table)).toBe(8_192);
    expect(resolveModelMaxOutputTokens('ft:gpt-4', table)).toBe(8_192);
    expect(resolveModelMaxOutputTokens('my@gpt-4', table)).toBe(8_192);
    expect(resolveModelMaxOutputTokens('org-gpt-4', table)).toBe(8_192);
  });

  it('picks the right Claude 3 entry when keys share a prefix', () => {
    const table = {
      defaultMaxOutputTokens: 32_000,
      maxOutputTokensByModel: {
        'claude-3-haiku': 4_096,
        'claude-3-opus': 4_096,
        'claude-3-5-haiku': 8_192,
        'claude-3-5-sonnet': 8_192,
        'claude-3-7-sonnet': 64_000,
      },
    };
    expect(resolveModelMaxOutputTokens('anthropic/claude-3.5-sonnet', table)).toBe(8_192);
    expect(resolveModelMaxOutputTokens('claude-3-7-sonnet-20250219', table)).toBe(64_000);
    expect(resolveModelMaxOutputTokens('anthropic/claude-3-opus', table)).toBe(4_096);
    expect(resolveModelMaxOutputTokens('claude-3-haiku-20240307', table)).toBe(4_096);
    expect(resolveModelMaxOutputTokens('anthropic/claude-3.5-haiku', table)).toBe(8_192);
  });

  it('uses the default for an unknown model', () => {
    expect(resolveModelMaxOutputTokens('qwen3.6:35b-a3b-q4_K_M', config)).toBe(32_000);
  });
});

describe('scaleTimeoutForOutput', () => {
  it('scales the timeout with the output limit', () => {
    expect(scaleTimeoutForOutput(60_000, 49_152, 6, 600_000)).toBe(294_912);
  });

  it('never goes below the base timeout', () => {
    expect(scaleTimeoutForOutput(60_000, 4_096, 6, 600_000)).toBe(60_000);
  });

  it('keeps the base timeout when scaling is off', () => {
    expect(scaleTimeoutForOutput(60_000, 49_152, 0, 600_000)).toBe(60_000);
  });

  it('caps the scaled timeout at the maximum call timeout', () => {
    expect(scaleTimeoutForOutput(60_000, 65_536, 60, 600_000)).toBe(600_000);
  });

  it('falls back to the default base timeout when the base is not a positive finite number', () => {
    expect(scaleTimeoutForOutput(Number.NaN, 4_096, 6, 600_000)).toBe(60_000);
    expect(scaleTimeoutForOutput(Number.POSITIVE_INFINITY, 49_152, 6, 600_000)).toBe(294_912);
    expect(scaleTimeoutForOutput(0, 4_096, 6, 600_000)).toBe(60_000);
  });
});

describe('resolveLlmCallOutputBudget', () => {
  const base = { thinking, baseTimeoutMs: 60_000, config, outputReserveTokens: 16_384 };

  it('keeps a limit within the model maximum and scales the timeout with it', () => {
    const budget = resolveLlmCallOutputBudget({ ...base, model: 'anthropic/claude-sonnet-4-5', maxTokens: 36_864, reasoningLevel: 'high' });
    expect(budget).toEqual({ maxTokens: 36_864, timeoutMs: 36_864 * 6, reasoningLevel: 'high' });
  });

  it('clamps a limit above the model maximum and scales the timeout with the clamped limit', () => {
    const budget = resolveLlmCallOutputBudget({ ...base, model: 'acme-reasoner', maxTokens: 49_152, reasoningLevel: 'low' });
    expect(budget.maxTokens).toBe(32_000);
    expect(budget.clampedFrom).toBe(49_152);
    expect(budget.timeoutMs).toBe(32_000 * 6);
    expect(budget.reasoningLevel).toBe('low');
    expect(budget.reasoningLoweredFrom).toBeUndefined();
  });

  it('lowers the reasoning level one step when that is enough to leave the reserve after thinking', () => {
    const budget = resolveLlmCallOutputBudget({ ...base, model: 'acme-reasoner', maxTokens: 49_152, reasoningLevel: 'high' });
    // high: 20,480 + 16,384 > 32,000; medium: 12,288 + 16,384 <= 32,000
    expect(budget.maxTokens).toBe(32_000);
    expect(budget.reasoningLevel).toBe('medium');
    expect(budget.reasoningLoweredFrom).toBe('high');
    expect(budget.reserveUnmet).toBeUndefined();
  });

  it('keeps lowering the reasoning level until the clamped limit leaves the reserve (bold judge)', () => {
    const budget = resolveLlmCallOutputBudget({
      ...base,
      thinking: boldThinking,
      model: 'acme-reasoner',
      maxTokens: 49_152,
      reasoningLevel: 'high',
    });
    // high: 32,768 + 16,384 > 32,000; medium: 20,480 + 16,384 > 32,000; low: 8,192 + 16,384 <= 32,000
    expect(budget.maxTokens).toBe(32_000);
    expect(budget.clampedFrom).toBe(49_152);
    expect(budget.reasoningLevel).toBe('low');
    expect(budget.reasoningLoweredFrom).toBe('high');
    expect(budget.reserveUnmet).toBeUndefined();
  });

  it('stops at none and reports the unmet reserve when even no thinking leaves too little room', () => {
    const budget = resolveLlmCallOutputBudget({ ...base, model: 'acme-mini', maxTokens: 36_864, reasoningLevel: 'high' });
    // 8,192 < reserve 16,384 at every level
    expect(budget.maxTokens).toBe(8_192);
    expect(budget.reasoningLevel).toBe('none');
    expect(budget.reasoningLoweredFrom).toBe('high');
    expect(budget.reserveUnmet).toBe(true);
  });

  it('lowers the reasoning level of an unclamped call whose level needs more thinking than the limit leaves room for', () => {
    // Scout at 'high' with a limit sized for light thinking: 20,480 + 4,096 > 8,192; medium: 12,288 + 4,096 > 8,192
    const budget = resolveLlmCallOutputBudget({
      ...base,
      outputReserveTokens: 4_096,
      model: 'acme-reasoner',
      maxTokens: 8_192,
      reasoningLevel: 'high',
    });
    expect(budget.clampedFrom).toBeUndefined();
    expect(budget.maxTokens).toBe(8_192);
    expect(budget.reasoningLevel).toBe('low');
    expect(budget.reasoningLoweredFrom).toBe('high');
  });

  it('keeps the level of an effort-based model, which is not bound by the thinking budget', () => {
    const clamped = resolveLlmCallOutputBudget({
      ...base,
      thinking: boldThinking,
      model: 'claude-opus-4-1',
      maxTokens: 49_152,
      reasoningLevel: 'high',
    });
    expect(clamped.maxTokens).toBe(32_000);
    expect(clamped.clampedFrom).toBe(49_152);
    expect(clamped.reasoningLevel).toBe('high');
    expect(clamped.reasoningLoweredFrom).toBeUndefined();

    const unclamped = resolveLlmCallOutputBudget({ ...base, model: 'claude-opus-4-1', maxTokens: 8_192, reasoningLevel: 'high' });
    expect(unclamped.reasoningLevel).toBe('high');
    expect(unclamped.clampedFrom).toBeUndefined();
  });

  it('keeps the level when the limit already leaves the reserve after thinking', () => {
    const budget = resolveLlmCallOutputBudget({ ...base, model: 'acme-reasoner', maxTokens: 32_000, reasoningLevel: 'medium' });
    expect(budget).toEqual({ maxTokens: 32_000, timeoutMs: 32_000 * 6, reasoningLevel: 'medium' });
  });
});

describe('lowerReasoningLevel', () => {
  it('steps one level down and stays at none', () => {
    expect(lowerReasoningLevel('high')).toBe('medium');
    expect(lowerReasoningLevel('medium')).toBe('low');
    expect(lowerReasoningLevel('low')).toBe('none');
    expect(lowerReasoningLevel('none')).toBe('none');
  });
});

describe('isOutputLimitFinishReason', () => {
  it('recognises the output-limit finish reasons of both API formats', () => {
    expect(isOutputLimitFinishReason('length')).toBe(true);
    expect(isOutputLimitFinishReason('max_tokens')).toBe(true);
  });

  it('rejects other or missing finish reasons', () => {
    expect(isOutputLimitFinishReason('stop')).toBe(false);
    expect(isOutputLimitFinishReason('tool_calls')).toBe(false);
    expect(isOutputLimitFinishReason(undefined)).toBe(false);
  });
});
