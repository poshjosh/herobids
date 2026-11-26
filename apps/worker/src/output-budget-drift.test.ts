import { describe, expect, it } from 'vitest';
import {
  AGENT_STYLE_RUNTIME_DEFAULTS,
  DEFAULT_MAX_OUTPUT_TOKENS_BY_MODEL,
  findModelMaxOutputTokens,
  resolveMediumThinkingTokens,
} from '@herobids/domain';
import { resolveModelMaxOutputTokens, resolveReasoningBudgetTokens } from '@herobids/llm';
import { PLATFORM_DOCS_INDEX } from './tools/platform-docs-data.js';

const STYLES = ['careful', 'balanced', 'bold'] as const;

describe('output budget drift guards', () => {
  it('sizes the scout rule with the same medium thinking budget the provider sends', () => {
    for (const [light, deep] of [[2_048, 10_240], [4_096, 20_480], [8_192, 32_768], [1_001, 2_000]] as const) {
      expect(resolveMediumThinkingTokens(light, deep)).toBe(
        resolveReasoningBudgetTokens('medium', { lightBudgetTokens: light, deepBudgetTokens: deep }),
      );
    }
  });

  it('documents the style token limits that the code uses', () => {
    const fmt = (n: number) => n.toLocaleString('en-US');
    const docs = PLATFORM_DOCS_INDEX.map((entry) => entry.content).join('\n');
    const row = (label: string, field: 'scoutMaxTokens' | 'judgeMaxTokens') =>
      `| **${label}** | ${STYLES.map((style) => fmt(AGENT_STYLE_RUNTIME_DEFAULTS[style][field])).join(' | ')} |`;
    expect(docs).toContain(row('Scout max tokens', 'scoutMaxTokens'));
    expect(docs).toContain(row('Judge max tokens', 'judgeMaxTokens'));
  });

  it('documents the style reasoning levels that the code uses', () => {
    const docs = PLATFORM_DOCS_INDEX.map((entry) => entry.content).join('\n');
    const label = (level: string) => `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
    const row = (title: string, field: 'scoutReasoning' | 'judgeReasoning') =>
      `| **${title}** | ${STYLES.map((style) => label(AGENT_STYLE_RUNTIME_DEFAULTS[style][field])).join(' | ')} |`;
    expect(docs).toContain(row('Economy (scout) reasoning', 'scoutReasoning'));
    expect(docs).toContain(row('Judge reasoning', 'judgeReasoning'));
  });

  it('finds the same model maximum output on the web as the worker uses', () => {
    const config = { defaultMaxOutputTokens: 1, maxOutputTokensByModel: { ...DEFAULT_MAX_OUTPUT_TOKENS_BY_MODEL } };
    const models = [
      ...Object.keys(DEFAULT_MAX_OUTPUT_TOKENS_BY_MODEL),
      'xiaomi/mimo-v2.6-flash',
      'anthropic/claude-haiku-5.5',
      'anthropic/claude-opus-4',
      'claude-opus-4-20250514',
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o',
      'ft:gpt-4',
      'qwen3:8b',
    ];
    for (const model of models) {
      const webMaxOutputTokens = findModelMaxOutputTokens(model);
      if (webMaxOutputTokens !== undefined) {
        expect(webMaxOutputTokens, model).toBe(resolveModelMaxOutputTokens(model, config));
      }
    }
    expect(findModelMaxOutputTokens('xiaomi/mimo-v2.6-flash')).toBeDefined();
  });
});
