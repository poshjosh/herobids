import { describe, expect, it } from 'vitest';
import { resolveEffectiveLlmSelection } from './llm-selection.js';

describe('resolveEffectiveLlmSelection', () => {
  it('prefers agent config over user defaults', () => {
    const resolved = resolveEffectiveLlmSelection({
      agentConfig: {
        provider: 'anthropic',
        lightModel: 'claude-haiku-3-5',
        heavyModel: 'claude-sonnet-4-5',
        userModelDefaults: {
          provider: 'openai',
          lightModel: 'gpt-4.1-mini',
          heavyModel: 'gpt-4.1',
        },
      },
    });

    expect(resolved).toEqual({
      provider: 'anthropic',
      lightModel: 'claude-haiku-3-5',
      heavyModel: 'claude-sonnet-4-5',
    });
  });

  it('uses user defaults when the agent has no explicit override', () => {
    const resolved = resolveEffectiveLlmSelection({
      agentConfig: {
        userModelDefaults: {
          provider: 'openai',
          lightModel: 'gpt-4.1-mini',
          heavyModel: 'gpt-4.1',
        },
      },
    });

    expect(resolved).toEqual({
      provider: 'openai',
      lightModel: 'gpt-4.1-mini',
      heavyModel: 'gpt-4.1',
    });
  });

  it('returns null fields when neither agent config nor user defaults specify a value', () => {
    const resolved = resolveEffectiveLlmSelection({
      agentConfig: {},
    });

    expect(resolved).toEqual({
      provider: null,
      lightModel: null,
      heavyModel: null,
    });
  });

  it('treats empty strings as absent and falls through to user defaults', () => {
    const resolved = resolveEffectiveLlmSelection({
      agentConfig: {
        provider: '',
        lightModel: '',
        heavyModel: '',
        userModelDefaults: {
          provider: 'openai',
          lightModel: 'gpt-4.1-mini',
          heavyModel: 'gpt-4.1',
        },
      },
    });

    expect(resolved).toEqual({
      provider: 'openai',
      lightModel: 'gpt-4.1-mini',
      heavyModel: 'gpt-4.1',
    });
  });

  it('returns null when user defaults are null', () => {
    const resolved = resolveEffectiveLlmSelection({
      agentConfig: {
        userModelDefaults: null,
      },
    });

    expect(resolved).toEqual({
      provider: null,
      lightModel: null,
      heavyModel: null,
    });
  });

  it('mixes agent and user defaults per field', () => {
    const resolved = resolveEffectiveLlmSelection({
      agentConfig: {
        provider: 'anthropic',
        userModelDefaults: {
          provider: 'openai',
          lightModel: 'gpt-4.1-mini',
          heavyModel: 'gpt-4.1',
        },
      },
    });

    expect(resolved).toEqual({
      provider: 'anthropic',
      lightModel: 'gpt-4.1-mini',
      heavyModel: 'gpt-4.1',
    });
  });
});

describe('resolveEffectiveLlmSelection — operator defaults tier', () => {
  it('uses operator defaults when both agent and user have no selection', () => {
    const resolved = resolveEffectiveLlmSelection({
      agentConfig: {
        operatorModelDefaults: {
          provider: 'ollama',
          lightModel: 'qwen3:8b',
          heavyModel: 'qwen3.6:35b',
        },
      },
    });

    expect(resolved).toEqual({
      provider: 'ollama',
      lightModel: 'qwen3:8b',
      heavyModel: 'qwen3.6:35b',
    });
  });

  it('user defaults take precedence over operator defaults', () => {
    const resolved = resolveEffectiveLlmSelection({
      agentConfig: {
        userModelDefaults: {
          provider: 'openai',
          lightModel: 'gpt-4.1-mini',
          heavyModel: 'gpt-4.1',
        },
        operatorModelDefaults: {
          provider: 'ollama',
          lightModel: 'qwen3:8b',
          heavyModel: 'qwen3.6:35b',
        },
      },
    });

    expect(resolved).toEqual({
      provider: 'openai',
      lightModel: 'gpt-4.1-mini',
      heavyModel: 'gpt-4.1',
    });
  });

  it('agent config takes precedence over both user and operator defaults', () => {
    const resolved = resolveEffectiveLlmSelection({
      agentConfig: {
        provider: 'anthropic',
        lightModel: 'claude-haiku-3-5',
        heavyModel: 'claude-sonnet-4-5',
        userModelDefaults: {
          provider: 'openai',
          lightModel: 'gpt-4.1-mini',
          heavyModel: 'gpt-4.1',
        },
        operatorModelDefaults: {
          provider: 'ollama',
          lightModel: 'qwen3:8b',
          heavyModel: 'qwen3.6:35b',
        },
      },
    });

    expect(resolved).toEqual({
      provider: 'anthropic',
      lightModel: 'claude-haiku-3-5',
      heavyModel: 'claude-sonnet-4-5',
    });
  });

  it('mixes tiers per field: agent provider, operator models', () => {
    const resolved = resolveEffectiveLlmSelection({
      agentConfig: {
        provider: 'anthropic',
        operatorModelDefaults: {
          provider: 'ollama',
          lightModel: 'qwen3:8b',
          heavyModel: 'qwen3.6:35b',
        },
      },
    });

    expect(resolved).toEqual({
      provider: 'anthropic',
      lightModel: 'qwen3:8b',
      heavyModel: 'qwen3.6:35b',
    });
  });

  it('null or undefined operatorModelDefaults does not break existing behavior', () => {
    const withNull = resolveEffectiveLlmSelection({
      agentConfig: {
        userModelDefaults: {
          provider: 'openai',
          lightModel: 'gpt-4.1-mini',
          heavyModel: 'gpt-4.1',
        },
        operatorModelDefaults: null,
      },
    });

    const withUndefined = resolveEffectiveLlmSelection({
      agentConfig: {
        userModelDefaults: {
          provider: 'openai',
          lightModel: 'gpt-4.1-mini',
          heavyModel: 'gpt-4.1',
        },
      },
    });

    expect(withNull).toEqual(withUndefined);
    expect(withNull).toEqual({
      provider: 'openai',
      lightModel: 'gpt-4.1-mini',
      heavyModel: 'gpt-4.1',
    });
  });
});
