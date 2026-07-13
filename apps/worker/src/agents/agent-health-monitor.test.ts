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

  describe('checkIntervalMs config', () => {
    it('uses configured checkIntervalMs instead of the internal 10000 ms default', () => {
      // Plan §3a: user-stop coverage must be driven by the operator-configured
      // checkIntervalMs (default 2_000 ms in config/default.yaml), not the
      // class-level DEFAULT_CONFIG of 10_000 ms.
      const monitor = new AgentHealthMonitor(
        {} as any,
        {} as any,
        { checkIntervalMs: 2_000, heartbeatTimeoutMs: 30_000 },
      );

      const stored = (monitor as any).config.checkIntervalMs;
      expect(stored).toBe(2_000);
      expect(stored).not.toBe(10_000);
    });

    it('falls back to the 10000 ms class default when no checkIntervalMs is provided', () => {
      const monitor = new AgentHealthMonitor(
        {} as any,
        {} as any,
        { heartbeatTimeoutMs: 30_000 },
      );

      expect((monitor as any).config.checkIntervalMs).toBe(10_000);
    });

    it('uses configured value even when all config fields are provided', () => {
      const monitor = new AgentHealthMonitor(
        {} as any,
        {} as any,
        { checkIntervalMs: 5_000, heartbeatTimeoutMs: 60_000 },
      );

      const config = (monitor as any).config;
      expect(config.checkIntervalMs).toBe(5_000);
      expect(config.heartbeatTimeoutMs).toBe(60_000);
    });
  });

  describe('onTerminalSessionCleanup callback', () => {
    it('calls onTerminalSessionCleanup before runtimeLauncher.stop for a stopped session', async () => {
      const callOrder: string[] = [];
      const onTerminalSessionCleanup = vi.fn().mockImplementation(() => {
        callOrder.push('cleanup');
        return Promise.resolve();
      });
      const runtimeStop = vi.fn().mockImplementation(() => {
        callOrder.push('stop');
        return Promise.resolve();
      });

      const runtimeLauncher = {
        getActiveRuntimes: vi.fn().mockReturnValue([
          { sessionId: 'sess-stopped', agentId: 'agent-1' },
        ]),
        stop: runtimeStop,
        cleanupSessionDocuments: vi.fn().mockImplementation(() => {
          callOrder.push('doc-cleanup');
          return Promise.resolve();
        }),
      };

      const sessionManager = {
        markUnhealthy: vi.fn().mockResolvedValue(undefined),
        handleStartTimeout: vi.fn().mockResolvedValue(undefined),
      };

      const queryResults = [
        [],   // stale running: none
        [],   // stale starting: none
        [     // terminal sessions: one stopped
          { id: 'sess-stopped', agentId: 'agent-1', status: 'stopped' },
        ],
      ];
      const db = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() =>
              Promise.resolve(queryResults.shift() ?? []),
            ),
          }),
        })),
      };

      const monitor = new AgentHealthMonitor(
        db as any,
        sessionManager as any,
        { checkIntervalMs: 1000, heartbeatTimeoutMs: 30000, onTerminalSessionCleanup },
        runtimeLauncher as any,
      );

      await (monitor as any).checkHealth();

      expect(onTerminalSessionCleanup).toHaveBeenCalledWith('agent-1', 'sess-stopped', 'stopped');
      expect(runtimeStop).toHaveBeenCalledWith('sess-stopped');
      // Cleanup must fire before stop, and doc cleanup after callback
      expect(callOrder[0]).toBe('cleanup');
      expect(callOrder[1]).toBe('doc-cleanup');
      expect(callOrder[2]).toBe('stop');
    });

    it('continues to stop the runtime even when the cleanup callback throws', async () => {
      const onTerminalSessionCleanup = vi.fn().mockRejectedValue(new Error('cleanup failed'));
      const runtimeStop = vi.fn().mockResolvedValue(undefined);

      const runtimeLauncher = {
        getActiveRuntimes: vi.fn().mockReturnValue([
          { sessionId: 'sess-fail', agentId: 'agent-2' },
        ]),
        stop: runtimeStop,
        cleanupSessionDocuments: vi.fn().mockResolvedValue(undefined),
      };

      const sessionManager = {
        markUnhealthy: vi.fn().mockResolvedValue(undefined),
        handleStartTimeout: vi.fn().mockResolvedValue(undefined),
      };

      const queryResults = [
        [],   // stale running: none
        [],   // stale starting: none
        [     // terminal sessions: one crashed
          { id: 'sess-fail', agentId: 'agent-2', status: 'crashed' },
        ],
      ];
      const db = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() =>
              Promise.resolve(queryResults.shift() ?? []),
            ),
          }),
        })),
      };

      const monitor = new AgentHealthMonitor(
        db as any,
        sessionManager as any,
        { checkIntervalMs: 1000, heartbeatTimeoutMs: 30000, onTerminalSessionCleanup },
        runtimeLauncher as any,
      );

      // Must not throw
      await expect((monitor as any).checkHealth()).resolves.not.toThrow();

      expect(onTerminalSessionCleanup).toHaveBeenCalledWith('agent-2', 'sess-fail', 'crashed');
      // runtimeLauncher.stop must still be called even though cleanup threw
      expect(runtimeStop).toHaveBeenCalledWith('sess-fail');
      // Document cleanup should also proceed even though callback threw
      expect(runtimeLauncher.cleanupSessionDocuments).toHaveBeenCalledWith('agent-2', 'sess-fail');
    });
  });
});