/**
 * Unit tests for agent-instantiation-service (Task 3).
 *
 * Covers:
 * - buildUnifiedConfigFromPayload: field mapping, risk override, defaults, null return
 * - createAgentFromPayload: agent row creation, skill rows, assignment source, status
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Database } from '@herobids/db';
import type { AgentBlueprintRevisionPayload } from '@herobids/domain';
import {
  buildUnifiedConfigFromPayload,
  createAgentFromPayload,
  type AgentFromPayloadContext,
  type SkillRef,
} from './agent-instantiation-service.js';

vi.mock('../agents/trading-profile-reconciliation-adapter.js', () => ({
  reconcileTradingProfile: vi.fn().mockResolvedValue({
    upserts: [], clears: [], selectedBinding: { previous: null, next: null }, inverseActions: [],
  }),
}));

import { reconcileTradingProfile } from '../agents/trading-profile-reconciliation-adapter.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Track inserted rows during test execution. */
interface InsertTracker {
  agentRows: Record<string, unknown>[];
  skillRows: Record<string, unknown>[];
}

function makeInsertTracker(): InsertTracker {
  return { agentRows: [], skillRows: [] };
}

/**
 * Build a mock Database (or transaction) for createAgentFromPayload.
 *
 * The function calls `tx.insert(agents).values(...)` and optionally
 * `tx.insert(agentSkills).values(...)`. We intercept both and record
 * what was inserted.
 */
function buildMockTx(tracker: InsertTracker): Database {
  let insertCallCount = 0;
  return {
    insert: vi.fn().mockImplementation(() => {
      const callIndex = insertCallCount++;
      return {
        values: vi.fn().mockImplementation((v: Record<string, unknown> | Record<string, unknown>[]) => {
          // First insert call = agents, second = agentSkills
          if (callIndex === 0) {
            tracker.agentRows.push(v as Record<string, unknown>);
          } else {
            if (Array.isArray(v)) {
              tracker.skillRows.push(...v);
            } else {
              tracker.skillRows.push(v);
            }
          }
          return Promise.resolve();
        }),
      };
    }),
  } as unknown as Database;
}

// ── Minimal valid payload ────────────────────────────────────────────────────

function makePayload(overrides: Partial<AgentBlueprintRevisionPayload> = {}): AgentBlueprintRevisionPayload {
  return {
    kind: 'agent',
    name: 'Test Agent',
    description: '',
    tags: [],
    prompt: 'Trade BTC',
    style: null,
    strategy: null,
    risk: null,
    executionDefaults: null,
    capabilityMode: 'intelligence',
    intelligence: { provider: 'openai', wakeIntervalMs: 60_000 },
    authorizationMode: 'direct',
    openPositionEscalationToJudgePolicy: 'uncovered_or_triggered',
    capital: null,
    maxBots: null,
    tickIntervalMs: null,
    ...overrides,
  } as AgentBlueprintRevisionPayload;
}

// ── Tests: buildUnifiedConfigFromPayload ─────────────────────────────────────

describe('createAgentFromPayload reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reconciles the instantiated agent profile through the shared seam', async () => {
    const tracker = makeInsertTracker();
    await createAgentFromPayload(
      buildMockTx(tracker),
      makePayload({ capital: '1250', executionDefaults: { mode: 'paper', slippageBps: 50 } }),
      [],
      { userId: 'user-1', agentId: 'agent-blueprint' },
    );

    expect(reconcileTradingProfile).toHaveBeenCalledWith({
      prior: expect.objectContaining({ connections: [] }),
      proposed: expect.objectContaining({
        config: expect.objectContaining({ actorId: 'agent-blueprint', capital: '1250' }),
        connections: [],
      }),
    });
  });
});

describe('buildUnifiedConfigFromPayload', () => {
  it('builds unifiedConfig with technical, intelligence, capabilityMode, hybridMode', () => {
    const payload = makePayload({
      technical: { scanIntervalMs: 5000, venues: ['hyperliquid'] } as AgentBlueprintRevisionPayload['technical'],
      intelligence: { provider: 'openai', wakeIntervalMs: 60_000 } as AgentBlueprintRevisionPayload['intelligence'],
      capabilityMode: 'hybrid',
      hybridMode: 'mixed',
    });

    const uc = buildUnifiedConfigFromPayload(payload);

    expect(uc).not.toBeNull();
    expect(uc!.technical).toEqual({ scanIntervalMs: 5000, venues: ['hyperliquid'] });
    expect(uc!.intelligence).toEqual({ provider: 'openai', wakeIntervalMs: 60_000 });
    expect(uc!.capabilityMode).toBe('hybrid');
    expect(uc!.hybridMode).toBe('mixed');
  });

  it('maps executionPolicy to unifiedConfig.execution (positionSizeMode, fixedPositionSize)', () => {
    const payload = makePayload({
      executionPolicy: {
        positionSizeMode: 'fixed',
        fixedPositionSize: '100',
      },
    });

    const uc = buildUnifiedConfigFromPayload(payload);

    expect(uc).not.toBeNull();
    const execution = uc!.execution as Record<string, unknown>;
    expect(execution.positionSizeMode).toBe('fixed');
    expect(execution.fixedPositionSize).toBe('100');
  });

  it('merges executionDefaults.mode into unifiedConfig.execution', () => {
    const payload = makePayload({
      executionDefaults: { mode: 'paper', slippageBps: 50 },
    });

    const uc = buildUnifiedConfigFromPayload(payload);

    expect(uc).not.toBeNull();
    const execution = uc!.execution as Record<string, unknown>;
    expect(execution.mode).toBe('paper');
  });

  it('merges executionPolicy and executionDefaults.mode into the same execution object', () => {
    const payload = makePayload({
      executionPolicy: {
        positionSizeMode: 'percent_equity',
        fixedPositionSize: undefined,
      },
      executionDefaults: { mode: 'shadow', slippageBps: null },
    });

    const uc = buildUnifiedConfigFromPayload(payload);

    expect(uc).not.toBeNull();
    const execution = uc!.execution as Record<string, unknown>;
    expect(execution.positionSizeMode).toBe('percent_equity');
    expect(execution.mode).toBe('shadow');
  });

  it('sets authorizationMode (defaults to "direct" when null)', () => {
    const payload = makePayload({ authorizationMode: null });

    const uc = buildUnifiedConfigFromPayload(payload);

    expect(uc).not.toBeNull();
    expect(uc!.authorizationMode).toBe('direct');
  });

  it('preserves explicit authorizationMode value', () => {
    const payload = makePayload({ authorizationMode: 'approval_required' });

    const uc = buildUnifiedConfigFromPayload(payload);

    expect(uc!.authorizationMode).toBe('approval_required');
  });

  it('includes allowedPresets, presetTransition, platformAssessment when present', () => {
    const allowedPresets = { presets: ['minimal', 'standard'] };
    const presetTransition = { cooldownMs: 5000 };
    const platformAssessment = { enabled: true };

    const payload = makePayload({
      allowedPresets: allowedPresets as AgentBlueprintRevisionPayload['allowedPresets'],
      presetTransition: presetTransition as AgentBlueprintRevisionPayload['presetTransition'],
      platformAssessment: platformAssessment as AgentBlueprintRevisionPayload['platformAssessment'],
    });

    const uc = buildUnifiedConfigFromPayload(payload);

    expect(uc).not.toBeNull();
    expect(uc!.allowedPresets).toEqual(allowedPresets);
    expect(uc!.presetTransition).toEqual(presetTransition);
    expect(uc!.platformAssessment).toEqual(platformAssessment);
  });

  it('includes risk in unifiedConfig when present', () => {
    const risk = { maxOpenPositions: 5, dailyMaxLossPct: 3 };
    const payload = makePayload({ risk });

    const uc = buildUnifiedConfigFromPayload(payload);

    expect(uc).not.toBeNull();
    expect(uc!.risk).toEqual(risk);
  });

  it('uses riskOverride when provided', () => {
    const payloadRisk = { maxOpenPositions: 5 };
    const riskOverride = { maxOpenPositions: 10, dailyMaxLossPct: 2 };
    const payload = makePayload({ risk: payloadRisk });

    const uc = buildUnifiedConfigFromPayload(payload, riskOverride);

    expect(uc!.risk).toEqual(riskOverride);
    // Payload risk should NOT appear — override wins
    expect(uc!.risk).not.toEqual(payloadRisk);
  });

  it('always includes capabilityMode and authorizationMode even when all other fields are empty', () => {
    // capabilityMode is always set unconditionally, and authorizationMode
    // defaults to 'direct' when null. These two guarantee the result is
    // never null in practice — the null branch in the source is unreachable.
    const payload = makePayload({
      intelligence: undefined,
      technical: undefined,
      executionPolicy: undefined,
      executionDefaults: null,
      risk: null,
      allowedPresets: undefined,
      presetTransition: undefined,
      platformAssessment: undefined,
      authorizationMode: null,
    });

    const uc = buildUnifiedConfigFromPayload(payload);

    expect(uc).not.toBeNull();
    expect(uc!.capabilityMode).toBe('intelligence');
    expect(uc!.authorizationMode).toBe('direct');
  });
});

// ── Tests: createAgentFromPayload ────────────────────────────────────────────

describe('createAgentFromPayload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates agent with correct fields from payload', async () => {
    const tracker = makeInsertTracker();
    const tx = buildMockTx(tracker);

    const payload = makePayload({
      name: 'Momentum Agent',
      prompt: 'Trade momentum',
      style: 'aggressive',
      strategy: { type: 'momentum', decisionMode: 'mechanical', params: {} } as AgentBlueprintRevisionPayload['strategy'],
      risk: { maxOpenPositions: 5 },
      executionDefaults: { mode: 'paper', slippageBps: 50 },
      capital: 1000,
      maxBots: 3,
      tickIntervalMs: 30_000,
      openPositionEscalationToJudgePolicy: 'always',
    });

    const context: AgentFromPayloadContext = { userId: 'user-1' };
    const result = await createAgentFromPayload(tx, payload, [], context);

    expect(result.agentId).toBeTruthy();
    expect(result.unifiedConfig).not.toBeNull();

    const agent = tracker.agentRows[0]!;
    expect(agent.userId).toBe('user-1');
    expect(agent.name).toBe('Momentum Agent');
    expect(agent.prompt).toBe('Trade momentum');
    expect(agent.style).toBe('aggressive');
    expect(agent.risk).toEqual({ maxOpenPositions: 5 });
    expect(agent.executionDefaults).toEqual({ mode: 'paper', slippageBps: 50 });
    expect(agent.capital).toBe(1000);
    expect(agent.maxBots).toBe(3);
    expect(agent.tickIntervalMs).toBe(30_000);
    expect(agent.openPositionEscalationToJudgePolicy).toBe('always');
  });

  it('uses context.agentId when provided', async () => {
    const tracker = makeInsertTracker();
    const tx = buildMockTx(tracker);

    const context: AgentFromPayloadContext = { userId: 'user-1', agentId: 'custom-id-123' };
    const result = await createAgentFromPayload(tx, makePayload(), [], context);

    expect(result.agentId).toBe('custom-id-123');
    expect(tracker.agentRows[0]!.id).toBe('custom-id-123');
  });

  it('falls back to fallbackName when payload.name is absent', async () => {
    const tracker = makeInsertTracker();
    const tx = buildMockTx(tracker);

    const payload = makePayload();
    // Override name to be undefined (simulating absent name)
    (payload as Record<string, unknown>).name = undefined;

    const context: AgentFromPayloadContext = { userId: 'user-1', fallbackName: 'Fallback Name' };
    await createAgentFromPayload(tx, payload, [], context);

    expect(tracker.agentRows[0]!.name).toBe('Fallback Name');
  });

  it('falls back to empty string when both name and fallbackName are absent', async () => {
    const tracker = makeInsertTracker();
    const tx = buildMockTx(tracker);

    const payload = makePayload();
    (payload as Record<string, unknown>).name = undefined;

    const context: AgentFromPayloadContext = { userId: 'user-1' };
    await createAgentFromPayload(tx, payload, [], context);

    expect(tracker.agentRows[0]!.name).toBe('');
  });

  it('sets blueprintId and blueprintRevisionId from context', async () => {
    const tracker = makeInsertTracker();
    const tx = buildMockTx(tracker);

    const context: AgentFromPayloadContext = {
      userId: 'user-1',
      blueprintId: 'bp-100',
      blueprintRevisionId: 'rev-200',
    };
    await createAgentFromPayload(tx, makePayload(), [], context);

    expect(tracker.agentRows[0]!.blueprintId).toBe('bp-100');
    expect(tracker.agentRows[0]!.blueprintRevisionId).toBe('rev-200');
  });

  it('sets blueprintId/blueprintRevisionId to null when not in context', async () => {
    const tracker = makeInsertTracker();
    const tx = buildMockTx(tracker);

    const context: AgentFromPayloadContext = { userId: 'user-1' };
    await createAgentFromPayload(tx, makePayload(), [], context);

    expect(tracker.agentRows[0]!.blueprintId).toBeNull();
    expect(tracker.agentRows[0]!.blueprintRevisionId).toBeNull();
  });

  it('sets assignment source to "blueprint_instantiate" when blueprintId present', async () => {
    const tracker = makeInsertTracker();
    const tx = buildMockTx(tracker);

    const skillRefs: SkillRef[] = [
      { skillId: 'skill-a', skillRevisionId: 'skill-a:v1' },
    ];
    const context: AgentFromPayloadContext = {
      userId: 'user-1',
      blueprintId: 'bp-1',
      blueprintRevisionId: 'rev-1',
    };
    await createAgentFromPayload(tx, makePayload(), skillRefs, context);

    expect(tracker.skillRows[0]!.assignmentSource).toBe('blueprint_instantiate');
  });

  it('sets assignment source to "go_live" when no blueprintId', async () => {
    const tracker = makeInsertTracker();
    const tx = buildMockTx(tracker);

    const skillRefs: SkillRef[] = [
      { skillId: 'skill-a', skillRevisionId: 'skill-a:v1' },
    ];
    const context: AgentFromPayloadContext = { userId: 'user-1' };
    await createAgentFromPayload(tx, makePayload(), skillRefs, context);

    expect(tracker.skillRows[0]!.assignmentSource).toBe('go_live');
  });

  it('creates agent_skills rows with correct order', async () => {
    const tracker = makeInsertTracker();
    const tx = buildMockTx(tracker);

    const skillRefs: SkillRef[] = [
      { skillId: 'skill-a', skillRevisionId: 'skill-a:v1' },
      { skillId: 'skill-b', skillRevisionId: 'skill-b:v2' },
      { skillId: 'skill-c', skillRevisionId: 'skill-c:v3' },
    ];
    const context: AgentFromPayloadContext = { userId: 'user-1' };
    await createAgentFromPayload(tx, makePayload(), skillRefs, context);

    expect(tracker.skillRows).toHaveLength(3);
    expect(tracker.skillRows[0]!.skillId).toBe('skill-a');
    expect(tracker.skillRows[0]!.skillRevisionId).toBe('skill-a:v1');
    expect(tracker.skillRows[0]!.orderIndex).toBe(0);
    expect(tracker.skillRows[0]!.assignedByUserId).toBe('user-1');

    expect(tracker.skillRows[1]!.skillId).toBe('skill-b');
    expect(tracker.skillRows[1]!.orderIndex).toBe(1);

    expect(tracker.skillRows[2]!.skillId).toBe('skill-c');
    expect(tracker.skillRows[2]!.orderIndex).toBe(2);
  });

  it('does not insert skill rows when skillRefs is empty', async () => {
    const tracker = makeInsertTracker();
    const tx = buildMockTx(tracker);

    await createAgentFromPayload(tx, makePayload(), [], { userId: 'user-1' });

    expect(tracker.skillRows).toHaveLength(0);
    // Only one insert call should have been made (for agents)
    expect(tx.insert).toHaveBeenCalledTimes(1);
  });

  it('agent starts in stopped status', async () => {
    const tracker = makeInsertTracker();
    const tx = buildMockTx(tracker);

    await createAgentFromPayload(tx, makePayload(), [], { userId: 'user-1' });

    expect(tracker.agentRows[0]!.status).toBe('stopped');
  });

  it('uses riskOverride for agent risk column when provided', async () => {
    const tracker = makeInsertTracker();
    const tx = buildMockTx(tracker);

    const payloadRisk = { maxOpenPositions: 5 };
    const riskOverride = { maxOpenPositions: 10, dailyMaxLossPct: 2 };
    const payload = makePayload({ risk: payloadRisk });

    await createAgentFromPayload(tx, payload, [], { userId: 'user-1' }, riskOverride);

    // The agent.risk column should use riskOverride, not payload.risk
    expect(tracker.agentRows[0]!.risk).toEqual(riskOverride);
  });

  it('sets telegramChatId from context when provided', async () => {
    const tracker = makeInsertTracker();
    const tx = buildMockTx(tracker);

    const context: AgentFromPayloadContext = {
      userId: 'user-1',
      telegramChatId: 'chat-999',
    };
    await createAgentFromPayload(tx, makePayload(), [], context);

    expect(tracker.agentRows[0]!.telegramChatId).toBe('chat-999');
  });

  it('persists toolPolicy, modelPolicy, runtimePolicyOverrides, and wakePreferences from payload', async () => {
    const tracker = makeInsertTracker();
    const tx = buildMockTx(tracker);

    const payload = makePayload({
      toolPolicy: { execute_trade: 'allow' } as AgentBlueprintRevisionPayload['toolPolicy'],
      modelPolicy: { provider: 'openai', model: 'gpt-4o' } as AgentBlueprintRevisionPayload['modelPolicy'],
      runtimePolicyOverrides: { costPreset: 'minimal' } as AgentBlueprintRevisionPayload['runtimePolicyOverrides'],
      wakePreferences: { wakeOnNewPosition: true } as AgentBlueprintRevisionPayload['wakePreferences'],
    });

    await createAgentFromPayload(tx, payload, [], { userId: 'user-1' });

    const agent = tracker.agentRows[0]!;
    expect(agent.toolPolicy).toEqual({ execute_trade: 'allow' });
    expect(agent.modelPolicy).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(agent.runtimePolicyOverrides).toEqual({ costPreset: 'minimal' });
    expect(agent.wakePreferences).toEqual({ wakeOnNewPosition: true });
  });

  it('sets telegramChatId to null when not provided', async () => {
    const tracker = makeInsertTracker();
    const tx = buildMockTx(tracker);

    await createAgentFromPayload(tx, makePayload(), [], { userId: 'user-1' });

    expect(tracker.agentRows[0]!.telegramChatId).toBeNull();
  });
});
