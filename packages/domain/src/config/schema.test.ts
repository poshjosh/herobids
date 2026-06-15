import { describe, expect, it } from 'vitest';
import {
  UsageBillingConfigSchema,
  BotConfigSchema,
  PublicStreamConfigSchema,
  MarkingConfigSchema,
  AgentRuntimePolicySchema,
  StrategyConfigSchema,
  MomentumParamsSchema,
  LlmParamsSchema,
} from './schema.js';

describe('UsageBillingConfigSchema', () => {
  it('rejects unknown provider keys in top-up mappings', () => {
    expect(() => UsageBillingConfigSchema.parse({
      topUpProductsByProvider: {
        unknown: [
          { packId: 'starter_500', externalId: 'external_1', cents: 500 },
        ],
      },
    })).toThrow();
  });

  it('rejects duplicate pack IDs across providers', () => {
    expect(() => UsageBillingConfigSchema.parse({
      topUpProductsByProvider: {
        stripe: [
          { packId: 'starter_500', externalId: 'price_1', cents: 500 },
        ],
        creem: [
          { packId: 'starter_500', externalId: 'product_1', cents: 500 },
        ],
      },
    })).toThrow();
  });

  it('rejects duplicate pack IDs within a single provider', () => {
    expect(() => UsageBillingConfigSchema.parse({
      topUpProductsByProvider: {
        stripe: [
          { packId: 'starter_500', externalId: 'price_1', cents: 500 },
          { packId: 'starter_500', externalId: 'price_2', cents: 750 },
        ],
      },
    })).toThrow();
  });
});

describe('BotConfigSchema', () => {
  const validBase = {
    strategy: { type: 'momentum' },
    venue: 'hyperliquid',
    symbol: 'SOL/USDC',
  };

  it('accepts valid config with swapAssets', () => {
    const result = BotConfigSchema.safeParse({
      ...validBase,
      venue: 'jupiter',
      venueType: 'swap',
      execution: { mode: 'shadow' },
      swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.swapAssets).toEqual({ baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 });
    }
  });

  it('swapAssets is optional — defaults to undefined', () => {
    const result = BotConfigSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.swapAssets).toBeUndefined();
    }
  });

  it('rejects swapAssets with missing baseAsset', () => {
    const result = BotConfigSchema.safeParse({
      ...validBase,
      swapAssets: { quoteAsset: 'USDC' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects swapAssets with missing quoteAsset', () => {
    const result = BotConfigSchema.safeParse({
      ...validBase,
      swapAssets: { baseAsset: 'SOL' },
    });
    expect(result.success).toBe(false);
  });

  it('defaults venueType to orderbook', () => {
    const result = BotConfigSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.venueType).toBe('orderbook');
    }
  });

  it('defaults shadowPollIntervalMs to 2000', () => {
    const result = BotConfigSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shadowPollIntervalMs).toBe(2000);
    }
  });

  it('rejects shadowPollIntervalMs below 100', () => {
    const result = BotConfigSchema.safeParse({
      ...validBase,
      shadowPollIntervalMs: 50,
    });
    expect(result.success).toBe(false);
  });

  it('rejects venueType swap without swapAssets', () => {
    const result = BotConfigSchema.safeParse({
      ...validBase,
      venue: 'jupiter',
      venueType: 'swap',
      execution: { mode: 'shadow' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('swapAssets');
    }
  });

  it('rejects venueType swap with paper mode', () => {
    const result = BotConfigSchema.safeParse({
      ...validBase,
      venue: 'jupiter',
      venueType: 'swap',
      execution: { mode: 'paper' },
      swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path);
      expect(paths).toContainEqual(['execution', 'mode']);
    }
  });
});

describe('PublicStreamConfigSchema', () => {
  it('applies defaults for all fields', () => {
    const result = PublicStreamConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reconnectBaseMs).toBe(1_000);
      expect(result.data.reconnectMaxMs).toBe(30_000);
      expect(result.data.maxReconnectAttempts).toBe(20);
      expect(result.data.depthLevels).toBe(5);
    }
  });

  it('rejects reconnectBaseMs below 100', () => {
    const result = PublicStreamConfigSchema.safeParse({ reconnectBaseMs: 50 });
    expect(result.success).toBe(false);
  });

  it('rejects depthLevels above 50', () => {
    const result = PublicStreamConfigSchema.safeParse({ depthLevels: 51 });
    expect(result.success).toBe(false);
  });
});

describe('MarkingConfigSchema', () => {
  it('applies defaults — stalenessThresholdMs = 300000', () => {
    const result = MarkingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stalenessThresholdMs).toBe(300_000);
      expect(result.data.oracleBaseUrl).toBeUndefined();
    }
  });

  it('rejects stalenessThresholdMs below 10000', () => {
    const result = MarkingConfigSchema.safeParse({ stalenessThresholdMs: 5000 });
    expect(result.success).toBe(false);
  });

  it('rejects invalid oracleBaseUrl', () => {
    const result = MarkingConfigSchema.safeParse({ oracleBaseUrl: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  it('accepts valid oracleBaseUrl', () => {
    const result = MarkingConfigSchema.safeParse({
      oracleBaseUrl: 'https://api.coingecko.com/v3',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.oracleBaseUrl).toBe('https://api.coingecko.com/v3');
    }
  });
});

describe('AgentRuntimePolicySchema', () => {
  const REQUIRED_RUNTIME_BUDGETS = {
    maxHistoryMessages: 20,
    maxRecentToolMessages: 6,
    maxToolResultChars: 4_000,
    maxVisibleToolSchemas: 64,
    maxContextBlockChars: 4_000,
  };

  it('accepts the worker-forwarded llm subtree and applies defaults', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
      llm: {
        retry: { maxRetries: 4 },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.llm.retry.maxRetries).toBe(4);
      expect(result.data.llm.scout.defaultModels.anthropic).toBe('claude-3-5-haiku-latest');
      expect(result.data.llm.scout.maxTurns).toBe(10);
      expect(result.data.llm.scout.maxTokens).toBe(1_024);
      expect(result.data.llm.scout.temperature).toBe(0);
      expect(result.data.llm.judge.maxTurns).toBe(25);
      expect(result.data.llm.judge.temperature).toBe(0.3);
      expect(result.data.llm.thinking.deepBudgetTokens).toBe(10_240);
      expect(result.data.wake.minIntervalMs).toBe(15_000);
      expect(result.data.wake.pollMs).toBe(1_000);
      expect(result.data.marketIntelligence.maxTrackedPerps).toBe(3);
      expect(result.data.marketIntelligence.maxTrackedDexTargets).toBe(3);
      expect(result.data.marketIntelligence.maxRefreshedDexTargetsPerTick).toBe(2);
      expect(result.data.sandboxDefaults.memoryMb).toBe(512);
    }
  });

  it('applies the default llm catalog locality policy', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
      llm: {},
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.llm.catalog.locality).toBe('auto');
    }
  });

  it('accepts an explicit llm catalog locality override', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
      llm: {
        catalog: { locality: 'remote' },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.llm.catalog.locality).toBe('remote');
    }
  });

  it('accepts an explicit scout maxHoldDurationMs override', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
      llm: {
        scout: { maxHoldDurationMs: 120_000 },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.llm.scout.maxHoldDurationMs).toBe(120_000);
    }
  });

  it('accepts explicit runtime loop-control overrides', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
      llm: {
        scout: { maxTurns: 7, maxTokens: 768, temperature: 0.1 },
        judge: { maxTurns: 12, temperature: 0.6 },
      },
      wake: { minIntervalMs: 20_000, pollMs: 1_500 },
      marketIntelligence: {
        maxTrackedPerps: 4,
        maxTrackedDexTargets: 5,
        maxRefreshedDexTargetsPerTick: 3,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.llm.scout.maxTurns).toBe(7);
      expect(result.data.llm.scout.maxTokens).toBe(768);
      expect(result.data.llm.scout.temperature).toBe(0.1);
      expect(result.data.llm.judge.maxTurns).toBe(12);
      expect(result.data.llm.judge.temperature).toBe(0.6);
      expect(result.data.wake.minIntervalMs).toBe(20_000);
      expect(result.data.wake.pollMs).toBe(1_500);
      expect(result.data.marketIntelligence.maxTrackedPerps).toBe(4);
      expect(result.data.marketIntelligence.maxTrackedDexTargets).toBe(5);
      expect(result.data.marketIntelligence.maxRefreshedDexTargetsPerTick).toBe(3);
    }
  });

  it('rejects invalid runtime loop-control overrides', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
      llm: {
        scout: { maxTurns: 0, maxTokens: 0, temperature: 3 },
        judge: { maxTurns: 0, temperature: -0.1 },
      },
      wake: { minIntervalMs: 500, pollMs: 0 },
      marketIntelligence: {
        maxTrackedPerps: 0,
        maxTrackedDexTargets: 0,
        maxRefreshedDexTargetsPerTick: 0,
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects missing defaultBudgets', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      llm: {},
    });

    expect(result.success).toBe(false);
  });
});

describe('StrategyConfigSchema', () => {
  it('accepts momentum strategy with defaults', () => {
    const result = StrategyConfigSchema.safeParse({ type: 'momentum' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('momentum');
      expect(result.data.params.lookbackPeriod).toBe(5);
      expect(result.data.params.threshold).toBe(0.02);
      expect(result.data.params.positionSize).toBe('1');
    }
  });

  it('accepts momentum strategy with custom params', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'momentum',
      params: { lookbackPeriod: 10, threshold: 0.05, positionSize: '2.5', instrumentId: 'BTC/USD:USD' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.params.lookbackPeriod).toBe(10);
      expect(result.data.params.instrumentId).toBe('BTC/USD:USD');
    }
  });

  it('rejects momentum with lookbackPeriod below 2', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'momentum',
      params: { lookbackPeriod: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects momentum with negative threshold', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'momentum',
      params: { threshold: -0.01 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts llm strategy with required fields', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'llm',
      params: { provider: 'openai', model: 'gpt-4' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('llm');
      expect(result.data.params.maxTokens).toBe(1024);
      expect(result.data.params.timeoutMs).toBe(30_000);
      expect(result.data.params.positionSize).toBe('1');
    }
  });

  it('accepts llm strategy with all fields', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'llm',
      params: {
        provider: 'openai',
        model: 'gpt-4o',
        promptVersion: 'v2',
        maxTokens: 2048,
        timeoutMs: 60_000,
        instrumentId: 'ETH/USD:USD',
        positionSize: '0.5',
        baseUrl: 'https://proxy.example.com/v1',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.params.baseUrl).toBe('https://proxy.example.com/v1');
    }
  });

  it('rejects llm strategy without provider', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'llm',
      params: { model: 'gpt-4' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects llm strategy without model', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'llm',
      params: { provider: 'openai' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects llm with maxTokens below 1', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'llm',
      params: { provider: 'openai', model: 'gpt-4', maxTokens: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects llm with timeoutMs below 1000', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'llm',
      params: { provider: 'openai', model: 'gpt-4', timeoutMs: 500 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects llm with invalid baseUrl', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'llm',
      params: { provider: 'openai', model: 'gpt-4', baseUrl: 'not-a-url' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown strategy type', () => {
    const result = StrategyConfigSchema.safeParse({ type: 'unknown', params: {} });
    expect(result.success).toBe(false);
  });

  it('rejects missing type field', () => {
    const result = StrategyConfigSchema.safeParse({ params: {} });
    expect(result.success).toBe(false);
  });
});

describe('MomentumParamsSchema', () => {
  it('provides all defaults when empty object given', () => {
    const result = MomentumParamsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lookbackPeriod).toBe(5);
      expect(result.data.threshold).toBe(0.02);
      expect(result.data.positionSize).toBe('1');
      expect(result.data.instrumentId).toBeUndefined();
    }
  });

  it('rejects non-integer lookbackPeriod', () => {
    const result = MomentumParamsSchema.safeParse({ lookbackPeriod: 3.5 });
    expect(result.success).toBe(false);
  });
});

describe('LlmParamsSchema', () => {
  it('rejects empty object (requires provider and model)', () => {
    const result = LlmParamsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts minimal valid config', () => {
    const result = LlmParamsSchema.safeParse({ provider: 'openai', model: 'gpt-4' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxTokens).toBe(1024);
      expect(result.data.timeoutMs).toBe(30_000);
      expect(result.data.positionSize).toBe('1');
    }
  });

  it('rejects non-integer maxTokens', () => {
    const result = LlmParamsSchema.safeParse({ provider: 'openai', model: 'gpt-4', maxTokens: 1.5 });
    expect(result.success).toBe(false);
  });
});

describe('StrategyConfigSchema (discriminated union)', () => {
  it('accepts momentum type with default params', () => {
    const result = StrategyConfigSchema.safeParse({ type: 'momentum' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('momentum');
      expect(result.data.params.positionSize).toBe('1');
    }
  });

  it('accepts momentum type with custom params', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'momentum',
      params: { lookbackPeriod: 10, threshold: 0.05, positionSize: '2.5' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.params).toEqual({
        lookbackPeriod: 10,
        threshold: 0.05,
        positionSize: '2.5',
      });
    }
  });

  it('rejects momentum with lookbackPeriod < 2', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'momentum',
      params: { lookbackPeriod: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects momentum with negative threshold', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'momentum',
      params: { threshold: -0.01 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts llm type with required params', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'llm',
      params: { provider: 'openai', model: 'gpt-4' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('llm');
      expect(result.data.params.maxTokens).toBe(1024);
      expect(result.data.params.timeoutMs).toBe(30_000);
      expect(result.data.params.positionSize).toBe('1');
    }
  });

  it('accepts llm type with all optional params', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'llm',
      params: {
        provider: 'anthropic',
        model: 'claude-4',
        promptVersion: 'v2',
        maxTokens: 2048,
        timeoutMs: 60_000,
        instrumentId: 'BTC/USD:USD',
        positionSize: '0.5',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.params.promptVersion).toBe('v2');
      expect(result.data.params.instrumentId).toBe('BTC/USD:USD');
    }
  });

  it('rejects llm type without provider', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'llm',
      params: { model: 'gpt-4' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects llm type without model', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'llm',
      params: { provider: 'openai' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects llm type with maxTokens < 1', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'llm',
      params: { provider: 'openai', model: 'gpt-4', maxTokens: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects llm type with timeoutMs < 1000', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'llm',
      params: { provider: 'openai', model: 'gpt-4', timeoutMs: 500 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown strategy type', () => {
    const result = StrategyConfigSchema.safeParse({
      type: 'unknown_strategy',
      params: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing type field', () => {
    const result = StrategyConfigSchema.safeParse({ params: {} });
    expect(result.success).toBe(false);
  });
});

describe('MomentumParamsSchema', () => {
  it('applies all defaults', () => {
    const result = MomentumParamsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lookbackPeriod).toBe(5);
      expect(result.data.threshold).toBe(0.02);
      expect(result.data.positionSize).toBe('1');
      expect(result.data.instrumentId).toBeUndefined();
    }
  });

  it('rejects non-integer lookbackPeriod', () => {
    const result = MomentumParamsSchema.safeParse({ lookbackPeriod: 3.5 });
    expect(result.success).toBe(false);
  });
});

describe('LlmParamsSchema', () => {
  it('requires provider and model', () => {
    const result = LlmParamsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('applies defaults for optional numeric fields', () => {
    const result = LlmParamsSchema.safeParse({ provider: 'openai', model: 'gpt-4' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxTokens).toBe(1024);
      expect(result.data.timeoutMs).toBe(30_000);
      expect(result.data.positionSize).toBe('1');
    }
  });

  it('rejects maxTokens as float', () => {
    const result = LlmParamsSchema.safeParse({ provider: 'x', model: 'y', maxTokens: 10.5 });
    expect(result.success).toBe(false);
  });
});
