import { describe, it, expect, vi } from 'vitest';
import { AgentSessionManager } from './agent-session-manager.js';

describe('AgentSessionManager', () => {
  it('bootstraps recovery on the first heartbeat for a starting session', async () => {
    const agentRepo = {
      getSession: vi.fn().mockResolvedValue({
        id: 'sess-1',
        agentId: 'agent-1',
        tradingInstanceId: 'inst-1',
        status: 'starting',
      }),
      updateSession: vi.fn().mockResolvedValue(undefined),
    };

    const reconnectHandler = {
      handleReconnect: vi.fn().mockResolvedValue(undefined),
    };

    const manager = new AgentSessionManager(
      agentRepo as any,
      {} as any,
      undefined,
      reconnectHandler as any,
    );

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

    expect(agentRepo.updateSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ status: 'running' }),
    );
    expect(reconnectHandler.handleReconnect).toHaveBeenCalledWith('agent-1', 'sess-1', 'inst-1');
  });
});