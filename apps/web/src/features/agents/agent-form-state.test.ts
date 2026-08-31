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
    executionDefaults: { mode: 'paper' },
    risk: null,
    maxBots: null,
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
    const agent = makeAgent({ risk: { maxDrawdownPct: 15 } });
    const form = agentToFormState(agent);
    expect(form.maxDrawdownPct).toBe('15');
  });

  it('defaults maxDrawdownPct to empty string when null', () => {
    const agent = makeAgent({ risk: null });
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
    const agent = makeAgent({ executionDefaults: { mode: 'paper' } });
    const form = agentToFormState(agent);
    expect(form.executionMode).toBe('test');
  });

  it('maps stored shadow to test', () => {
    const agent = makeAgent({ executionDefaults: { mode: 'shadow' } });
    const form = agentToFormState(agent);
    expect(form.executionMode).toBe('test');
  });

  it('maps stored live to live', () => {
    const agent = makeAgent({ executionDefaults: { mode: 'live' } });
    const form = agentToFormState(agent);
    expect(form.executionMode).toBe('live');
  });

  it('maps null executionDefaults to empty string', () => {
    const agent = makeAgent({ executionDefaults: null });
    const form = agentToFormState(agent);
    expect(form.executionMode).toBe('');
  });

  it('maps undefined executionDefaults to empty string', () => {
    const agent = makeAgent({ executionDefaults: undefined });
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

import { intentToFormState } from './agent-form-state.js';
import { defaultTechnicalConfigFormState } from './technical-config-helpers.js';

// ---------------------------------------------------------------------------
// agentToFormState — permissionLevel hydration
// ---------------------------------------------------------------------------

describe('agentToFormState — permissionLevel hydration', () => {
  it('hydrates "restricted" from the agent object', () => {
    const agent = makeAgent({ permissionLevel: 'restricted' });
    expect(agentToFormState(agent).permissionLevel).toBe('restricted');
  });

  it('hydrates "standard" from the agent object', () => {
    const agent = makeAgent({ permissionLevel: 'standard' });
    expect(agentToFormState(agent).permissionLevel).toBe('standard');
  });

  it('hydrates "full" from the agent object', () => {
    const agent = makeAgent({ permissionLevel: 'full' });
    expect(agentToFormState(agent).permissionLevel).toBe('full');
  });

  it('defaults to "standard" when permissionLevel is null', () => {
    const agent = makeAgent({ permissionLevel: null });
    expect(agentToFormState(agent).permissionLevel).toBe('standard');
  });

  it('defaults to "standard" when permissionLevel is undefined', () => {
    const agent = makeAgent({ permissionLevel: undefined });
    expect(agentToFormState(agent).permissionLevel).toBe('standard');
  });

  it('defaults to "standard" when permissionLevel is an invalid string', () => {
    const agent = makeAgent({ permissionLevel: 'admin' as any });
    expect(agentToFormState(agent).permissionLevel).toBe('standard');
  });
});

// ---------------------------------------------------------------------------
// intentToFormState — permissionLevel passthrough
// ---------------------------------------------------------------------------

const BASE_INTENT = {
  name: 'test',
  goal: 'trade',
  capabilityMode: 'intelligence' as const,
  hybridMode: undefined,
  technicalPreFilterEnabled: false,
  technicalConfig: defaultTechnicalConfigFormState(),
  skillIds: [],
  connectionIds: [],
  executionMode: 'test' as const,
  capital: '',
  telegramChatId: '',
  emailDelivery: 'inherit' as const,
  costPreset: '' as const,
  dailySpendBudgetUsd: '',
  tickIntervalMins: '',
  dailyMaxLossPct: '',
  maxDrawdownPct: '',
  maxSlippageBps: '',
  maxOpenPositions: '',
  maxPositionSizePct: '',
  stopLossPct: '',
  stopLossCooldownSecs: '',
  openPositionEscalationToJudgePolicy: 'uncovered_or_triggered' as const,
  strategyPreset: '',
  platformAssessmentEnabled: false,
  platformAssessmentReviewIntervalHours: '',
  subscribedSources: [] as string[],
  pendingFiles: [] as File[],
  authorizationMode: 'direct' as const,
};

describe('intentToFormState — permissionLevel passthrough', () => {
  it('passes through "restricted" from intent', () => {
    const result = intentToFormState({ ...BASE_INTENT, permissionLevel: 'restricted' });
    expect(result.permissionLevel).toBe('restricted');
  });

  it('passes through "standard" from intent', () => {
    const result = intentToFormState({ ...BASE_INTENT, permissionLevel: 'standard' });
    expect(result.permissionLevel).toBe('standard');
  });

  it('passes through "full" from intent', () => {
    const result = intentToFormState({ ...BASE_INTENT, permissionLevel: 'full' });
    expect(result.permissionLevel).toBe('full');
  });

  it('defaults to "standard" when permissionLevel is undefined', () => {
    const result = intentToFormState({ ...BASE_INTENT });
    expect(result.permissionLevel).toBe('standard');
  });
});
