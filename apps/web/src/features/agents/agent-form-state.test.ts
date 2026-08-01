import { describe, expect, it } from 'vitest';
import { agentToFormState } from './agent-form-state.js';
import type { Agent } from '../../lib/api-client.js';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    userId: 'user-1',
    name: 'Test agent',
    prompt: '',
    skillIds: [],
    status: 'stopped',
    pauseState: null,
    toolPolicy: null,
    modelPolicy: null,
    provider: null,
    lightModel: null,
    heavyModel: null,
    costPreset: null,
    dailySpendBudgetUsd: null,
    dailyLlmTokenBudget: null,
    telegramChatId: null,
    executionMode: 'paper',
    dailyMaxLossPct: null,
    maxDrawdownPct: null,
    maxBots: null,
    maxSlippageBps: null,
    maxOpenPositions: null,
    maxPositionSizePct: null,
    stopLossPct: null,
    stopLossCooldownMs: null,
    tickIntervalMs: null,
    capital: null,
    style: null,
    runtimePolicyOverrides: null,
    resolvedRuntimePolicy: null,
    openPositionEscalationToJudgePolicy: null,
    technical: null,
    strategyPreset: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Agent;
}

describe('agentToFormState — maxDrawdownPct hydration', () => {
  it('hydrates a numeric maxDrawdownPct into a string form field', () => {
    const agent = makeAgent({ maxDrawdownPct: 15 });
    const form = agentToFormState(agent);
    expect(form.maxDrawdownPct).toBe('15');
  });

  it('defaults maxDrawdownPct to empty string when null', () => {
    const agent = makeAgent({ maxDrawdownPct: null });
    const form = agentToFormState(agent);
    expect(form.maxDrawdownPct).toBe('');
  });
});

describe('agentToFormState — strategyPreset hydration', () => {
  it('hydrates the persisted preset key so a preset-managed agent reopens selected', () => {
    const agent = makeAgent({
      strategyPreset: 'momentum',
      technical: { signalBias: 'trend-following' },
    });
    const form = agentToFormState(agent);
    expect(form.strategyPreset).toBe('momentum');
  });

  it('falls back to custom when a technical config exists but no preset metadata', () => {
    const agent = makeAgent({
      strategyPreset: null,
      technical: { signalBias: 'trend-following' },
    });
    const form = agentToFormState(agent);
    expect(form.strategyPreset).toBe('custom');
  });

  it('falls back to empty when neither preset nor technical config exist', () => {
    const agent = makeAgent({ strategyPreset: null, technical: null });
    const form = agentToFormState(agent);
    expect(form.strategyPreset).toBe('');
  });
});

describe('agentToFormState — executionMode canonicalization', () => {
  it('maps stored paper to test', () => {
    const agent = makeAgent({ executionMode: 'paper' });
    const form = agentToFormState(agent);
    expect(form.executionMode).toBe('test');
  });

  it('maps stored shadow to test', () => {
    const agent = makeAgent({ executionMode: 'shadow' });
    const form = agentToFormState(agent);
    expect(form.executionMode).toBe('test');
  });

  it('maps stored live to live', () => {
    const agent = makeAgent({ executionMode: 'live' });
    const form = agentToFormState(agent);
    expect(form.executionMode).toBe('live');
  });

  it('maps null executionMode to empty string', () => {
    const agent = makeAgent({ executionMode: null });
    const form = agentToFormState(agent);
    expect(form.executionMode).toBe('');
  });

  it('maps undefined executionMode to empty string', () => {
    const agent = makeAgent({ executionMode: undefined });
    const form = agentToFormState(agent);
    expect(form.executionMode).toBe('');
  });
});

describe('agentToFormState — emailDelivery hydration', () => {
  it('defaults to "inherit" when notificationPolicy is null', () => {
    const agent = makeAgent({ notificationPolicy: null });
    expect(agentToFormState(agent).emailDelivery).toBe('inherit');
  });

  it('defaults to "inherit" when notificationPolicy is undefined', () => {
    const agent = makeAgent({});
    expect(agentToFormState(agent).emailDelivery).toBe('inherit');
  });

  it('defaults to "inherit" when notificationPolicy has no email key', () => {
    const agent = makeAgent({ notificationPolicy: { sendMessage: {} } });
    expect(agentToFormState(agent).emailDelivery).toBe('inherit');
  });

  it('resolves to "allow" when notificationPolicy email.enabled is true', () => {
    const agent = makeAgent({
      notificationPolicy: {
        sendMessage: { email: { enabled: true, source: 'explicit_update' } },
      },
    });
    expect(agentToFormState(agent).emailDelivery).toBe('allow');
  });

  it('resolves to "disable" when notificationPolicy email.enabled is false', () => {
    const agent = makeAgent({
      notificationPolicy: {
        sendMessage: { email: { enabled: false, source: 'explicit_update' } },
      },
    });
    expect(agentToFormState(agent).emailDelivery).toBe('disable');
  });
});
