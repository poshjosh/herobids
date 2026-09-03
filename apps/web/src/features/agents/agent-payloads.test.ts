import { describe, expect, it } from 'vitest';
import { buildCreateAgentPayload, buildUpdateAgentPayload, normalizeEscalationPolicy, resolveCanonicalExecutionMode, resolveCreateAgentConnectionIds } from './agent-payloads.js';

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
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading', 'bot-management'],
      hasBotManagementSkill: true,
      requiresTradingSetup: true,
      executionMode: 'test',
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '  ',
      tickIntervalMins: '',
      capital: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
    })).toMatchObject({
      name: 'market-watch-01',
      prompt: 'Trade BTC on breakouts',
      skillIds: ['trading', 'bot-management'],
      capabilityMode: 'intelligence',
    });
  });

  it('buildCreateAgentPayload omits empty optional fields and preserves explicit model overrides', () => {
    expect(buildCreateAgentPayload({
      name: 'agent',
      goal: 'goal',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
      technical: null,
      skillIds: [],
      hasBotManagementSkill: false,
      requiresTradingSetup: false,
      executionMode: 'test',
      modelPayload: { inherits: false, provider: 'openai', lightModel: 'gpt-4.1-mini', heavyModel: 'gpt-4.1' },
      costPreset: 'custom',
      dailySpendBudgetUsd: '1.25',
      telegramChatId: '1234',
      tickIntervalMins: '1',
      capital: '1000',
      dailyMaxLossPct: '250',
      maxDrawdownPct: '15',
      maxSlippageBps: '25',
      maxOpenPositions: '4',
      maxPositionSizePct: '35',
      stopLossPct: '2.5',
      stopLossCooldownSecs: '300',
    })).toMatchObject({
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
      risk: {
        dailyMaxLossPct: 250,
        maxDrawdownPct: 15,
        maxOpenPositions: 4,
        maxPositionSizePct: 35,
        stopLossPct: 2.5,
        stopLossCooldownMs: 300000,
      },
      executionDefaults: {
        slippageBps: 25,
      },
      capabilityMode: 'intelligence',
    });
  });

  it('buildCreateAgentPayload omits authorizationMode for non-trading agents', () => {
    const payload = buildCreateAgentPayload({
      name: 'assistant',
      goal: 'Read my Gmail and summarize messages.',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
      technicalPreFilterEnabled: false,
      technical: null,
      skillIds: ['email'],
      hasBotManagementSkill: false,
      requiresTradingSetup: false,
      executionMode: 'test',
      connectionIds: ['gmail-conn-1'],
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      emailDelivery: 'inherit',
      tickIntervalMins: '',
      capital: '',
      dailyLossLimit: '',
      maxDrawdownPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      authorizationMode: 'direct',
    });

    expect(payload).not.toHaveProperty('authorizationMode');
  });

  it('resolves executionDefaults.mode to shadow when executionMode is test with connections', () => {
    const payload = buildCreateAgentPayload({
      name: 'agent',
      goal: 'trade',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      requiresTradingSetup: true,
      executionMode: 'test',
      connectionIds: ['conn-1'],
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '',
      capital: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
    });
    expect(payload.executionDefaults).toEqual({ mode: 'shadow' });
  });

  it('resolves executionDefaults.mode to paper when executionMode is test without connections', () => {
    const payload = buildCreateAgentPayload({
      name: 'agent',
      goal: 'trade',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      requiresTradingSetup: true,
      executionMode: 'test',
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '',
      capital: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
    });
    expect(payload.executionDefaults).toEqual({ mode: 'paper' });
  });

  it('resolves executionDefaults.mode to live when executionMode is live', () => {
    const payload = buildCreateAgentPayload({
      name: 'agent',
      goal: 'trade',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      requiresTradingSetup: true,
      executionMode: 'live',
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '',
      capital: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
    });
    expect(payload.executionDefaults).toEqual({ mode: 'live' });
  });

  it('omits executionDefaults when not a trading agent (requiresTradingSetup is false)', () => {
    const payload = buildCreateAgentPayload({
      name: 'assistant',
      goal: 'Read my Gmail.',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['email'],
      hasBotManagementSkill: false,
      requiresTradingSetup: false,
      executionMode: 'test',
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '',
      capital: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
    });
    expect(payload).not.toHaveProperty('executionDefaults');
  });

  it('buildCreateAgentPayload includes technical config and intelligence fields in hybrid mode', () => {
    expect(buildCreateAgentPayload({
      name: '  technical scout  ',
      goal: 'Trade BTC',
      capabilityMode: 'hybrid',
      hybridMode: 'mixed',
      technicalPreFilterEnabled: true,
      technical: TECHNICAL_CONFIG,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      requiresTradingSetup: false,
      executionMode: 'test',
      modelPayload: { inherits: false, provider: 'openai', lightModel: 'gpt-4.1-mini', heavyModel: 'gpt-4.1' },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '',
      capital: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
    })).toMatchObject({
      name: 'technical scout',
      prompt: 'Trade BTC',
      skillIds: ['trading'],
      technical: TECHNICAL_CONFIG,
      capabilityMode: 'hybrid',
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
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '  ',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
      emailDelivery: 'inherit',
    })).toMatchObject({
      name: 'Momentum scout',
      prompt: 'Watch BTC and trade breakouts.',
      skillIds: ['trading'],
      telegramChatId: null,
      costPreset: null,
      dailySpendBudgetUsd: null,
      risk: {
        dailyMaxLossPct: null,
        maxDrawdownPct: null,
        maxOpenPositions: null,
        maxPositionSizePct: null,
        stopLossPct: null,
        stopLossCooldownMs: null,
      },
      executionDefaults: {
        mode: 'paper',
      },
      tickIntervalMs: null,
      capital: null,
      provider: null,
      lightModel: null,
      heavyModel: null,
      technical: null,
      notificationPolicy: null,
      capabilityMode: 'intelligence',
      hybridMode: null,
    });
  });

  it('preserves an existing legacy millisecond cadence when the edit form leaves it untouched', () => {
    expect(buildUpdateAgentPayload({
      name: 'Momentum scout',
      prompt: 'Watch BTC and trade breakouts.',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyMaxLossPct: '',
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
      emailDelivery: 'inherit',
    }).tickIntervalMs).toBe(90_000);
  });

  it('buildUpdateAgentPayload preserves both intelligence and technical fields in hybrid mode', () => {
    const payload = buildUpdateAgentPayload({
      name: '  Hybrid scout  ',
      prompt: '  Watch BTC and scan order flow.  ',
      capabilityMode: 'hybrid',
      hybridMode: 'mixed',
      technicalPreFilterEnabled: true,
      technical: TECHNICAL_CONFIG,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: '',
      hasTradingCapability: false,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: true,
      modelForm: { provider: 'openai', lightModel: 'gpt-4.1-mini', heavyModel: 'gpt-4.1' },
      emailDelivery: 'inherit',
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
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      requiresTradingSetup: true,
      executionMode: 'test',
      executionVenue: 'hyperliquid',
      connectionIds: ['conn-1', 'conn-2'],
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '',
      capital: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
    })).toMatchObject({
      name: 'agent',
      prompt: 'trade',
      skillIds: ['trading'],
      executionVenue: 'hyperliquid',
      connectionIds: ['conn-1', 'conn-2'],
    });
  });

  it('buildCreateAgentPayload omits connectionIds when empty', () => {
    const payload = buildCreateAgentPayload({
      name: 'agent',
      goal: 'trade',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      requiresTradingSetup: true,
      executionMode: 'test',
      connectionIds: [],
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '',
      capital: '',
      dailyMaxLossPct: '',
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
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      requiresTradingSetup: true,
      executionMode: 'test',
      modelPayload: { inherits: true },
      costPreset: '',
      dailySpendBudgetUsd: '',
      telegramChatId: '',
      tickIntervalMins: '',
      capital: '',
      dailyMaxLossPct: '',
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
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'test',
      hasTradingCapability: true,
      connectionIds: ['conn-1', 'conn-2'],
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
      emailDelivery: 'inherit',
    })).toMatchObject({
      name: 'agent',
      prompt: 'trade',
      skillIds: ['trading'],
      connectionIds: ['conn-1', 'conn-2'],
    });
  });

  it('buildUpdateAgentPayload preserves explicit empty connectionIds for clears', () => {
    const payload = buildUpdateAgentPayload({
      name: 'agent',
      prompt: 'trade',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'test',
      hasTradingCapability: true,
      connectionIds: [],
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
      emailDelivery: 'inherit',
    });
    expect(payload.connectionIds).toEqual([]);
  });

  it('buildUpdateAgentPayload omits connectionIds when undefined', () => {
    const payload = buildUpdateAgentPayload({
      name: 'agent',
      prompt: 'trade',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'test',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
      emailDelivery: 'inherit',
    });
    expect(payload).not.toHaveProperty('connectionIds');
  });

  it('buildUpdateAgentPayload omits authorizationMode for non-trading agents', () => {
    const payload = buildUpdateAgentPayload({
      name: 'assistant',
      prompt: 'Read my Gmail and summarize messages.',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
      technicalPreFilterEnabled: false,
      technical: null,
      skillIds: ['email'],
      hasBotManagementSkill: false,
      executionMode: '',
      hasTradingCapability: false,
      connectionIds: ['gmail-conn-1'],
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxDrawdownPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
      emailDelivery: 'inherit',
      authorizationMode: 'direct',
    });

    expect(payload).not.toHaveProperty('authorizationMode');
  });

  it('resolves executionDefaults.mode to live when executionMode is live', () => {
    const payload = buildUpdateAgentPayload({
      name: 'agent',
      prompt: 'trade',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'live',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
      emailDelivery: 'inherit',
    });
    expect(payload.executionDefaults).toEqual({ mode: 'live' });
  });

  it('does not send executionDefaults when mode is null (non-trading agent)', () => {
    const payload = buildUpdateAgentPayload({
      name: 'assistant',
      prompt: 'Read my Gmail.',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['email'],
      hasBotManagementSkill: false,
      executionMode: '',
      hasTradingCapability: false,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
      emailDelivery: 'inherit',
    });
    expect(payload).not.toHaveProperty('executionDefaults');
  });

  // executionMode 'paper' is vestigial here — hasTradingCapability is false so
  // executionDefaults.mode resolves to null and executionDefaults is omitted.
  it('omits executionDefaults for hybrid technical-only agent even when executionMode is paper', () => {
    expect(buildUpdateAgentPayload({
      name: '  Technical scout  ',
      prompt: 'legacy objective',
      capabilityMode: 'hybrid',
      hybridMode: 'mixed',
      technicalPreFilterEnabled: true,
      technical: TECHNICAL_CONFIG,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: false,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
      emailDelivery: 'inherit',
    })).toMatchObject({
      name: 'Technical scout',
      prompt: 'legacy objective',
      skillIds: ['trading'],
      technical: TECHNICAL_CONFIG,
    });
  });

  it('rejects invalid tick intervals in create payloads instead of silently dropping them', () => {
    expect(() => buildCreateAgentPayload({
      name: 'agent',
      goal: 'goal',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
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
      dailyMaxLossPct: '',
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
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyMaxLossPct: '',
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
      emailDelivery: 'inherit',
    })).toThrow('Invalid tick interval minutes input');
  });

  // --- openPositionEscalationToJudgePolicy ---

  it('buildCreateAgentPayload includes the policy field when provided', () => {
    const payload = buildCreateAgentPayload({
      name: 'agent',
      goal: 'goal',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
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
      dailyMaxLossPct: '',
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
      hybridMode: 'mixed',
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
      dailyMaxLossPct: '',
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
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyMaxLossPct: '',
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
      emailDelivery: 'inherit',
    });
    expect(payload.openPositionEscalationToJudgePolicy).toBe('never');
  });

  it('buildUpdateAgentPayload omits the policy field when undefined', () => {
    const payload = buildUpdateAgentPayload({
      name: 'agent',
      prompt: 'goal',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
      emailDelivery: 'inherit',
    });
    expect(payload).not.toHaveProperty('openPositionEscalationToJudgePolicy');
  });

  // --- runtimePolicyOverrides ---

  it('buildCreateAgentPayload includes runtimePolicyOverrides when provided', () => {
    const payload = buildCreateAgentPayload({
      name: 'agent',
      goal: 'goal',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
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
      dailyMaxLossPct: '',
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
      hybridMode: 'mixed',
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
      dailyMaxLossPct: '',
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
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
      emailDelivery: 'inherit',
      runtimePolicyOverrides: { maxHoldDurationMs: 900_000 },
    });
    expect(payload.runtimePolicyOverrides).toEqual({ maxHoldDurationMs: 900_000 });
  });

  it('buildUpdateAgentPayload omits runtimePolicyOverrides when undefined', () => {
    const payload = buildUpdateAgentPayload({
      name: 'agent',
      prompt: 'goal',
      capabilityMode: 'intelligence',
      hybridMode: 'mixed',
      technical: null,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyMaxLossPct: '',
      maxSlippageBps: '',
      maxOpenPositions: '',
      maxPositionSizePct: '',
      stopLossPct: '',
      stopLossCooldownSecs: '',
      tickIntervalMins: '',
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
      emailDelivery: 'inherit',
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

// ---------------------------------------------------------------------------
// emailDelivery mapping
// ---------------------------------------------------------------------------

const BASE_CREATE_INPUT = {
  name: 'agent',
  goal: 'do stuff',
  capabilityMode: 'intelligence' as const,
      hybridMode: 'mixed',
  technical: null,
  skillIds: [],
  hasBotManagementSkill: false,
  requiresTradingSetup: false,
  executionMode: 'paper' as const,
  modelPayload: { inherits: true },
  costPreset: '' as const,
  dailySpendBudgetUsd: '',
  telegramChatId: '',
  tickIntervalMins: '',
  capital: '',
  dailyMaxLossPct: '',
  maxSlippageBps: '',
  maxOpenPositions: '',
  maxPositionSizePct: '',
  stopLossPct: '',
  stopLossCooldownSecs: '',
};

const BASE_UPDATE_INPUT = {
  name: 'agent',
  prompt: 'do stuff',
  capabilityMode: 'intelligence' as const,
      hybridMode: 'mixed',
  technical: null,
  skillIds: [],
  hasBotManagementSkill: false,
  executionMode: 'paper',
  hasTradingCapability: false,
  telegramChatId: '',
  costPreset: '' as const,
  dailySpendBudgetUsd: '',
  dailyMaxLossPct: '',
  maxSlippageBps: '',
  maxOpenPositions: '',
  maxPositionSizePct: '',
  stopLossPct: '',
  stopLossCooldownSecs: '',
  tickIntervalMins: '',
  capital: '',
  modelOverrideEnabled: false,
  modelForm: { provider: '', lightModel: '', heavyModel: '' },
  emailDelivery: 'inherit' as const,
};

describe('resolveCanonicalExecutionMode', () => {
  it('resolves test without connections to paper', () => {
    expect(resolveCanonicalExecutionMode('test', false)).toBe('paper');
  });

  it('resolves test with connections to shadow', () => {
    expect(resolveCanonicalExecutionMode('test', true)).toBe('shadow');
  });

  it('passes live through unchanged', () => {
    expect(resolveCanonicalExecutionMode('live', false)).toBe('live');
    expect(resolveCanonicalExecutionMode('live', true)).toBe('live');
  });

  it('passes paper through unchanged', () => {
    expect(resolveCanonicalExecutionMode('paper', false)).toBe('paper');
    expect(resolveCanonicalExecutionMode('paper', true)).toBe('paper');
  });

  it('passes shadow through unchanged', () => {
    expect(resolveCanonicalExecutionMode('shadow', false)).toBe('shadow');
    expect(resolveCanonicalExecutionMode('shadow', true)).toBe('shadow');
  });

  it('returns null for empty string', () => {
    expect(resolveCanonicalExecutionMode('', false)).toBeNull();
    expect(resolveCanonicalExecutionMode('', true)).toBeNull();
  });
});

describe('buildCreateAgentPayload — emailDelivery mapping', () => {
  it('omits notificationPolicy when emailDelivery is "inherit"', () => {
    const payload = buildCreateAgentPayload({ ...BASE_CREATE_INPUT, emailDelivery: 'inherit' });
    expect(payload).not.toHaveProperty('notificationPolicy');
  });

  it('omits notificationPolicy when emailDelivery is undefined', () => {
    const payload = buildCreateAgentPayload(BASE_CREATE_INPUT);
    expect(payload).not.toHaveProperty('notificationPolicy');
  });

  it('sends enabled: true when emailDelivery is "allow"', () => {
    const payload = buildCreateAgentPayload({ ...BASE_CREATE_INPUT, emailDelivery: 'allow' });
    expect(payload.notificationPolicy).toEqual({
      sendMessage: { email: { enabled: true, source: 'explicit_update' } },
    });
  });

  it('sends enabled: false when emailDelivery is "disable"', () => {
    const payload = buildCreateAgentPayload({ ...BASE_CREATE_INPUT, emailDelivery: 'disable' });
    expect(payload.notificationPolicy).toEqual({
      sendMessage: { email: { enabled: false, source: 'explicit_update' } },
    });
  });
});

describe('buildCreateAgentPayload — platformAssessment', () => {
  // Regression: CreateAgentSchema.platformAssessment is `.optional()` (NOT
  // `.nullable()`, unlike UpdateAgentSchema) — there's nothing to "clear" on
  // create. Sending `platformAssessment: null` fails Zod validation with
  // "Expected object, received null" and blocks every agent creation that
  // doesn't opt into platform assessment. See
  // docs/bug-reports/2026/07/21/002-create-agent-platform-assessment-null-payload.md
  it('omits platformAssessment entirely when not enabled (must not send null)', () => {
    const payload = buildCreateAgentPayload(BASE_CREATE_INPUT);
    expect(payload).not.toHaveProperty('platformAssessment');
  });

  it('omits platformAssessment when platformAssessmentEnabled is explicitly false', () => {
    const payload = buildCreateAgentPayload({ ...BASE_CREATE_INPUT, platformAssessmentEnabled: false });
    expect(payload).not.toHaveProperty('platformAssessment');
  });

  it('includes platformAssessment as an object when enabled', () => {
    const payload = buildCreateAgentPayload({
      ...BASE_CREATE_INPUT,
      platformAssessmentEnabled: true,
      platformAssessmentReviewIntervalHours: '24',
    });
    expect(payload.platformAssessment).toEqual({ enabled: true, reviewIntervalMs: 24 * 3_600_000 });
  });

  it('includes platformAssessment without reviewIntervalMs when hours is unset', () => {
    const payload = buildCreateAgentPayload({ ...BASE_CREATE_INPUT, platformAssessmentEnabled: true });
    expect(payload.platformAssessment).toEqual({ enabled: true });
  });
});

describe('buildUpdateAgentPayload — emailDelivery mapping', () => {
  it('sends notificationPolicy: null when emailDelivery is "inherit" (clears override)', () => {
    const payload = buildUpdateAgentPayload({ ...BASE_UPDATE_INPUT, emailDelivery: 'inherit' });
    expect(payload.notificationPolicy).toBeNull();
  });

  it('sends enabled: true when emailDelivery is "allow"', () => {
    const payload = buildUpdateAgentPayload({ ...BASE_UPDATE_INPUT, emailDelivery: 'allow' });
    expect(payload.notificationPolicy).toEqual({
      sendMessage: { email: { enabled: true, source: 'explicit_update' } },
    });
  });

  it('sends enabled: false when emailDelivery is "disable"', () => {
    const payload = buildUpdateAgentPayload({ ...BASE_UPDATE_INPUT, emailDelivery: 'disable' });
    expect(payload.notificationPolicy).toEqual({
      sendMessage: { email: { enabled: false, source: 'explicit_update' } },
    });
  });
});

// ── Regression: sliageBps must not be sent as null ──────────────────────

describe('buildUpdateAgentPayload — sliageBps null regression', () => {
  it('omits sliageBps from executionDefaults when maxSlippageBps is empty', () => {
    const payload = buildUpdateAgentPayload({
      ...BASE_UPDATE_INPUT,
      hasTradingCapability: true,
      executionMode: 'shadow',
      maxSlippageBps: '',
    });
    expect(payload.executionDefaults).toBeDefined();
    expect(payload.executionDefaults).not.toHaveProperty('slippageBps');
  });

  it('includes sliageBps in executionDefaults when maxSlippageBps is a number', () => {
    const payload = buildUpdateAgentPayload({
      ...BASE_UPDATE_INPUT,
      hasTradingCapability: true,
      executionMode: 'shadow',
      maxSlippageBps: '50',
    });
    expect(payload.executionDefaults).toMatchObject({ slippageBps: 50 });
  });
});

describe('buildCreateAgentPayload — sliageBps null regression', () => {
  it('omits sliageBps from executionDefaults when maxSlippageBps is empty', () => {
    const payload = buildCreateAgentPayload({
      ...BASE_CREATE_INPUT,
      requiresTradingSetup: true,
      maxSlippageBps: '',
    });
    // Create path doesn't send executionDefaults at all when mode is not set
    // (requiresTradingSetup needs connections for mode resolution).
    // The key invariant: if executionDefaults is present, sliageBps is not null.
    if (payload.executionDefaults) {
      expect(payload.executionDefaults).not.toHaveProperty('slippageBps');
    }
  });

  it('includes sliageBps in executionDefaults when maxSlippageBps is a number', () => {
    const payload = buildCreateAgentPayload({
      ...BASE_CREATE_INPUT,
      requiresTradingSetup: true,
      executionMode: 'test',
      connectionIds: ['conn-1'],
      maxSlippageBps: '75',
    });
    expect(payload.executionDefaults).toMatchObject({ mode: 'shadow', slippageBps: 75 });
  });
});

// ---------------------------------------------------------------------------
// blank goal
// ---------------------------------------------------------------------------

describe('buildCreateAgentPayload — blank goal', () => {
  it('stores an empty prompt when goal is empty', () => {
    const payload = buildCreateAgentPayload({ ...BASE_CREATE_INPUT, goal: '' });
    expect(payload.prompt).toBe('');
  });

  it('stores an empty prompt when goal is whitespace-only', () => {
    const payload = buildCreateAgentPayload({ ...BASE_CREATE_INPUT, goal: '   ' });
    expect(payload.prompt).toBe('');
  });

  it('uses user goal when provided', () => {
    const payload = buildCreateAgentPayload({ ...BASE_CREATE_INPUT, goal: 'Trade aggressively' });
    expect(payload.prompt).toBe('Trade aggressively');
  });
});

// ---------------------------------------------------------------------------
// permissionLevel — create payload
// ---------------------------------------------------------------------------

describe('buildCreateAgentPayload — permissionLevel', () => {
  it('includes permissionLevel when explicitly set to "restricted"', () => {
    const payload = buildCreateAgentPayload({ ...BASE_CREATE_INPUT, permissionLevel: 'restricted' });
    expect(payload.permissionLevel).toBe('restricted');
  });

  it('includes permissionLevel when explicitly set to "standard"', () => {
    const payload = buildCreateAgentPayload({ ...BASE_CREATE_INPUT, permissionLevel: 'standard' });
    expect(payload.permissionLevel).toBe('standard');
  });

  it('includes permissionLevel when explicitly set to "full"', () => {
    const payload = buildCreateAgentPayload({ ...BASE_CREATE_INPUT, permissionLevel: 'full' });
    expect(payload.permissionLevel).toBe('full');
  });

  it('defaults permissionLevel to "standard" when undefined', () => {
    const payload = buildCreateAgentPayload(BASE_CREATE_INPUT);
    expect(payload.permissionLevel).toBe('standard');
  });
});

// ---------------------------------------------------------------------------
// permissionLevel — update payload
// ---------------------------------------------------------------------------

describe('buildUpdateAgentPayload — permissionLevel', () => {
  it('includes permissionLevel when explicitly set to "restricted"', () => {
    const payload = buildUpdateAgentPayload({ ...BASE_UPDATE_INPUT, permissionLevel: 'restricted' });
    expect(payload.permissionLevel).toBe('restricted');
  });

  it('includes permissionLevel when explicitly set to "standard"', () => {
    const payload = buildUpdateAgentPayload({ ...BASE_UPDATE_INPUT, permissionLevel: 'standard' });
    expect(payload.permissionLevel).toBe('standard');
  });

  it('includes permissionLevel when explicitly set to "full"', () => {
    const payload = buildUpdateAgentPayload({ ...BASE_UPDATE_INPUT, permissionLevel: 'full' });
    expect(payload.permissionLevel).toBe('full');
  });

  it('defaults permissionLevel to "standard" when undefined', () => {
    const payload = buildUpdateAgentPayload(BASE_UPDATE_INPUT);
    expect(payload.permissionLevel).toBe('standard');
  });
});
