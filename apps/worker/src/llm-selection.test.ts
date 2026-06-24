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
