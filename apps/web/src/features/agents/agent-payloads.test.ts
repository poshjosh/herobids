import { describe, expect, it } from 'vitest';
import { buildCreateAgentPayload, buildUpdateAgentPayload, resolveCreateAgentBindingId } from './agent-payloads.js';

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
      maxBots: '',
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
      maxBots: '5',
      capital: '1000',
      dailyLossLimit: '250',
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
      maxBots: '',
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

  it('resolveCreateAgentBindingId returns null when no binding is present', () => {
    expect(resolveCreateAgentBindingId(null)).toBeNull();
  });

  it('resolveCreateAgentBindingId returns the binding id when present', () => {
    expect(resolveCreateAgentBindingId({
      id: 'binding-1',
      connectionId: 'conn-1',
      provider: 'hyperliquid',
      label: 'Main',
      sourceVenueAccountId: 'va-1',
      status: 'active',
    })).toBe('binding-1');
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
      maxBots: '',
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
      maxBots: null,
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
      maxBots: '',
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
      technical: TECHNICAL_CONFIG,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: '',
      hasTradingCapability: false,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxBots: '',
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

  it('buildUpdateAgentPayload clears execution mode in technical-only mode even when the current agent used to trade', () => {
    expect(buildUpdateAgentPayload({
      name: '  Technical scout  ',
      prompt: 'legacy objective',
      capabilityMode: 'technical',
      technical: TECHNICAL_CONFIG,
      skillIds: ['trading'],
      hasBotManagementSkill: false,
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxBots: '',
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
      maxBots: '',
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
      maxBots: '',
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
});