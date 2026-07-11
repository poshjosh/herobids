import { describe, expect, it } from 'vitest';
import {
  UsageBillingConfigSchema,
  BotConfigSchema,
  PublicStreamConfigSchema,
  MarkingConfigSchema,
  AgentRuntimePolicySchema,
  StrategySchema,
  LlmParamsSchema,
  TechnicalConfigSchema,
  AgentRuntimePolicyOverridesSchema,
  AgentStyleSchema,
  ReasoningLevelSchema,
  RUNTIME_POLICY_CEILINGS,
  AGENT_STYLE_RUNTIME_DEFAULTS,
  resolveAgentRuntimePolicy,
  type AgentStyleValue,
  type ReasoningLevel,
} from './schema.js';

// ── Helpers for reasoning-level ordering (mirrors schema.ts internals for testing) ──
const REASONING_LEVEL_ORDER = ['none', 'low', 'medium', 'high'] as const;
function reasoningLevelIndex(level: string): number {
  return REASONING_LEVEL_ORDER.indexOf(level as typeof REASONING_LEVEL_ORDER[number]);
}

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
    strategy: { type: 'momentum', decisionMode: 'mechanical' },
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

  it('accepts config without venue and venueType (stamped by broker)', () => {
    const result = BotConfigSchema.safeParse({
      strategy: { type: 'momentum', decisionMode: 'mechanical' },
      symbol: 'SOL/USDC',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.venue).toBeUndefined();
      expect(result.data.venueType).toBeUndefined();
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
    maxHistoryTokens: 40_000,
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
      expect(result.data.llm.scout.maxHoldDurationMs).toBeUndefined();
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

  it('accepts optional toolResultFullRetentionTurns and toolResultMaxStaleChars', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: {
        ...REQUIRED_RUNTIME_BUDGETS,
        toolResultFullRetentionTurns: 4,
        toolResultMaxStaleChars: 600,
      },
      llm: {},
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultBudgets.toolResultFullRetentionTurns).toBe(4);
      expect(result.data.defaultBudgets.toolResultMaxStaleChars).toBe(600);
    }
  });

  it('rejects toolResultMaxStaleChars of 0 (min 1)', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: {
        ...REQUIRED_RUNTIME_BUDGETS,
        toolResultMaxStaleChars: 0,
      },
      llm: {},
    });

    expect(result.success).toBe(false);
  });

  it('accepts toolResultFullRetentionTurns of 0 (min 0)', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: {
        ...REQUIRED_RUNTIME_BUDGETS,
        toolResultFullRetentionTurns: 0,
      },
      llm: {},
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultBudgets.toolResultFullRetentionTurns).toBe(0);
    }
  });

  it('rejects negative toolResultFullRetentionTurns', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: {
        ...REQUIRED_RUNTIME_BUDGETS,
        toolResultFullRetentionTurns: -1,
      },
      llm: {},
    });

    expect(result.success).toBe(false);
  });

  it('rejects missing defaultBudgets', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      llm: {},
    });

    expect(result.success).toBe(false);
  });

  it('runtime loop-control fields are accessible via agent.ts destructuring pattern', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
      llm: {
        scout: { maxTurns: 8, maxTokens: 512, temperature: 0.2 },
        judge: { maxTurns: 20, temperature: 0.4 },
      },
      wake: { minIntervalMs: 30_000, pollMs: 2_000 },
      marketIntelligence: { maxRefreshedDexTargetsPerTick: 4 },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Mirrors the destructuring pattern used in apps/worker/src/agent.ts.
    // If agent.ts ever reintroduces hardcoded literals, this test still passes —
    // its purpose is to guard the config interface so the fields remain reachable
    // and that overrides flow through to the values the agent uses.
    const agentRuntimePolicy = result.data;
    const scoutLoopConfig = agentRuntimePolicy.llm.scout;
    const judgeLoopConfig = agentRuntimePolicy.llm.judge;
    const marketIntelligencePolicy = agentRuntimePolicy.marketIntelligence;

    expect(scoutLoopConfig.maxTurns).toBe(8);
    expect(judgeLoopConfig.maxTurns).toBe(20);
    expect(marketIntelligencePolicy.maxRefreshedDexTargetsPerTick).toBe(4);
    expect(agentRuntimePolicy.wake.pollMs).toBe(2_000);
    expect(agentRuntimePolicy.wake.minIntervalMs).toBe(30_000);
  });

  // ── promptStyle ─────────────────────────────────────────────────────────

  it('promptStyle defaults to "enriched"', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.promptStyle).toBe('enriched');
    }
  });

  it('promptStyle accepts "classic"', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      promptStyle: 'classic',
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.promptStyle).toBe('classic');
    }
  });

  it('promptStyle rejects invalid values', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      promptStyle: 'legacy',
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
    });
    expect(result.success).toBe(false);
  });

  // ── promptEnrichment ─────────────────────────────────────────────────────

  it('promptEnrichment applies all defaults', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const pe = result.data.promptEnrichment;
      expect(pe.memory.enabled).toBe(true);
      expect(pe.memory.maxInlineKeys).toBe(12);
      expect(pe.judgeHistory.hybridMaxResponses).toBe(3);
      expect(pe.judgeHistory.tickMaxDisplayed).toBe(10);
      expect(pe.configReference.enabled).toBe(true);
      expect(pe.queuedSignals.enabled).toBe(true);
      expect(pe.queuedSignals.max).toBe(5);
      expect(pe.wakeEmphasis.enabled).toBe(true);
      expect(pe.activityTimeline.enabled).toBe(true);
      expect(pe.activityTimeline.maxEvents).toBe(10);
    }
  });

  it('promptEnrichment memory maxInlineKeys rejects 0 (min 1)', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
      promptEnrichment: { memory: { maxInlineKeys: 0 } },
    });
    expect(result.success).toBe(false);
  });

  it('promptEnrichment memory maxInlineKeys rejects 51 (max 50)', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
      promptEnrichment: { memory: { maxInlineKeys: 51 } },
    });
    expect(result.success).toBe(false);
  });

  it('promptEnrichment judgeHistory tickMaxDisplayed rejects 0 (min 1)', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
      promptEnrichment: { judgeHistory: { tickMaxDisplayed: 0 } },
    });
    expect(result.success).toBe(false);
  });

  it('promptEnrichment judgeHistory tickMaxDisplayed rejects 31 (max 30)', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
      promptEnrichment: { judgeHistory: { tickMaxDisplayed: 31 } },
    });
    expect(result.success).toBe(false);
  });

  it('promptEnrichment queuedSignals max rejects 0 (min 1)', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
      promptEnrichment: { queuedSignals: { max: 0 } },
    });
    expect(result.success).toBe(false);
  });

  it('promptEnrichment activityTimeline maxEvents rejects 2 (min 3)', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
      promptEnrichment: { activityTimeline: { maxEvents: 2 } },
    });
    expect(result.success).toBe(false);
  });

  it('promptEnrichment activityTimeline maxEvents rejects 31 (max 30)', () => {
    const result = AgentRuntimePolicySchema.safeParse({
      defaultBudgets: REQUIRED_RUNTIME_BUDGETS,
      promptEnrichment: { activityTimeline: { maxEvents: 31 } },
    });
    expect(result.success).toBe(false);
  });
});

describe('StrategySchema', () => {
  it('accepts momentum strategy with mechanical decisionMode', () => {
    const result = StrategySchema.safeParse({ type: 'momentum', decisionMode: 'mechanical' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('momentum');
      expect(result.data.decisionMode).toBe('mechanical');
    }
  });

  it('accepts momentum strategy with llm decisionMode', () => {
    const result = StrategySchema.safeParse({ type: 'momentum', decisionMode: 'llm' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('momentum');
      expect(result.data.decisionMode).toBe('llm');
    }
  });

  it('accepts dca strategy without decisionMode (timer-driven)', () => {
    const result = StrategySchema.safeParse({ type: 'dca' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('dca');
      expect(result.data.decisionMode).toBeUndefined();
    }
  });

  it('accepts all trading styles with decisionMode', () => {
    const styles = ['range', 'contrarian', 'swing', 'scalper'] as const;
    for (const style of styles) {
      const result = StrategySchema.safeParse({ type: style, decisionMode: 'mechanical' });
      expect(result.success).toBe(true);
    }
  });

  it('rejects non-DCA strategy without decisionMode', () => {
    const result = StrategySchema.safeParse({ type: 'momentum' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('decisionMode');
    }
  });

  it('rejects invalid trading style', () => {
    const result = StrategySchema.safeParse({ type: 'unknown', decisionMode: 'mechanical' });
    expect(result.success).toBe(false);
  });

  it('rejects missing type field', () => {
    const result = StrategySchema.safeParse({ decisionMode: 'mechanical' });
    expect(result.success).toBe(false);
  });

  it('accepts strategy with params', () => {
    const result = StrategySchema.safeParse({
      type: 'momentum',
      decisionMode: 'mechanical',
      params: { lookbackPeriod: 10, threshold: 0.05 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.params?.lookbackPeriod).toBe(10);
    }
  });

  it('accepts strategy stringified as the old "type" was a string — new schema requires object', () => {
    // This tests the error message when agent sends strategy as a string
    const result = StrategySchema.safeParse('momentum');
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

describe('StrategySchema (BotConfigSchema.strategy)', () => {
  it('accepts momentum with mechanical decisionMode and accepts type-specific params in params', () => {
    const result = StrategySchema.safeParse({ type: 'momentum', decisionMode: 'mechanical', params: { lookbackPeriod: 10 } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('momentum');
      expect(result.data.decisionMode).toBe('mechanical');
    }
  });

  it('allows params to carry any trading-style tuning data', () => {
    const result = StrategySchema.safeParse({
      type: 'momentum',
      decisionMode: 'mechanical',
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

  it('rejects invalid type string', () => {
    const result = StrategySchema.safeParse({ type: 'llm', decisionMode: 'mechanical' });
    expect(result.success).toBe(false);
  });

  it('rejects momentum without decisionMode (non-DCA)', () => {
    const result = StrategySchema.safeParse({ type: 'momentum' });
    expect(result.success).toBe(false);
  });

  it('accepts dca without decisionMode', () => {
    const result = StrategySchema.safeParse({ type: 'dca' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('dca');
      expect(result.data.decisionMode).toBeUndefined();
    }
  });

  it('passes params through as-is — params are intentionally unvalidated (flexible tuning)', () => {
    // params is z.record(z.unknown()) by design — each trading style has its
    // own tuning surface and no single param schema fits all. Validation of
    // type-specific params is done at the strategy execution layer, not at config parse time.
    const result = StrategySchema.safeParse({
      type: 'momentum',
      decisionMode: 'mechanical',
      params: { lookbackPeriod: -1, threshold: 'invalid', extraField: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.params).toEqual({
        lookbackPeriod: -1,
        threshold: 'invalid',
        extraField: true,
      });
    }
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

describe('TechnicalConfigSchema', () => {
  it('defaults autonomousExit to false', () => {
    const result = TechnicalConfigSchema.safeParse({
      filters: { venue: 'hyperliquid', venueType: 'orderbook' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autonomousExit).toBe(false);
    }
  });

  it('accepts explicit autonomousExit true', () => {
    const result = TechnicalConfigSchema.safeParse({
      filters: { venue: 'hyperliquid', venueType: 'orderbook' },
      autonomousExit: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autonomousExit).toBe(true);
    }
  });
});

// ── Per-agent runtime policy ────────────────────────────────────────────────

describe('AgentStyleSchema', () => {
  it('accepts valid styles', () => {
    expect(AgentStyleSchema.safeParse('careful').success).toBe(true);
    expect(AgentStyleSchema.safeParse('balanced').success).toBe(true);
    expect(AgentStyleSchema.safeParse('bold').success).toBe(true);
  });

  it('rejects invalid styles', () => {
    expect(AgentStyleSchema.safeParse('aggressive').success).toBe(false);
    expect(AgentStyleSchema.safeParse('').success).toBe(false);
  });
});

describe('AgentRuntimePolicyOverridesSchema', () => {
  it('accepts empty object (no overrides)', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scoutMaxTurns).toBeUndefined();
    }
  });

  it('accepts a single override field', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({ scoutMaxTurns: 50 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scoutMaxTurns).toBe(50);
      expect(result.data.judgeMaxTurns).toBeUndefined();
    }
  });

  it('accepts multiple override fields', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      scoutMaxTurns: 50,
      maxHistoryTokens: 60_000,
      weekendPause: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scoutMaxTurns).toBe(50);
      expect(result.data.maxHistoryTokens).toBe(60_000);
      expect(result.data.weekendPause).toBe(false);
    }
  });

  it('rejects scoutMaxTurns below minimum (1)', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({ scoutMaxTurns: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects scoutMaxTurns above operator ceiling (500)', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({ scoutMaxTurns: 501 });
    expect(result.success).toBe(false);
  });

  it('accepts scoutMaxTurns at operator ceiling (500)', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({ scoutMaxTurns: 500 });
    expect(result.success).toBe(true);
  });

  it('rejects judgeMaxTurns above operator ceiling (1000)', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({ judgeMaxTurns: 1_001 });
    expect(result.success).toBe(false);
  });

  it('rejects maxHistoryTokens above operator ceiling (160000)', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({ maxHistoryTokens: 160_001 });
    expect(result.success).toBe(false);
  });

  it('accepts null to signal reset-to-default', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({ scoutMaxTurns: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scoutMaxTurns).toBeNull();
    }
  });

  it('rejects negative maxHoldDurationMs', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({ maxHoldDurationMs: -1 });
    expect(result.success).toBe(false);
  });

  it('accepts maxHoldDurationMs of 0 (no forced escalation)', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({ maxHoldDurationMs: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxHoldDurationMs).toBe(0);
    }
  });

  it('rejects invalid allowedHoursUtc values', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({ allowedHoursUtc: [25] });
    expect(result.success).toBe(false);
  });

  it('accepts valid allowedHoursUtc', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({ allowedHoursUtc: [0, 8, 16, 23] });
    expect(result.success).toBe(true);
  });

  it('accepts tradingSessions in AgentRuntimePolicyOverridesSchema', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      tradingSessions: ['asia', 'london'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown session name', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      tradingSessions: ['bogus'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts empty tradingSessions array', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      tradingSessions: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts tradingSessions null', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      tradingSessions: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('AGENT_STYLE_RUNTIME_DEFAULTS', () => {
  it('has entries for all three styles', () => {
    const styles: AgentStyleValue[] = ['careful', 'balanced', 'bold'];
    for (const style of styles) {
      expect(AGENT_STYLE_RUNTIME_DEFAULTS[style]).toBeDefined();
    }
  });

  it('careful has conservative defaults', () => {
    const d = AGENT_STYLE_RUNTIME_DEFAULTS.careful;
    expect(d.scoutMaxTurns).toBe(10);
    expect(d.judgeMaxTurns).toBe(25);
    expect(d.maxHistoryTokens).toBe(20_000);
    expect(d.weekendPause).toBe(false);
    expect(d.allowedHoursUtc).toEqual([14, 15, 16, 17, 18, 19, 20]);
  });

  it('balanced has moderate defaults', () => {
    const d = AGENT_STYLE_RUNTIME_DEFAULTS.balanced;
    expect(d.scoutMaxTurns).toBe(30);
    expect(d.judgeMaxTurns).toBe(75);
    expect(d.maxHistoryTokens).toBe(40_000);
  });

  it('bold has aggressive defaults', () => {
    const d = AGENT_STYLE_RUNTIME_DEFAULTS.bold;
    expect(d.scoutMaxTurns).toBe(100);
    expect(d.judgeMaxTurns).toBe(300);
    expect(d.maxHistoryTokens).toBe(80_000);
    expect(d.weekendPause).toBe(false);
  });

  it('all defaults are within operator ceilings', () => {
    for (const style of ['careful', 'balanced', 'bold'] as const) {
      const d = AGENT_STYLE_RUNTIME_DEFAULTS[style];
      expect(d.scoutMaxTurns).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.scoutMaxTurns);
      expect(d.judgeMaxTurns).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.judgeMaxTurns);
      expect(d.maxHistoryTokens).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.maxHistoryTokens);
      expect(d.maxHoldDurationMs).toBeLessThanOrEqual(RUNTIME_POLICY_CEILINGS.maxHoldDurationMs);
      // Reasoning-level ceilings
      expect(reasoningLevelIndex(d.scoutReasoning)).toBeLessThanOrEqual(
        reasoningLevelIndex(RUNTIME_POLICY_CEILINGS.scoutReasoningMax),
      );
      expect(reasoningLevelIndex(d.judgeReasoning)).toBeLessThanOrEqual(
        reasoningLevelIndex(RUNTIME_POLICY_CEILINGS.judgeReasoningMax),
      );
    }
  });
});

describe('resolveAgentRuntimePolicy', () => {
  it('returns balanced defaults when style is undefined', () => {
    const resolved = resolveAgentRuntimePolicy(undefined, null);
    expect(resolved.scoutMaxTurns).toBe(30);
    expect(resolved.judgeMaxTurns).toBe(75);
  });

  it('returns balanced defaults when style is null', () => {
    const resolved = resolveAgentRuntimePolicy(null, null);
    expect(resolved.scoutMaxTurns).toBe(30);
  });

  it('returns balanced defaults when style is invalid', () => {
    const resolved = resolveAgentRuntimePolicy('aggressive', null);
    expect(resolved.scoutMaxTurns).toBe(30);
  });

  it('returns bold defaults for bold style', () => {
    const resolved = resolveAgentRuntimePolicy('bold', null);
    expect(resolved.scoutMaxTurns).toBe(100);
    expect(resolved.judgeMaxTurns).toBe(300);
    expect(resolved.maxHistoryTokens).toBe(80_000);
    expect(resolved.weekendPause).toBe(false);
  });

  it('returns careful defaults for careful style', () => {
    const resolved = resolveAgentRuntimePolicy('careful', null);
    expect(resolved.scoutMaxTurns).toBe(10);
    expect(resolved.weekendPause).toBe(false);
  });

  it('overrides win over style defaults', () => {
    const resolved = resolveAgentRuntimePolicy('bold', { scoutMaxTurns: 25 });
    expect(resolved.scoutMaxTurns).toBe(25); // override wins
    expect(resolved.judgeMaxTurns).toBe(300); // style default preserved
  });

  it('multiple overrides all win', () => {
    const resolved = resolveAgentRuntimePolicy('balanced', {
      scoutMaxTurns: 15,
      maxHistoryTokens: 10_000,
      weekendPause: false,
    });
    expect(resolved.scoutMaxTurns).toBe(15);
    expect(resolved.maxHistoryTokens).toBe(10_000);
    expect(resolved.weekendPause).toBe(false);
    // style defaults for non-overridden fields
    expect(resolved.judgeMaxTurns).toBe(75);
    expect(resolved.maxHistoryMessages).toBe(20);
  });

  it('handles empty overrides object', () => {
    const resolved = resolveAgentRuntimePolicy('careful', {});
    expect(resolved.scoutMaxTurns).toBe(10);
    expect(resolved.maxHoldDurationMs).toBe(27_000_000);  // careful: 5 × tick interval
  });
});

// ── ReasoningLevel ──────────────────────────────────────────────────────────

describe('ReasoningLevelSchema', () => {
  it('accepts all valid reasoning levels', () => {
    const levels: ReasoningLevel[] = ['none', 'low', 'medium', 'high'];
    for (const level of levels) {
      expect(ReasoningLevelSchema.safeParse(level).success).toBe(true);
    }
  });

  it('rejects invalid reasoning levels', () => {
    expect(ReasoningLevelSchema.safeParse('off').success).toBe(false);
    expect(ReasoningLevelSchema.safeParse('extreme').success).toBe(false);
    expect(ReasoningLevelSchema.safeParse('').success).toBe(false);
    expect(ReasoningLevelSchema.safeParse(0).success).toBe(false);
    expect(ReasoningLevelSchema.safeParse(null).success).toBe(false);
  });
});

describe('AgentRuntimePolicyOverridesSchema — reasoning', () => {
  it('accepts scoutReasoning and judgeReasoning as nullable optional', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      scoutReasoning: 'low',
      judgeReasoning: 'high',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scoutReasoning).toBe('low');
      expect(result.data.judgeReasoning).toBe('high');
    }
  });

  // ── Operator ceiling enforcement ──

  it('rejects scoutReasoning high (exceeds medium ceiling)', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      scoutReasoning: 'high',
    });
    expect(result.success).toBe(false);
  });

  it('accepts scoutReasoning medium (at ceiling)', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      scoutReasoning: 'medium',
    });
    expect(result.success).toBe(true);
  });

  it('accepts judgeReasoning high (at ceiling)', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      judgeReasoning: 'high',
    });
    expect(result.success).toBe(true);
  });

  // ── end ceiling enforcement ──

  it('accepts null scoutReasoning and judgeReasoning', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      scoutReasoning: null,
      judgeReasoning: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scoutReasoning).toBeNull();
      expect(result.data.judgeReasoning).toBeNull();
    }
  });

  it('defaults to undefined when not provided', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scoutReasoning).toBeUndefined();
      expect(result.data.judgeReasoning).toBeUndefined();
    }
  });

  it('rejects invalid reasoning level', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      scoutReasoning: 'extreme',
    });
    expect(result.success).toBe(false);
  });
});

describe('AGENT_STYLE_RUNTIME_DEFAULTS — reasoning', () => {
  it('careful style has scoutReasoning=none, judgeReasoning=low', () => {
    expect(AGENT_STYLE_RUNTIME_DEFAULTS.careful.scoutReasoning).toBe('none');
    expect(AGENT_STYLE_RUNTIME_DEFAULTS.careful.judgeReasoning).toBe('low');
  });

  it('balanced style has scoutReasoning=none, judgeReasoning=medium', () => {
    expect(AGENT_STYLE_RUNTIME_DEFAULTS.balanced.scoutReasoning).toBe('none');
    expect(AGENT_STYLE_RUNTIME_DEFAULTS.balanced.judgeReasoning).toBe('medium');
  });

  it('bold style has scoutReasoning=low, judgeReasoning=high', () => {
    expect(AGENT_STYLE_RUNTIME_DEFAULTS.bold.scoutReasoning).toBe('low');
    expect(AGENT_STYLE_RUNTIME_DEFAULTS.bold.judgeReasoning).toBe('high');
  });
});

describe('resolveAgentRuntimePolicy — reasoning', () => {
  it('returns style default when no overrides', () => {
    const resolved = resolveAgentRuntimePolicy('careful', null);
    expect(resolved.scoutReasoning).toBe('none');
    expect(resolved.judgeReasoning).toBe('low');
  });

  it('null override falls back to style default', () => {
    const resolved = resolveAgentRuntimePolicy('balanced', {
      scoutReasoning: null,
      judgeReasoning: null,
    });
    expect(resolved.scoutReasoning).toBe('none'); // balanced default
    expect(resolved.judgeReasoning).toBe('medium'); // balanced default
  });

  it('undefined override falls back to style default', () => {
    const resolved = resolveAgentRuntimePolicy('bold', {});
    expect(resolved.scoutReasoning).toBe('low'); // bold default
    expect(resolved.judgeReasoning).toBe('high'); // bold default
  });

  it('explicit override wins over style default', () => {
    const resolved = resolveAgentRuntimePolicy('careful', {
      scoutReasoning: 'medium',
      judgeReasoning: 'high',
    });
    expect(resolved.scoutReasoning).toBe('medium');
    expect(resolved.judgeReasoning).toBe('high');
  });

  it('partial override: one explicit, one style default', () => {
    const resolved = resolveAgentRuntimePolicy('balanced', {
      judgeReasoning: 'high',
    });
    expect(resolved.scoutReasoning).toBe('none'); // balanced default
    expect(resolved.judgeReasoning).toBe('high'); // override
  });

  it('falls back to balanced reasoning defaults when style is invalid', () => {
    const resolved = resolveAgentRuntimePolicy('aggressive', null);
    expect(resolved.scoutReasoning).toBe('none'); // balanced default
    expect(resolved.judgeReasoning).toBe('medium'); // balanced default
  });
});

// ── Adaptive reasoning ──────────────────────────────────────────────────────

describe('adaptive reasoning defaults', () => {
  it('AGENT_STYLE_RUNTIME_DEFAULTS has adaptScoutReasoning true for all styles', () => {
    for (const style of ['careful', 'balanced', 'bold'] as const) {
      expect(AGENT_STYLE_RUNTIME_DEFAULTS[style].adaptScoutReasoning).toBe(true);
    }
  });

  it('AGENT_STYLE_RUNTIME_DEFAULTS has adaptJudgeReasoning true for all styles', () => {
    for (const style of ['careful', 'balanced', 'bold'] as const) {
      expect(AGENT_STYLE_RUNTIME_DEFAULTS[style].adaptJudgeReasoning).toBe(true);
    }
  });

  it('AgentRuntimePolicyOverridesSchema accepts adaptScoutReasoning boolean', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({ adaptScoutReasoning: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.adaptScoutReasoning).toBe(false);
    }
  });

  it('AgentRuntimePolicyOverridesSchema accepts adaptJudgeReasoning boolean', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({ adaptJudgeReasoning: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.adaptJudgeReasoning).toBe(false);
    }
  });

  it('AgentRuntimePolicyOverridesSchema accepts null for adaptive fields', () => {
    const result = AgentRuntimePolicyOverridesSchema.safeParse({
      adaptScoutReasoning: null,
      adaptJudgeReasoning: null,
    });
    expect(result.success).toBe(true);
  });

  it('resolveAgentRuntimePolicy returns adaptive defaults when no overrides', () => {
    const resolved = resolveAgentRuntimePolicy('balanced', null);
    expect(resolved.adaptScoutReasoning).toBe(true);
    expect(resolved.adaptJudgeReasoning).toBe(true);
  });

  it('resolveAgentRuntimePolicy allows overrides to set adaptive flags to false', () => {
    const resolved = resolveAgentRuntimePolicy('balanced', {
      adaptScoutReasoning: false,
      adaptJudgeReasoning: false,
    });
    expect(resolved.adaptScoutReasoning).toBe(false);
    expect(resolved.adaptJudgeReasoning).toBe(false);
  });

  it('resolveAgentRuntimePolicy falls back to style default when adaptive override is null', () => {
    const resolved = resolveAgentRuntimePolicy('bold', {
      adaptScoutReasoning: null,
      adaptJudgeReasoning: null,
    });
    expect(resolved.adaptScoutReasoning).toBe(true); // bold default
    expect(resolved.adaptJudgeReasoning).toBe(true); // bold default
  });
});
