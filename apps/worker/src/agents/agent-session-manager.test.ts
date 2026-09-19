import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentSessionManager } from './agent-session-manager.js';

const TEST_RUNTIME_BUDGETS = {
  maxHistoryMessages: 20,
  maxHistoryTokens: 40000,
  maxRecentToolMessages: 6,
  maxToolResultChars: 4000,
  maxVisibleToolSchemas: 37,
  maxContextBlockChars: 4000,
};

describe('AgentSessionManager', () => {
  function buildManager(overrides: Record<string, unknown> = {}) {
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
      getSession: vi.fn(),
      getActiveLink: vi.fn().mockResolvedValue({ botId: 'inst-1' }),
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
    };

    const reconnectHandler = {
      handleReconnect: vi.fn().mockResolvedValue(undefined),
    };

    const eventPublisher = {
      emitGuardrailTriggered: vi.fn().mockResolvedValue(undefined),
      emitInstanceStatus: vi.fn().mockResolvedValue(undefined),
    };
    const manager = new AgentSessionManager(
      agentRepo as any,
      eventPublisher as any,
      runtimeLauncher as any,
      {
        budgets: TEST_RUNTIME_BUDGETS,
      },
      reconnectHandler as any,
    );

    return { manager, agentRepo, runtimeLauncher, reconnectHandler };
  }

  it('launches each eligible starting session exactly once', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager();
    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-1', agentId: 'agent-1', botId: 'inst-1' },
      { id: 'sess-2', agentId: 'agent-2', botId: 'inst-2' },
    ]);

    await manager.reconcileStartingSessions();

    expect(agentRepo.claimStartingSession).toHaveBeenCalledTimes(2);
    expect(runtimeLauncher.launch).toHaveBeenCalledTimes(2);
    expect(runtimeLauncher.launch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      agentConfig: expect.objectContaining({
        prompt: 'Test agent',
      }),
      runtimeDescriptor: expect.objectContaining({
        agentId: 'agent-1',
        goal: 'Test agent',
        budgets: TEST_RUNTIME_BUDGETS,
        resolvedSkills: expect.any(Array),
        readinessByFamily: expect.any(Object),
        grantedConnectionsByFamily: expect.any(Object),
      }),
    }));
    const launchedConfig = (runtimeLauncher.launch as ReturnType<typeof vi.fn>).mock.calls[0]![0].agentConfig as Record<string, unknown>;
    expect(launchedConfig).not.toHaveProperty('capital');
    expect(launchedConfig).not.toHaveProperty('risk');
    expect(launchedConfig).not.toHaveProperty('executionMode');
    expect(launchedConfig).not.toHaveProperty('maxSlippageBps');
    expect(runtimeLauncher.launch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-2',
      agentId: 'agent-2',
      runtimeDescriptor: expect.objectContaining({
        agentId: 'agent-2',
        goal: 'Test agent',
      }),
    }));
  });

  it('builds a trading-ready runtime descriptor when the agent has an active binding grant', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager();
    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-1', agentId: 'agent-1', botId: 'inst-1' },
    ]);
    (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'agent-1',
      userId: 'user-1',
      prompt: 'Trade BTC conservatively',
      skillIds: ['bot-management'],
      toolPolicy: { manage_bot: { capability: 'manage_bot', tier: 'brokered', enabled: true } },
      modelPolicy: { provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5' },
      executionDefaults: { mode: 'paper' },
      dailyTokenBudget: 1000,
      dailyLossLimit: '50',
      maxBots: 2,
      maxSlippageBps: 25,
    });
    (agentRepo.getRuntimeCapabilityDescriptor as ReturnType<typeof vi.fn>).mockResolvedValue({
      grantedConnectionsByFamily: {
        trading: [
          {
            family: 'trading',
            connectionId: 'binding-1',
            provider: 'hyperliquid',
            label: 'Primary HL binding',
            bindingRef: 'acct-1',
            bindingProfile: { venue: 'hyperliquid' },
            resolvedVenueAccountId: 'va-1',
            readiness: {
              family: 'trading',
              state: 'ready',
              connectionReadiness: 'ready',
              agentEligibility: 'eligible',
              effectiveReady: true,
              connectionId: 'binding-1',
              reasons: [],
            },
            isDefault: true,
          },
        ],
      },
      readinessByFamily: {
        trading: {
          family: 'trading',
          state: 'ready',
          connectionReadiness: 'ready',
          agentEligibility: 'eligible',
          effectiveReady: true,
          connectionId: 'binding-1',
          reasons: [],
        },
      },
      defaultConnectionByFamily: { trading: 'binding-1' },
    });

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.launch).toHaveBeenCalledWith(expect.objectContaining({
      agentConfig: expect.objectContaining({
        prompt: 'Trade BTC conservatively',
      }),
      runtimeDescriptor: expect.objectContaining({
        agentId: 'agent-1',
        goal: 'Trade BTC conservatively',
        executionMode: 'paper',
        defaultConnectionByFamily: { trading: 'binding-1' },
        readinessByFamily: {
          trading: expect.objectContaining({ effectiveReady: true, connectionId: 'binding-1' }),
        },
        grantedConnectionsByFamily: {
          trading: [expect.objectContaining({ provider: 'hyperliquid', isDefault: true })],
        },
      }),
    }));
  });

  it('forwards explicit DEX watchlist symbols from model policy into agent config', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager();
    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-1', agentId: 'agent-1', botId: 'inst-1' },
    ]);
    (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'agent-1',
      userId: 'user-1',
      prompt: 'Watch DEX momentum names',
      skillIds: ['trading'],
      toolPolicy: null,
      modelPolicy: { provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5', dexWatchlistSymbols: ['BONK', 'WIF'] },
      executionDefaults: { mode: 'paper' },
      dailyTokenBudget: null,
      dailyLossLimit: null,
      maxBots: null,
      maxSlippageBps: null,
    });

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.launch).toHaveBeenCalledWith(expect.objectContaining({
      agentConfig: expect.objectContaining({
        dexWatchlistSymbols: ['BONK', 'WIF'],
      }),
    }));
  });

  it('forwards saved user model defaults into agent config for runtime fallback resolution', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager();
    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-1', agentId: 'agent-1', botId: 'inst-1' },
    ]);
    (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'agent-1',
      userId: 'user-1',
      prompt: 'Trade BTC carefully',
      skillIds: [],
      toolPolicy: null,
      modelPolicy: { lightModel: 'gpt-4o-mini' },
      executionDefaults: { mode: 'paper' },
      dailyTokenBudget: null,
      dailyLossLimit: null,
      maxBots: null,
      maxSlippageBps: null,
    });
    (agentRepo.getUserAiModelConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider: 'openai',
      lightModel: 'gpt-4.1-mini',
      heavyModel: 'gpt-4.1',
    });

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.launch).toHaveBeenCalledWith(expect.objectContaining({
      agentConfig: expect.objectContaining({
        lightModel: 'gpt-4o-mini',
        userModelDefaults: {
          provider: 'openai',
          lightModel: 'gpt-4.1-mini',
          heavyModel: 'gpt-4.1',
        },
      }),
    }));
  });

  it('skips launch, stops the session, and emits guardrail when model selection is incomplete', async () => {
    const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();
    const eventPublisher = {
      emitGuardrailTriggered: vi.fn().mockResolvedValue(undefined),
      emitInstanceStatus: vi.fn().mockResolvedValue(undefined),
    };
    const manager = new AgentSessionManager(
      agentRepo as any,
      eventPublisher as any,
      runtimeLauncher as any,
      { budgets: TEST_RUNTIME_BUDGETS },
      reconnectHandler as any,
    );

    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-1', agentId: 'agent-1' },
    ]);
    (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'agent-1',
      userId: 'user-1',
      prompt: 'Trade carefully',
      skillIds: [],
      toolPolicy: null,
      modelPolicy: null, // No model policy set
      executionDefaults: null,
      dailyTokenBudget: null,
      dailyLossLimit: null,
      maxBots: null,
      maxSlippageBps: null,
    });
    (agentRepo.getUserAiModelConfig as ReturnType<typeof vi.fn>).mockResolvedValue(null); // No user AI settings

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.launch).not.toHaveBeenCalled();
    expect(agentRepo.updateAgent).toHaveBeenCalledWith('agent-1', { status: 'stopped' });
    expect(agentRepo.markSessionStopped).toHaveBeenCalledWith('sess-1', expect.any(Date));
    expect(eventPublisher.emitGuardrailTriggered).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({
        scope: 'agent_guardrail',
        code: 'config.model_selection_incomplete',
      }),
    );
    expect(eventPublisher.emitInstanceStatus).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ status: 'stopped', reason: 'config.model_selection_incomplete' }),
    );
  });

  it('skips a session whose claim fails (another worker already claimed it)', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager();
    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-1', agentId: 'agent-1', botId: 'inst-1' },
    ]);
    (agentRepo.claimStartingSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    await manager.reconcileStartingSessions();

    expect(agentRepo.claimStartingSession).toHaveBeenCalledWith('sess-1');
    expect(runtimeLauncher.launch).not.toHaveBeenCalled();
  });

  it('continues reconciling later sessions if one launch fails', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager();
    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-1', agentId: 'agent-1', botId: 'inst-1' },
      { id: 'sess-2', agentId: 'agent-2', botId: 'inst-2' },
    ]);
    (runtimeLauncher.launch as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('launch failed'))
      .mockResolvedValueOnce({ containerId: 'container-2', agentId: 'agent-2', sessionId: 'sess-2', startedAt: new Date().toISOString() });

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.launch).toHaveBeenCalledTimes(2);
    expect(runtimeLauncher.launch).toHaveBeenNthCalledWith(1, expect.objectContaining({ sessionId: 'sess-1' }));
    expect(runtimeLauncher.launch).toHaveBeenNthCalledWith(2, expect.objectContaining({ sessionId: 'sess-2' }));
  });

  it('promotes a starting session to running on first heartbeat', async () => {
    const { manager, agentRepo, reconnectHandler } = buildManager();
    (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'sess-1',
      agentId: 'agent-1',
      botId: 'inst-1',
      status: 'starting',
    });

    await manager.handleHeartbeat(
      {
        schemaVersion: 'v1',
        messageId: 'msg-1',
        correlationId: 'corr-1',
        initiatorType: 'agent',
        initiatorId: 'agent-1',
        botId: 'inst-1',
        type: 'agent.runtime.heartbeat',
        createdAt: '2026-06-03T00:00:00.000Z',
        payload: {},
      },
      {
        sessionId: 'sess-1',
        status: 'ready',
      },
    );

    expect(agentRepo.markSessionRunning).toHaveBeenCalledWith('sess-1', expect.any(Date));
    expect(agentRepo.updateAgent).toHaveBeenCalledWith('agent-1', { status: 'active' });
    expect(reconnectHandler.handleReconnect).toHaveBeenCalledWith('agent-1', 'sess-1');
  });

  it('stops the launcher handle when a session stops', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager();
    (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'sess-1',
      agentId: 'agent-1',
      botId: 'inst-1',
      status: 'running',
    });

    await manager.stopSession('sess-1');

    expect(runtimeLauncher.stop).toHaveBeenCalledWith('sess-1');
    expect(agentRepo.markSessionStopped).toHaveBeenCalledWith('sess-1', expect.any(Date));
    expect(agentRepo.updateAgent).toHaveBeenCalledWith('agent-1', { status: 'stopped' });
  });

  it('marks a never-connected session as stopped on timeout', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager();
    (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'sess-1',
      agentId: 'agent-1',
      botId: 'inst-1',
      status: 'starting',
    });

    await manager.handleStartTimeout('sess-1');

    expect(agentRepo.markSessionStartTimedOut).toHaveBeenCalledWith('sess-1', expect.any(Date));
    expect(runtimeLauncher.stop).toHaveBeenCalledWith('sess-1');
    expect(agentRepo.updateAgent).toHaveBeenCalledWith('agent-1', { status: 'stopped' });
  });

  it('ignores heartbeats for sessions in a terminal state', async () => {
    const { manager, agentRepo } = buildManager();
    (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'sess-1',
      agentId: 'agent-1',
      status: 'stopped',
    });

    await manager.handleHeartbeat(
      {
        schemaVersion: 'v1',
        messageId: 'msg-2',
        correlationId: 'corr-2',
        initiatorType: 'agent',
        initiatorId: 'agent-1',
        type: 'agent.runtime.heartbeat',
        createdAt: '2026-06-06T00:00:00.000Z',
        payload: {},
      },
      {
        sessionId: 'sess-1',
        status: 'ready',
      },
    );

    expect(agentRepo.markSessionRunning).not.toHaveBeenCalled();
    expect(agentRepo.updateAgent).not.toHaveBeenCalled();
  });

  it('triggers reconnect recovery for a running session when the worker has no in-memory handle', async () => {
    const { manager, agentRepo, runtimeLauncher, reconnectHandler } = buildManager();
    (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'sess-1',
      agentId: 'agent-1',
      botId: 'inst-1',
      status: 'running',
    });
    (runtimeLauncher.hasRuntime as ReturnType<typeof vi.fn>).mockReturnValue(false);

    await manager.handleHeartbeat(
      {
        schemaVersion: 'v1',
        messageId: 'msg-restart',
        correlationId: 'corr-restart',
        initiatorType: 'agent',
        initiatorId: 'agent-1',
        botId: 'inst-1',
        type: 'agent.runtime.heartbeat',
        createdAt: '2026-06-03T00:00:00.000Z',
        payload: {},
      },
      {
        sessionId: 'sess-1',
        status: 'ready',
      },
    );

    expect(agentRepo.markSessionRunning).toHaveBeenCalledWith('sess-1', expect.any(Date));
    expect(agentRepo.updateAgent).toHaveBeenCalledWith('agent-1', { status: 'active' });
    expect(runtimeLauncher.registerRecoveredRuntime).toHaveBeenCalledWith('agent-1', 'sess-1');
    expect(reconnectHandler.handleReconnect).toHaveBeenCalledWith('agent-1', 'sess-1');
  });

  // ---------------------------------------------------------------------------
  // streamSubscribe regression — agent stuck in 'starting' then auto-stopped
  //
  // Before the fix, reconcileStartingSessions() never called streamSubscribe after
  // launching a container.  Heartbeats published to agent:inbound:{agentId} had no
  // consumer group subscribed, so they were never read, handleHeartbeat() was never
  // invoked, the session never transitioned starting → running, and the health
  // monitor's 30-second startup timeout fired and stopped the agent.
  // ---------------------------------------------------------------------------

  it('calls streamSubscribe for each agentId after a successful launch (regression)', async () => {
    const streamSubscribe = vi.fn().mockResolvedValue(undefined);
    const { agentRepo, runtimeLauncher } = buildManager();
    const manager = new AgentSessionManager(
      agentRepo as any,
      {} as any,
      runtimeLauncher as any,
      { streamSubscribe, budgets: TEST_RUNTIME_BUDGETS },
    );

    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-a', agentId: 'agent-a', botId: 'inst-a' },
      { id: 'sess-b', agentId: 'agent-b', botId: 'inst-b' },
    ]);
    (agentRepo.getAgent as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'agent-a', userId: 'user-1', prompt: 'goal-a', skillIds: [], toolPolicy: null, modelPolicy: { provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5' }, executionDefaults: null, dailyTokenBudget: null, dailyLossLimit: null, maxBots: null, maxSlippageBps: null })
      .mockResolvedValueOnce({ id: 'agent-b', userId: 'user-1', prompt: 'goal-b', skillIds: [], toolPolicy: null, modelPolicy: { provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5' }, executionDefaults: null, dailyTokenBudget: null, dailyLossLimit: null, maxBots: null, maxSlippageBps: null });

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.launch).toHaveBeenCalledTimes(2);
    // The stream must be subscribed for BOTH agents so their heartbeats are received
    expect(streamSubscribe).toHaveBeenCalledTimes(2);
    expect(streamSubscribe).toHaveBeenCalledWith('agent-a');
    expect(streamSubscribe).toHaveBeenCalledWith('agent-b');
  });

  it('does not call streamSubscribe when launch throws (regression guard)', async () => {
    const streamSubscribe = vi.fn().mockResolvedValue(undefined);
    const { agentRepo, runtimeLauncher } = buildManager();
    const manager = new AgentSessionManager(
      agentRepo as any,
      {} as any,
      runtimeLauncher as any,
      { streamSubscribe, budgets: TEST_RUNTIME_BUDGETS },
    );

    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-fail', agentId: 'agent-fail', botId: 'inst-fail' },
    ]);
    (runtimeLauncher.launch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('container start error'));

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.launch).toHaveBeenCalledOnce();
    // No stream subscription when launch fails — nothing will heartbeat to it
    expect(streamSubscribe).not.toHaveBeenCalled();
  });

  it('does not call streamSubscribe when the session claim fails (regression guard)', async () => {
    const streamSubscribe = vi.fn().mockResolvedValue(undefined);
    const { agentRepo, runtimeLauncher } = buildManager();
    const manager = new AgentSessionManager(
      agentRepo as any,
      {} as any,
      runtimeLauncher as any,
      { streamSubscribe, budgets: TEST_RUNTIME_BUDGETS },
    );

    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-race', agentId: 'agent-race', botId: 'inst-race' },
    ]);
    (agentRepo.claimStartingSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.launch).not.toHaveBeenCalled();
    expect(streamSubscribe).not.toHaveBeenCalled();
  });

  // bug-008 regression: the default healthCheckIntervalMs is 10 000 ms (10 s).
  // When AgentSessionManager is created without an explicit interval — as was the
  // case before the fix — agents could stay in 'starting' for up to 10 s after the
  // API called POST /agents/:id/start.  The fix reduced the interval to 2 000 ms
  // in apps/worker/src/index.ts by passing { healthCheckIntervalMs: 2000 }.
  //
  // This test verifies:
  //   a) The default interval remains 10 000 ms so the regression is detectable.
  //   b) A custom value (2 000 ms in production) is accepted and overrides the default.
  //   c) The reconcile loop uses the configured interval, not the default, when one is set.
  describe('healthCheckIntervalMs configuration (bug-008 regression)', () => {
    it('default interval is 10 000 ms — production MUST override to a lower value', () => {
      const { agentRepo, runtimeLauncher } = buildManager();
      // Construct without an interval override beyond the required budgets config.
      const defaultManager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS },
      );
      // Access the private config via a cast to verify the interval default.
      // The intent is to document that the DEFAULT is 10 000 ms and production
      // must explicitly configure a lower value.
      const cfg = (defaultManager as unknown as { config: { healthCheckIntervalMs: number } }).config;
      expect(cfg.healthCheckIntervalMs).toBe(10_000);
    });

    it('accepts a custom healthCheckIntervalMs that overrides the default', () => {
      const { agentRepo, runtimeLauncher } = buildManager();
      const fastManager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS, healthCheckIntervalMs: 2000 },
      );
      const cfg = (fastManager as unknown as { config: { healthCheckIntervalMs: number } }).config;
      expect(cfg.healthCheckIntervalMs).toBe(2000);
    });
  });

  // --- New lifecycle callbacks: onSessionActive and onSessionStopped ---

  describe('onSessionActive callback', () => {
    it('fires onSessionActive with agentId and sessionId when session transitions to running', async () => {
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();
      const onSessionActive = vi.fn();
      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS, onSessionActive },
        reconnectHandler as any,
      );

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-active-1',
        agentId: 'agent-active-1',
        status: 'starting',
      });
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'agent-active-1',
        userId: 'user-1',
        executionDefaults: { mode: 'shadow' },
        prompt: 'Test',
        toolPolicy: null,
        modelPolicy: null,
        dailyTokenBudget: null,
        dailyLossLimit: null,
        maxBots: null,
        maxSlippageBps: null,
      });

      await manager.handleHeartbeat(
        {
          schemaVersion: 'v1',
          messageId: 'msg-active-1',
          correlationId: 'corr-1',
          initiatorType: 'agent',
          initiatorId: 'agent-active-1',
          type: 'agent.runtime.heartbeat',
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { sessionId: 'sess-active-1', status: 'ready' },
      );

      expect(onSessionActive).toHaveBeenCalledWith('agent-active-1', 'sess-active-1');
    });

    it('does not read execution mode when session transitions to running', async () => {
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();
      const onSessionActive = vi.fn();
      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS, onSessionActive },
        reconnectHandler as any,
      );

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-active-2',
        agentId: 'agent-active-2',
        status: 'starting',
      });
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'agent-active-2',
        userId: 'user-1',
        executionDefaults: null,
        prompt: 'Test',
        toolPolicy: null,
        modelPolicy: null,
        dailyTokenBudget: null,
        dailyLossLimit: null,
        maxBots: null,
        maxSlippageBps: null,
      });

      await manager.handleHeartbeat(
        {
          schemaVersion: 'v1',
          messageId: 'msg-active-2',
          correlationId: 'corr-2',
          initiatorType: 'agent',
          initiatorId: 'agent-active-2',
          type: 'agent.runtime.heartbeat',
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { sessionId: 'sess-active-2', status: 'ready' },
      );

      expect(onSessionActive).toHaveBeenCalledWith('agent-active-2', 'sess-active-2');
    });

    it('fires onSessionStarted only for first-boot sessions, not recovery heartbeats', async () => {
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();
      const onSessionActive = vi.fn();
      const onSessionStarted = vi.fn();
      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS, onSessionActive, onSessionStarted },
        reconnectHandler as any,
      );

      (agentRepo.getSession as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ id: 'sess-first', agentId: 'agent-first', status: 'starting' })
        .mockResolvedValueOnce({ id: 'sess-recovery', agentId: 'agent-recovery', status: 'running' });
      (agentRepo.getAgent as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ id: 'agent-first', userId: 'user-1', executionDefaults: { mode: 'paper' } })
        .mockResolvedValueOnce({ id: 'agent-first', userId: 'user-1', executionDefaults: { mode: 'paper' } })
        .mockResolvedValueOnce({ id: 'agent-recovery', userId: 'user-1', executionDefaults: { mode: 'paper' } })
        .mockResolvedValueOnce({ id: 'agent-recovery', userId: 'user-1', executionDefaults: { mode: 'paper' } });

      await manager.handleHeartbeat(
        {
          schemaVersion: 'v1',
          messageId: 'msg-first',
          correlationId: 'corr-first',
          initiatorType: 'agent',
          initiatorId: 'agent-first',
          type: 'agent.runtime.heartbeat',
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { sessionId: 'sess-first', status: 'ready' },
      );

      await manager.handleHeartbeat(
        {
          schemaVersion: 'v1',
          messageId: 'msg-recovery',
          correlationId: 'corr-recovery',
          initiatorType: 'agent',
          initiatorId: 'agent-recovery',
          type: 'agent.runtime.heartbeat',
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { sessionId: 'sess-recovery', status: 'ready' },
      );

      expect(onSessionStarted).toHaveBeenCalledTimes(1);
      expect(onSessionStarted).toHaveBeenCalledWith('agent-first', 'sess-first');
    });

    it('does NOT fire onSessionActive for a session that was already activated', async () => {
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();
      const onSessionActive = vi.fn();
      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS, onSessionActive },
        reconnectHandler as any,
      );

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-existing',
        agentId: 'agent-existing',
        status: 'running',
      });
      (runtimeLauncher.hasRuntime as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'agent-existing',
        userId: 'user-1',
        executionDefaults: null,
        prompt: 'Test',
        toolPolicy: null,
        modelPolicy: null,
        dailyTokenBudget: null,
        dailyLossLimit: null,
        maxBots: null,
        maxSlippageBps: null,
      });

      // First heartbeat activates
      await manager.handleHeartbeat(
        {
          schemaVersion: 'v1',
          messageId: 'msg-existing',
          correlationId: 'corr-existing',
          initiatorType: 'agent',
          initiatorId: 'agent-existing',
          type: 'agent.runtime.heartbeat',
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { sessionId: 'sess-existing', status: 'ready' },
      );
      expect(onSessionActive).toHaveBeenCalledTimes(1);

      // Second heartbeat should NOT re-activate
      await manager.handleHeartbeat(
        {
          schemaVersion: 'v1',
          messageId: 'msg-existing-2',
          correlationId: 'corr-existing-2',
          initiatorType: 'agent',
          initiatorId: 'agent-existing',
          type: 'agent.runtime.heartbeat',
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { sessionId: 'sess-existing', status: 'ready' },
      );
      expect(onSessionActive).toHaveBeenCalledTimes(1);
    });

    it('fires onSessionActive on worker-restart recovery (running session with no in-memory handle)', async () => {
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();
      const onSessionActive = vi.fn();
      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS, onSessionActive },
        reconnectHandler as any,
      );

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-recovery',
        agentId: 'agent-recovery',
        status: 'running',
      });
      (runtimeLauncher.hasRuntime as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'agent-recovery',
        userId: 'user-1',
        executionDefaults: { mode: 'live' },
        prompt: 'Test',
        toolPolicy: null,
        modelPolicy: null,
        dailyTokenBudget: null,
        dailyLossLimit: null,
        maxBots: null,
        maxSlippageBps: null,
      });

      await manager.handleHeartbeat(
        {
          schemaVersion: 'v1',
          messageId: 'msg-recovery',
          correlationId: 'corr-recovery',
          initiatorType: 'agent',
          initiatorId: 'agent-recovery',
          type: 'agent.runtime.heartbeat',
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { sessionId: 'sess-recovery', status: 'ready' },
      );

      expect(onSessionActive).toHaveBeenCalledWith('agent-recovery', 'sess-recovery');
    });

    it('fires onSessionActive even when registerSurvivedSessions pre-registered the runtime handle', async () => {
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();
      const onSessionActive = vi.fn();
      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS, onSessionActive },
        reconnectHandler as any,
      );

      // Simulate registerSurvivedSessions having pre-registered the runtime handle
      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-survived',
        agentId: 'agent-survived',
        status: 'running',
      });
      // hasRuntime is TRUE — but activation should still fire because the trading actor
      // has not yet been bootstrapped (activatedSessions does not contain this session).
      (runtimeLauncher.hasRuntime as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'agent-survived',
        userId: 'user-1',
        executionDefaults: { mode: 'paper' },
        prompt: 'Test',
        toolPolicy: null,
        modelPolicy: null,
        dailyTokenBudget: null,
        dailyLossLimit: null,
        maxBots: null,
        maxSlippageBps: null,
      });

      await manager.handleHeartbeat(
        {
          schemaVersion: 'v1',
          messageId: 'msg-survived',
          correlationId: 'corr-survived',
          initiatorType: 'agent',
          initiatorId: 'agent-survived',
          type: 'agent.runtime.heartbeat',
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { sessionId: 'sess-survived', status: 'ready' },
      );

      expect(onSessionActive).toHaveBeenCalledWith('agent-survived', 'sess-survived');
    });

    it('does NOT fire onSessionActive a second time after actor is already activated', async () => {
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();
      const onSessionActive = vi.fn();
      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS, onSessionActive },
        reconnectHandler as any,
      );

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-dup',
        agentId: 'agent-dup',
        status: 'running',
      });
      (runtimeLauncher.hasRuntime as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'agent-dup',
        userId: 'user-1',
        executionDefaults: { mode: 'paper' },
        prompt: 'Test',
        toolPolicy: null,
        modelPolicy: null,
        dailyTokenBudget: null,
        dailyLossLimit: null,
        maxBots: null,
        maxSlippageBps: null,
      });

      const heartbeat = {
        schemaVersion: 'v1' as const,
        messageId: 'msg-dup',
        correlationId: 'corr-dup',
        initiatorType: 'agent' as const,
        initiatorId: 'agent-dup',
        type: 'agent.runtime.heartbeat' as const,
        createdAt: new Date().toISOString(),
        payload: {},
      };

      // First heartbeat activates the actor
      await manager.handleHeartbeat(heartbeat, { sessionId: 'sess-dup', status: 'ready' });
      expect(onSessionActive).toHaveBeenCalledTimes(1);

      // Second heartbeat for same session should NOT re-activate
      await manager.handleHeartbeat(heartbeat, { sessionId: 'sess-dup', status: 'ready' });
      expect(onSessionActive).toHaveBeenCalledTimes(1);
    });

    it('retries activation on later heartbeats when onSessionActive reports no actor was established yet', async () => {
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();
      const onSessionActive = vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(undefined);
      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS, onSessionActive },
        reconnectHandler as any,
      );

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-bind-later',
        agentId: 'agent-bind-later',
        status: 'running',
      });
      (runtimeLauncher.hasRuntime as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'agent-bind-later',
        userId: 'user-1',
        executionDefaults: { mode: 'paper' },
        prompt: 'Test',
        toolPolicy: null,
        modelPolicy: null,
        dailyTokenBudget: null,
        dailyLossLimit: null,
        maxBots: null,
        maxSlippageBps: null,
      });

      const heartbeat = {
        schemaVersion: 'v1' as const,
        messageId: 'msg-bind-later',
        correlationId: 'corr-bind-later',
        initiatorType: 'agent' as const,
        initiatorId: 'agent-bind-later',
        type: 'agent.runtime.heartbeat' as const,
        createdAt: new Date().toISOString(),
        payload: {},
      };

      await manager.handleHeartbeat(heartbeat, { sessionId: 'sess-bind-later', status: 'ready' });
      await manager.handleHeartbeat(heartbeat, { sessionId: 'sess-bind-later', status: 'ready' });

      expect(onSessionActive).toHaveBeenCalledTimes(2);
    });

    it('activates and fires onSessionStarted when onSessionActive returns true with no trading actor (e.g. PA agent with no binding), and does not re-activate on the next heartbeat', async () => {
      // Regression guard: a personal-assistant agent has no trading binding, so
      // onSessionActive legitimately establishes the session without a trading
      // actor and returns true. The session MUST still be marked active (so it is
      // not re-bootstrapped as a reconnect on every heartbeat) and onSessionStarted
      // MUST fire (this is the Telegram reply anchor). Previously the no-binding
      // path returned false, which suppressed both — leaving PA agents unable to
      // receive Telegram replies and looping reconnect forever.
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();
      const onSessionActive = vi.fn().mockResolvedValue(true); // activated, no trading actor
      const onSessionStarted = vi.fn();
      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS, onSessionActive, onSessionStarted },
        reconnectHandler as any,
      );

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-pa',
        agentId: 'agent-pa',
        status: 'starting',
      });
      (runtimeLauncher.hasRuntime as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'agent-pa',
        userId: 'user-1',
        executionDefaults: null,
        prompt: 'PA agent',
        toolPolicy: null,
        modelPolicy: null,
        dailyTokenBudget: null,
        dailyLossLimit: null,
        maxBots: null,
        maxSlippageBps: null,
      });

      const heartbeat = {
        schemaVersion: 'v1' as const,
        messageId: 'msg-pa',
        correlationId: 'corr-pa',
        initiatorType: 'agent' as const,
        initiatorId: 'agent-pa',
        type: 'agent.runtime.heartbeat' as const,
        createdAt: new Date().toISOString(),
        payload: {},
      };

      // First heartbeat (starting → running): activates and fires the anchor.
      await manager.handleHeartbeat(heartbeat, { sessionId: 'sess-pa', status: 'ready' });
      expect(onSessionActive).toHaveBeenCalledTimes(1);
      expect(onSessionStarted).toHaveBeenCalledTimes(1);
      expect(onSessionStarted).toHaveBeenCalledWith('agent-pa', 'sess-pa');

      // Session is now recorded active. A subsequent heartbeat (now 'running')
      // must NOT re-bootstrap — no reconnect loop, no duplicate activation.
      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-pa',
        agentId: 'agent-pa',
        status: 'running',
      });
      await manager.handleHeartbeat(heartbeat, { sessionId: 'sess-pa', status: 'ready' });
      expect(onSessionActive).toHaveBeenCalledTimes(1);
      expect(onSessionStarted).toHaveBeenCalledTimes(1);
    });

    it('marks the session and agent crashed when onSessionActive fails', async () => {
      const { manager, agentRepo, runtimeLauncher, reconnectHandler } = buildManager();
      const onSessionActive = vi.fn().mockRejectedValue(new Error('actor init failed'));
      const eventPublisher = (manager as unknown as {
        eventPublisher: {
          emitGuardrailTriggered: ReturnType<typeof vi.fn>;
          emitInstanceStatus: ReturnType<typeof vi.fn>;
        };
      }).eventPublisher;

      const failingManager = new AgentSessionManager(
        agentRepo as any,
        eventPublisher as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS, onSessionActive },
        reconnectHandler as any,
      );

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-failed-actor',
        agentId: 'agent-failed-actor',
        status: 'starting',
      });
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'agent-failed-actor',
        userId: 'user-1',
        executionDefaults: { mode: 'shadow' },
        prompt: 'Test',
        toolPolicy: null,
        modelPolicy: null,
        dailyTokenBudget: null,
        dailyLossLimit: null,
        maxBots: null,
        maxSlippageBps: null,
      });

      await failingManager.handleHeartbeat(
        {
          schemaVersion: 'v1',
          messageId: 'msg-failed-actor',
          correlationId: 'corr-failed-actor',
          initiatorType: 'agent',
          initiatorId: 'agent-failed-actor',
          type: 'agent.runtime.heartbeat',
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { sessionId: 'sess-failed-actor', status: 'ready' },
      );

      expect(onSessionActive).toHaveBeenCalledWith('agent-failed-actor', 'sess-failed-actor');
      expect(runtimeLauncher.stop).toHaveBeenCalledWith('sess-failed-actor');
      expect(agentRepo.updateSession).toHaveBeenCalledWith('sess-failed-actor', expect.objectContaining({ status: 'crashed' }));
      expect(agentRepo.updateAgent).toHaveBeenCalledWith('agent-failed-actor', { status: 'crashed' });
      expect(eventPublisher.emitInstanceStatus).toHaveBeenCalledWith('agent-failed-actor', expect.objectContaining({ status: 'stopped' }));
      expect(reconnectHandler.handleReconnect).not.toHaveBeenCalled();
    });

    it('does not overwrite a stopped session when onSessionActive fails after stop wins the race', async () => {
      const { manager, agentRepo, runtimeLauncher, reconnectHandler } = buildManager();
      const onSessionActive = vi.fn().mockRejectedValue(new Error('actor init failed'));
      const eventPublisher = (manager as unknown as {
        eventPublisher: {
          emitGuardrailTriggered: ReturnType<typeof vi.fn>;
          emitInstanceStatus: ReturnType<typeof vi.fn>;
        };
      }).eventPublisher;

      const failingManager = new AgentSessionManager(
        agentRepo as any,
        eventPublisher as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS, onSessionActive },
        reconnectHandler as any,
      );

      (agentRepo.getSession as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          id: 'sess-stop-won',
          agentId: 'agent-stop-won',
          status: 'starting',
        })
        .mockResolvedValueOnce({
          id: 'sess-stop-won',
          agentId: 'agent-stop-won',
          status: 'stopped',
        });
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'agent-stop-won',
        userId: 'user-1',
        executionDefaults: { mode: 'shadow' },
        prompt: 'Test',
        toolPolicy: null,
        modelPolicy: null,
        dailyTokenBudget: null,
        dailyLossLimit: null,
        maxBots: null,
        maxSlippageBps: null,
      });

      await failingManager.handleHeartbeat(
        {
          schemaVersion: 'v1',
          messageId: 'msg-stop-won',
          correlationId: 'corr-stop-won',
          initiatorType: 'agent',
          initiatorId: 'agent-stop-won',
          type: 'agent.runtime.heartbeat',
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { sessionId: 'sess-stop-won', status: 'ready' },
      );

      expect(onSessionActive).toHaveBeenCalledWith('agent-stop-won', 'sess-stop-won');
      expect(runtimeLauncher.stop).not.toHaveBeenCalledWith('sess-stop-won');
      expect(agentRepo.updateSession).not.toHaveBeenCalledWith('sess-stop-won', expect.objectContaining({ status: 'crashed' }));
      expect(agentRepo.updateAgent).not.toHaveBeenCalledWith('agent-stop-won', { status: 'crashed' });
      expect(eventPublisher.emitGuardrailTriggered).not.toHaveBeenCalledWith(
        'agent-stop-won',
        expect.objectContaining({ code: 'trading_actor.start_failed' }),
      );
      expect(eventPublisher.emitInstanceStatus).not.toHaveBeenCalledWith(
        'agent-stop-won',
        expect.objectContaining({ status: 'crashed' }),
      );
      expect(reconnectHandler.handleReconnect).not.toHaveBeenCalled();
    });
  });

  describe('onSessionStopped callback', () => {
    it('fires onSessionStopped when a session is stopped', async () => {
      const { agentRepo, runtimeLauncher } = buildManager();
      const onSessionStopped = vi.fn();
      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS, onSessionStopped },
      );

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-stop-1',
        agentId: 'agent-stop-1',
        status: 'running',
      });

      await manager.stopSession('sess-stop-1');

      expect(onSessionStopped).toHaveBeenCalledWith('agent-stop-1', 'sess-stop-1');
    });

    it('fires onSessionStopped before updating agent status', async () => {
      const { agentRepo, runtimeLauncher } = buildManager();
      const callOrder: string[] = [];
      const onSessionStopped = vi.fn().mockImplementation(() => {
        callOrder.push('onSessionStopped');
      });
      (agentRepo.updateAgent as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('updateAgent');
      });

      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS, onSessionStopped },
      );

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-order',
        agentId: 'agent-order',
        status: 'running',
      });

      await manager.stopSession('sess-order');

      expect(callOrder[0]).toBe('onSessionStopped');
      expect(callOrder[1]).toBe('updateAgent');
    });

    it('does not fire onSessionStopped when session is not found', async () => {
      const { agentRepo, runtimeLauncher } = buildManager();
      const onSessionStopped = vi.fn();
      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS, onSessionStopped },
      );

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await manager.stopSession('sess-not-found');

      expect(onSessionStopped).not.toHaveBeenCalled();
    });

    it('does not fire onSessionStopped when markSessionStopped returns false (already stopped)', async () => {
      const { agentRepo, runtimeLauncher } = buildManager();
      const onSessionStopped = vi.fn();
      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS, onSessionStopped },
      );

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-already-stopped',
        agentId: 'agent-already-stopped',
        status: 'stopped',
      });
      (agentRepo.markSessionStopped as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await manager.stopSession('sess-already-stopped');

      expect(onSessionStopped).not.toHaveBeenCalled();
    });
  });

  it('marks runtime sessions crashed when session_ended reports a crash', async () => {
    const { agentRepo, runtimeLauncher } = buildManager();
    const onSessionStopped = vi.fn();
    const onAgentStatusChange = vi.fn();

    const manager = new AgentSessionManager(
      agentRepo as any,
      {} as any,
      runtimeLauncher as any,
      { budgets: TEST_RUNTIME_BUDGETS, onSessionStopped, onAgentStatusChange },
    );

    await manager.handleRuntimeSessionEnd('sess-crashed', 'agent-crashed', 'crashed');

    expect(agentRepo.markSessionEnded).toHaveBeenCalledWith('sess-crashed', 'crashed', expect.any(Date));
    expect(agentRepo.updateAgent).toHaveBeenCalledWith('agent-crashed', { status: 'crashed' });
    expect(onSessionStopped).toHaveBeenCalledWith('agent-crashed', 'sess-crashed');
    expect(onAgentStatusChange).toHaveBeenCalledWith('agent-crashed', 'user-1', 'crashed');
  });

  it('ignores a stale session_ended when the session is already in a terminal state (ordering regression)', async () => {
    // Regression guard: after session_ended marks a session as 'stopped', a second
    // session_ended (e.g. from a delayed or duplicate message) must be a no-op.
    // markSessionEnded returns false when the session is already terminal.
    const { agentRepo, runtimeLauncher } = buildManager();
    const onSessionStopped = vi.fn();
    const onAgentStatusChange = vi.fn();

    const manager = new AgentSessionManager(
      agentRepo as any,
      {} as any,
      runtimeLauncher as any,
      { budgets: TEST_RUNTIME_BUDGETS, onSessionStopped, onAgentStatusChange },
    );

    // Simulate: session_ended already processed (markSessionEnded returns false → already terminal)
    (agentRepo.markSessionEnded as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    await manager.handleRuntimeSessionEnd('sess-already-stopped', 'agent-1', 'crashed');

    // No further state mutations — the earlier 'stopped' status is preserved
    expect(agentRepo.updateAgent).not.toHaveBeenCalled();
    expect(onSessionStopped).not.toHaveBeenCalled();
    expect(onAgentStatusChange).not.toHaveBeenCalled();
  });

  describe('handleRuntimeFailure', () => {
    it('marks the session and agent crashed when a running trading actor fails', async () => {
      const { manager, agentRepo, runtimeLauncher } = buildManager();
      const eventPublisher = (manager as unknown as {
        eventPublisher: {
          emitGuardrailTriggered: ReturnType<typeof vi.fn>;
          emitInstanceStatus: ReturnType<typeof vi.fn>;
        };
      }).eventPublisher;

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-runtime-failed',
        agentId: 'agent-runtime-failed',
        status: 'running',
      });

      await manager.handleRuntimeFailure('sess-runtime-failed', 'agent-runtime-failed', 'user-1', new Error('stream mutation failed'));

      expect(runtimeLauncher.stop).toHaveBeenCalledWith('sess-runtime-failed');
      expect(agentRepo.updateSession).toHaveBeenCalledWith('sess-runtime-failed', expect.objectContaining({ status: 'crashed' }));
      expect(agentRepo.updateAgent).toHaveBeenCalledWith('agent-runtime-failed', { status: 'crashed' });
      expect(eventPublisher.emitGuardrailTriggered).toHaveBeenCalledWith('agent-runtime-failed', expect.objectContaining({
        code: 'trading_actor.runtime_failed',
      }));
      expect(eventPublisher.emitInstanceStatus).toHaveBeenCalledWith('agent-runtime-failed', expect.objectContaining({
        status: 'stopped',
        reason: 'trading_actor_runtime_failed',
      }));
    });

    it('does not overwrite a newer active session when an older actor fails later', async () => {
      const { manager, agentRepo, runtimeLauncher } = buildManager();
      const eventPublisher = (manager as unknown as {
        eventPublisher: {
          emitGuardrailTriggered: ReturnType<typeof vi.fn>;
          emitInstanceStatus: ReturnType<typeof vi.fn>;
        };
      }).eventPublisher;

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-old',
        agentId: 'agent-race',
        status: 'running',
      });
      (agentRepo.getActiveSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-new',
        agentId: 'agent-race',
        status: 'running',
      });

      await manager.handleRuntimeFailure('sess-old', 'agent-race', 'user-1', new Error('stream mutation failed'));

      expect(runtimeLauncher.stop).not.toHaveBeenCalledWith('sess-old');
      expect(agentRepo.updateSession).not.toHaveBeenCalledWith('sess-old', expect.objectContaining({ status: 'crashed' }));
      expect(agentRepo.updateAgent).not.toHaveBeenCalledWith('agent-race', { status: 'crashed' });
      expect(eventPublisher.emitGuardrailTriggered).not.toHaveBeenCalledWith(
        'agent-race',
        expect.objectContaining({ code: 'trading_actor.runtime_failed' }),
      );
      expect(eventPublisher.emitInstanceStatus).not.toHaveBeenCalledWith(
        'agent-race',
        expect.objectContaining({ reason: 'trading_actor_runtime_failed' }),
      );
    });
  });

  describe('session-scoped authorization', () => {
    it('rejects pause from a stale agent runtime session', async () => {
      const { manager, agentRepo } = buildManager();

      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'agent-1',
        userId: 'user-1',
        status: 'active',
      });
      (agentRepo.isActiveSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

      await manager.handlePauseRequest(
        {
          schemaVersion: 'v1',
          messageId: 'msg-pause',
          correlationId: 'old-session-id',
          initiatorType: 'agent',
          initiatorId: 'agent-1',
          type: 'agent.runtime.pause_request',
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { reason: 'stale pause attempt' },
      );

      expect(agentRepo.updateAgent).not.toHaveBeenCalled();
    });

    it('accepts pause from the current agent runtime session', async () => {
      const { manager, agentRepo } = buildManager();

      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'agent-1',
        userId: 'user-1',
        status: 'active',
      });
      (agentRepo.isActiveSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

      await manager.handlePauseRequest(
        {
          schemaVersion: 'v1',
          messageId: 'msg-pause-ok',
          correlationId: 'current-session-id',
          initiatorType: 'agent',
          initiatorId: 'agent-1',
          type: 'agent.runtime.pause_request',
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { reason: 'agent self-pause' },
      );

      expect(agentRepo.updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({ status: 'paused' }));
    });

    it('allows system-originated pause without session validation', async () => {
      const { manager, agentRepo } = buildManager();

      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'agent-1',
        userId: 'user-1',
        status: 'active',
      });

      await manager.handlePauseRequest(
        {
          schemaVersion: 'v1',
          messageId: 'msg-sys-pause',
          correlationId: 'irrelevant',
          initiatorType: 'system',
          initiatorId: 'agent-1',
          type: 'agent.runtime.pause_request',
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { reason: 'system guardrail', requestedBy: 'guardrail' },
      );

      // System-originated: no isActiveSession call, directly pauses
      expect(agentRepo.isActiveSession).not.toHaveBeenCalled();
      expect(agentRepo.updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({ status: 'paused' }));
    });

    it('rejects stop from a stale agent runtime session', async () => {
      const { manager, agentRepo } = buildManager();

      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'agent-1',
        userId: 'user-1',
        status: 'active',
      });
      (agentRepo.isActiveSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

      await manager.handleStopRequest(
        {
          schemaVersion: 'v1',
          messageId: 'msg-stop',
          correlationId: 'old-session-id',
          initiatorType: 'agent',
          initiatorId: 'agent-1',
          type: 'agent.runtime.stop_request',
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { reason: 'stale stop attempt' },
      );

      expect(agentRepo.getActiveSession).not.toHaveBeenCalled();
      expect(agentRepo.updateAgent).not.toHaveBeenCalled();
    });

    it('accepts stop from the current agent runtime session', async () => {
      const { manager, agentRepo } = buildManager();

      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'agent-1',
        userId: 'user-1',
        status: 'active',
      });
      (agentRepo.isActiveSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
      (agentRepo.getActiveSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'current-session-id',
        agentId: 'agent-1',
        status: 'running',
      });
      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'current-session-id',
        agentId: 'agent-1',
        status: 'running',
      });

      await manager.handleStopRequest(
        {
          schemaVersion: 'v1',
          messageId: 'msg-stop-ok',
          correlationId: 'current-session-id',
          initiatorType: 'agent',
          initiatorId: 'agent-1',
          type: 'agent.runtime.stop_request',
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { reason: 'agent voluntary stop' },
      );

      expect(agentRepo.isActiveSession).toHaveBeenCalledWith('agent-1', 'current-session-id');
      expect(agentRepo.markSessionStopped).toHaveBeenCalled();
    });
  });

  describe('readiness barrier', () => {
    it('stopSession awaits readyPromise before reaching runtimeLauncher', async () => {
      const { manager, agentRepo, runtimeLauncher } = buildManager();

      // Simulate a slow preregistration
      let resolveReady!: () => void;
      const slowReady = new Promise<void>((r) => { resolveReady = r; });
      (manager as unknown as { readyPromise: Promise<void> }).readyPromise = slowReady;

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-1',
        agentId: 'agent-1',
        status: 'running',
      });

      const stopPromise = manager.stopSession('sess-1');

      // runtimeLauncher.stop should NOT have been called yet
      expect(runtimeLauncher.stop).not.toHaveBeenCalled();

      // Resolve the readiness barrier
      resolveReady();
      await stopPromise;

      // Now it should have been called
      expect(runtimeLauncher.stop).toHaveBeenCalledWith('sess-1');
    });
  });

  describe('usage billing — always-on (no enabled flag)', () => {
    it('opens a billing account and period when usageBillingRepo is provided, without requiring an enabled flag', async () => {
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();

      const mockBillingAccount = { id: 'account-1', userId: 'user-1', status: 'active' };
      const mockRateCard = { id: 'ratecard-1', name: 'default' };
      const usageBillingRepo = {
        getUserPlanId: vi.fn().mockResolvedValue(null),
        getAccountByUserId: vi.fn().mockResolvedValue(null),
        getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue(mockBillingAccount),
        ensureActiveRateCard: vi.fn().mockResolvedValue(mockRateCard),
        getOrCreateOpenPeriod: vi.fn().mockResolvedValue({ id: 'period-1' }),
        recomputeSpendState: vi.fn().mockResolvedValue('active'),
        canSpendNow: vi.fn().mockResolvedValue({ canSpend: true, availableMicrousd: 0, hardCapMicrousd: null, status: 'active', reason: 'ok' }),
      };

      (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'sess-billing', agentId: 'agent-1' },
      ]);

      const manager = new AgentSessionManager(
        agentRepo as any,
        { emitGuardrailTriggered: vi.fn(), emitInstanceStatus: vi.fn() } as any,
        runtimeLauncher as any,
        {
          budgets: TEST_RUNTIME_BUDGETS,
          usageBillingRepo: usageBillingRepo as any,
          usageBillingConfig: { defaultRateCardName: 'default' } as any,
        },
        reconnectHandler as any,
      );

      await manager.reconcileStartingSessions();

      expect(usageBillingRepo.getOrCreateBillingAccountForUser).toHaveBeenCalledWith(
        'user-1',
        expect.any(String),
        expect.any(Object),
      );
      expect(usageBillingRepo.getOrCreateOpenPeriod).toHaveBeenCalledWith(
        'account-1',
        expect.any(Date),
        expect.any(String),
        'ratecard-1',
        expect.any(Number),
        null,
        null,
      );
    });

    it('recomputes spend state before gating so a stale persisted hard_limited status cannot deadlock launch', async () => {
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();

      const mockBillingAccount = { id: 'account-1', userId: 'user-1', status: 'hard_limited' };
      const mockRateCard = { id: 'ratecard-1', name: 'default' };
      const usageBillingRepo = {
        getUserPlanId: vi.fn().mockResolvedValue(null),
        getAccountByUserId: vi.fn().mockResolvedValue(null),
        getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue(mockBillingAccount),
        ensureActiveRateCard: vi.fn().mockResolvedValue(mockRateCard),
        getOrCreateOpenPeriod: vi.fn().mockResolvedValue({ id: 'period-1' }),
        // Stale persisted status is hard_limited, but the fresh recompute
        // resolves to active — the launch must proceed.
        recomputeSpendState: vi.fn().mockResolvedValue('active'),
        canSpendNow: vi.fn().mockResolvedValue({ canSpend: true, availableMicrousd: 0, hardCapMicrousd: null, status: 'active', reason: 'ok' }),
      };

      (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'sess-billing', agentId: 'agent-1' },
      ]);

      const eventPublisher = {
        emitGuardrailTriggered: vi.fn().mockResolvedValue(undefined),
        emitInstanceStatus: vi.fn().mockResolvedValue(undefined),
        publishUserNotification: vi.fn().mockResolvedValue(undefined),
      };

      const manager = new AgentSessionManager(
        agentRepo as any,
        eventPublisher as any,
        runtimeLauncher as any,
        {
          budgets: TEST_RUNTIME_BUDGETS,
          usageBillingRepo: usageBillingRepo as any,
          usageBillingConfig: { defaultRateCardName: 'default' } as any,
        },
        reconnectHandler as any,
      );

      await manager.reconcileStartingSessions();

      expect(usageBillingRepo.recomputeSpendState).toHaveBeenCalledWith('account-1');
      expect(usageBillingRepo.canSpendNow).toHaveBeenCalledWith('account-1');
      expect(
        usageBillingRepo.recomputeSpendState.mock.invocationCallOrder[0],
      ).toBeLessThan(usageBillingRepo.canSpendNow.mock.invocationCallOrder[0]);
      // The launch must actually proceed — the billing-block path is not taken.
      expect(runtimeLauncher.launch).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-billing', agentId: 'agent-1' }),
      );
      expect(agentRepo.updateAgent).not.toHaveBeenCalled();
      expect(agentRepo.markSessionStopped).not.toHaveBeenCalled();
      expect(eventPublisher.emitGuardrailTriggered).not.toHaveBeenCalled();
      expect(eventPublisher.emitInstanceStatus).not.toHaveBeenCalled();
    });
  });

  describe('containerReconcileIntervalMs — Docker container reconciliation timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function buildReconcileManager(intervalOverride?: number) {
      const { agentRepo, runtimeLauncher } = buildManager();
      const reconcile = vi.fn().mockResolvedValue(undefined);
      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        { ...runtimeLauncher, reconcile } as any,
        { budgets: TEST_RUNTIME_BUDGETS, ...(intervalOverride !== undefined ? { containerReconcileIntervalMs: intervalOverride } : {}) },
      );
      return { manager, reconcile };
    }

    it('does not call reconcile() immediately on start()', () => {
      const { manager, reconcile } = buildReconcileManager();
      manager.start();
      expect(reconcile).not.toHaveBeenCalled();
    });

    it('calls reconcile() once after the default 60 s interval', async () => {
      const { manager, reconcile } = buildReconcileManager();
      manager.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcile).toHaveBeenCalledOnce();
    });

    it('respects a custom containerReconcileIntervalMs override', async () => {
      const { manager, reconcile } = buildReconcileManager(5_000);
      manager.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reconcile).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reconcile).toHaveBeenCalledTimes(2);
    });

    it('stops calling reconcile() after stop()', async () => {
      const { manager, reconcile } = buildReconcileManager(5_000);
      manager.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reconcile).toHaveBeenCalledOnce();
      await manager.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reconcile).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Redis projection lifecycle (C3)
  // ---------------------------------------------------------------------------

  function makeRedisMock() {
    const store = new Map<string, string>();
    const sset = new Map<string, Set<string>>();
    return {
      _store: store,
      _sset: sset,
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
      del: vi.fn(async (...keys: string[]) => {
        let deleted = 0;
        for (const k of keys) {
          if (store.delete(k)) deleted++;
          if (sset.delete(k)) deleted++;
        }
        return deleted;
      }),
      sadd: vi.fn(async (key: string, ...members: string[]) => {
        if (!sset.has(key)) sset.set(key, new Set());
        let added = 0;
        for (const m of members) {
          if (!sset.get(key)!.has(m)) { sset.get(key)!.add(m); added++; }
        }
        return added;
      }),
      srem: vi.fn(async (key: string, ...members: string[]) => {
        const s = sset.get(key);
        if (!s) return 0;
        let removed = 0;
        for (const m of members) {
          if (s.delete(m)) removed++;
        }
        return removed;
      }),
      smembers: vi.fn(async (key: string) => [...(sset.get(key) ?? [])]),
      sismember: vi.fn(async (key: string, member: string) => (sset.get(key)?.has(member) ? 1 : 0)),
      incr: vi.fn(async (key: string) => {
        const v = Number(store.get(key) ?? '0') + 1;
        store.set(key, String(v));
        return v;
      }),
      decr: vi.fn(async (key: string) => {
        const v = Number(store.get(key) ?? '0') - 1;
        store.set(key, String(v));
        return v;
      }),
    } as any;
  }

  function makeAgent(overrides: Record<string, unknown> = {}) {
    return {
      id: overrides.id ?? 'agent-1',
      userId: 'user-1',
      prompt: 'Test agent',
      skillIds: [],
      toolPolicy: null,
      modelPolicy: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
      executionDefaults: { mode: 'paper' },
      dailyTokenBudget: null,
      dailyLossLimit: null,
      maxBots: null,
      maxSlippageBps: null,
      ...overrides,
    };
  }

  const HEARTBEAT_ENVELOPE = {
    schemaVersion: 'v1' as const,
    messageId: 'msg-hb-1',
    correlationId: 'corr-hb-1',
    initiatorType: 'agent' as const,
    initiatorId: 'agent-1',
    type: 'agent.runtime.heartbeat' as const,
    createdAt: new Date().toISOString(),
    payload: {},
  };

  // C3.1 — First session activation creates Redis projection
  describe('Redis projection — first activation (C3.1)', () => {
    it('creates agent:sessions:count, agent:sessions:active, and agent:wake:prefs on first heartbeat', async () => {
      const redis = makeRedisMock();
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();

      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS },
        reconnectHandler as any,
        undefined,
        redis,
      );

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-1',
        agentId: 'agent-1',
        status: 'starting',
      });
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeAgent({ wakePreferences: { subscribedSources: ['discovery_delta', 'watch_threshold'] } }),
      );

      await manager.handleHeartbeat(
        { ...HEARTBEAT_ENVELOPE, initiatorId: 'agent-1', messageId: 'msg-c31-1' },
        { sessionId: 'sess-1', status: 'ready' },
      );

      // Count key set to 1
      expect(redis._store.get('agent:sessions:count:agent-1')).toBe('1');
      // Agent added to active set
      expect(redis._sset.get('agent:sessions:active')?.has('agent-1')).toBe(true);
      // Wake preferences stored
      const prefsJson = redis._store.get('agent:wake:prefs:agent-1');
      expect(prefsJson).toBeDefined();
      const prefs = JSON.parse(prefsJson!);
      expect(prefs).toEqual({ subscribedSources: ['discovery_delta', 'watch_threshold'] });
    });

    it('does not create agent:wake:prefs when agent has no wakePreferences configured', async () => {
      const redis = makeRedisMock();
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();

      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS },
        reconnectHandler as any,
        undefined,
        redis,
      );

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-1',
        agentId: 'agent-1',
        status: 'starting',
      });
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeAgent({ wakePreferences: undefined }),
      );

      await manager.handleHeartbeat(
        { ...HEARTBEAT_ENVELOPE, initiatorId: 'agent-1', messageId: 'msg-c31-2' },
        { sessionId: 'sess-1', status: 'ready' },
      );

      // Count and active set are created
      expect(redis._store.get('agent:sessions:count:agent-1')).toBe('1');
      expect(redis._sset.get('agent:sessions:active')?.has('agent-1')).toBe(true);
      // But prefs key is absent
      expect(redis._store.has('agent:wake:prefs:agent-1')).toBe(false);
    });

    it('only adds to active set when count transitions from 0 to 1 (first session)', async () => {
      const redis = makeRedisMock();
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();

      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS },
        reconnectHandler as any,
        undefined,
        redis,
      );

      // First session
      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-1',
        agentId: 'agent-1',
        status: 'starting',
      });
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgent());

      await manager.handleHeartbeat(
        { ...HEARTBEAT_ENVELOPE, initiatorId: 'agent-1', messageId: 'msg-c31-first' },
        { sessionId: 'sess-1', status: 'ready' },
      );

      expect(redis._store.get('agent:sessions:count:agent-1')).toBe('1');
      expect(redis.sadd).toHaveBeenCalledWith('agent:sessions:active', 'agent-1');

      // Second session for same agent — count increments but sadd should NOT be called again
      // (count > 1, so sadd only fires when count === 1)
      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-2',
        agentId: 'agent-1',
        status: 'starting',
      });

      await manager.handleHeartbeat(
        { ...HEARTBEAT_ENVELOPE, initiatorId: 'agent-1', messageId: 'msg-c31-second' },
        { sessionId: 'sess-2', status: 'ready' },
      );

      expect(redis._store.get('agent:sessions:count:agent-1')).toBe('2');
      // sadd for active set should only have been called once (for first session)
      const saddActiveCalls = (redis.sadd as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: [string]) => c[0] === 'agent:sessions:active',
      );
      expect(saddActiveCalls).toHaveLength(1);
    });
  });

  // C3.2 — Multiple concurrent sessions ref-count correctly
  describe('Redis projection — multi-session ref-count (C3.2)', () => {
    it('increments count to 2 for two sessions, decrements on stop, cleans up on last stop', async () => {
      const redis = makeRedisMock();
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();

      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS },
        reconnectHandler as any,
        undefined,
        redis,
      );

      // Activate first session
      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-1',
        agentId: 'agent-1',
        status: 'starting',
      });
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeAgent({ wakePreferences: { subscribedSources: ['watch_threshold'] } }),
      );

      await manager.handleHeartbeat(
        { ...HEARTBEAT_ENVELOPE, initiatorId: 'agent-1', messageId: 'msg-c32-s1' },
        { sessionId: 'sess-1', status: 'ready' },
      );
      expect(redis._store.get('agent:sessions:count:agent-1')).toBe('1');

      // Activate second session (same agent)
      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-2',
        agentId: 'agent-1',
        status: 'starting',
      });

      await manager.handleHeartbeat(
        { ...HEARTBEAT_ENVELOPE, initiatorId: 'agent-1', messageId: 'msg-c32-s2' },
        { sessionId: 'sess-2', status: 'ready' },
      );
      expect(redis._store.get('agent:sessions:count:agent-1')).toBe('2');

      // Stop first session — count decrements, keys survive
      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-1',
        agentId: 'agent-1',
        status: 'running',
      });
      (agentRepo.markSessionStopped as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      await manager.stopSession('sess-1');
      expect(redis._store.get('agent:sessions:count:agent-1')).toBe('1');
      // Active membership survives
      expect(redis._sset.get('agent:sessions:active')?.has('agent-1')).toBe(true);
      // Prefs key survives
      expect(redis._store.has('agent:wake:prefs:agent-1')).toBe(true);

      // Stop second session — count goes to 0, all keys removed
      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-2',
        agentId: 'agent-1',
        status: 'running',
      });

      await manager.stopSession('sess-2');
      // Count key deleted when count <= 0
      expect(redis._store.has('agent:sessions:count:agent-1')).toBe(false);
      // Removed from active set
      expect(redis._sset.get('agent:sessions:active')?.has('agent-1')).toBeFalsy();
      // Prefs key deleted
      expect(redis._store.has('agent:wake:prefs:agent-1')).toBe(false);
    });
  });

  // C3.3 — registerSurvivedSessions rebuilds from DB, no double increment on recovery heartbeat
  describe('Redis projection — survived session recovery (C3.3)', () => {
    it('rebuilds Redis projection from DB state without double increment on recovery heartbeat', async () => {
      const redis = makeRedisMock();
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();

      // Seed two survived running sessions for the same agent
      (agentRepo.getSessionsByStatuses as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'sess-surv-1', agentId: 'agent-1', status: 'running' },
        { id: 'sess-surv-2', agentId: 'agent-1', status: 'running' },
      ]);
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeAgent({ wakePreferences: { subscribedSources: ['discovery_delta'] } }),
      );

      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS },
        reconnectHandler as any,
        undefined,
        redis,
      );

      // Call registerSurvivedSessions directly to rebuild projection
      await (manager as unknown as { registerSurvivedSessions: () => Promise<void> }).registerSurvivedSessions();

      // Redis projection rebuilt from DB: count = 2 (two survived sessions)
      expect(redis._store.get('agent:sessions:count:agent-1')).toBe('2');
      expect(redis._sset.get('agent:sessions:active')?.has('agent-1')).toBe(true);
      const prefs = JSON.parse(redis._store.get('agent:wake:prefs:agent-1')!);
      expect(prefs).toEqual({ subscribedSources: ['discovery_delta'] });

      // Now simulate a recovery heartbeat for one of the survived sessions.
      // isFirstBoot is false (status is 'running'), so the Redis projection
      // must NOT increment again.
      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-surv-1',
        agentId: 'agent-1',
        status: 'running',
      });
      (runtimeLauncher.hasRuntime as ReturnType<typeof vi.fn>).mockReturnValue(false);

      await manager.handleHeartbeat(
        { ...HEARTBEAT_ENVELOPE, initiatorId: 'agent-1', messageId: 'msg-c33-recovery' },
        { sessionId: 'sess-surv-1', status: 'ready' },
      );

      // Count must still be 2 — no double increment
      expect(redis._store.get('agent:sessions:count:agent-1')).toBe('2');
    });

    it('sets count from DB (not increment) during rebuild', async () => {
      const redis = makeRedisMock();
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();

      // Seed 3 survived sessions
      (agentRepo.getSessionsByStatuses as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'sess-a', agentId: 'agent-1', status: 'running' },
        { id: 'sess-b', agentId: 'agent-1', status: 'running' },
        { id: 'sess-c', agentId: 'agent-1', status: 'running' },
      ]);
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgent());

      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS },
        reconnectHandler as any,
        undefined,
        redis,
      );

      await (manager as unknown as { registerSurvivedSessions: () => Promise<void> }).registerSurvivedSessions();

      // Count is SET (not INCR) from the DB count of sessions
      expect(redis._store.get('agent:sessions:count:agent-1')).toBe('3');
      // Verify it was set, not incremented (incr would have been called if handleHeartbeat path was used)
      const incrCalls = (redis.incr as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: [string]) => c[0] === 'agent:sessions:count:agent-1',
      );
      expect(incrCalls).toHaveLength(0);
    });

    it('rebuilds prefs for multiple agents from DB', async () => {
      const redis = makeRedisMock();
      const { agentRepo, runtimeLauncher, reconnectHandler } = buildManager();

      (agentRepo.getSessionsByStatuses as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'sess-1', agentId: 'agent-a', status: 'running' },
        { id: 'sess-2', agentId: 'agent-b', status: 'running' },
      ]);
      (agentRepo.getAgent as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(makeAgent({ id: 'agent-a', wakePreferences: { subscribedSources: ['watch_threshold'] } }))
        .mockResolvedValueOnce(makeAgent({ id: 'agent-b', wakePreferences: { subscribedSources: ['discovery_delta', 'regime_change'] } }));

      const manager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        { budgets: TEST_RUNTIME_BUDGETS },
        reconnectHandler as any,
        undefined,
        redis,
      );

      await (manager as unknown as { registerSurvivedSessions: () => Promise<void> }).registerSurvivedSessions();

      // Both agents in active set
      expect(redis._sset.get('agent:sessions:active')?.has('agent-a')).toBe(true);
      expect(redis._sset.get('agent:sessions:active')?.has('agent-b')).toBe(true);

      // Both prefs keys present
      expect(JSON.parse(redis._store.get('agent:wake:prefs:agent-a')!)).toEqual({ subscribedSources: ['watch_threshold'] });
      expect(JSON.parse(redis._store.get('agent:wake:prefs:agent-b')!)).toEqual({ subscribedSources: ['discovery_delta', 'regime_change'] });

      // Counts
      expect(redis._store.get('agent:sessions:count:agent-a')).toBe('1');
      expect(redis._store.get('agent:sessions:count:agent-b')).toBe('1');
    });
  });

  // ── Crash path & ephemeral cleanup ────────────────────────────────────────

  function makeCrashRedisMock() {
    const store = new Map<string, string>();
    const sset = new Map<string, Set<string>>();
    const zset = new Map<string, Map<string, number>>();
    const pipelineMock = {
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    return {
      _store: store,
      _sset: sset,
      _zset: zset,
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, ...args: string[]) => {
        // Support SET key value PX ms NX
        if (args.includes('NX') && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }),
      del: vi.fn(async (...keys: string[]) => {
        let deleted = 0;
        for (const k of keys) {
          if (store.delete(k)) deleted++;
          if (sset.delete(k)) deleted++;
          if (zset.delete(k)) deleted++;
        }
        return deleted;
      }),
      sadd: vi.fn(async (key: string, ...members: string[]) => {
        if (!sset.has(key)) sset.set(key, new Set());
        let added = 0;
        for (const m of members) {
          if (!sset.get(key)!.has(m)) { sset.get(key)!.add(m); added++; }
        }
        return added;
      }),
      srem: vi.fn(async (key: string, ...members: string[]) => {
        const s = sset.get(key);
        if (!s) return 0;
        let removed = 0;
        for (const m of members) {
          if (s.delete(m)) removed++;
        }
        return removed;
      }),
      smembers: vi.fn(async (key: string) => [...(sset.get(key) ?? [])]),
      sismember: vi.fn(async (key: string, member: string) => (sset.get(key)?.has(member) ? 1 : 0)),
      incr: vi.fn(async (key: string) => {
        const v = Number(store.get(key) ?? '0') + 1;
        store.set(key, String(v));
        return v;
      }),
      decr: vi.fn(async (key: string) => {
        const v = Number(store.get(key) ?? '0') - 1;
        store.set(key, String(v));
        return v;
      }),
      pipeline: vi.fn(() => pipelineMock),
      // Crash guard methods
      zadd: vi.fn(async (key: string, score: number, member: string) => {
        if (!zset.has(key)) zset.set(key, new Map());
        zset.get(key)!.set(member, score);
        return 1;
      }),
      zremrangebyscore: vi.fn(async (_key: string, _min: string, _max: string) => 0),
      zcard: vi.fn(async (key: string) => zset.get(key)?.size ?? 0),
      pexpire: vi.fn(async () => 1),
      exec: vi.fn(async () => []),
    } as any;
  }

  describe('handleAgentCrashed', () => {
    it('clears session projection fully (srem + del count + del prefs)', async () => {
      const redis = makeCrashRedisMock();
      const { agentRepo } = buildManager();

      const manager = new AgentSessionManager(
        agentRepo as any,
        { emitGuardrailTriggered: vi.fn(), emitInstanceStatus: vi.fn() } as any,
        { stop: vi.fn(), cleanupSessionDocuments: vi.fn() } as any,
        { budgets: TEST_RUNTIME_BUDGETS, crashLoopGuard: { enabled: true, maxCrashesInWindow: 3, windowMs: 300_000 } },
        undefined as any,
        undefined,
        redis,
      );

      await manager.handleAgentCrashed('agent-1', 'sess-crash-1');

      // Session projection cleared
      expect(redis.srem).toHaveBeenCalledWith('agent:sessions:active', 'agent-1');
      expect(redis.del).toHaveBeenCalledWith('agent:sessions:count:agent-1');
      expect(redis.del).toHaveBeenCalledWith('agent:wake:prefs:agent-1');
    });

    it('calls ephemeral cleanup via pipeline', async () => {
      const redis = makeCrashRedisMock();
      const { agentRepo } = buildManager();

      const manager = new AgentSessionManager(
        agentRepo as any,
        { emitGuardrailTriggered: vi.fn(), emitInstanceStatus: vi.fn() } as any,
        { stop: vi.fn(), cleanupSessionDocuments: vi.fn() } as any,
        { budgets: TEST_RUNTIME_BUDGETS, crashLoopGuard: { enabled: true, maxCrashesInWindow: 3, windowMs: 300_000 } },
        undefined as any,
        undefined,
        redis,
      );

      await manager.handleAgentCrashed('agent-1', 'sess-crash-1');

      // Cleanup calls pipeline
      expect(redis.pipeline).toHaveBeenCalled();
      const pipeline = redis.pipeline();
      expect(pipeline.del).toHaveBeenCalledWith('agent:inbound:agent-1');
      expect(pipeline.exec).toHaveBeenCalled();
    });

    it('records crash event when guard is enabled', async () => {
      const redis = makeCrashRedisMock();
      const { agentRepo } = buildManager();

      const manager = new AgentSessionManager(
        agentRepo as any,
        { emitGuardrailTriggered: vi.fn(), emitInstanceStatus: vi.fn() } as any,
        { stop: vi.fn(), cleanupSessionDocuments: vi.fn() } as any,
        { budgets: TEST_RUNTIME_BUDGETS, crashLoopGuard: { enabled: true, maxCrashesInWindow: 3, windowMs: 300_000 } },
        undefined as any,
        undefined,
        redis,
      );

      await manager.handleAgentCrashed('agent-1', 'sess-crash-1');

      // ZADD called for crash event
      expect(redis.zadd).toHaveBeenCalledWith(
        'agent:crash:events:agent-1',
        expect.any(Number),
        'sess-crash-1',
      );
    });

    it('fires crash-loop alert on block transition', async () => {
      const redis = makeCrashRedisMock();
      const { agentRepo } = buildManager();
      const platformAlerts = { fireAlert: vi.fn().mockResolvedValue(undefined) };

      // Simulate 3 crashes already → next one triggers block
      redis.zcard.mockResolvedValue(3);

      const manager = new AgentSessionManager(
        agentRepo as any,
        { emitGuardrailTriggered: vi.fn(), emitInstanceStatus: vi.fn() } as any,
        { stop: vi.fn(), cleanupSessionDocuments: vi.fn() } as any,
        { budgets: TEST_RUNTIME_BUDGETS, crashLoopGuard: { enabled: true, maxCrashesInWindow: 3, windowMs: 300_000 } },
        undefined as any,
        platformAlerts as any,
        redis,
      );

      await manager.handleAgentCrashed('agent-1', 'sess-crash-1');

      expect(platformAlerts.fireAlert).toHaveBeenCalledWith(
        expect.stringContaining('crash_loop_blocked'),
        expect.objectContaining({ agentId: 'agent-1' }),
      );
    });

    it('does NOT fire alert if already alerted (SET NX returns null)', async () => {
      const redis = makeCrashRedisMock();
      const { agentRepo } = buildManager();
      const platformAlerts = { fireAlert: vi.fn().mockResolvedValue(undefined) };

      redis.zcard.mockResolvedValue(3);
      // Simulate alert already sent: SET NX returns null
      redis.set.mockResolvedValue(null);

      const manager = new AgentSessionManager(
        agentRepo as any,
        { emitGuardrailTriggered: vi.fn(), emitInstanceStatus: vi.fn() } as any,
        { stop: vi.fn(), cleanupSessionDocuments: vi.fn() } as any,
        { budgets: TEST_RUNTIME_BUDGETS, crashLoopGuard: { enabled: true, maxCrashesInWindow: 3, windowMs: 300_000 } },
        undefined as any,
        platformAlerts as any,
        redis,
      );

      await manager.handleAgentCrashed('agent-1', 'sess-crash-1');

      expect(platformAlerts.fireAlert).not.toHaveBeenCalled();
    });

    it('handles Redis errors gracefully without throwing', async () => {
      const redis = makeCrashRedisMock();
      const { agentRepo } = buildManager();
      redis.srem.mockRejectedValueOnce(new Error('Redis gone'));

      const manager = new AgentSessionManager(
        agentRepo as any,
        { emitGuardrailTriggered: vi.fn(), emitInstanceStatus: vi.fn() } as any,
        { stop: vi.fn(), cleanupSessionDocuments: vi.fn() } as any,
        { budgets: TEST_RUNTIME_BUDGETS },
        undefined as any,
        undefined,
        redis,
      );

      await expect(manager.handleAgentCrashed('agent-1')).resolves.toBeUndefined();
    });
  });

  describe('handleStartTimeout — ephemeral cleanup', () => {
    it('calls ephemeral cleanup without changing session count', async () => {
      const redis = makeCrashRedisMock();
      const { agentRepo } = buildManager();

      (agentRepo.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-timeout',
        agentId: 'agent-1',
        status: 'starting',
      });
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'agent-1',
        userId: 'user-1',
      });

      const manager = new AgentSessionManager(
        agentRepo as any,
        { emitGuardrailTriggered: vi.fn(), emitInstanceStatus: vi.fn() } as any,
        { stop: vi.fn(), cleanupSessionDocuments: vi.fn() } as any,
        { budgets: TEST_RUNTIME_BUDGETS },
        undefined as any,
        undefined,
        redis,
      );

      await manager.handleStartTimeout('sess-timeout');

      // Ephemeral cleanup called
      expect(redis.pipeline).toHaveBeenCalled();
      const pipeline = redis.pipeline();
      expect(pipeline.del).toHaveBeenCalledWith('agent:inbound:agent-1');

      // Session count NOT decremented
      const decrCalls = redis.decr.mock.calls.filter(
        (c: string[]) => c[0] === 'agent:sessions:count:agent-1',
      );
      expect(decrCalls).toHaveLength(0);
    });
  });

  describe('handleRuntimeSessionEnd — crash recording', () => {
    it('records crash event when status is crashed', async () => {
      const redis = makeCrashRedisMock();
      const { agentRepo } = buildManager();

      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'agent-1',
        userId: 'user-1',
      });

      const manager = new AgentSessionManager(
        agentRepo as any,
        { emitGuardrailTriggered: vi.fn(), emitInstanceStatus: vi.fn() } as any,
        { stop: vi.fn(), cleanupSessionDocuments: vi.fn() } as any,
        { budgets: TEST_RUNTIME_BUDGETS, crashLoopGuard: { enabled: true, maxCrashesInWindow: 3, windowMs: 300_000 } },
        undefined as any,
        undefined,
        redis,
      );

      await manager.handleRuntimeSessionEnd('sess-crash-1', 'agent-1', 'crashed');

      // ZADD called for crash event with sessionId
      expect(redis.zadd).toHaveBeenCalledWith(
        'agent:crash:events:agent-1',
        expect.any(Number),
        'sess-crash-1',
      );
    });

    it('does NOT record crash when status is stopped (graceful end)', async () => {
      const redis = makeCrashRedisMock();
      const { agentRepo } = buildManager();

      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'agent-1',
        userId: 'user-1',
      });

      const manager = new AgentSessionManager(
        agentRepo as any,
        { emitGuardrailTriggered: vi.fn(), emitInstanceStatus: vi.fn() } as any,
        { stop: vi.fn(), cleanupSessionDocuments: vi.fn() } as any,
        { budgets: TEST_RUNTIME_BUDGETS, crashLoopGuard: { enabled: true, maxCrashesInWindow: 3, windowMs: 300_000 } },
        undefined as any,
        undefined,
        redis,
      );

      await manager.handleRuntimeSessionEnd('sess-stop-1', 'agent-1', 'stopped');

      // No ZADD for graceful stop
      expect(redis.zadd).not.toHaveBeenCalled();
    });

    it('fires crash-loop alert on block transition', async () => {
      const redis = makeCrashRedisMock();
      const { agentRepo } = buildManager();
      const platformAlerts = { fireAlert: vi.fn().mockResolvedValue(undefined) };

      redis.zcard.mockResolvedValue(3);
      (agentRepo.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'agent-1',
        userId: 'user-1',
      });

      const manager = new AgentSessionManager(
        agentRepo as any,
        { emitGuardrailTriggered: vi.fn(), emitInstanceStatus: vi.fn() } as any,
        { stop: vi.fn(), cleanupSessionDocuments: vi.fn() } as any,
        { budgets: TEST_RUNTIME_BUDGETS, crashLoopGuard: { enabled: true, maxCrashesInWindow: 3, windowMs: 300_000 } },
        undefined as any,
        platformAlerts as any,
        redis,
      );

      await manager.handleRuntimeSessionEnd('sess-crash-1', 'agent-1', 'crashed');

      expect(platformAlerts.fireAlert).toHaveBeenCalledWith(
        expect.stringContaining('crash_loop_blocked'),
        expect.objectContaining({ agentId: 'agent-1' }),
      );
    });
  });
});
