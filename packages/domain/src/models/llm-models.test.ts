import { describe, it, expect } from 'vitest';
import {
  getProviderModelIds,
  validateLlmModelSelection,
  getLlmModelPricing,
  getLlmModelRateCardItems,
  normalizePersistedAiModelConfig,
  ModelPricingSchema,
  ProvidersYamlSchema,
  type LlmProviderDefinition,
  type ProviderConfig,
} from './llm-models.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function isLlmProviderDefinition(value: unknown): value is LlmProviderDefinition {
  if (!value || typeof value !== 'object') return false;
  const def = value as Record<string, unknown>;
  return typeof def.id === 'string'
    && typeof def.models === 'object'
    && !Array.isArray(def.models)
    && def.models !== null
    && (def.catalogMode === 'static' || def.catalogMode === 'dynamic');
}

// ── Mock provider configs ───────────────────────────────────────────────────

const staticProviderConfig: ProviderConfig = {
  catalogMode: 'static',
  models: {
    'gpt-4o-mini': { inputUsdPerM: 0.15, outputUsdPerM: 0.6 },
    'gpt-4o': { inputUsdPerM: 2.5, outputUsdPerM: 10 },
  },
};

const dynamicProviderConfig: ProviderConfig = {
  catalogMode: 'dynamic',
  models: {},
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ModelPricingSchema', () => {
  it('accepts valid pricing', () => {
    expect(() =>
      ModelPricingSchema.parse({ inputUsdPerM: 1, outputUsdPerM: 5 }),
    ).not.toThrow();
  });

  it('accepts pricing with optional reasoningUsdPerM', () => {
    expect(() =>
      ModelPricingSchema.parse({ inputUsdPerM: 1, outputUsdPerM: 5, reasoningUsdPerM: 10 }),
    ).not.toThrow();
  });

  it('rejects negative inputUsdPerM', () => {
    expect(() =>
      ModelPricingSchema.parse({ inputUsdPerM: -1, outputUsdPerM: 5 }),
    ).toThrow();
  });

  it('rejects missing outputUsdPerM', () => {
    expect(() =>
      ModelPricingSchema.parse({ inputUsdPerM: 1 }),
    ).toThrow();
  });
});

describe('ProvidersYamlSchema', () => {
  it('accepts valid static provider with full pricing', () => {
    const result = ProvidersYamlSchema.parse({
      providers: {
        test: {
          catalogMode: 'static',
          models: {
            'model-a': { inputUsdPerM: 1, outputUsdPerM: 5 },
            'model-b': { inputUsdPerM: 2, outputUsdPerM: 10 },
          },
        },
      },
    });
    expect(result.providers.test.catalogMode).toBe('static');
  });

  it('accepts static provider with cacheReadUsdPerM and preserves the value', () => {
    const result = ProvidersYamlSchema.parse({
      providers: {
        test: {
          catalogMode: 'static',
          models: {
            'model-a': { inputUsdPerM: 1, outputUsdPerM: 5, cacheReadUsdPerM: 0.1 },
          },
        },
      },
    });
    expect(result.providers.test.models['model-a']?.cacheReadUsdPerM).toBe(0.1);
  });

  it('rejects static provider with missing pricing', () => {
    expect(() =>
      ProvidersYamlSchema.parse({
        providers: {
          test: {
            catalogMode: 'static',
            models: {
              'model-a': { inputUsdPerM: 1 }, // missing outputUsdPerM
            },
          },
        },
      }),
    ).toThrow();
  });

  it('accepts dynamic provider with empty models', () => {
    const result = ProvidersYamlSchema.parse({
      providers: {
        test: {
          catalogMode: 'dynamic',
          models: {},
        },
      },
    });
    expect(result.providers.test.models).toEqual({});
  });

  it('rejects missing catalogMode', () => {
    expect(() =>
      ProvidersYamlSchema.parse({
        providers: {
          test: {
            models: {},
          },
        },
      }),
    ).toThrow();
  });
});

describe('getProviderModelIds', () => {
  it('returns model IDs for valid provider config', () => {
    const ids = getProviderModelIds(staticProviderConfig);
    expect(ids).toEqual(['gpt-4o-mini', 'gpt-4o']);
  });

  it('returns empty array for undefined', () => {
    expect(getProviderModelIds(undefined)).toEqual([]);
  });

  it('returns empty array for empty models', () => {
    const emptyConfig: ProviderConfig = {
      catalogMode: 'static',
      models: {},
    };
    expect(getProviderModelIds(emptyConfig)).toEqual([]);
  });
});

describe('validateLlmModelSelection', () => {
  it('rejects unknown provider', () => {
    const issues = validateLlmModelSelection(
      {
        provider: 'nonexistent',
        lightModel: 'gpt-4o',
        heavyModel: 'gpt-4o',
      },
      undefined,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(['provider']);
  });

  it('rejects unknown model for static provider', () => {
    const issues = validateLlmModelSelection(
      {
        provider: 'openai',
        lightModel: 'unknown-model',
        heavyModel: 'gpt-4o',
      },
      staticProviderConfig,
    );
    const paths = issues.map((i) => i.path.join('.'));
    expect(paths).toContain('lightModel');
  });

  it('accepts valid selection for static provider', () => {
    const issues = validateLlmModelSelection(
      {
        provider: 'openai',
        lightModel: 'gpt-4o-mini',
        heavyModel: 'gpt-4o',
      },
      staticProviderConfig,
    );
    expect(issues).toHaveLength(0);
  });

  it('defers dynamic model validation', () => {
    const issues = validateLlmModelSelection(
      {
        provider: 'ollama',
        lightModel: 'any-custom-model',
        heavyModel: 'another-custom-model',
      },
      dynamicProviderConfig,
    );
    expect(issues).toHaveLength(0);
  });
});

describe('getLlmModelRateCardItems', () => {
  it('generates correct µUSD per 1K conversion from snapshot', () => {
    const items = getLlmModelRateCardItems('test', {
      'model-a': { inputUsdPerM: 1, outputUsdPerM: 5 },
    });
    // $1/M input → 1000 µUSD/1K
    const inputItem = items.find((i) => i.meterKey === 'llm.input_tokens');
    expect(inputItem).toBeDefined();
    expect(inputItem!.priceMicrousd).toBe(1000);
    expect(inputItem!.perUnit).toBe(1000);
    expect(inputItem!.provider).toBe('test');
    expect(inputItem!.modelPattern).toBe('model-a');

    // $5/M output → 5000 µUSD/1K
    const outputItem = items.find((i) => i.meterKey === 'llm.output_tokens');
    expect(outputItem!.priceMicrousd).toBe(5000);
  });

  it('returns empty array for null snapshot', () => {
    expect(getLlmModelRateCardItems('test', null)).toEqual([]);
  });

  it('skips models with incomplete pricing', () => {
    const items = getLlmModelRateCardItems('test', {
      incomplete: { inputUsdPerM: 1 }, // missing outputUsdPerM
      complete: { inputUsdPerM: 2, outputUsdPerM: 10 },
    });
    const modelIds = [...new Set(items.map((i) => i.modelPattern))];
    expect(modelIds).not.toContain('incomplete');
    expect(modelIds).toContain('complete');
  });

  it('seeds llm.cached_input_tokens when cacheReadUsdPerM is present', () => {
    const items = getLlmModelRateCardItems('test', {
      'model-a': { inputUsdPerM: 1, outputUsdPerM: 5, cacheReadUsdPerM: 0.1 },
    });
    const cachedItem = items.find((i) => i.meterKey === 'llm.cached_input_tokens');
    expect(cachedItem).toBeDefined();
    // $0.1/M → 100 µUSD/1K
    expect(cachedItem!.priceMicrousd).toBe(100);
    expect(cachedItem!.perUnit).toBe(1000);
    expect(cachedItem!.provider).toBe('test');
    expect(cachedItem!.modelPattern).toBe('model-a');
  });

  it('does not seed llm.cached_input_tokens when cacheReadUsdPerM is absent', () => {
    const items = getLlmModelRateCardItems('test', {
      'model-a': { inputUsdPerM: 1, outputUsdPerM: 5 },
    });
    expect(items.find((i) => i.meterKey === 'llm.cached_input_tokens')).toBeUndefined();
  });

  it('seeds cacheReadUsdPerM: 0 as a zero-cost cached-input item', () => {
    const items = getLlmModelRateCardItems('test', {
      'free-cache': { inputUsdPerM: 1, outputUsdPerM: 2, cacheReadUsdPerM: 0 },
    });
    const cachedItem = items.find((i) => i.meterKey === 'llm.cached_input_tokens');
    expect(cachedItem).toBeDefined();
    expect(cachedItem!.priceMicrousd).toBe(0);
  });
});

describe('getLlmModelPricing', () => {
  const snapshot = {
    'model-a': { inputUsdPerM: 1, outputUsdPerM: 5 },
  };

  it('returns pricing for existing model', () => {
    expect(getLlmModelPricing(snapshot, 'model-a')).toEqual({
      inputUsdPerM: 1,
      outputUsdPerM: 5,
    });
  });

  it('returns undefined for unknown model', () => {
    expect(getLlmModelPricing(snapshot, 'model-b')).toBeUndefined();
  });

  it('returns undefined for null snapshot', () => {
    expect(getLlmModelPricing(null, 'model-a')).toBeUndefined();
  });
});

describe('normalizePersistedAiModelConfig', () => {
  it('returns null for null, undefined, non-object, and array inputs', () => {
    expect(normalizePersistedAiModelConfig(null)).toBeNull();
    expect(normalizePersistedAiModelConfig(undefined)).toBeNull();
    expect(normalizePersistedAiModelConfig('string')).toBeNull();
    expect(normalizePersistedAiModelConfig([])).toBeNull();
  });

  it('returns the config when all three required fields are present', () => {
    const raw = { provider: 'openrouter', lightModel: 'haiku', heavyModel: 'sonnet' };
    expect(normalizePersistedAiModelConfig(raw)).toEqual(raw);
  });

  it('returns null when a required field is missing', () => {
    expect(normalizePersistedAiModelConfig({ provider: 'openrouter', lightModel: 'haiku' })).toBeNull();
    expect(normalizePersistedAiModelConfig({ provider: 'openrouter' })).toBeNull();
  });

  it('preserves scoutReasoning and judgeReasoning when present', () => {
    const raw = {
      provider: 'openrouter',
      lightModel: 'haiku',
      heavyModel: 'sonnet',
      scoutReasoning: 'none',
      judgeReasoning: 'medium',
    };
    expect(normalizePersistedAiModelConfig(raw)).toEqual(raw);
  });

  it('returns null for invalid reasoning level values', () => {
    const raw = {
      provider: 'openrouter',
      lightModel: 'haiku',
      heavyModel: 'sonnet',
      scoutReasoning: 'ultra',  // not a valid ReasoningLevel
    };
    expect(normalizePersistedAiModelConfig(raw)).toBeNull();
  });

  it('accepts null reasoning fields (explicit clear)', () => {
    const raw = {
      provider: 'openrouter',
      lightModel: 'haiku',
      heavyModel: 'sonnet',
      scoutReasoning: null,
      judgeReasoning: null,
    };
    const result = normalizePersistedAiModelConfig(raw);
    expect(result).not.toBeNull();
    expect(result?.scoutReasoning).toBeNull();
    expect(result?.judgeReasoning).toBeNull();
  });

  it('returns null for clear payloads (all fields null)', () => {
    expect(normalizePersistedAiModelConfig({
      provider: null, lightModel: null, heavyModel: null,
    })).toBeNull();
  });

  it('returns null for clear payloads with reasoning fields also null', () => {
    expect(normalizePersistedAiModelConfig({
      provider: null, lightModel: null, heavyModel: null,
      scoutReasoning: null, judgeReasoning: null,
    })).toBeNull();
  });
});
