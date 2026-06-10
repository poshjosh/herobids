import { describe, expect, it } from 'vitest';
import { resolveEffectiveLlmSelection } from './llm-selection.js';

const DEFAULT_SCOUT_MODELS = {
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-3-5-haiku-latest',
  openrouter: 'openai/gpt-4.1-mini',
};

describe('resolveEffectiveLlmSelection', () => {
  it('prefers agent overrides over user defaults and operator fallback', () => {
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
      operatorProvider: 'openrouter',
      operatorHeavyModel: 'openai/gpt-4.1',
      defaultScoutModels: DEFAULT_SCOUT_MODELS,
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
      operatorProvider: 'anthropic',
      operatorHeavyModel: 'claude-sonnet-4-5',
      defaultScoutModels: DEFAULT_SCOUT_MODELS,
    });

    expect(resolved).toEqual({
      provider: 'openai',
      lightModel: 'gpt-4.1-mini',
      heavyModel: 'gpt-4.1',
    });
  });

  it('falls back to the operator heavy model when heavyModel is unset on agent and user defaults', () => {
    const resolved = resolveEffectiveLlmSelection({
      agentConfig: {
        userModelDefaults: {
          provider: 'openai',
          lightModel: 'gpt-4.1-mini',
          heavyModel: null,
        },
      },
      operatorProvider: 'openai',
      operatorHeavyModel: 'gpt-4.1',
      defaultScoutModels: DEFAULT_SCOUT_MODELS,
    });

    expect(resolved).toEqual({
      provider: 'openai',
      lightModel: 'gpt-4.1-mini',
      heavyModel: 'gpt-4.1',
    });
  });
});