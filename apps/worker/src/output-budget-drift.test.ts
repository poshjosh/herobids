import { describe, expect, it } from 'vitest';
import { AGENT_STYLE_RUNTIME_DEFAULTS, resolveMediumThinkingTokens } from '@herobids/domain';
import { resolveReasoningBudgetTokens } from '@herobids/llm';
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
});
