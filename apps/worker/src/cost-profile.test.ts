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
    expect(profile.tickIntervalMs).toBe(3_600_000);
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

  it('explicit tickIntervalMs overrides minimal preset interval', () => {
    const profile = resolveAgentCostProfile({
      provider: 'openai',
      heavyModel: 'gpt-4.1',
      lightModel: 'gpt-4.1-mini',
      costPreset: 'minimal',
      baseTickIntervalMs: 900_000,
      tickIntervalMs: 600_000,
    });

    expect(profile.tickIntervalMs).toBe(600_000);
    // Other preset properties should remain intact
    expect(profile.preset).toBe('minimal');
    expect(profile.enabledGates.adaptiveInterval).toBe(true);
  });

  it('explicit tickIntervalMs overrides standard preset interval', () => {
    const profile = resolveAgentCostProfile({
      provider: 'openai',
      heavyModel: 'gpt-4.1',
      lightModel: 'gpt-4.1-mini',
      costPreset: 'standard',
      baseTickIntervalMs: 900_000,
      tickIntervalMs: 1_200_000,
    });

    expect(profile.tickIntervalMs).toBe(1_200_000);
    expect(profile.preset).toBe('standard');
  });

  it('explicit tickIntervalMs overrides premium preset interval', () => {
    const profile = resolveAgentCostProfile({
      provider: 'openai',
      heavyModel: 'gpt-4.1',
      lightModel: 'gpt-4.1-mini',
      costPreset: 'premium',
      baseTickIntervalMs: 900_000,
      tickIntervalMs: 120_000,
    });

    expect(profile.tickIntervalMs).toBe(120_000);
    expect(profile.preset).toBe('premium');
  });

  it('explicit tickIntervalMs overrides base interval when no preset is set', () => {
    const profile = resolveAgentCostProfile({
      provider: 'openai',
      heavyModel: 'gpt-4.1',
      lightModel: 'gpt-4.1-mini',
      baseTickIntervalMs: 900_000,
      tickIntervalMs: 300_000,
    });

    expect(profile.tickIntervalMs).toBe(300_000);
  });

  it('falls back to preset-derived interval when explicit tickIntervalMs is not set', () => {
    const profile = resolveAgentCostProfile({
      provider: 'openai',
      heavyModel: 'gpt-4.1',
      lightModel: 'gpt-4.1-mini',
      costPreset: 'standard',
      baseTickIntervalMs: 900_000,
    });

    expect(profile.tickIntervalMs).toBe(1_800_000);
  });

  it('falls back to baseTickIntervalMs when neither preset nor explicit interval is set', () => {
    const profile = resolveAgentCostProfile({
      provider: 'openai',
      heavyModel: 'gpt-4.1',
      lightModel: 'gpt-4.1-mini',
      baseTickIntervalMs: 600_000,
    });

    expect(profile.tickIntervalMs).toBe(600_000);
  });
});