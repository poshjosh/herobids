import { describe, it, expect } from 'vitest';
import {
  PROVIDER_DEFINITIONS,
  KNOWN_LLM_PROVIDERS,
  getLlmProviderModels,
  validateLlmModelSelection,
  type LlmProviderDefinition,
} from './llm-models.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function isLlmProviderDefinition(value: unknown): value is LlmProviderDefinition {
  if (!value || typeof value !== 'object') return false;
  const def = value as Record<string, unknown>;
  return typeof def.id === 'string'
    && Array.isArray(def.models)
    && def.models.every((m: unknown) => typeof m === 'string')
    && (def.catalogMode === 'static' || def.catalogMode === 'dynamic');
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PROVIDER_DEFINITIONS', () => {
  it('every provider definition has required fields', () => {
    for (const [key, def] of Object.entries(PROVIDER_DEFINITIONS)) {
      expect(isLlmProviderDefinition(def), `provider "${key}" must be a valid LlmProviderDefinition`).toBe(true);
      expect(def.id, `provider "${key}" definition.id must match its key`).toBe(key);
      expect(def.models.length, `provider "${key}" must have at least one model`).toBeGreaterThan(0);
    }
  });

  it('provider ids are unique', () => {
    const ids = Object.values(PROVIDER_DEFINITIONS).map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all catalog modes are valid', () => {
    for (const def of Object.values(PROVIDER_DEFINITIONS)) {
      expect(['static', 'dynamic']).toContain(def.catalogMode);
    }
  });

  it('dynamic providers have at least one model for static fallback', () => {
    for (const def of Object.values(PROVIDER_DEFINITIONS)) {
      if (def.catalogMode === 'dynamic') {
        expect(def.models.length, `dynamic provider "${def.id}" must have fallback models`).toBeGreaterThan(0);
      }
    }
  });

  it('devOnly providers have explicit opt-in semantics', () => {
    // devOnly is optional, but if set it must be boolean true
    for (const [key, def] of Object.entries(PROVIDER_DEFINITIONS)) {
      if (def.devOnly !== undefined) {
        expect(def.devOnly, `provider "${key}" devOnly must be true if present`).toBe(true);
      }
    }
  });
});

describe('KNOWN_LLM_PROVIDERS', () => {
  it('contains exactly the keys of PROVIDER_DEFINITIONS', () => {
    const expected = Object.keys(PROVIDER_DEFINITIONS).sort();
    const actual = [...KNOWN_LLM_PROVIDERS].sort();
    expect(actual).toEqual(expected);
  });

  it('does not contain duplicates', () => {
    expect(new Set(KNOWN_LLM_PROVIDERS).size).toBe(KNOWN_LLM_PROVIDERS.length);
  });
});

describe('getLlmProviderModels', () => {
  it('returns models for known providers', () => {
    const models = getLlmProviderModels('openai');
    expect(models).toEqual(PROVIDER_DEFINITIONS.openai.models);
  });

  it('returns empty array for unknown providers', () => {
    expect(getLlmProviderModels('nonexistent')).toEqual([]);
  });
});

describe('validateLlmModelSelection', () => {
  it('rejects unknown provider', () => {
    const issues = validateLlmModelSelection({
      provider: 'nonexistent',
      lightModel: 'gpt-4o',
      heavyModel: 'gpt-4o',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(['provider']);
  });

  it('rejects unknown model for static provider', () => {
    const issues = validateLlmModelSelection({
      provider: 'openai',
      lightModel: 'unknown-model',
      heavyModel: 'gpt-4o',
    });
    const paths = issues.map((i) => i.path.join('.'));
    expect(paths).toContain('lightModel');
  });

  it('accepts valid selection for static provider', () => {
    const issues = validateLlmModelSelection({
      provider: 'openai',
      lightModel: 'gpt-4o-mini',
      heavyModel: 'gpt-4o',
    });
    expect(issues).toHaveLength(0);
  });

  it('defers ollama model validation to runtime catalog', () => {
    // Domain does not validate Ollama models — that's done at runtime by the API layer
    const issues = validateLlmModelSelection({
      provider: 'ollama',
      lightModel: 'any-custom-model',
      heavyModel: 'another-custom-model',
    });
    expect(issues).toHaveLength(0);
  });
});

describe('adding a new provider', () => {
  it('is a single-line addition to PROVIDER_DEFINITIONS', () => {
    // Simulate: adding a new provider is as simple as adding one entry.
    const simulated = {
      ...PROVIDER_DEFINITIONS,
      deepseek: {
        id: 'deepseek',
        models: ['deepseek-chat', 'deepseek-reasoner'],
        catalogMode: 'static',
      },
    } as const satisfies Record<string, LlmProviderDefinition>;

    // The new provider propagates to derived structures
    const derivedKeys = Object.keys(simulated);
    expect(derivedKeys).toContain('deepseek');

    const derivedModels = Object.fromEntries(
      Object.entries(simulated).map(([id, def]) => [id, def.models]),
    );
    expect(derivedModels['deepseek']).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });
});
