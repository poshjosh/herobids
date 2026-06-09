import { describe, expect, it } from 'vitest';
import { buildScoutSystemPrompt, parseScoutDecision, resolveDefaultScoutModel } from './scout-dispatch.js';

const DEFAULTS = { anthropic: 'claude-3-5-haiku-latest', openai: 'gpt-4.1-mini', openrouter: 'openai/gpt-4.1-mini' };

describe('resolveDefaultScoutModel', () => {
  it('maps providers to cheaper scout defaults', () => {
    expect(resolveDefaultScoutModel('anthropic', 'claude-sonnet', DEFAULTS)).toBe('claude-3-5-haiku-latest');
    expect(resolveDefaultScoutModel('openai', 'gpt-4.1', DEFAULTS)).toBe('gpt-4.1-mini');
    expect(resolveDefaultScoutModel('ollama', 'local-model', DEFAULTS)).toBe('local-model');
  });

  describe('defaultModels override parameter', () => {
    it('uses the override model for anthropic when provided', () => {
      expect(resolveDefaultScoutModel('anthropic', 'claude-sonnet', {
        ...DEFAULTS,
        anthropic: 'claude-3-haiku-20240307',
      })).toBe('claude-3-haiku-20240307');
    });

    it('uses the override model for openai when provided', () => {
      expect(resolveDefaultScoutModel('openai', 'gpt-4.1', {
        ...DEFAULTS,
        openai: 'gpt-4o-mini',
      })).toBe('gpt-4o-mini');
    });

    it('uses the override model for openrouter when provided', () => {
      expect(resolveDefaultScoutModel('openrouter', 'openai/gpt-4.1', {
        ...DEFAULTS,
        openrouter: 'anthropic/claude-3-haiku',
      })).toBe('anthropic/claude-3-haiku');
    });

    it('falls back to judgeModel for unknown providers regardless of defaultModels', () => {
      expect(resolveDefaultScoutModel('ollama', 'local-model', {
        ...DEFAULTS,
        anthropic: 'claude-3-haiku-20240307',
        openai: 'gpt-4o-mini',
      })).toBe('local-model');
    });
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