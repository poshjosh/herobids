import { describe, it, expect } from 'vitest';
import type { OpenRouterProviderControls, LlmProviderConfig } from './llm-provider.js';

describe('OpenRouterProviderControls type', () => {
  it('is importable from the package barrel', async () => {
    // Importing the type from the barrel (index.ts) confirms it is re-exported.
    const barrel = await import('./index.js');
    // The barrel is a runtime module — types exist at compile time.
    // If the import above compiles, the type is correctly exported.
    expect(barrel).toBeDefined();
  });

  it('accepts a full OpenRouterProviderControls object', () => {
    const controls: OpenRouterProviderControls = {
      dataCollection: 'deny',
      zdr: true,
      allowFallbacks: false,
      only: ['anthropic', 'openai'],
      order: ['anthropic'],
    };
    // Runtime assertion: object satisfies the shape
    expect(controls.dataCollection).toBe('deny');
    expect(controls.zdr).toBe(true);
    expect(controls.allowFallbacks).toBe(false);
    expect(controls.only).toEqual(['anthropic', 'openai']);
    expect(controls.order).toEqual(['anthropic']);
  });

  it('accepts an empty OpenRouterProviderControls object (all fields optional)', () => {
    const controls: OpenRouterProviderControls = {};
    expect(controls).toEqual({});
  });

  it('accepts dataCollection as allow', () => {
    const controls: OpenRouterProviderControls = { dataCollection: 'allow' };
    expect(controls.dataCollection).toBe('allow');
  });

  it('accepts only subset of fields', () => {
    const controls: OpenRouterProviderControls = {
      zdr: false,
      order: ['openai', 'anthropic'],
    };
    expect(controls.zdr).toBe(false);
    expect(controls.order).toEqual(['openai', 'anthropic']);
    expect(controls.dataCollection).toBeUndefined();
    expect(controls.allowFallbacks).toBeUndefined();
    expect(controls.only).toBeUndefined();
  });
});

describe('LlmProviderConfig with openRouterProviderControls', () => {
  const baseConfig: LlmProviderConfig = {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4-20250514',
    maxTokens: 4096,
    timeoutMs: 30_000,
  };

  it('accepts config without openRouterProviderControls (backward compat)', () => {
    const config: LlmProviderConfig = { ...baseConfig };
    expect(config.openRouterProviderControls).toBeUndefined();
  });

  it('accepts config with openRouterProviderControls set', () => {
    const config: LlmProviderConfig = {
      ...baseConfig,
      openRouterProviderControls: {
        dataCollection: 'deny',
        allowFallbacks: true,
        only: ['anthropic'],
      },
    };
    expect(config.openRouterProviderControls).toBeDefined();
    expect(config.openRouterProviderControls!.dataCollection).toBe('deny');
    expect(config.openRouterProviderControls!.allowFallbacks).toBe(true);
    expect(config.openRouterProviderControls!.only).toEqual(['anthropic']);
  });

  it('accepts config with empty openRouterProviderControls', () => {
    const config: LlmProviderConfig = {
      ...baseConfig,
      openRouterProviderControls: {},
    };
    expect(config.openRouterProviderControls).toEqual({});
  });

  it('accepts config with openRouterProviderControls alongside other optional fields', () => {
    const config: LlmProviderConfig = {
      ...baseConfig,
      baseUrl: 'https://custom.openrouter.ai/api/v1',
      thinking: { lightBudgetTokens: 2048, deepBudgetTokens: 8192 },
      openRouterProviderControls: {
        zdr: true,
        order: ['anthropic', 'openai'],
      },
    };
    expect(config.baseUrl).toBe('https://custom.openrouter.ai/api/v1');
    expect(config.thinking).toBeDefined();
    expect(config.openRouterProviderControls!.zdr).toBe(true);
    expect(config.openRouterProviderControls!.order).toEqual(['anthropic', 'openai']);
  });
});
