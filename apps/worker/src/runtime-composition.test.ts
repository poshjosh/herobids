import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, buildTickUserContext, createRuntimeCompositionState, getVisibleToolNames } from './runtime-composition.js';

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
      requiredTools: ['send_message', 'artifact_publish', 'set_memory'],
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
      requiredTools: ['create_bot', 'submit_decision', 'send_message'],
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
    expect(getVisibleToolNames(state)).toEqual(['send_message', 'artifact_publish']);
  });

  it('renders the runtime prompt from typed descriptor state', () => {
    const state = createRuntimeCompositionState(baseDescriptor);
    const prompt = buildSystemPrompt(state);

    expect(prompt).toContain('Trade carefully');
    expect(prompt).toContain('Capability Readiness');
    expect(prompt).toContain('Trading Context');
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
});