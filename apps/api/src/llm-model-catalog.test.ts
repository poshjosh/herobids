import { afterEach, describe, expect, it } from 'vitest';
import { PROVIDER_DEFINITIONS } from '@herobids/domain';
import { getAvailableProviders, getProviderCatalogEntry, type OperatorLlmCatalogContext } from './llm-model-catalog.js';

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];
const ORIGINAL_LLM_API_KEY_OPENAI = process.env['LLM_API_KEY_OPENAI'];
const ORIGINAL_LLM_API_KEY_OLLAMA = process.env['LLM_API_KEY_OLLAMA'];

type MutableProviderDefinitions = Record<string, {
  id: string;
  models: string[];
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
      models: ['deepseek-chat'],
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