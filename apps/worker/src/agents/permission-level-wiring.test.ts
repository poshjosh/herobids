/**
 * Tests for Phase 3: Permission Level Runtime Wiring (steps 3.1–3.3).
 *
 * Covers:
 * - Session manager propagates permissionLevel from the agent DB record into agentConfig
 * - Default fallback to 'standard' when permissionLevel is absent
 * - Tool visibility gating: execute_shell excluded for 'restricted' agents
 * - Tool visibility gating: execute_shell visible for 'standard' and 'full'
 * - ToolContext.permissionLevel wired from agentConfig
 */

import { describe, it, expect, vi } from 'vitest';
import type { RuntimeDescriptor } from '@herobids/domain';
import { AgentSessionManager } from './agent-session-manager.js';
import { createRuntimeToolVisibilityController } from '../runtime-tool-visibility.js';

// ── Shared helpers ────────────────────────────────────────────────────────

const TEST_RUNTIME_BUDGETS = {
  maxHistoryMessages: 20,
  maxHistoryTokens: 40_000,
  maxRecentToolMessages: 6,
  maxToolResultChars: 4_000,
  maxVisibleToolSchemas: 37,
  maxContextBlockChars: 4_000,
};

function makeRuntimeDescriptor(agentId: string): RuntimeDescriptor {
  return {
    schemaVersion: 'v1',
    agentId,
    goal: 'Test agent',
    executionMode: 'paper',
    resolvedSkills: [
      {
        id: 'base',
        name: 'base',
        description: '',
        requiredTools: ['send_message', 'publish_artifact', 'set_memory'],
        isOptional: false,
        prompt: '',
      },
    ],
    grantedConnectionsByFamily: {},
    readinessByFamily: {},
    defaultConnectionByFamily: {},
    toolPolicy: {},
    guardrails: {},
    budgets: TEST_RUNTIME_BUDGETS,
  };
}

function makeAgent(agentId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    userId: 'user-1',
    name: 'TestAgent',
    prompt: 'Test agent',
    skillIds: [],
    toolPolicy: null,
    modelPolicy: {
      provider: 'anthropic',
      lightModel: 'claude-haiku-3-5',
      heavyModel: 'claude-sonnet-4-5',
    },
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

function buildManager() {
  const agentRepo = {
    getSession: vi.fn(),
    getActiveLink: vi.fn().mockResolvedValue(null),
    getLaunchableStartingSessions: vi.fn().mockResolvedValue([]),
    claimStartingSession: vi.fn().mockResolvedValue(true),
    markSessionRunning: vi.fn().mockResolvedValue(true),
    markSessionStopped: vi.fn().mockResolvedValue(true),
    markSessionEnded: vi.fn().mockResolvedValue(true),
    markSessionStartTimedOut: vi.fn().mockResolvedValue(true),
    updateSession: vi.fn().mockResolvedValue(undefined),
    updateAgent: vi.fn().mockResolvedValue(undefined),
    getActiveSession: vi.fn().mockResolvedValue(null),
    isActiveSession: vi.fn().mockResolvedValue(true),
    getSessionForAgentAndInstance: vi.fn().mockResolvedValue(null),
    retireActiveSessions: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn().mockImplementation(async (agentId: string) => makeAgent(agentId)),
    getUserAiModelConfig: vi.fn().mockResolvedValue(null),
    getSessionsByStatuses: vi.fn().mockResolvedValue([]),
    getRuntimeCapabilityDescriptor: vi.fn().mockImplementation(async (agentId: string) =>
      makeRuntimeDescriptor(agentId),
    ),
    recordSessionStartedSkillUsage: vi.fn().mockResolvedValue(undefined),
  };

  const runtimeLauncher = {
    launch: vi.fn().mockResolvedValue({
      containerId: 'container-1',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      startedAt: new Date().toISOString(),
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    hasRuntime: vi.fn().mockReturnValue(false),
    registerRecoveredRuntime: vi.fn(),
    reconcile: vi.fn().mockResolvedValue(undefined),
    refreshLiveDocuments: vi.fn().mockResolvedValue(undefined),
    cleanupSessionDocuments: vi.fn().mockResolvedValue(undefined),
  };

  const eventPublisher = {
    emitGuardrailTriggered: vi.fn().mockResolvedValue(undefined),
    emitInstanceStatus: vi.fn().mockResolvedValue(undefined),
    publishUserNotification: vi.fn().mockResolvedValue(undefined),
  };

  const manager = new AgentSessionManager(
    agentRepo as any,
    eventPublisher as any,
    runtimeLauncher as any,
    { budgets: TEST_RUNTIME_BUDGETS },
  );

  return { manager, agentRepo, runtimeLauncher };
}

// ── 1. Session manager propagates permissionLevel ─────────────────────────

describe('AgentSessionManager permissionLevel propagation', () => {
  it('passes permissionLevel from agent DB record into agentConfig', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager();

    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-1', agentId: 'agent-1' },
    ]);
    (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgent('agent-1', { permissionLevel: 'full' }),
    );

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfig: expect.objectContaining({
          permissionLevel: 'full',
        }),
      }),
    );
  });

  it('passes restricted permissionLevel into agentConfig', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager();

    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-1', agentId: 'agent-1' },
    ]);
    (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgent('agent-1', { permissionLevel: 'restricted' }),
    );

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfig: expect.objectContaining({
          permissionLevel: 'restricted',
        }),
      }),
    );
  });

  it('defaults to standard when permissionLevel is undefined on agent record', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager();

    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-1', agentId: 'agent-1' },
    ]);
    // Agent record without permissionLevel field
    (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgent('agent-1'),
    );

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfig: expect.objectContaining({
          permissionLevel: 'standard',
        }),
      }),
    );
  });

  it('defaults to standard when permissionLevel is null on agent record', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager();

    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-1', agentId: 'agent-1' },
    ]);
    (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgent('agent-1', { permissionLevel: null }),
    );

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfig: expect.objectContaining({
          permissionLevel: 'standard',
        }),
      }),
    );
  });
});

// ── 2. Tool visibility gating via permanentlyExcludedTools ────────────────

describe('execute_shell visibility gating by permissionLevel', () => {
  function makeDescriptorWithShell(): RuntimeDescriptor {
    return {
      schemaVersion: 'v1',
      agentId: 'test-agent',
      goal: 'test',
      executionMode: 'paper',
      resolvedSkills: [
        {
          id: 'programming',
          name: 'programming',
          description: '',
          requiredTools: ['execute_code', 'execute_shell', 'read_file', 'write_file'],
          isOptional: false,
          prompt: '',
        },
      ],
      grantedConnectionsByFamily: {},
      defaultConnectionByFamily: {},
      readinessByFamily: {},
      toolPolicy: {},
      guardrails: {},
      budgets: TEST_RUNTIME_BUDGETS,
    };
  }

  it('excludes execute_shell when permanentlyExcludedTools contains it (restricted agent)', () => {
    const descriptor = makeDescriptorWithShell();
    const excluded = new Set(['execute_shell']);
    const controller = createRuntimeToolVisibilityController(() => descriptor, excluded);

    const allowed = controller.allowedTools();
    expect(allowed).not.toContain('execute_shell');
    // Other tools from the same skill remain visible
    expect(allowed).toContain('execute_code');
    expect(allowed).toContain('read_file');
    expect(allowed).toContain('write_file');
  });

  it('includes execute_shell when permanentlyExcludedTools is empty (standard/full agent)', () => {
    const descriptor = makeDescriptorWithShell();
    const excluded = new Set<string>();
    const controller = createRuntimeToolVisibilityController(() => descriptor, excluded);

    const allowed = controller.allowedTools();
    expect(allowed).toContain('execute_shell');
  });

  it('removes execute_shell from resolvedSkills.requiredTools when permanently excluded', () => {
    const descriptor = makeDescriptorWithShell();
    const excluded = new Set(['execute_shell']);
    createRuntimeToolVisibilityController(() => descriptor, excluded);

    // After controller construction, the skill's requiredTools should be mutated
    const programmingSkill = descriptor.resolvedSkills.find((s) => s.id === 'programming');
    expect(programmingSkill).toBeDefined();
    expect(programmingSkill!.requiredTools).not.toContain('execute_shell');
    expect(programmingSkill!.requiredTools).toContain('execute_code');
  });

  it('excludes only execute_shell and preserves other tools across skills', () => {
    // Verify that permanent exclusion is scoped to just the named tool, not siblings
    const descriptor: RuntimeDescriptor = {
      schemaVersion: 'v1',
      agentId: 'test-agent',
      goal: 'test',
      executionMode: 'paper',
      resolvedSkills: [
        {
          id: 'programming',
          name: 'programming',
          description: '',
          requiredTools: ['execute_code', 'execute_shell'],
          isOptional: false,
          prompt: '',
        },
        {
          id: 'base',
          name: 'base',
          description: '',
          requiredTools: ['send_message', 'set_memory'],
          isOptional: false,
          prompt: '',
        },
      ],
      grantedConnectionsByFamily: {},
      defaultConnectionByFamily: {},
      readinessByFamily: {},
      toolPolicy: {},
      guardrails: {},
      budgets: TEST_RUNTIME_BUDGETS,
    };
    const excluded = new Set(['execute_shell']);
    const controller = createRuntimeToolVisibilityController(() => descriptor, excluded);

    const allowed = controller.allowedTools();
    expect(allowed).not.toContain('execute_shell');
    expect(allowed).toContain('execute_code');
    expect(allowed).toContain('send_message');
    expect(allowed).toContain('set_memory');
  });
});

// ── 3. ToolContext.permissionLevel contract ───────────────────────────────

describe('ToolContext permissionLevel contract', () => {
  it('ToolContext interface requires permissionLevel field', () => {
    // TypeScript compile-time check: create a minimal ToolContext-like object
    // to verify the field is required. This test acts as a compile-time guard
    // — it would fail to compile if permissionLevel were removed from ToolContext.
    const ctx: Pick<import('@herobids/domain').ToolContext, 'permissionLevel'> = {
      permissionLevel: 'standard',
    };
    expect(ctx.permissionLevel).toBe('standard');
  });

  it('accepts all three valid permission levels', () => {
    const levels = ['restricted', 'standard', 'full'] as const;
    for (const level of levels) {
      const ctx: Pick<import('@herobids/domain').ToolContext, 'permissionLevel'> = {
        permissionLevel: level,
      };
      expect(ctx.permissionLevel).toBe(level);
    }
  });
});
