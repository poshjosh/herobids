import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentSessionManager } from './agent-session-manager.js';

describe('AgentSessionManager', () => {
  function buildManager(overrides: Record<string, unknown> = {}) {
    const agentRepo = {
      getSession: vi.fn(),
      getActiveLink: vi.fn().mockResolvedValue({ tradingInstanceId: 'inst-1' }),
      getLaunchableStartingSessions: vi.fn().mockResolvedValue([]),
      claimStartingSession: vi.fn().mockResolvedValue(true),
      markSessionRunning: vi.fn().mockResolvedValue(true),
      markSessionStopped: vi.fn().mockResolvedValue(true),
      markSessionStartTimedOut: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
      getSessionForAgentAndInstance: vi.fn().mockResolvedValue(null),
      retireActiveSessions: vi.fn().mockResolvedValue(undefined),
      getAgent: vi.fn().mockResolvedValue({ id: 'agent-1', prompt: 'Test agent', skillIds: [], toolPolicy: null, executionMode: null, dailyTokenBudget: null, dailyLossLimit: null, maxBots: null, maxSlippageBps: null }),
      getSessionsByStatuses: vi.fn().mockResolvedValue([]),
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
      { id: 'sess-1', agentId: 'agent-1', tradingInstanceId: 'inst-1' },
      { id: 'sess-2', agentId: 'agent-2', tradingInstanceId: 'inst-2' },
    ]);

    await manager.reconcileStartingSessions();

    expect(agentRepo.claimStartingSession).toHaveBeenCalledTimes(2);
    expect(runtimeLauncher.launch).toHaveBeenCalledTimes(2);
    expect(runtimeLauncher.launch).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1', agentId: 'agent-1' }));
    expect(runtimeLauncher.launch).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-2', agentId: 'agent-2' }));
  });

  it('skips a session whose claim fails (another worker already claimed it)', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager();
    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-1', agentId: 'agent-1', tradingInstanceId: 'inst-1' },
    ]);
    (agentRepo.claimStartingSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    await manager.reconcileStartingSessions();

    expect(agentRepo.claimStartingSession).toHaveBeenCalledWith('sess-1');
    expect(runtimeLauncher.launch).not.toHaveBeenCalled();
  });

  it('continues reconciling later sessions if one launch fails', async () => {
    const { manager, agentRepo, runtimeLauncher } = buildManager();
    (agentRepo.getLaunchableStartingSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'sess-1', agentId: 'agent-1', tradingInstanceId: 'inst-1' },
      { id: 'sess-2', agentId: 'agent-2', tradingInstanceId: 'inst-2' },
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
      tradingInstanceId: 'inst-1',
      status: 'starting',
    });

    await manager.handleHeartbeat(
      {
        schemaVersion: 'v1',
        messageId: 'msg-1',
        correlationId: 'corr-1',
        initiatorType: 'agent',
        initiatorId: 'agent-1',
        tradingInstanceId: 'inst-1',
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
      tradingInstanceId: 'inst-1',
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
      tradingInstanceId: 'inst-1',
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
      tradingInstanceId: 'inst-1',
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
        tradingInstanceId: 'inst-1',
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
});