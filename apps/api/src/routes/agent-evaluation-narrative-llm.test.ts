import { describe, it, expect } from 'vitest';
import { resolveNarrativeLlmConfig } from './agent-evaluation-narrative-llm.js';
import type { NarrativeLlmResolutionInput } from './agent-evaluation-narrative-llm.js';
import type { ProvidersYaml } from '@herobids/domain';

const staticProvidersYaml: ProvidersYaml = {
  providers: {
    openai: {
      catalogMode: 'static',
      models: {
        'gpt-4o': { inputUsdPerM: 2.5, outputUsdPerM: 10 },
        'gpt-4o-mini': { inputUsdPerM: 0.15, outputUsdPerM: 0.6 },
      },
    },
    anthropic: {
      catalogMode: 'static',
      models: {
        'claude-haiku-3-5': { inputUsdPerM: 0.8, outputUsdPerM: 4 },
        'claude-sonnet-4-5': { inputUsdPerM: 3, outputUsdPerM: 15 },
      },
    },
  },
};

const dynamicProvidersYaml: ProvidersYaml = {
  providers: {
    openrouter: {
      catalogMode: 'dynamic',
      isMultiProvider: true,
      models: {
        'anthropic/claude-sonnet-4-5': { inputUsdPerM: 3, outputUsdPerM: 15 },
        'openai/gpt-4o': { inputUsdPerM: 2.5, outputUsdPerM: 10 },
      },
    },
    ollama: {
      catalogMode: 'dynamic',
      devOnly: true,
      models: {},
    },
  },
};

function baseInput(overrides: Partial<NarrativeLlmResolutionInput> = {}): NarrativeLlmResolutionInput {
  return {
    agentModelPolicy: {
      provider: 'openai',
      lightModel: 'gpt-4o-mini',
      heavyModel: 'gpt-4o',
      costPreset: 'standard',
    },
    userAiModelConfig: null,
    narrativeLlmOverride: undefined,
    operatorDefaultProvider: 'openai',
    operatorBaseUrl: 'https://api.openai.com/v1',
    operatorTimeoutMs: 30_000,
    operatorMaxTokens: 1024,
    providersYaml: staticProvidersYaml,
    ...overrides,
  };
}

describe('resolveNarrativeLlmConfig', () => {
  // ── Default resolution ─────────────────────────────────────────────────

  it('resolves narrative LLM using agent config when no override is provided', async () => {
    const result = await resolveNarrativeLlmConfig(baseInput());

    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o'); // heavy model from standard preset
    expect(result.baseUrl).toBe('https://api.openai.com/v1');
    expect(result.timeoutMs).toBe(30_000);
    expect(result.maxTokens).toBe(1024);
  });

  it('falls back to user AI settings when agent config is incomplete', async () => {
    const result = await resolveNarrativeLlmConfig(baseInput({
      agentModelPolicy: null,
      userAiModelConfig: {
        provider: 'anthropic',
        lightModel: 'claude-haiku-3-5',
        heavyModel: 'claude-sonnet-4-5',
      },
    }));

    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-5');
  });

  it('cost preset downgrades heavy model to light model on minimal preset', async () => {
    const result = await resolveNarrativeLlmConfig(baseInput({
      agentModelPolicy: {
        provider: 'openai',
        lightModel: 'gpt-4o-mini',
        heavyModel: 'gpt-4o',
        costPreset: 'minimal',
      },
    }));

    expect(result.provider).toBe('openai');
    // minimal preset uses light model as heavy model
    expect(result.model).toBe('gpt-4o-mini');
  });

  // ── Override rules ─────────────────────────────────────────────────────

  it('model-only override keeps the resolved provider and replaces the model', async () => {
    const result = await resolveNarrativeLlmConfig(baseInput({
      narrativeLlmOverride: {
        model: 'gpt-4o-mini',
      },
    }));

    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o-mini');
  });

  it('provider+model override replaces both provider and model', async () => {
    const result = await resolveNarrativeLlmConfig(baseInput({
      narrativeLlmOverride: {
        provider: 'anthropic',
        model: 'claude-haiku-3-5',
      },
    }));

    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-haiku-3-5');
  });

  // ── Validation: invalid overrides ──────────────────────────────────────

  it('rejects when includeNarrative is true but model selection is incomplete', async () => {
    await expect(resolveNarrativeLlmConfig(baseInput({
      agentModelPolicy: null,
      userAiModelConfig: null,
    }))).rejects.toThrow(/incomplete model selection/);
  });

  it('rejects an unknown override provider', async () => {
    await expect(resolveNarrativeLlmConfig(baseInput({
      narrativeLlmOverride: {
        provider: 'nonexistent',
        model: 'some-model',
      },
    }))).rejects.toThrow(/not available on this platform/);
  });

  it('rejects an invalid override model for a static provider', async () => {
    await expect(resolveNarrativeLlmConfig(baseInput({
      narrativeLlmOverride: {
        model: 'nonexistent-model',
      },
    }))).rejects.toThrow(/not available for provider/);
  });

  // ── Dynamic provider validation ─────────────────────────────────────────

  it('validates explicit override model for dynamic providers when catalog deps are provided', async () => {
    // Minimal DB mock that returns no pricing snapshot rows, so getProviderModels
    // falls back to the static seed model list from providersYaml.
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => [],
          }),
        }),
      }),
    };

    const mockCatalogDeps = {
      db: mockDb as never,
      providersYaml: dynamicProvidersYaml,
      context: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4-5',
        baseUrl: undefined,
        catalogTimeoutMs: 3000,
        catalogCacheTtlMs: 86_400_000,
      },
    };

    // Model exists in the static seed list — should resolve
    const result = await resolveNarrativeLlmConfig(baseInput({
      agentModelPolicy: {
        provider: 'openrouter',
        lightModel: 'anthropic/claude-sonnet-4-5',
        heavyModel: 'openai/gpt-4o',
      },
      narrativeLlmOverride: {
        model: 'anthropic/claude-sonnet-4-5',
      },
      providersYaml: dynamicProvidersYaml,
      catalogDeps: mockCatalogDeps,
    }));

    expect(result.provider).toBe('openrouter');
    expect(result.model).toBe('anthropic/claude-sonnet-4-5');
  });

  it('defers dynamic provider validation when catalog deps are absent', async () => {
    // Without catalogDeps, dynamic providers skip model validation.
    // Any model name is accepted (validation happens at runtime in the worker).
    const result = await resolveNarrativeLlmConfig(baseInput({
      agentModelPolicy: {
        provider: 'openrouter',
        lightModel: 'anthropic/claude-sonnet-4-5',
        heavyModel: 'openai/gpt-4o',
      },
      narrativeLlmOverride: {
        model: 'anthropic/claude-sonnet-4-5',
      },
      providersYaml: dynamicProvidersYaml,
      // catalogDeps intentionally omitted
    }));

    expect(result.provider).toBe('openrouter');
    expect(result.model).toBe('anthropic/claude-sonnet-4-5');
  });

  // ── baseUrl derivation ──────────────────────────────────────────────────

  it('sets baseUrl when final provider matches operator default', async () => {
    const result = await resolveNarrativeLlmConfig(baseInput({
      operatorDefaultProvider: 'openai',
      operatorBaseUrl: 'https://custom.openai.com/v1',
    }));

    expect(result.provider).toBe('openai');
    expect(result.baseUrl).toBe('https://custom.openai.com/v1');
  });

  it('leaves baseUrl undefined when final provider differs from operator default', async () => {
    const result = await resolveNarrativeLlmConfig(baseInput({
      agentModelPolicy: {
        provider: 'anthropic',
        lightModel: 'claude-haiku-3-5',
        heavyModel: 'claude-sonnet-4-5',
      },
      operatorDefaultProvider: 'openai',
      operatorBaseUrl: 'https://api.openai.com/v1',
    }));

    expect(result.provider).toBe('anthropic');
    expect(result.baseUrl).toBeUndefined();
  });
});
