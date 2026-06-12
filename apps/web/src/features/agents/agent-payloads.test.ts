import { describe, expect, it } from 'vitest';
import { buildCreateAgentPayload, buildUpdateAgentPayload, resolveCreateAgentBindingId } from './agent-payloads.js';

describe('agent payload builders', () => {
  it('buildCreateAgentPayload stores only the trimmed goal in prompt', () => {
    expect(buildCreateAgentPayload({
      name: '  market-watch-01  ',
      goal: '  Trade BTC on breakouts  ',
      skillIds: ['bot-management', 'trading'],
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
      skillIds: [],
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
      maxBots: 5,
      capital: '1000',
      dailyLossLimit: '250',
      maxSlippageBps: 25,
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
      skillIds: ['trading'],
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '  ',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxBots: '',
      maxSlippageBps: '',
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
      tickIntervalMs: null,
      capital: null,
      provider: null,
      lightModel: null,
      heavyModel: null,
    });
  });

  it('preserves an existing legacy millisecond cadence when the edit form leaves it untouched', () => {
    expect(buildUpdateAgentPayload({
      name: 'Momentum scout',
      prompt: 'Watch BTC and trade breakouts.',
      skillIds: ['trading'],
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxBots: '',
      maxSlippageBps: '',
      tickIntervalMins: '2',
      preserveOriginalTickIntervalMs: true,
      originalTickIntervalMs: 90_000,
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
    }).tickIntervalMs).toBe(90_000);
  });

  it('rejects invalid tick intervals in create payloads instead of silently dropping them', () => {
    expect(() => buildCreateAgentPayload({
      name: 'agent',
      goal: 'goal',
      skillIds: [],
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
    })).toThrow('Invalid tick interval minutes input');
  });

  it('rejects invalid tick intervals in update payloads when not preserving a legacy value', () => {
    expect(() => buildUpdateAgentPayload({
      name: 'Momentum scout',
      prompt: 'Watch BTC and trade breakouts.',
      skillIds: ['trading'],
      executionMode: 'paper',
      hasTradingCapability: true,
      telegramChatId: '',
      costPreset: '',
      dailySpendBudgetUsd: '',
      dailyLossLimit: '',
      maxBots: '',
      maxSlippageBps: '',
      tickIntervalMins: '1.5',
      preserveOriginalTickIntervalMs: false,
      originalTickIntervalMs: 90_000,
      capital: '',
      modelOverrideEnabled: false,
      modelForm: { provider: '', lightModel: '', heavyModel: '' },
    })).toThrow('Invalid tick interval minutes input');
  });
});