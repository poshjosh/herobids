import { describe, expect, it } from 'vitest';
import { resolveAgentCostProfile } from './cost-profile.js';

describe('resolveAgentCostProfile', () => {
  it('maps minimal preset to the cheapest profile', () => {
    const profile = resolveAgentCostProfile({
      provider: 'openai',
      judgeModel: 'gpt-4.1',
      costPreset: 'minimal',
      baseTickIntervalMs: 900_000,
    });

    expect(profile.scoutModel).toBe('gpt-4.1-mini');
    expect(profile.judgeModel).toBe('gpt-4.1-mini');
    expect(profile.tickIntervalMs).toBe(1_800_000);
    expect(profile.enabledGates.adaptiveInterval).toBe(true);
  });

  it('derives custom intervals from budget', () => {
    const profile = resolveAgentCostProfile({
      provider: 'openrouter',
      judgeModel: 'anthropic/claude-sonnet-4-5',
      costPreset: 'custom',
      dailyBudgetUsd: 2,
      baseTickIntervalMs: 900_000,
    });

    expect(profile.tickIntervalMs).toBeGreaterThanOrEqual(300_000);
    expect(profile.judgeModel).toBe(profile.scoutModel);
  });

  it('uses configured scout default models for preset resolution', () => {
    const profile = resolveAgentCostProfile({
      provider: 'openai',
      judgeModel: 'gpt-4.1',
      scoutDefaultModels: {
        anthropic: 'claude-3-5-haiku-latest',
        openai: 'gpt-4o-mini',
        openrouter: 'openai/gpt-4.1-mini',
      },
      costPreset: 'minimal',
      baseTickIntervalMs: 900_000,
    });

    expect(profile.scoutModel).toBe('gpt-4o-mini');
    expect(profile.judgeModel).toBe('gpt-4o-mini');
  });
});