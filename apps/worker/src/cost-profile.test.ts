import { describe, expect, it } from 'vitest';
import { resolveAgentCostProfile } from './cost-profile.js';

describe('resolveAgentCostProfile', () => {
  it('maps minimal preset to the cheapest profile', () => {
    const profile = resolveAgentCostProfile({
      provider: 'openai',
      heavyModel: 'gpt-4.1',
      lightModel: 'gpt-4.1-mini',
      costPreset: 'minimal',
      baseTickIntervalMs: 900_000,
    });

    expect(profile.lightModel).toBe('gpt-4.1-mini');
    expect(profile.heavyModel).toBe('gpt-4.1-mini');
    expect(profile.tickIntervalMs).toBe(1_800_000);
    expect(profile.enabledGates.adaptiveInterval).toBe(true);
  });

  it('derives custom intervals from budget', () => {
    const profile = resolveAgentCostProfile({
      provider: 'openrouter',
      heavyModel: 'anthropic/claude-sonnet-4-5',
      lightModel: 'anthropic/claude-sonnet-4-5-mini',
      costPreset: 'custom',
      dailyBudgetUsd: 2,
      baseTickIntervalMs: 900_000,
    });

    expect(profile.tickIntervalMs).toBeGreaterThanOrEqual(300_000);
    expect(profile.heavyModel).toBe(profile.lightModel);
  });

  it('uses configured scout default models for preset resolution', () => {
    const profile = resolveAgentCostProfile({
      provider: 'openai',
      heavyModel: 'gpt-4.1',
      lightModel: 'gpt-4o-mini',
      costPreset: 'minimal',
      baseTickIntervalMs: 900_000,
    });

    expect(profile.lightModel).toBe('gpt-4o-mini');
    expect(profile.heavyModel).toBe('gpt-4o-mini');
  });
});