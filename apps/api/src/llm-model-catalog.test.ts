import { afterEach, describe, expect, it } from 'vitest';
import { PROVIDER_DEFINITIONS } from '@herobids/domain';
import { deriveLatestVariants, getAvailableProviders, getProviderCatalogEntry, type OperatorLlmCatalogContext } from './llm-model-catalog.js';

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];
const ORIGINAL_LLM_API_KEY_OPENAI = process.env['LLM_API_KEY_OPENAI'];
const ORIGINAL_LLM_API_KEY_OLLAMA = process.env['LLM_API_KEY_OLLAMA'];

type MutableProviderDefinitions = Record<string, {
  id: string;
  models: Record<string, object>;
  catalogMode: 'static' | 'dynamic';
  devOnly?: boolean;
  isMultiProvider?: boolean;
}>;

const BASE_CONTEXT: OperatorLlmCatalogContext = {
  provider: 'openai',
  model: 'gpt-4.1-mini',
  catalogTimeoutMs: 1_000,
  catalogCacheTtlMs: 1_000,
  catalogLocality: 'auto',
};

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  setEnv('NODE_ENV', ORIGINAL_NODE_ENV);
  setEnv('LLM_API_KEY_OPENAI', ORIGINAL_LLM_API_KEY_OPENAI);
  setEnv('LLM_API_KEY_OLLAMA', ORIGINAL_LLM_API_KEY_OLLAMA);
});

describe('getAvailableProviders', () => {
  it('includes ollama outside development when operator explicitly configured it with a baseUrl', () => {
    setEnv('NODE_ENV', 'test');
    setEnv('LLM_API_KEY_OPENAI', 'openai-key');

    expect(getAvailableProviders({ ...BASE_CONTEXT, provider: 'ollama', baseUrl: 'http://localhost:11434/v1' })).toEqual(['openai', 'ollama']);
  });

  it('hides dev-only providers in production when only an API key is set (no explicit operator baseUrl)', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('LLM_API_KEY_OPENAI', 'openai-key');
    setEnv('LLM_API_KEY_OLLAMA', 'ollama-key');

    // Operator did NOT set provider: 'ollama' — context has no baseUrl for ollama → hidden in production
    expect(getAvailableProviders({ ...BASE_CONTEXT })).toEqual(['openai']);
  });

  it('shows dev-only providers in development when configured via API key', () => {
    setEnv('NODE_ENV', 'development');
    setEnv('LLM_API_KEY_OPENAI', 'openai-key');
    setEnv('LLM_API_KEY_OLLAMA', 'ollama-key');

    expect(getAvailableProviders({ ...BASE_CONTEXT, provider: 'ollama', baseUrl: 'http://localhost:11434/v1' })).toEqual(['openai', 'ollama']);
  });
});

describe('getProviderCatalogEntry', () => {
  it('preserves isMultiProvider metadata for registry-defined static providers', async () => {
    const mutableDefinitions = PROVIDER_DEFINITIONS as unknown as MutableProviderDefinitions;
    mutableDefinitions['deepseek'] = {
      id: 'deepseek',
      models: { 'deepseek-chat': {} },
      catalogMode: 'static',
      isMultiProvider: true,
    };

    try {
      const entry = await getProviderCatalogEntry('deepseek', BASE_CONTEXT);
      expect(entry).toEqual({
        provider: 'deepseek',
        models: [{ id: 'deepseek-chat' }],
        isMultiProvider: true,
      });
    } finally {
      delete mutableDefinitions['deepseek'];
    }
  });
});

// --- deriveLatestVariants tests -------------------------------------------------

function makeCatalog(modelIds: string[], pricing?: Record<string, { prompt?: string; completion?: string }>): {
  modelIds: string[];
  pricingByModel: Record<string, { prompt?: string; completion?: string }>;
} {
  const pricingByModel: Record<string, { prompt?: string; completion?: string }> = {};
  for (const id of modelIds) {
    pricingByModel[id] = pricing?.[id] ?? { prompt: '1', completion: '2' };
  }
  return { modelIds: [...modelIds].sort(), pricingByModel };
}

describe('deriveLatestVariants', () => {
  it('emits major-level :latest when multiple minor versions exist', () => {
    const catalog = makeCatalog([
      'openai/gpt-5.4',
      'openai/gpt-5.5',
      'openai/gpt-5.3',
    ]);

    const result = deriveLatestVariants(catalog);

    expect(result.modelIds).toContain('openai/gpt-5:latest');
  });

  it('does NOT emit broader family-level :latest aliases', () => {
    const catalog = makeCatalog([
      'openai/gpt-5.4',
      'openai/gpt-5.5',
    ]);

    const result = deriveLatestVariants(catalog);

    expect(result.modelIds).not.toContain('openai/gpt:latest');
    expect(result.modelIds).toContain('openai/gpt-5:latest');
  });

  it('copies pricing from the highest-versioned member', () => {
    const catalog = makeCatalog(
      ['openai/gpt-5.4', 'openai/gpt-5.5'],
      {
        'openai/gpt-5.4': { prompt: '2', completion: '8' },
        'openai/gpt-5.5': { prompt: '5', completion: '30' },
      },
    );

    const result = deriveLatestVariants(catalog);

    expect(result.pricingByModel['openai/gpt-5:latest']).toEqual({ prompt: '5', completion: '30' });
  });

  it('does not emit :latest for a single-version family', () => {
    const catalog = makeCatalog(['openai/gpt-5.5']);

    const result = deriveLatestVariants(catalog);

    expect(result.modelIds).not.toContain('openai/gpt-5:latest');
    expect(result.modelIds).toEqual(['openai/gpt-5.5']);
  });

  it('does not emit :latest for non-versioned model IDs', () => {
    const catalog = makeCatalog([
      'deepseek/deepseek-r1',
      'openai/o4-mini',
      'meta-llama/llama-4-maverick',
    ]);

    const result = deriveLatestVariants(catalog);

    // No :latest should be added; original IDs preserved
    expect(result.modelIds.filter((id) => id.endsWith(':latest'))).toHaveLength(0);
    expect(result.modelIds).toEqual([
      'deepseek/deepseek-r1',
      'meta-llama/llama-4-maverick',
      'openai/o4-mini',
    ]);
  });

  it('preserves existing :latest entries already in the catalog', () => {
    const catalog = makeCatalog([
      'openai/gpt-5.4',
      'openai/gpt-5.5',
      'openai/gpt-5:latest',
    ]);

    const result = deriveLatestVariants(catalog);

    expect(result.modelIds).toContain('openai/gpt-5:latest');
    // Should not duplicate
    expect(result.modelIds.filter((id) => id === 'openai/gpt-5:latest')).toHaveLength(1);
  });

  it('emits multiple major-level aliases across different families', () => {
    const catalog = makeCatalog([
      'openai/gpt-5.4',
      'openai/gpt-5.5',
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-sonnet-4.6',
    ]);

    const result = deriveLatestVariants(catalog);

    expect(result.modelIds).toContain('openai/gpt-5:latest');
    expect(result.modelIds).toContain('anthropic/claude-sonnet-4:latest');
  });

  it('handles empty catalog gracefully', () => {
    const catalog = { modelIds: [] as string[], pricingByModel: {} };

    const result = deriveLatestVariants(catalog);

    expect(result.modelIds).toEqual([]);
    expect(result.pricingByModel).toEqual({});
  });

  it('sorts modelIds after adding variants', () => {
    const catalog = makeCatalog([
      'openai/gpt-5.4',
      'openai/gpt-5.5',
      'anthropic/claude-sonnet-4.5',
    ]);

    const result = deriveLatestVariants(catalog);

    // Verify sorted order
    for (let i = 1; i < result.modelIds.length; i++) {
      expect(result.modelIds[i]! >= result.modelIds[i - 1]!).toBe(true);
    }
  });
});