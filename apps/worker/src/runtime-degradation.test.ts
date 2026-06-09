import { describe, expect, it, vi } from 'vitest';
import { FailureBackoffController } from './runtime-resilience.js';
import { processRuntimeFailure } from './runtime-degradation.js';
import { createRuntimeToolVisibilityController } from './runtime-tool-visibility.js';
import type { RuntimeDescriptor } from '@herobids/domain';

function buildRuntimeDescriptor(): RuntimeDescriptor {
  return {
    schemaVersion: 'v1',
    agentId: 'agent-1',
    goal: 'Test runtime degradation',
    executionMode: 'paper',
    resolvedSkills: [
      {
        id: 'base',
        name: 'Base',
        description: 'Base skill',
        instructions: 'Stay operational.',
        requiredTools: ['send_message', 'list_positions', 'search_tokens', 'get_market_overview'],
        capabilityFamilies: [],
        bindingRequirements: {},
        contextRequirements: [],
        requiredContextBlocks: ['corePlatformContext'],
        promptRendererHints: ['core-system'],
        requiredGuardrails: [],
        suggestedTickIntervalMs: 60_000,
        visibility: 'public',
      },
    ],
    grantedBindingsByFamily: {},
    defaultBindingByFamily: {},
    readinessByFamily: {},
    toolPolicy: {},
    guardrails: {
      dailyTokenBudget: null,
      dailyLossLimit: null,
      maxBots: null,
      maxSlippageBps: null,
    },
    budgets: {
      maxHistoryMessages: 20,
      maxRecentToolMessages: 6,
      maxToolResultChars: 4000,
      maxVisibleToolSchemas: 16,
      maxContextBlockChars: 4000,
    },
  };
}

describe('processRuntimeFailure', () => {
  it('keeps the tick alive and hides DB tools during a database outage', async () => {
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const runtimeDescriptor = buildRuntimeDescriptor();
    const visibility = createRuntimeToolVisibilityController(() => runtimeDescriptor, new Set());

    const outcome = await processRuntimeFailure('database', new Error('db offline'), {
      failureBackoff: new FailureBackoffController({ baseIntervalMs: 60_000 }),
      effectiveTickIntervalMs: 60_000,
      setDependencyAvailability: visibility.setDependencyAvailability,
      sendHeartbeat: heartbeat,
      shutdown,
    });

    expect(outcome.shouldShutdown).toBe(false);
    expect(outcome.classification.reasonCode).toBe('database.unavailable');
    expect(heartbeat).toHaveBeenCalledWith('degraded', 'database.unavailable');
    expect(shutdown).not.toHaveBeenCalled();
    expect([...visibility.allowedTools()]).toEqual(['send_message', 'search_tokens', 'get_market_overview']);
    expect([...visibility.getDependencyDegradations()]).toEqual(['database']);
  });

  it('keeps the tick alive and hides market-data tools during a market-data outage', async () => {
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const runtimeDescriptor = buildRuntimeDescriptor();
    const visibility = createRuntimeToolVisibilityController(() => runtimeDescriptor, new Set());

    const outcome = await processRuntimeFailure('market-data', new Error('dexscreener timeout'), {
      failureBackoff: new FailureBackoffController({ baseIntervalMs: 60_000 }),
      effectiveTickIntervalMs: 60_000,
      setDependencyAvailability: visibility.setDependencyAvailability,
      sendHeartbeat: heartbeat,
      shutdown,
    });

    expect(outcome.shouldShutdown).toBe(false);
    expect(outcome.classification.reasonCode).toBe('market_data.unavailable');
    expect(heartbeat).toHaveBeenCalledWith('degraded', 'market_data.unavailable');
    expect(shutdown).not.toHaveBeenCalled();
    expect([...visibility.allowedTools()]).toEqual(['send_message', 'list_positions']);
    expect([...visibility.getDependencyDegradations()]).toEqual(['market-data']);
  });
});