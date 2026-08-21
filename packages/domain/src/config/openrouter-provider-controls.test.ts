import { describe, expect, it } from 'vitest';
import {
  OpenRouterProviderControlsSchema,
  LlmRuntimeConfigSchema,
} from './schema.js';

describe('OpenRouterProviderControlsSchema', () => {
  describe('defaults', () => {
    it('applies dataCollection=deny and zdr=true when parsing empty object', () => {
      const result = OpenRouterProviderControlsSchema.parse({});
      expect(result).toEqual({ dataCollection: 'deny', zdr: true });
    });

    it('applies defaults for omitted fields while preserving explicit values', () => {
      const result = OpenRouterProviderControlsSchema.parse({ dataCollection: 'allow' });
      expect(result.dataCollection).toBe('allow');
      expect(result.zdr).toBe(true);
    });
  });

  describe('valid values', () => {
    it('accepts dataCollection=allow', () => {
      const result = OpenRouterProviderControlsSchema.parse({ dataCollection: 'allow' });
      expect(result.dataCollection).toBe('allow');
    });

    it('accepts dataCollection=deny', () => {
      const result = OpenRouterProviderControlsSchema.parse({ dataCollection: 'deny' });
      expect(result.dataCollection).toBe('deny');
    });

    it('accepts zdr=false', () => {
      const result = OpenRouterProviderControlsSchema.parse({ zdr: false });
      expect(result.zdr).toBe(false);
    });

    it('accepts allowFallbacks when provided', () => {
      const result = OpenRouterProviderControlsSchema.parse({ allowFallbacks: true });
      expect(result.allowFallbacks).toBe(true);
    });

    it('accepts only array of provider slugs', () => {
      const result = OpenRouterProviderControlsSchema.parse({ only: ['anthropic', 'openai'] });
      expect(result.only).toEqual(['anthropic', 'openai']);
    });

    it('accepts order array of provider slugs', () => {
      const result = OpenRouterProviderControlsSchema.parse({ order: ['anthropic', 'google'] });
      expect(result.order).toEqual(['anthropic', 'google']);
    });

    it('accepts full config with all fields', () => {
      const result = OpenRouterProviderControlsSchema.parse({
        dataCollection: 'allow',
        zdr: false,
        allowFallbacks: false,
        only: ['anthropic'],
        order: ['anthropic', 'openai'],
      });
      expect(result).toEqual({
        dataCollection: 'allow',
        zdr: false,
        allowFallbacks: false,
        only: ['anthropic'],
        order: ['anthropic', 'openai'],
      });
    });
  });

  describe('invalid values', () => {
    it('rejects invalid dataCollection enum value', () => {
      const result = OpenRouterProviderControlsSchema.safeParse({ dataCollection: 'maybe' });
      expect(result.success).toBe(false);
    });

    it('rejects non-boolean zdr', () => {
      const result = OpenRouterProviderControlsSchema.safeParse({ zdr: 'yes' });
      expect(result.success).toBe(false);
    });

    it('rejects non-boolean allowFallbacks', () => {
      const result = OpenRouterProviderControlsSchema.safeParse({ allowFallbacks: 'true' });
      expect(result.success).toBe(false);
    });

    it('rejects non-array only', () => {
      const result = OpenRouterProviderControlsSchema.safeParse({ only: 'anthropic' });
      expect(result.success).toBe(false);
    });

    it('rejects non-string elements in only array', () => {
      const result = OpenRouterProviderControlsSchema.safeParse({ only: [123] });
      expect(result.success).toBe(false);
    });

    it('rejects non-array order', () => {
      const result = OpenRouterProviderControlsSchema.safeParse({ order: 'anthropic' });
      expect(result.success).toBe(false);
    });

    it('rejects non-string elements in order array', () => {
      const result = OpenRouterProviderControlsSchema.safeParse({ order: [true] });
      expect(result.success).toBe(false);
    });
  });

  describe('optional fields', () => {
    it('omits allowFallbacks from output when not provided', () => {
      const result = OpenRouterProviderControlsSchema.parse({});
      expect(result).not.toHaveProperty('allowFallbacks');
    });

    it('omits only from output when not provided', () => {
      const result = OpenRouterProviderControlsSchema.parse({});
      expect(result).not.toHaveProperty('only');
    });

    it('omits order from output when not provided', () => {
      const result = OpenRouterProviderControlsSchema.parse({});
      expect(result).not.toHaveProperty('order');
    });
  });
});

describe('LlmRuntimeConfigSchema — openRouterProviderControls integration', () => {
  it('applies openRouterProviderControls defaults when llm config is empty', () => {
    const result = LlmRuntimeConfigSchema.parse({});
    expect(result.openRouterProviderControls).toEqual({ dataCollection: 'deny', zdr: true });
  });

  it('preserves explicit openRouterProviderControls values', () => {
    const result = LlmRuntimeConfigSchema.parse({
      openRouterProviderControls: { dataCollection: 'allow', zdr: false },
    });
    expect(result.openRouterProviderControls.dataCollection).toBe('allow');
    expect(result.openRouterProviderControls.zdr).toBe(false);
  });

  it('merges partial openRouterProviderControls with defaults', () => {
    const result = LlmRuntimeConfigSchema.parse({
      openRouterProviderControls: { allowFallbacks: true },
    });
    expect(result.openRouterProviderControls.dataCollection).toBe('deny');
    expect(result.openRouterProviderControls.zdr).toBe(true);
    expect(result.openRouterProviderControls.allowFallbacks).toBe(true);
  });
});
