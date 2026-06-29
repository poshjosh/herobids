import { describe, it, expect, vi, beforeEach } from 'vitest';
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
      executionMode: null,
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
      executionMode: 'paper',
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
      executionMode: 'paper',
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
      executionMode: 'paper',
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
      executionMode: null,
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
      .mockResolvedValueOnce({ id: 'agent-a', userId: 'user-1', prompt: 'goal-a', skillIds: [], toolPolicy: null, modelPolicy: { provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5' }, executionMode: null, dailyTokenBudget: null, dailyLossLimit: null, maxBots: null, maxSlippageBps: null })
      .mockResolvedValueOnce({ id: 'agent-b', userId: 'user-1', prompt: 'goal-b', skillIds: [], toolPolicy: null, modelPolicy: { provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5' }, executionMode: null, dailyTokenBudget: null, dailyLossLimit: null, maxBots: null, maxSlippageBps: null });

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
    it('fires onSessionActive with agentId and executionMode when session transitions to running', async () => {
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
        executionMode: 'shadow',
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

      expect(onSessionActive).toHaveBeenCalledWith('agent-active-1', 'shadow', 'sess-active-1');
    });

    it('fires onSessionActive with null executionMode when agent has no execution mode set', async () => {
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
        executionMode: null,
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

      expect(onSessionActive).toHaveBeenCalledWith('agent-active-2', null, 'sess-active-2');
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
        .mockResolvedValueOnce({ id: 'agent-first', userId: 'user-1', executionMode: 'paper' })
        .mockResolvedValueOnce({ id: 'agent-first', userId: 'user-1', executionMode: 'paper' })
        .mockResolvedValueOnce({ id: 'agent-recovery', userId: 'user-1', executionMode: 'paper' })
        .mockResolvedValueOnce({ id: 'agent-recovery', userId: 'user-1', executionMode: 'paper' });

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
        executionMode: null,
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
        executionMode: 'live',
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

      expect(onSessionActive).toHaveBeenCalledWith('agent-recovery', 'live', 'sess-recovery');
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
        executionMode: 'paper',
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

      expect(onSessionActive).toHaveBeenCalledWith('agent-survived', 'paper', 'sess-survived');
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
        executionMode: 'paper',
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
        executionMode: 'paper',
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
        executionMode: 'shadow',
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

      expect(onSessionActive).toHaveBeenCalledWith('agent-failed-actor', 'shadow', 'sess-failed-actor');
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
        executionMode: 'shadow',
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

      expect(onSessionActive).toHaveBeenCalledWith('agent-stop-won', 'shadow', 'sess-stop-won');
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
  });
});
