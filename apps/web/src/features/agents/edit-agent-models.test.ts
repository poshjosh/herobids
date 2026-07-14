import { describe, expect, it } from 'vitest';
import { validateEditAgentConnections } from './form-validation.js';

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

describe('validateEditAgentConnections', () => {
  it('blocks live mode with no connections regardless of touch state', () => {
    expect(validateEditAgentConnections({
      storedExecutionMode: 'live',
      formExecutionMode: 'live',
      connectionIds: [],
      hasExistingActiveConnections: true,
      executionModeWasTouched: true,
    })).toBeTruthy();
  });

  it('blocks removing last connection from live agent when mode not touched', () => {
    expect(validateEditAgentConnections({
      storedExecutionMode: 'live',
      formExecutionMode: 'test',
      connectionIds: [],
      hasExistingActiveConnections: true,
      executionModeWasTouched: false,
    })).toBeTruthy();
  });

  it('allows removing last connection from live agent when mode explicitly changed to test', () => {
    expect(validateEditAgentConnections({
      storedExecutionMode: 'live',
      formExecutionMode: 'test',
      connectionIds: [],
      hasExistingActiveConnections: true,
      executionModeWasTouched: true,
    })).toBeNull();
  });

  it('blocks removing last connection from shadow agent when mode not touched', () => {
    expect(validateEditAgentConnections({
      storedExecutionMode: 'shadow',
      formExecutionMode: 'test',
      connectionIds: [],
      hasExistingActiveConnections: true,
      executionModeWasTouched: false,
    })).toBeTruthy();
  });

  it('allows removing last connection from shadow agent when mode explicitly changed to test', () => {
    expect(validateEditAgentConnections({
      storedExecutionMode: 'shadow',
      formExecutionMode: 'test',
      connectionIds: [],
      hasExistingActiveConnections: true,
      executionModeWasTouched: true,
    })).toBeNull();
  });

  it('allows removing connections from paper agent (never needed them)', () => {
    expect(validateEditAgentConnections({
      storedExecutionMode: 'paper',
      formExecutionMode: 'test',
      connectionIds: [],
      hasExistingActiveConnections: true,
      executionModeWasTouched: false,
    })).toBeNull();
  });

  it('allows save when connections are present', () => {
    expect(validateEditAgentConnections({
      storedExecutionMode: 'live',
      formExecutionMode: 'live',
      connectionIds: ['conn-1'],
      hasExistingActiveConnections: true,
      executionModeWasTouched: false,
    })).toBeNull();
  });

  it('allows removing connections when there were never any active ones', () => {
    expect(validateEditAgentConnections({
      storedExecutionMode: 'shadow',
      formExecutionMode: 'test',
      connectionIds: [],
      hasExistingActiveConnections: false,
      executionModeWasTouched: false,
    })).toBeNull();
  });

  it('returns null for non-trading agents with null stored mode', () => {
    expect(validateEditAgentConnections({
      storedExecutionMode: null,
      formExecutionMode: 'test',
      connectionIds: [],
      hasExistingActiveConnections: true,
      executionModeWasTouched: false,
    })).toBeNull();
  });
});
