import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentHealthMonitor } from './agent-health-monitor.js';

describe('AgentHealthMonitor', () => {
  function buildMonitor(queryResults: Array<Array<Record<string, unknown>>>) {
    const sessionManager = {
      markUnhealthy: vi.fn().mockResolvedValue(undefined),
      handleStartTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const db = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => Promise.resolve(queryResults.shift() ?? [])),
        }),
      })),
    };

    const monitor = new AgentHealthMonitor(db as any, sessionManager as any, {
      checkIntervalMs: 1000,
      heartbeatTimeoutMs: 30000,
    });

    return { monitor, sessionManager };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes stale starting sessions to handleStartTimeout', async () => {
    const { monitor, sessionManager } = buildMonitor([
      [],
      [{ id: 'sess-starting', agentId: 'agent-1', startedAt: new Date('2026-06-02T00:00:00.000Z') }],
    ]);

    await (monitor as any).checkHealth();

    expect(sessionManager.handleStartTimeout).toHaveBeenCalledWith('sess-starting');
    expect(sessionManager.markUnhealthy).not.toHaveBeenCalled();
  });

  it('routes stale running sessions to markUnhealthy', async () => {
    const { monitor, sessionManager } = buildMonitor([
      [{ id: 'sess-running', agentId: 'agent-1', lastHeartbeatAt: new Date('2026-06-02T00:00:00.000Z') }],
      [],
    ]);

    await (monitor as any).checkHealth();

    expect(sessionManager.markUnhealthy).toHaveBeenCalledWith('sess-running');
    expect(sessionManager.handleStartTimeout).not.toHaveBeenCalled();
  });

  it('ignores recently started or recently heartbeating sessions', async () => {
    const { monitor, sessionManager } = buildMonitor([[], []]);

    await (monitor as any).checkHealth();

    expect(sessionManager.handleStartTimeout).not.toHaveBeenCalled();
    expect(sessionManager.markUnhealthy).not.toHaveBeenCalled();
  });
});