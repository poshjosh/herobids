import { describe, expect, it } from 'vitest';
import { buildScoutSystemPrompt, parseScoutDecision, resolveDefaultScoutModel } from './scout-dispatch.js';

describe('resolveDefaultScoutModel', () => {
  it('maps providers to cheaper scout defaults', () => {
    expect(resolveDefaultScoutModel('anthropic', 'claude-sonnet')).toBe('claude-3-5-haiku-latest');
    expect(resolveDefaultScoutModel('openai', 'gpt-4.1')).toBe('gpt-4.1-mini');
    expect(resolveDefaultScoutModel('ollama', 'local-model')).toBe('local-model');
  });
});

describe('buildScoutSystemPrompt', () => {
  it('renders a compact scout instruction block', () => {
    const prompt = buildScoutSystemPrompt({
      agentId: 'agent-1',
      goal: 'Trade carefully',
      readOnlyTools: ['check_regime', 'search_tokens'],
    });

    expect(prompt).toContain('Visible read-only tools: check_regime, search_tokens.');
    expect(prompt).toContain('Use tools only when they help decide hold versus escalate.');
    expect(prompt).toContain('Respond with JSON only');
  });
});

describe('parseScoutDecision', () => {
  it('parses structured hold decisions', () => {
    expect(parseScoutDecision('{"disposition":"hold","reason":"no setup"}')).toEqual({
      disposition: 'hold',
      reason: 'no setup',
    });
  });

  it('falls back to escalate when the response mentions escalation', () => {
    expect(parseScoutDecision('escalate because momentum changed')).toEqual({
      disposition: 'escalate',
      reason: 'escalate because momentum changed',
    });
  });
});