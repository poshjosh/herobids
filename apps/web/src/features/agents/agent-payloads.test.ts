import { describe, expect, it } from 'vitest';
import { buildCreateAgentPayload, buildUpdateAgentPayload, normalizeEscalationPolicy, resolveCreateAgentConnectionIds } from './agent-payloads.js';

const TECHNICAL_CONFIG = {
  filters: {
    venue: 'hyperliquid',
    venueType: 'orderbook' as const,
    minVolume24hUsd: 0,
  },
  indicators: {
    rsi: { enabled: true, period: 14, healthyMin: 40, healthyMax: 70, overbought: 80, weakBelow: 30 },
    macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
    volume: { enabled: true, strongRatio: 1.5, weakRatio: 0.5, recentBars: 4, avgBars: 20 },
    choch: { enabled: false, swingLookback: 5, minSwingPct: 0.01, confirmBars: 2, rejectOnBearish: false },
    supportResistance: { enabled: false, lookback: 50, breakoutThreshold: 0.005 },
    confidence: {
      rsiWeight: 0.15,
      macdCrossoverWeight: 0.2,
      macdIncreasingWeight: 0.1,
      volumeWeight: 0.15,
      breakoutWeight: 0.15,
      chochBullishWeight: 0.15,
      chochBearishPenalty: 0.1,
      priceActionWeight: 0,
      minConfidence: 0,
      minReasons: 2,
    },
  },
  candles: { interval: '15m' as const, limit: 100 },
  signalBias: 'trend-following' as const,
  scanIntervalMs: 60_000,
  scanBatchSize: 5,
};

describe('agent payload builders', () => {
  it('buildCreateAgentPayload stores only the trimmed goal in prompt', () => {
    expect(buildCreateAgentPayload({
      name: '  market-watch-01  ',
      goal: '  Trade BTC on breakouts  ',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: ['bot-management', 'trading'],
      hasBotManagementSkill: true,
      requiresTradingSetup: true,
      executionMode: 'paper',
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '  ',
      tickIntervalMins: '',
      capital: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
    })).toEqual({
      name: 'market-watch-01',
      prompt: 'Trade BTC on breakouts',
      skillIds: ['bot-management', 'trading'],
      executionMode: 'paper',
    });
  });

  it('buildCreateAgentPayload omits empty optional fields and preserves explicit model overrides', () => {
    expect(buildCreateAgentPayload({
      name: 'agent',
      goal: 'goal',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: [],
      hasBotManagementSkill: false,
      requiresTradingSetup: false,
      executionMode: 'paper',
      modelPayload: { inherits: false, provider: 'openai', lightModel: 'gpt-4.1-mini', heavyModel: 'gpt-4.1' },
      costPreset: 'custom',
      dailySpendBudgetUsd: '1.25',
      telegramChatId: '1234',
      tickIntervalMins: '1',
      capital: '1000',
      dailyLossLimit: '250',
      maxDrawdown: '5000',
      maxDrawdownPct: '15',
      maxSlippageBps: '25',
      maxOpenPositions: '4',
      maxPositionSizePct: '35',
      stopLossPct: '2.5',
      stopLossCooldownSecs: '300',
    })).toEqual({
      name: 'agent',
      prompt: 'goal',
      skillIds: [],
      provider: 'openai',
      lightModel: 'gpt-4.1-mini',
      heavyModel: 'gpt-4.1',
      costPreset: 'custom',
      dailySpendBudgetUsd: 1.25,
      telegramChatId: '1234',
      tickIntervalMs: 60_000,
      capital: '1000',
      dailyLossLimit: '250',
      maxDrawdown: '5000',
      maxDrawdownPct: 15,
      maxSlippageBps: 25,
      maxOpenPositions: 4,
      maxPositionSizePct: 35,
      stopLossPct: 2.5,
      stopLossCooldownMs: 300000,
    });
  });

  it('buildCreateAgentPayload includes technical config and clears intelligence fields in technical-only mode', () => {
    expect(buildCreateAgentPayload({
      name: '  technical scout  ',
      goal: 'This should not be sent',
      capabilityMode: 'technical',
      technicalPreFilterEnabled: true,
      technical: TECHNICAL_CONFIG,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      requiresTradingSetup: false,
      executionMode: 'paper',
      modelPayload: { inherits: false, provider: 'openai', lightModel: 'gpt-4.1-mini', heavyModel: 'gpt-4.1' },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '',
      capital: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
    })).toEqual({
      name: 'technical scout',
      prompt: '',
      skillIds: [],
      technical: TECHNICAL_CONFIG,
    });
  });

  it('resolveCreateAgentConnectionIds returns empty array when no connection is present', () => {
    expect(resolveCreateAgentConnectionIds(null)).toEqual([]);
  });

  it('resolveCreateAgentConnectionIds returns single-element array when connection is present', () => {
    expect(resolveCreateAgentConnectionIds({
      id: 'conn-1',
      provider: 'hyperliquid',
      label: 'Main',
      status: 'active',
      credentialId: 'cred-1',
      createdAt: '2026-01-01T00:00:00Z',
    })).toEqual(['conn-1']);
  });

  it('buildUpdateAgentPayload normalizes an edited legacy prompt back to pure intent', () => {
    expect(buildUpdateAgentPayload({
      name: '  Momentum scout  ',
      prompt: '  Watch BTC and trade breakouts.  ',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '  ',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
    })).toEqual({
      name: 'Momentum scout',
      prompt: 'Watch BTC and trade breakouts.',
      skillIds: ['trading'],
      executionMode: 'paper',
      telegramChatId: null,
      costPreset: null,
      dailySpendBudgetUsd: null,
      dailyLossLimit: null,
      maxDrawdown: null,
      maxDrawdownPct: null,
      maxSlippageBps: null,
      maxOpenPositions: null,
      maxPositionSizePct: null,
      stopLossPct: null,
      stopLossCooldownMs: null,
      tickIntervalMs: null,
      capital: null,
      provider: null,
      lightModel: null,
      heavyModel: null,
      technical: null,
    });
  });

  it('preserves an existing legacy millisecond cadence when the edit form leaves it untouched', () => {
    expect(buildUpdateAgentPayload({
      name: 'Momentum scout',
      prompt: 'Watch BTC and trade breakouts.',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '2',
      preserveOriginalTickIntervalMs: true,
      originalTickIntervalMs: 90_000,
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
    }).tickIntervalMs).toBe(90_000);
  });

  it('buildUpdateAgentPayload preserves both intelligence and technical fields in both mode', () => {
    const payload = buildUpdateAgentPayload({
      name: '  Hybrid scout  ',
      prompt: '  Watch BTC and scan order flow.  ',
      capabilityMode: 'both',
      technicalPreFilterEnabled: true,
      technical: TECHNICAL_CONFIG,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: '',
      hasTradingCapability: false,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: true,
      modelForm: { provider: 'openai', lightModel: 'gpt-4.1-mini', heavyModel: 'gpt-4.1' },
    });

    expect(payload.name).toBe('Hybrid scout');
    expect(payload.prompt).toBe('Watch BTC and scan order flow.');
    expect(payload.skillIds).toEqual(['trading']);
    expect(payload.provider).toBe('openai');
    expect(payload.lightModel).toBe('gpt-4.1-mini');
    expect(payload.heavyModel).toBe('gpt-4.1');
    expect(payload.technical).toEqual(TECHNICAL_CONFIG);
  });

  it('buildCreateAgentPayload includes connectionIds when provided', () => {
    expect(buildCreateAgentPayload({
      name: 'agent',
      goal: 'trade',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      requiresTradingSetup: true,
      executionMode: 'paper',
      connectionIds: ['conn-1', 'conn-2'],
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '',
      capital: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
    })).toMatchObject({
      name: 'agent',
      prompt: 'trade',
      skillIds: ['trading'],
      executionMode: 'paper',
      connectionIds: ['conn-1', 'conn-2'],
    });
  });

  it('buildCreateAgentPayload omits connectionIds when empty', () => {
    const payload = buildCreateAgentPayload({
      name: 'agent',
      goal: 'trade',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      requiresTradingSetup: true,
      executionMode: 'paper',
      connectionIds: [],
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '',
      capital: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
    });
    expect(payload).not.toHaveProperty('connectionIds');
  });

  it('buildCreateAgentPayload omits connectionIds when undefined', () => {
    const payload = buildCreateAgentPayload({
      name: 'agent',
      goal: 'trade',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      requiresTradingSetup: true,
      executionMode: 'paper',
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '',
      capital: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
    });
    expect(payload).not.toHaveProperty('connectionIds');
  });

  it('buildUpdateAgentPayload includes connectionIds when provided', () => {
    expect(buildUpdateAgentPayload({
      name: 'agent',
      prompt: 'trade',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      connectionIds: ['conn-1', 'conn-2'],
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
    })).toMatchObject({
      name: 'agent',
      prompt: 'trade',
      skillIds: ['trading'],
      connectionIds: ['conn-1', 'conn-2'],
    });
  });

  it('buildUpdateAgentPayload omits connectionIds when empty', () => {
    const payload = buildUpdateAgentPayload({
      name: 'agent',
      prompt: 'trade',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      connectionIds: [],
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
    });
    expect(payload).not.toHaveProperty('connectionIds');
  });

  it('buildUpdateAgentPayload omits connectionIds when undefined', () => {
    const payload = buildUpdateAgentPayload({
      name: 'agent',
      prompt: 'trade',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
    });
    expect(payload).not.toHaveProperty('connectionIds');
  });

  it('buildUpdateAgentPayload clears execution mode in technical-only mode even when the current agent used to trade', () => {
    expect(buildUpdateAgentPayload({
      name: '  Technical scout  ',
      prompt: 'legacy objective',
      capabilityMode: 'technical',
      technicalPreFilterEnabled: true,
      technical: TECHNICAL_CONFIG,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
    })).toMatchObject({
      name: 'Technical scout',
      prompt: '',
      skillIds: [],
      executionMode: null,
      technical: TECHNICAL_CONFIG,
    });
  });

  it('rejects invalid tick intervals in create payloads instead of silently dropping them', () => {
    expect(() => buildCreateAgentPayload({
      name: 'agent',
      goal: 'goal',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: [],
      hasBotManagementSkill: false,
      requiresTradingSetup: false,
      executionMode: 'paper',
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '0',
      capital: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
    })).toThrow('Invalid tick interval minutes input');
  });

  it('rejects invalid tick intervals in update payloads when not preserving a legacy value', () => {
    expect(() => buildUpdateAgentPayload({
      name: 'Momentum scout',
      prompt: 'Watch BTC and trade breakouts.',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '1.5',
      preserveOriginalTickIntervalMs: false,
      originalTickIntervalMs: 90_000,
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
    })).toThrow('Invalid tick interval minutes input');
  });

  // --- openPositionEscalationToJudgePolicy ---

  it('buildCreateAgentPayload includes the policy field when provided', () => {
    const payload = buildCreateAgentPayload({
      name: 'agent',
      goal: 'goal',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: [],
      hasBotManagementSkill: false,
      requiresTradingSetup: false,
      executionMode: 'paper',
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '',
      capital: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      openPositionEscalationToJudgePolicy: 'always',
    });
    expect(payload.openPositionEscalationToJudgePolicy).toBe('always');
  });

  it('buildCreateAgentPayload omits the policy field when not provided', () => {
    const payload = buildCreateAgentPayload({
      name: 'agent',
      goal: 'goal',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: [],
      hasBotManagementSkill: false,
      requiresTradingSetup: false,
      executionMode: 'paper',
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '',
      capital: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
    });
    expect(payload).not.toHaveProperty('openPositionEscalationToJudgePolicy');
  });

  it('buildUpdateAgentPayload includes the policy field when defined', () => {
    const payload = buildUpdateAgentPayload({
      name: 'agent',
      prompt: 'goal',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      openPositionEscalationToJudgePolicy: 'never',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
    });
    expect(payload.openPositionEscalationToJudgePolicy).toBe('never');
  });

  it('buildUpdateAgentPayload omits the policy field when undefined', () => {
    const payload = buildUpdateAgentPayload({
      name: 'agent',
      prompt: 'goal',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
    });
    expect(payload).not.toHaveProperty('openPositionEscalationToJudgePolicy');
  });

  // --- runtimePolicyOverrides ---

  it('buildCreateAgentPayload includes runtimePolicyOverrides when provided', () => {
    const payload = buildCreateAgentPayload({
      name: 'agent',
      goal: 'goal',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: [],
      hasBotManagementSkill: false,
      requiresTradingSetup: false,
      executionMode: 'paper',
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '',
      capital: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      runtimePolicyOverrides: { scoutMaxTurns: 50 },
    });
    expect(payload.runtimePolicyOverrides).toEqual({ scoutMaxTurns: 50 });
  });

  it('buildCreateAgentPayload omits runtimePolicyOverrides when not provided', () => {
    const payload = buildCreateAgentPayload({
      name: 'agent',
      goal: 'goal',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: [],
      hasBotManagementSkill: false,
      requiresTradingSetup: false,
      executionMode: 'paper',
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '',
      capital: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
    });
    expect(payload).not.toHaveProperty('runtimePolicyOverrides');
  });

  it('buildUpdateAgentPayload includes runtimePolicyOverrides when provided', () => {
    const payload = buildUpdateAgentPayload({
      name: 'agent',
      prompt: 'goal',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
      runtimePolicyOverrides: { maxHoldDurationMs: 900_000 },
    });
    expect(payload.runtimePolicyOverrides).toEqual({ maxHoldDurationMs: 900_000 });
  });

  it('buildUpdateAgentPayload omits runtimePolicyOverrides when undefined', () => {
    const payload = buildUpdateAgentPayload({
      name: 'agent',
      prompt: 'goal',
      capabilityMode: 'intelligence',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
    });
    expect(payload).not.toHaveProperty('runtimePolicyOverrides');
  });
});

describe('normalizeEscalationPolicy', () => {
  it('returns null for null', () => {
    expect(normalizeEscalationPolicy(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(normalizeEscalationPolicy(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeEscalationPolicy('')).toBeNull();
  });

  it('returns the value for a valid policy string', () => {
    expect(normalizeEscalationPolicy('never')).toBe('never');
    expect(normalizeEscalationPolicy('uncovered_or_triggered')).toBe('uncovered_or_triggered');
    expect(normalizeEscalationPolicy('always')).toBe('always');
  });

  it('returns null for an invalid string', () => {
    expect(normalizeEscalationPolicy('sometimes')).toBeNull();
    expect(normalizeEscalationPolicy('NEVER')).toBeNull();
    expect(normalizeEscalationPolicy('unknown')).toBeNull();
  });
});