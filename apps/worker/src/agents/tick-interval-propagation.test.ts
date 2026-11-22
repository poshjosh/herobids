/**
 * Session manager resolves agentConfig.tickIntervalMs through
 * resolveEffectiveTickIntervalMs (non-trading tick resolver plan, item 2).
 */

import { describe, it, expect, vi } from 'vitest';
import type { RuntimeDescriptor } from '@herobids/domain';
import { resolveRuntimeCapabilityDescriptor } from '@herobids/db';
import type { Database } from '@herobids/db';
import { AgentSessionManager } from './agent-session-manager.js';

const TEST_RUNTIME_BUDGETS = {
  maxHistoryMessages: 20,
  maxHistoryTokens: 40_000,
  maxRecentToolMessages: 6,
  maxToolResultChars: 4_000,
  maxVisibleToolSchemas: 37,
  maxContextBlockChars: 4_000,
};

const OPERATOR_NON_TRADING_TICK_MS = 43_200_000; // 12 h — deliberately not the 24 h schema default
const SCHEMA_DEFAULT_NON_TRADING_TICK_MS = 86_400_000;

function makeDescriptor(agentId: string, hasTrading: boolean): RuntimeDescriptor {
  return {
    schemaVersion: 'v1',
    agentId,
    goal: 'Test agent',
    executionMode: 'paper',
    resolvedSkills: [
      {
        id: hasTrading ? 'crypto-trading' : 'base',
        name: hasTrading ? 'crypto-trading' : 'base',
        description: '',
        requiredTools: ['send_message'],
        isOptional: false,
        prompt: '',
        ...(hasTrading ? { capabilityFamilies: ['trading'] } : {}),
      },
    ],
    grantedConnectionsByFamily: {},
    readinessByFamily: {},
    defaultConnectionByFamily: {},
    toolPolicy: {},
    guardrails: {},
    budgets: TEST_RUNTIME_BUDGETS,
  } as RuntimeDescriptor;
}

function makeAgent(agentId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    userId: 'user-1',
    name: 'TestAgent',
    prompt: 'Test agent',
    skillIds: [],
    toolPolicy: null,
    modelPolicy: { provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5' },
    executionDefaults: null,
    risk: null,
    capital: null,
    maxBots: null,
    tickIntervalMs: null,
    style: null,
    runtimePolicyOverrides: null,
    unifiedConfig: null,
    wakePreferences: null,
    openPositionEscalationToJudgePolicy: null,
    ...overrides,
  };
}

function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'innerJoin', 'orderBy']) {
    chain[method] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

// Builds the capability descriptor through the real DB resolver (skill rows -> SkillDefinition),
// not a hand-written SkillDefinition, so the worker classification input is the production shape.
function resolveThroughDb(skillRows: Array<Record<string, unknown>>) {
  let selectCount = 0;
  const db = {
    select: vi.fn().mockImplementation(() => {
      selectCount++;
      return makeChain(selectCount === 1 ? skillRows : []);
    }),
  } as unknown as Database;
  return resolveRuntimeCapabilityDescriptor(db, 'agent-1');
}

function externalSkillRow(capabilityFamilies: string[]): Record<string, unknown> {
  return {
    skillId: 'ext_crypto_bot_management',
    name: 'crypto-bot-management',
    description: '',
    instructions: '',
    promptHint: null,
    promptTemplate: null,
    requiredTools: [],
    contextRequirements: [],
    requiredGuardrails: [],
    capabilityFamilies,
    suggestedTickIntervalMs: null,
    sourceRef: 'traderton/skills/crypto-bot-management',
  };
}

async function launchAgentConfig(opts: {
  hasTrading: boolean;
  stored: number | null | undefined;
  operatorDefault?: number;
  capabilityDescriptor?: unknown;
  agentOverrides?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const agentRepo = {
    getLaunchableStartingSessions: vi.fn().mockResolvedValue([{ id: 'sess-1', agentId: 'agent-1' }]),
    claimStartingSession: vi.fn().mockResolvedValue(true),
    updateSession: vi.fn().mockResolvedValue(undefined),
    updateAgent: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn().mockResolvedValue(
      makeAgent('agent-1', { ...(opts.stored === undefined ? {} : { tickIntervalMs: opts.stored }), ...opts.agentOverrides }),
    ),
    getUserAiModelConfig: vi.fn().mockResolvedValue(null),
    getRuntimeCapabilityDescriptor: vi.fn().mockResolvedValue(opts.capabilityDescriptor ?? makeDescriptor('agent-1', opts.hasTrading)),
    recordSessionStartedSkillUsage: vi.fn().mockResolvedValue(undefined),
    getSessionsByStatuses: vi.fn().mockResolvedValue([]),
  };
  const runtimeLauncher = {
    launch: vi.fn().mockResolvedValue({}),
    hasRuntime: vi.fn().mockReturnValue(false),
  };
  const manager = new AgentSessionManager(
    agentRepo as any,
    { emitGuardrailTriggered: vi.fn(), emitInstanceStatus: vi.fn() } as any,
    runtimeLauncher as any,
    {
      budgets: TEST_RUNTIME_BUDGETS,
      ...(opts.operatorDefault !== undefined && { nonTradingDefaultTickIntervalMs: opts.operatorDefault }),
    },
  );

  await manager.reconcileStartingSessions();

  expect(runtimeLauncher.launch).toHaveBeenCalledTimes(1);
  return runtimeLauncher.launch.mock.calls[0]![0].agentConfig as Record<string, unknown>;
}

describe('AgentSessionManager tickIntervalMs resolution', () => {
  it('gives a non-trading agent with no stored tick the operator non-trading default', async () => {
    const config = await launchAgentConfig({
      hasTrading: false,
      stored: null,
      operatorDefault: OPERATOR_NON_TRADING_TICK_MS,
    });
    expect(config['tickIntervalMs']).toBe(OPERATOR_NON_TRADING_TICK_MS);
  });

  it('treats an undefined stored tick like null for a non-trading agent', async () => {
    const config = await launchAgentConfig({ hasTrading: false, stored: undefined, operatorDefault: OPERATOR_NON_TRADING_TICK_MS });
    expect(config['tickIntervalMs']).toBe(OPERATOR_NON_TRADING_TICK_MS);
  });

  it('falls back to the schema default (24 h) when the operator value is not threaded in', async () => {
    const config = await launchAgentConfig({ hasTrading: false, stored: null });
    expect(config['tickIntervalMs']).toBe(SCHEMA_DEFAULT_NON_TRADING_TICK_MS);
  });

  it('gives a hybrid-capability agent without a trading skill the operator default, matching the API classification', async () => {
    const config = await launchAgentConfig({
      hasTrading: false,
      stored: null,
      operatorDefault: OPERATOR_NON_TRADING_TICK_MS,
      agentOverrides: { unifiedConfig: { capabilityMode: 'hybrid' } },
    });
    expect(config['tickIntervalMs']).toBe(OPERATOR_NON_TRADING_TICK_MS);
  });

  it('omits tickIntervalMs for a trading agent with no stored tick so cost-profile cadence applies', async () => {
    const config = await launchAgentConfig({
      hasTrading: true,
      stored: null,
      operatorDefault: OPERATOR_NON_TRADING_TICK_MS,
    });
    expect(config).not.toHaveProperty('tickIntervalMs');
  });

  it('omits tickIntervalMs for an external backend-approved trading skill row (capability_families={trading}) with a null stored tick', async () => {
    const capabilityDescriptor = await resolveThroughDb([externalSkillRow(['trading'])]);
    const config = await launchAgentConfig({
      hasTrading: false,
      stored: null,
      operatorDefault: OPERATOR_NON_TRADING_TICK_MS,
      capabilityDescriptor,
    });
    expect(config).not.toHaveProperty('tickIntervalMs');
  });

  it('gives the operator default to the same external skill row when its stored families are empty', async () => {
    const capabilityDescriptor = await resolveThroughDb([externalSkillRow([])]);
    const config = await launchAgentConfig({
      hasTrading: false,
      stored: null,
      operatorDefault: OPERATOR_NON_TRADING_TICK_MS,
      capabilityDescriptor,
    });
    expect(config['tickIntervalMs']).toBe(OPERATOR_NON_TRADING_TICK_MS);
  });

  it('keeps a legacy stored 24 h on a non-trading agent even when the operator default differs', async () => {
    const config = await launchAgentConfig({
      hasTrading: false,
      stored: SCHEMA_DEFAULT_NON_TRADING_TICK_MS,
      operatorDefault: OPERATOR_NON_TRADING_TICK_MS,
    });
    expect(config['tickIntervalMs']).toBe(SCHEMA_DEFAULT_NON_TRADING_TICK_MS);
  });

  it.each([
    ['non-trading', false],
    ['trading', true],
  ])('keeps an explicit stored tick for a %s agent', async (_label, hasTrading) => {
    const config = await launchAgentConfig({
      hasTrading,
      stored: 900_000,
      operatorDefault: OPERATOR_NON_TRADING_TICK_MS,
    });
    expect(config['tickIntervalMs']).toBe(900_000);
  });
});
