import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentMessageBroker } from './agent-message-broker.js';
import type { AgentDecisionHandler } from './agent-decision-handler.js';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'v1',
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    correlationId: 'corr-001',
    initiatorType: 'agent',
    initiatorId: 'agent-123',
    tradingInstanceId: 'ti-456',
    type: 'agent.decision.submit',
    createdAt: '2026-06-01T00:00:00.000Z',
    payload: {
      decisionId: 'dec-001',
      instrumentId: 'BTC-USD',
      intent: 'go_long',
      targetSize: '1.5',
      rationaleSummary: 'Momentum breakout',
    },
    ...overrides,
  };
}

function mockAgentRepo() {
  return {
    isMessageDuplicate: vi.fn().mockResolvedValue(false),
    insertMessage: vi.fn().mockResolvedValue(undefined),
    markMessageProcessed: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn().mockResolvedValue({ id: 'agent-123', status: 'active' }),
    getActiveSession: vi.fn().mockResolvedValue({ id: 'sess-001' }),
    insertArtifact: vi.fn().mockResolvedValue('art-id'),
    getActiveLink: vi.fn().mockResolvedValue({ tradingInstanceId: 'ti-456' }),
  };
}

function mockDecisionHandler() {
  return {
    handleDecisionSubmit: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentDecisionHandler;
}

function mockSessionManager() {
  return {
    handleHeartbeat: vi.fn().mockResolvedValue(undefined),
    handlePauseRequest: vi.fn().mockResolvedValue(undefined),
    handleStopRequest: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentSessionManager;
}

function mockEventPublisher() {
  return {
    emitDecisionAccepted: vi.fn().mockResolvedValue(undefined),
    emitDecisionRejected: vi.fn().mockResolvedValue(undefined),
  } as unknown as InstanceEventPublisher;
}

describe('AgentMessageBroker', () => {
  let broker: AgentMessageBroker;
  let agentRepo: ReturnType<typeof mockAgentRepo>;
  let decisionHandler: ReturnType<typeof mockDecisionHandler>;
  let sessionManager: ReturnType<typeof mockSessionManager>;
  let eventPublisher: ReturnType<typeof mockEventPublisher>;

  beforeEach(() => {
    agentRepo = mockAgentRepo();
    decisionHandler = mockDecisionHandler();
    sessionManager = mockSessionManager();
    eventPublisher = mockEventPublisher();
    broker = new AgentMessageBroker(
      {} as any, // redis (not used directly in processInbound tests)
      agentRepo as any,
      decisionHandler,
      sessionManager,
      eventPublisher,
    );
  });

  describe('envelope validation', () => {
    it('rejects invalid envelope', async () => {
      const result = await broker.processInbound({ bad: 'data' });
      expect(result.accepted).toBe(false);
      expect(result.error).toBe('invalid_envelope');
    });

    it('rejects missing required fields', async () => {
      const result = await broker.processInbound({ messageId: 'msg-1' });
      expect(result.accepted).toBe(false);
      expect(result.error).toBe('invalid_envelope');
    });

    it('rejects envelope with unknown message type', async () => {
      const envelope = makeEnvelope({ type: 'agent.unknown.action' });
      const result = await broker.processInbound(envelope);
      expect(result.accepted).toBe(false);
      expect(result.error).toBe('unknown_message_type');
    });
  });

  describe('payload validation', () => {
    it('rejects envelope with invalid payload for its type', async () => {
      const envelope = makeEnvelope({
        payload: { /* missing required fields */ },
      });
      const result = await broker.processInbound(envelope);
      expect(result.accepted).toBe(false);
      expect(result.error).toBe('invalid_payload');
    });
  });

  describe('deduplication', () => {
    it('accepts duplicate messages idempotently', async () => {
      agentRepo.isMessageDuplicate.mockResolvedValue(true);
      const envelope = makeEnvelope();
      const result = await broker.processInbound(envelope);
      expect(result.accepted).toBe(true);
      // Should not call insertMessage or route to handler
      expect(agentRepo.insertMessage).not.toHaveBeenCalled();
      expect(decisionHandler.handleDecisionSubmit).not.toHaveBeenCalled();
    });

    it('processes new messages normally', async () => {
      const envelope = makeEnvelope();
      const result = await broker.processInbound(envelope);
      expect(result.accepted).toBe(true);
      expect(agentRepo.insertMessage).toHaveBeenCalled();
      expect(decisionHandler.handleDecisionSubmit).toHaveBeenCalled();
    });
  });

  describe('message routing', () => {
    it('routes decision.submit to decisionHandler', async () => {
      const envelope = makeEnvelope({ type: 'agent.decision.submit' });
      await broker.processInbound(envelope);
      expect(decisionHandler.handleDecisionSubmit).toHaveBeenCalled();
    });

    it('routes heartbeat to sessionManager', async () => {
      const envelope = makeEnvelope({
        type: 'agent.runtime.heartbeat',
        payload: { sessionId: 'sess-001', status: 'ready' },
      });
      await broker.processInbound(envelope);
      expect((sessionManager as any).handleHeartbeat).toHaveBeenCalled();
    });

    it('routes pause request to sessionManager', async () => {
      const envelope = makeEnvelope({
        type: 'agent.lifecycle.pause_request',
        payload: { reason: 'User requested' },
      });
      await broker.processInbound(envelope);
      expect((sessionManager as any).handlePauseRequest).toHaveBeenCalled();
    });

    it('routes stop request to sessionManager', async () => {
      const envelope = makeEnvelope({
        type: 'agent.lifecycle.stop_request',
        payload: { reason: 'Done' },
      });
      await broker.processInbound(envelope);
      expect((sessionManager as any).handleStopRequest).toHaveBeenCalled();
    });
  });

  describe('message persistence', () => {
    it('persists envelope metadata before routing', async () => {
      const envelope = makeEnvelope({ messageId: 'msg-specific' });
      await broker.processInbound(envelope);
      expect(agentRepo.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-specific',
          correlationId: 'corr-001',
          actorType: 'agent',
          actorId: 'agent-123',
          tradingInstanceId: 'ti-456',
          type: 'agent.decision.submit',
          direction: 'inbound',
          schemaVersion: 'v1',
        }),
      );
    });

    it('marks message as processed on success', async () => {
      const envelope = makeEnvelope({ messageId: 'msg-success' });
      await broker.processInbound(envelope);
      expect(agentRepo.markMessageProcessed).toHaveBeenCalledWith('msg-success', 'processed');
    });

    it('marks message as failed on handler error', async () => {
      (decisionHandler.handleDecisionSubmit as any).mockRejectedValue(new Error('Engine crash'));
      const envelope = makeEnvelope({ messageId: 'msg-fail' });
      const result = await broker.processInbound(envelope);
      expect(result.accepted).toBe(false);
      expect(agentRepo.markMessageProcessed).toHaveBeenCalledWith(
        'msg-fail',
        'failed',
        expect.objectContaining({ code: 'processing_error' }),
      );
    });
  });
});
