import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentSessionManager } from './agent-session-manager.js';

// P6: capacity-aware startup. Covers the startup-deadline expiry claim and the post-submit
// markRuntimeRegistered hook. The builder is separate from agent-session-manager.test.ts because
// that suite's helper does not apply overrides.

const TEST_RUNTIME_BUDGETS = {
  maxHistoryMessages: 20,
  maxHistoryTokens: 40000,
  maxRecentToolMessages: 6,
  maxToolResultChars: 4000,
  maxVisibleToolSchemas: 37,
  maxContextBlockChars: 4000,
};

const RUNTIME_REGISTERED_AT = new Date('2026-10-30T10:00:00.000Z');
const FIRST_PLACED_AT = new Date('2026-10-30T10:01:00.000Z');

function buildManager(options: { gate: boolean; observes?: boolean }) {
  const runtimeDescriptor = {
    schemaVersion: 'v1' as const,
    agentId: 'agent-1',
    goal: 'Test agent',
    executionMode: 'paper',
    resolvedSkills: [{ id: 'base', capabilityFamilies: [], requiredTools: ['send_message', 'publish_artifact', 'set_memory'] }],
    grantedConnectionsByFamily: {},
    readinessByFamily: {},
    defaultConnectionByFamily: {},
    toolPolicy: {},
    guardrails: {
      dailyTokenBudget: null,
      dailyLossLimit: null,
      maxBots: null,
      maxSlippageBps: null,
    },
    budgets: TEST_RUNTIME_BUDGETS,
  };
  const makeAgent = (agentId: string) => ({
    id: agentId,
    userId: 'user-1',
    name: 'Agent One',
    status: 'starting',
    prompt: 'Test agent',
    skillIds: [],
    toolPolicy: null,
    modelPolicy: { provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5' },
    executionDefaults: null,
    dailyTokenBudget: null,
    dailyLossLimit: null,
    maxBots: null,
    maxSlippageBps: null,
  });
  const agentRepo = {
    getSession: vi.fn().mockResolvedValue(null),
    getActiveLink: vi.fn().mockResolvedValue({ botId: 'inst-1' }),
    getLaunchableStartingSessions: vi.fn().mockResolvedValue([]),
    claimStartingSession: vi.fn().mockResolvedValue(true),
    markSessionRunning: vi.fn().mockResolvedValue(true),
    markSessionStopped: vi.fn().mockResolvedValue(true),
    markSessionEnded: vi.fn().mockResolvedValue(true),
    markSessionStartTimedOut: vi.fn().mockResolvedValue(true),
    markRuntimeRegistered: vi.fn().mockResolvedValue(true),
    expireStartingSession: vi.fn().mockResolvedValue(true),
    updateSession: vi.fn().mockResolvedValue(undefined),
    updateAgent: vi.fn().mockResolvedValue(undefined),
    activateAgentUnlessPaused: vi.fn().mockResolvedValue('active'),
    getActiveSession: vi.fn().mockResolvedValue(null),
    isActiveSession: vi.fn().mockResolvedValue(true),
    getSessionForAgentAndInstance: vi.fn().mockResolvedValue(null),
    retireActiveSessions: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn().mockImplementation(async (agentId: string) => makeAgent(agentId)),
    getUserAiModelConfig: vi.fn().mockResolvedValue(null),
    getSessionsByStatuses: vi.fn().mockResolvedValue([]),
    getRuntimeCapabilityDescriptor: vi.fn().mockImplementation(async (agentId: string) => ({
      ...runtimeDescriptor,
      agentId,
    })),
    recordSessionStartedSkillUsage: vi.fn().mockResolvedValue(undefined),
  };

  const runtimeLauncher = {
    launch: vi.fn().mockResolvedValue({ containerId: 'container-1', agentId: 'agent-1', sessionId: 'sess-1', startedAt: new Date().toISOString() }),
    stop: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    hasRuntime: vi.fn().mockReturnValue(false),
    registerRecoveredRuntime: vi.fn(),
    reconcile: vi.fn().mockResolvedValue(undefined),
    refreshLiveDocuments: vi.fn().mockResolvedValue(undefined),
    cleanupSessionDocuments: vi.fn().mockResolvedValue(undefined),
    supportsStartupObservation: vi.fn().mockReturnValue(options.observes ?? true),
  };

  const eventPublisher = {
    emitGuardrailTriggered: vi.fn().mockResolvedValue(undefined),
    emitInstanceStatus: vi.fn().mockResolvedValue(undefined),
  };
  const platformAlerts = {
    fireAlert: vi.fn().mockResolvedValue(undefined),
  };
  const onAgentStatusChange = vi.fn();

  const manager = new AgentSessionManager(
    agentRepo as any,
    eventPublisher as any,
    runtimeLauncher as any,
    {
      budgets: TEST_RUNTIME_BUDGETS,
      capacityAwareStartEnabled: options.gate,
      onAgentStatusChange,
    } as any,
    undefined,
    platformAlerts as any,
  );

  return { manager, agentRepo, runtimeLauncher, eventPublisher, platformAlerts, onAgentStatusChange };
}

const LAUNCHABLE_SESSION = { id: 'sess-1', agentId: 'agent-1', botId: 'inst-1' };

describe('AgentSessionManager P6 startup expiry', () => {
  const launchingClaim = {
    status: 'launching' as const,
    runtimeRegisteredAt: RUNTIME_REGISTERED_AT,
    firstPlacedAt: null,
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T10:15:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not stop the runtime, update the agent, or emit events when the repository rejects the claim', async () => {
    const { manager, agentRepo, runtimeLauncher, eventPublisher, platformAlerts, onAgentStatusChange } = buildManager({ gate: true });
    (agentRepo.expireStartingSession as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const expired = await manager.expireStartupDeadline('agent-1', 'sess-1', launchingClaim, 'queue_deadline');

    expect(expired).toBe(false);
    expect(agentRepo.expireStartingSession).toHaveBeenCalledTimes(1);
    expect(runtimeLauncher.stop).not.toHaveBeenCalled();
    expect(agentRepo.updateAgent).not.toHaveBeenCalled();
    expect(eventPublisher.emitGuardrailTriggered).not.toHaveBeenCalled();
    expect(platformAlerts.fireAlert).not.toHaveBeenCalled();
    expect(onAgentStatusChange).not.toHaveBeenCalled();
  });

  it('passes the expected status and startup facts and the current time to the claim', async () => {
    const { manager, agentRepo } = buildManager({ gate: true });

    await manager.expireStartupDeadline('agent-1', 'sess-1', launchingClaim, 'observation_failure');

    expect(agentRepo.expireStartingSession).toHaveBeenCalledWith(
      'sess-1',
      new Date('2026-10-30T10:15:00.000Z'),
      launchingClaim,
    );
  });

  it('lets the successful claimant stop the runtime, mark the agent stopped, and emit the failure event exactly once', async () => {
    const { manager, agentRepo, runtimeLauncher, eventPublisher, platformAlerts, onAgentStatusChange } = buildManager({ gate: true });
    (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'agent-1', userId: 'user-1', status: 'stopped' });

    const expired = await manager.expireStartupDeadline('agent-1', 'sess-1', launchingClaim, 'queue_deadline');

    expect(expired).toBe(true);
    expect(runtimeLauncher.stop).toHaveBeenCalledTimes(1);
    expect(runtimeLauncher.stop).toHaveBeenCalledWith('sess-1');
    expect(agentRepo.updateAgent).toHaveBeenCalledWith('agent-1', { status: 'stopped' });
    expect(onAgentStatusChange).toHaveBeenCalledWith('agent-1', 'user-1', 'stopped');
    expect(eventPublisher.emitGuardrailTriggered).toHaveBeenCalledTimes(1);
    expect(eventPublisher.emitGuardrailTriggered).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      scope: 'agent_guardrail',
      code: 'startup.queue_deadline',
    }));
    expect(platformAlerts.fireAlert).toHaveBeenCalledTimes(1);
  });

  it('emits no startup guardrail for a start_timeout expiry but still fires the runtime-failed alert', async () => {
    const { manager, eventPublisher, platformAlerts } = buildManager({ gate: true });

    await manager.expireStartupDeadline('agent-1', 'sess-1', launchingClaim, 'start_timeout');

    expect(eventPublisher.emitGuardrailTriggered).not.toHaveBeenCalled();
    expect(platformAlerts.fireAlert).toHaveBeenCalledTimes(1);
  });

  it('a second expiry attempt after the claim is lost does not repeat the stop or the events', async () => {
    const { manager, agentRepo, runtimeLauncher, eventPublisher } = buildManager({ gate: true });
    (agentRepo.expireStartingSession as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await manager.expireStartupDeadline('agent-1', 'sess-1', launchingClaim, 'boot_deadline');
    const second = await manager.expireStartupDeadline('agent-1', 'sess-1', launchingClaim, 'boot_deadline');

    expect(second).toBe(false);
    expect(runtimeLauncher.stop).toHaveBeenCalledTimes(1);
    expect(eventPublisher.emitGuardrailTriggered).toHaveBeenCalledTimes(1);
  });
});

describe('AgentSessionManager P6 post-submit markRuntimeRegistered hook', () => {
  it('records scheduler registration after a successful submit', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager({ gate: true });
    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([LAUNCHABLE_SESSION]);

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.launch).toHaveBeenCalledTimes(1);
    expect(agentRepo.markRuntimeRegistered).toHaveBeenCalledTimes(1);
    expect(agentRepo.markRuntimeRegistered).toHaveBeenCalledWith('sess-1', expect.any(Date));
    expect(runtimeLauncher.launch.mock.invocationCallOrder[0]!)
      .toBeLessThan(agentRepo.markRuntimeRegistered.mock.invocationCallOrder[0]!);
  });

  it('does not record registration when the submit fails', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager({ gate: true });
    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([LAUNCHABLE_SESSION]);
    (runtimeLauncher.launch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('nomad submit failed'));

    await manager.reconcileStartingSessions();

    expect(agentRepo.markRuntimeRegistered).not.toHaveBeenCalled();
  });

  it('does not record registration when the gate is off', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager({ gate: false });
    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([LAUNCHABLE_SESSION]);

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.launch).toHaveBeenCalledTimes(1);
    expect(agentRepo.markRuntimeRegistered).not.toHaveBeenCalled();
  });

  it('does not record registration when the port cannot observe startup', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager({ gate: true, observes: false });
    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([LAUNCHABLE_SESSION]);

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.launch).toHaveBeenCalledTimes(1);
    expect(agentRepo.markRuntimeRegistered).not.toHaveBeenCalled();
  });

  it('does not resurrect a session stopped during the slow submit and reclaims the submitted job', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager({ gate: true });
    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([LAUNCHABLE_SESSION]);
    (agentRepo.markRuntimeRegistered as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sess-1', agentId: 'agent-1', status: 'stopped' });

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.stop).toHaveBeenCalledWith('sess-1');
    expect(agentRepo.updateAgent).not.toHaveBeenCalledWith('agent-1', { lastStartRefusal: null });
    expect(agentRepo.updateSession).not.toHaveBeenCalledWith('sess-1', expect.objectContaining({ status: 'running' }));
    expect(agentRepo.markSessionRunning).not.toHaveBeenCalled();
  });

  it('reclaims the job for a crashed session in the same way', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager({ gate: true });
    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([LAUNCHABLE_SESSION]);
    (agentRepo.markRuntimeRegistered as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sess-1', agentId: 'agent-1', status: 'crashed' });

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.stop).toHaveBeenCalledWith('sess-1');
  });

  it('keeps a live session when registration was already recorded by another writer', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager({ gate: true });
    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([LAUNCHABLE_SESSION]);
    (agentRepo.markRuntimeRegistered as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sess-1', agentId: 'agent-1', status: 'launching' });

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.stop).not.toHaveBeenCalled();
    expect(agentRepo.updateAgent).toHaveBeenCalledWith('agent-1', { lastStartRefusal: null });
  });
});
