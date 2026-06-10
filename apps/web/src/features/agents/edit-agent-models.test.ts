import { describe, expect, it } from 'vitest';

function isOverrideSaveDisabled(
  modelOverrideEnabled: boolean,
  form: { provider: string; lightModel: string; heavyModel: string },
  isPending: boolean,
): boolean {
  return isPending || (modelOverrideEnabled && (!form.provider || !form.lightModel || !form.heavyModel));
}

function resolveOverridePayload(
  modelOverrideEnabled: boolean,
  form: { provider: string; lightModel: string; heavyModel: string },
): { provider: string | null; lightModel: string | null; heavyModel: string | null } {
  if (!modelOverrideEnabled) {
    return { provider: null, lightModel: null, heavyModel: null };
  }

  return {
    provider: form.provider || null,
    lightModel: form.lightModel || null,
    heavyModel: form.heavyModel || null,
  };
}

describe('EditAgentModal model overrides', () => {
  it('blocks save when override mode is enabled but the model values are incomplete', () => {
    expect(isOverrideSaveDisabled(true, { provider: '', lightModel: '', heavyModel: '' }, false)).toBe(true);
    expect(isOverrideSaveDisabled(true, { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: '' }, false)).toBe(true);
    expect(isOverrideSaveDisabled(false, { provider: '', lightModel: '', heavyModel: '' }, false)).toBe(false);
  });

  it('clears model overrides back to inheritance when override mode is off', () => {
    expect(resolveOverridePayload(false, { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' })).toEqual({
      provider: null,
      lightModel: null,
      heavyModel: null,
    });
  });

  it('sends provider, lightModel, and heavyModel when override mode is on', () => {
    expect(resolveOverridePayload(true, { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' })).toEqual({
      provider: 'openai',
      lightModel: 'gpt-4o-mini',
      heavyModel: 'gpt-4o',
    });
  });
});
