import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  buildTickUserContext,
  createRuntimeCompositionState,
  getVisibleToolNames,
  recordRegimeEvaluation,
  recordSessionCost,
  setCapabilityDegradation,
  recordVenueSignals,
} from './runtime-composition.js';

const baseDescriptor = {
  schemaVersion: 'v1' as const,
  agentId: 'agent-1',
  goal: 'Trade carefully',
  executionMode: 'paper',
  resolvedSkills: [
    {
      id: 'base',
      name: 'Base',
      description: 'Base skill',
      instructions: 'Be concise.',
      requiredTools: ['send_message', 'publish_artifact', 'set_memory'],
      capabilityFamilies: [],
      bindingRequirements: {},
      contextRequirements: [],
      requiredContextBlocks: ['corePlatformContext'],
      promptRendererHints: ['core-system'],
      requiredGuardrails: [],
      suggestedTickIntervalMs: 900_000,
      visibility: 'public' as const,
    },
    {
      id: 'bot-management',
      name: 'Bot Management',
      description: 'Trading bots',
      instructions: 'Manage trading bots.',
      requiredTools: ['create_bot', 'stop_bot', 'start_bot', 'adjust_bot_config', 'list_bots', 'get_bot_status', 'get_analytics', 'list_positions', 'send_message'],
      capabilityFamilies: ['trading'],
      bindingRequirements: { trading: { minBindings: 1, requireReady: true } },
      contextRequirements: ['bot_statuses'],
      requiredContextBlocks: ['corePlatformContext', 'tradingContext'],
      promptRendererHints: ['readiness-summary', 'trading'],
      requiredGuardrails: [],
      suggestedTickIntervalMs: 900_000,
      visibility: 'public' as const,
    },
  ],
  grantedBindingsByFamily: {
    trading: [
      {
        family: 'trading',
        bindingId: 'binding-1',
        connectionId: 'conn-1',
        provider: 'hyperliquid',
        label: 'Primary binding',
        readiness: {
          family: 'trading',
          state: 'ready',
          bindingReadiness: 'ready',
          agentEligibility: 'eligible',
          effectiveReady: true,
          bindingId: 'binding-1',
          reasons: [],
        },
        isDefault: true,
      },
    ],
  },
  defaultBindingByFamily: { trading: 'binding-1' },
  readinessByFamily: {
    trading: {
      family: 'trading',
      state: 'ready',
      bindingReadiness: 'ready',
      agentEligibility: 'eligible',
      effectiveReady: true,
      bindingId: 'binding-1',
      reasons: [],
    },
  },
  toolPolicy: {},
  guardrails: {
    dailyTokenBudget: 1000,
    dailyLossLimit: '10',
    maxBots: 2,
    maxSlippageBps: 25,
  },
  budgets: {
    maxHistoryMessages: 20,
    maxRecentToolMessages: 6,
    maxToolResultChars: 4_000,
    maxVisibleToolSchemas: 2,
    maxContextBlockChars: 4_000,
  },
};

describe('runtime composition helpers', () => {
  it('caps visible tool names by runtime budget', () => {
    const state = createRuntimeCompositionState(baseDescriptor);
    expect(getVisibleToolNames(state)).toEqual(['send_message', 'publish_artifact']);
  });

  it('renders the runtime prompt from typed descriptor state', () => {
    const state = createRuntimeCompositionState(baseDescriptor);
    const prompt = buildSystemPrompt(state);
    const userContext = buildTickUserContext(state, []);

    expect(prompt).toContain('Trade carefully');
    expect(prompt).toContain('Core Platform');
    expect(prompt).not.toContain('To call a tool, output a JSON object');
    expect(prompt).not.toContain('{"tool": "<tool_name>", "args": {...}}');
    expect(prompt).not.toContain('Capability Readiness');
    expect(prompt).not.toContain('Portfolio Summary');
    expect(userContext).toContain('Capability Readiness');
    expect(userContext).toContain('Portfolio Summary');
    expect(userContext).toContain('Open Positions');
  });

  it('keeps static prompt content ahead of dynamic tick content', () => {
    const state = createRuntimeCompositionState(baseDescriptor);
    const prompt = buildSystemPrompt(state);
    const userContext = buildTickUserContext(state, []);

    expect(prompt.indexOf('## Core Platform')).toBeGreaterThan(-1);
    expect(userContext.indexOf('## Capability Readiness')).toBeGreaterThan(-1);
    expect(prompt).not.toContain('Performance Summary');
    expect(userContext).toContain('## Performance Summary');
  });

  it('applies runtime config updates from inbound messages', () => {
    const state = createRuntimeCompositionState(baseDescriptor);
    const updatedDescriptor = {
      ...baseDescriptor,
      goal: 'Updated goal',
      defaultBindingByFamily: { trading: 'binding-2' },
    };

    const summary = buildTickUserContext(state, [{ type: 'agent.runtime.config_update', payload: { reason: 'binding_changed', runtimeDescriptor: updatedDescriptor } }]);

    expect(summary).toContain('Runtime config updated: binding_changed');
    expect(state.runtimeDescriptor.goal).toBe('Updated goal');
    expect(state.runtimeDescriptor.defaultBindingByFamily.trading).toBe('binding-2');
  });

  it('renders portfolio, positions, and recent events from runtime messages', () => {
    const state = createRuntimeCompositionState(baseDescriptor);
    const userContext = buildTickUserContext(state, [
      {
        type: 'instance.context.snapshot',
        payload: {
          symbol: 'BTC',
          price: '67123.4',
          pnl: '12.5',
          position: { side: 'long', size: '0.2', entryPrice: '66800' },
        },
      },
      {
        type: 'instance.tool.result',
        payload: {
          tool: 'get_analytics',
          data: { realizedPnlUsd: '8.1', openPositions: 1, winRate: 0.67 },
        },
      },
    ]);

    expect(userContext).toContain('## Portfolio Summary');
    expect(userContext).toContain('Realized P&L: $8.10');
    expect(userContext).toContain('## Open Positions');
    expect(userContext).toContain('BTC: long size=0.2');
    expect(userContext).toContain('## Recent Events');
    expect(userContext).toContain('Market: BTC @ 67123.4');
    expect(userContext).toContain('Win rate: 67%');
  });

  it('renders freshness markers for mixed venue intelligence and keeps performance summary last', () => {
    const state = createRuntimeCompositionState(baseDescriptor);
    recordRegimeEvaluation(
      state,
      {
        pass: true,
        reasons: ['trend aligned'],
        details: {
          benchmarkSymbol: 'BTC',
          currentPrice: 67000,
          emaFast: 66800,
          emaSlow: 66200,
          emaTrend: 65000,
          emaAlignment: 'bullish',
          adxValue: 28,
          choppy: false,
          vwap: 66600,
          priceAboveVwap: true,
          marketStructure: 'higherHighs',
        },
      },
      { state: 'fresh', provider: 'binance' },
    );
    recordVenueSignals(state, [
      {
        kind: 'perps',
        instrument: 'BTC',
        venue: 'hyperliquid',
        fields: [{ label: 'Funding', value: '0.01%' }],
        freshness: { state: 'fresh', provider: 'hyperliquid' },
      },
      {
        kind: 'dex',
        instrument: 'BONK (solana)',
        venue: 'dexscreener',
        fields: [{ label: 'Liquidity', value: '$1200000' }],
        freshness: { state: 'stale', provider: 'dexscreener', ageMs: 120000 },
      },
    ]);
    recordSessionCost(state, { tokensUsed: 1200, thinkingTokens: 180, costUsd: 0.01 });

    const userContext = buildTickUserContext(state, []);

    expect(userContext).toContain('## Market Regime');
    expect(userContext).toContain('## Venue Intelligence');
    expect(userContext).toContain('BTC (hyperliquid, perps)');
    expect(userContext).toContain('BONK (solana) (dexscreener, dex)');
    expect(userContext).toContain('Freshness: fresh via hyperliquid');
    expect(userContext).toContain('Freshness: stale 2m');
    expect(userContext.trim().endsWith('Performance score: 5/10')).toBe(true);
    expect(state.metrics.sessionCosts.hiddenReasoningTokensUsed).toBe(180);
  });

  it('renders a perps-only intelligence block without dex entries', () => {
    const state = createRuntimeCompositionState(baseDescriptor);
    recordVenueSignals(state, [
      {
        kind: 'perps',
        instrument: 'ETH',
        venue: 'hyperliquid',
        fields: [{ label: 'Funding', value: '0.02%' }],
        freshness: { state: 'fresh', provider: 'hyperliquid' },
      },
    ]);

    const userContext = buildTickUserContext(state, []);

    expect(userContext).toContain('ETH (hyperliquid, perps)');
    expect(userContext).not.toContain('(dexscreener, dex)');
  });

  it('renders a dex-only intelligence block without perps entries', () => {
    const state = createRuntimeCompositionState(baseDescriptor);
    recordVenueSignals(state, [
      {
        kind: 'dex',
        instrument: 'JUP (solana)',
        venue: 'dexscreener',
        fields: [{ label: 'Liquidity', value: '$4500000' }],
        freshness: { state: 'unavailable', provider: 'dexscreener', note: 'holding snapshot unavailable' },
      },
    ]);

    const userContext = buildTickUserContext(state, []);

    expect(userContext).toContain('JUP (solana) (dexscreener, dex)');
    expect(userContext).toContain('Freshness: unavailable (holding snapshot unavailable)');
    expect(userContext).not.toContain('(hyperliquid, perps)');
  });

  it('preserves positions, regime, and performance summary under constrained budgets', () => {
    const constrainedDescriptor = {
      ...baseDescriptor,
      budgets: {
        ...baseDescriptor.budgets,
        maxContextBlockChars: 120,
      },
    };
    const state = createRuntimeCompositionState(constrainedDescriptor);
    recordRegimeEvaluation(
      state,
      {
        pass: false,
        reasons: ['adx too low', 'below vwap'],
        details: {
          benchmarkSymbol: 'BTC',
          currentPrice: 65000,
          emaFast: 64950,
          emaSlow: 65200,
          emaTrend: 66000,
          emaAlignment: 'bearish',
          adxValue: 14,
          choppy: true,
          vwap: 65100,
          priceAboveVwap: false,
          marketStructure: 'lowerHighs',
        },
      },
      { state: 'fresh', provider: 'binance' },
    );
    recordVenueSignals(state, [
      {
        kind: 'perps',
        instrument: 'BTC',
        venue: 'hyperliquid',
        fields: Array.from({ length: 8 }, (_, index) => ({ label: `Field ${index}`, value: 'detail' })),
        freshness: { state: 'fresh', provider: 'hyperliquid' },
      },
    ]);

    const userContext = buildTickUserContext(state, [
      {
        type: 'instance.context.snapshot',
        payload: {
          symbol: 'BTC',
          price: '64980',
          pnl: '-12.5',
          position: { side: 'short', size: '0.15', entryPrice: '65200' },
        },
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        type: 'instance.execution.result',
        payload: { detail: `event-${index}` },
      })),
    ]);

    expect(userContext).toContain('## Open Positions');
    expect(userContext).toContain('BTC: short size=0.15');
    expect(userContext).toContain('## Market Regime');
    expect(userContext).toContain('Pass: no');
    expect(userContext).toContain('## Performance Summary');
    expect(userContext).toMatch(/Performance score: \d+\/10\s*$/);
  });

  it('does not use decision acceptance rate as a win-rate proxy', () => {
    const state = createRuntimeCompositionState(baseDescriptor);

    state.metrics.decisionsSubmitted = 9;
    state.metrics.decisionsAccepted = 6;

    const userContext = buildTickUserContext(state, []);

    expect(userContext).toContain('Win rate: unavailable');
    expect(userContext.trim().endsWith('Performance score: 5/10')).toBe(true);
  });

  it('marks positions as dex when only DEX bindings are active', () => {
    const dexDescriptor = {
      ...baseDescriptor,
      grantedBindingsByFamily: {
        trading: [
          {
            ...baseDescriptor.grantedBindingsByFamily.trading[0],
            provider: 'jupiter',
          },
        ],
      },
    };
    const state = createRuntimeCompositionState(dexDescriptor);

    buildTickUserContext(state, [
      {
        type: 'instance.tool.result',
        payload: {
          tool: 'list_positions',
          data: [
            {
              instrumentId: 'BONK/USDC',
              side: 'long',
              size: '1000',
              entryPrice: '0.00002',
            },
          ],
        },
      },
    ]);

    expect(state.metrics.openPositions[0]?.venueType).toBe('dex');
  });

  it('derives exposure and starting capital from tracked positions', () => {
    const state = createRuntimeCompositionState(baseDescriptor);

    buildTickUserContext(state, [
      {
        type: 'instance.tool.result',
        payload: {
          tool: 'list_positions',
          data: [
            {
              instrumentId: 'BTC-PERP',
              side: 'long',
              size: '0.5',
              entryPrice: '60000',
              unrealizedPnlUsd: '500',
            },
          ],
        },
      },
    ]);

    expect(state.metrics.portfolio.exposureUsd).toBe(30000);
    expect(state.metrics.performance.startingCapitalUsd).toBe(29500);
    expect(state.metrics.performance.riskAdjustedReturn).not.toBeNull();
  });

  it('clears portfolio exposure and unrealized PnL when positions flatten', () => {
    const state = createRuntimeCompositionState(baseDescriptor);

    buildTickUserContext(state, [
      {
        type: 'instance.tool.result',
        payload: {
          tool: 'list_positions',
          data: [
            {
              instrumentId: 'BTC-PERP',
              side: 'long',
              size: '0.5',
              entryPrice: '60000',
              unrealizedPnlUsd: '500',
            },
          ],
        },
      },
    ]);

    buildTickUserContext(state, [
      {
        type: 'instance.tool.result',
        payload: {
          tool: 'list_positions',
          data: [],
        },
      },
    ]);

    expect(state.metrics.portfolio.exposureUsd).toBe(0);
    expect(state.metrics.portfolio.unrealizedPnlUsd).toBe(0);
    expect(state.metrics.lastPositionSide).toBe('flat');
  });

  it('renders degraded capability guidance when dependencies are unavailable', () => {
    const state = createRuntimeCompositionState(baseDescriptor);
    setCapabilityDegradation(state, 'market-data', true);

    const userContext = buildTickUserContext(state, []);

    expect(userContext).toContain('## Degraded Capabilities');
    expect(userContext).toContain('Market-data tools are temporarily unavailable.');
    expect(userContext).toContain('Guidance: Skip market-data lookups for now or retry next tick after recovery.');
  });
});