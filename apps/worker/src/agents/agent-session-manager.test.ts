import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentSessionManager } from './agent-session-manager.js';

describe('AgentSessionManager', () => {
  function buildManager(overrides: Record<string, unknown> = {}) {
    const runtimeDescriptor = {
      schemaVersion: 'v1' as const,
      agentId: 'agent-1',
      goal: 'Test agent',
      executionMode: 'paper',
      resolvedSkills: [{ id: 'base', capabilityFamilies: [], requiredTools: ['send_message', 'publish_artifact', 'set_memory'] }],
      grantedBindingsByFamily: {},
      readinessByFamily: {},
      defaultBindingByFamily: {},
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
    const makeAgent = (agentId: string) => ({
      id: agentId,
      userId: 'user-1',
      prompt: 'Test agent',
      skillIds: [],
      toolPolicy: null,
      modelPolicy: null,
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
      markSessionStartTimedOut: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
      getSessionForAgentAndInstance: vi.fn().mockResolvedValue(null),
      retireActiveSessions: vi.fn().mockResolvedValue(undefined),
      getAgent: vi.fn().mockImplementation(async (agentId: string) => makeAgent(agentId)),
      getUserAiModelConfig: vi.fn().mockResolvedValue(null),
      getSessionsByStatuses: vi.fn().mockResolvedValue([]),
      getRuntimeCapabilityDescriptor: vi.fn().mockImplementation(async (agentId: string) => ({
        ...runtimeDescriptor,
        agentId,
      })),
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

    const eventPublisher = {};
    const manager = new AgentSessionManager(
      agentRepo as any,
      eventPublisher as any,
      runtimeLauncher as any,
      undefined,
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
        skillIds: [],
      }),
      runtimeDescriptor: expect.objectContaining({
        agentId: 'agent-1',
        goal: 'Test agent',
        resolvedSkills: expect.any(Array),
        readinessByFamily: expect.any(Object),
        grantedBindingsByFamily: expect.any(Object),
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
      prompt: 'Trade BTC conservatively',
      skillIds: ['bot-management'],
      toolPolicy: { manage_bot: { capability: 'manage_bot', tier: 'brokered', enabled: true } },
      executionMode: 'paper',
      dailyTokenBudget: 1000,
      dailyLossLimit: '50',
      maxBots: 2,
      maxSlippageBps: 25,
    });
    (agentRepo.getRuntimeCapabilityDescriptor as ReturnType<typeof vi.fn>).mockResolvedValue({
      grantedBindingsByFamily: {
        trading: [
          {
            family: 'trading',
            bindingId: 'binding-1',
            connectionId: 'conn-1',
            provider: 'hyperliquid',
            label: 'Primary HL binding',
            bindingRef: 'acct-1',
            bindingProfile: { venue: 'hyperliquid' },
            sourceVenueAccountId: 'va-1',
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
      defaultBindingByFamily: { trading: 'binding-1' },
    });

    await manager.reconcileStartingSessions();

    expect(runtimeLauncher.launch).toHaveBeenCalledWith(expect.objectContaining({
      agentConfig: expect.objectContaining({
        prompt: 'Trade BTC conservatively',
        skillIds: ['bot-management'],
      }),
      runtimeDescriptor: expect.objectContaining({
        agentId: 'agent-1',
        goal: 'Trade BTC conservatively',
        executionMode: 'paper',
        defaultBindingByFamily: { trading: 'binding-1' },
        readinessByFamily: {
          trading: expect.objectContaining({ effectiveReady: true, bindingId: 'binding-1' }),
        },
        grantedBindingsByFamily: {
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
      prompt: 'Watch DEX momentum names',
      skillIds: ['trading'],
      toolPolicy: null,
      modelPolicy: { dexWatchlistSymbols: ['BONK', 'WIF'] },
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
      { streamSubscribe },
    );

    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-a', agentId: 'agent-a', botId: 'inst-a' },
      { id: 'sess-b', agentId: 'agent-b', botId: 'inst-b' },
    ]);
    (agentRepo.getAgent as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'agent-a', prompt: 'goal-a', skillIds: [], toolPolicy: null, executionMode: null, dailyTokenBudget: null, dailyLossLimit: null, maxBots: null, maxSlippageBps: null })
      .mockResolvedValueOnce({ id: 'agent-b', prompt: 'goal-b', skillIds: [], toolPolicy: null, executionMode: null, dailyTokenBudget: null, dailyLossLimit: null, maxBots: null, maxSlippageBps: null });

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
      { streamSubscribe },
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
      { streamSubscribe },
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
      // Construct without an interval override to verify the default
      const defaultManager = new AgentSessionManager(
        agentRepo as any,
        {} as any,
        runtimeLauncher as any,
        // No config passed — uses DEFAULT_CONFIG
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
        { healthCheckIntervalMs: 2000 },
      );
      const cfg = (fastManager as unknown as { config: { healthCheckIntervalMs: number } }).config;
      expect(cfg.healthCheckIntervalMs).toBe(2000);
    });
  });
});