// L3c: AgentDecisionHandler tests against a STUBBED Traderton side-effecting
// boundary (no network, fakes only). The engine-driven submit path was replaced
// by an invoke → poll to the boundary; per-trade validation + risk mapping now
// live behind the boundary. These tests assert: platform gates still fire; a
// `direct`-mode decision routes to the boundary and maps accepted/rejected/error
// onto the sync reply + events; `approval_required` produces pending_approval and
// NEVER calls the boundary; a boundary failure preserves code/retryable; and the
// no-fallback posture (unconfigured boundary → typed error, never the engine).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageEnvelope, DecisionSubmitPayload } from '@herobids/domain';
import type { TradertonClientResult } from '@herobids/domain/traderton';
import type { TradertonSideEffectBoundary } from '../traderton/write-adapter.js';
import { AgentDecisionHandler } from './agent-decision-handler.js';

function makeEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    schemaVersion: 'v1',
    messageId: 'msg-1',
    correlationId: 'sess-1',
    initiatorType: 'agent',
    initiatorId: 'agent-1',
    agentId: 'agent-1',
    botId: 'agent-1',
    type: 'agent.decision.submit',
    createdAt: '2026-06-03T00:00:00.000Z',
    payload: {},
    ...overrides,
  } as MessageEnvelope;
}

function makePayload(overrides: Partial<DecisionSubmitPayload> = {}): DecisionSubmitPayload {
  return {
    decisionId: 'dec-1',
    instrumentId: 'BTC',
    intent: 'go_long',
    targetSize: '1',
    rationaleSummary: 'test',
    _expectsReply: true,
    ...overrides,
  } as DecisionSubmitPayload;
}

/** A stubbed boundary whose invokeAndAwait returns a scripted client result. */
function makeBoundary(result: TradertonClientResult): {
  boundary: TradertonSideEffectBoundary;
  invokeAndAwait: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
} {
  const invokeAndAwait = vi.fn().mockResolvedValue(result);
  const invoke = vi.fn().mockResolvedValue(result);
  return { boundary: { invoke, invokeAndAwait }, invokeAndAwait, invoke };
}

function makeAgentRepo(overrides: Record<string, unknown> = {}) {
  return {
    getAgent: vi.fn().mockResolvedValue({ id: 'agent-1', userId: 'user-1', status: 'active' }),
    isActiveSession: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeEventPublisher() {
  return {
    emitDecisionAccepted: vi.fn().mockResolvedValue(undefined),
    emitDecisionRejected: vi.fn().mockResolvedValue(undefined),
    emitGuardrailTriggered: vi.fn().mockResolvedValue(undefined),
    emitPlanStatus: vi.fn().mockResolvedValue(undefined),
    emitExecutionResult: vi.fn().mockResolvedValue(undefined),
    emitDecisionPendingApproval: vi.fn().mockResolvedValue(undefined),
    publishDecisionReply: vi.fn().mockResolvedValue(undefined),
    publishUserNotification: vi.fn().mockResolvedValue(undefined),
    emitJournalEvent: vi.fn().mockResolvedValue(undefined),
  };
}

describe('AgentDecisionHandler (L3c — boundary)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects when the agent is paused — boundary NOT called', async () => {
    const agentRepo = makeAgentRepo({ getAgent: vi.fn().mockResolvedValue({ id: 'agent-1', userId: 'user-1', status: 'paused' }) });
    const eventPublisher = makeEventPublisher();
    const { boundary, invokeAndAwait } = makeBoundary({ kind: 'success', requestId: 'r', correlationId: 'c', payload: {} });
    const handler = new AgentDecisionHandler(agentRepo as any, eventPublisher as any, undefined, undefined, undefined, undefined, undefined, boundary);

    await handler.handleDecisionSubmit(makeEnvelope(), makePayload());

    expect(invokeAndAwait).not.toHaveBeenCalled();
    expect(eventPublisher.emitDecisionRejected).toHaveBeenCalledWith('agent-1', expect.objectContaining({ code: 'agent_paused' }));
    expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith('dec-1', expect.objectContaining({ status: 'rejected', code: 'agent_paused' }));
  });

  it('rejects when the runtime session is stale — boundary NOT called', async () => {
    const agentRepo = makeAgentRepo({ isActiveSession: vi.fn().mockResolvedValue(false) });
    const eventPublisher = makeEventPublisher();
    const { boundary, invokeAndAwait } = makeBoundary({ kind: 'success', requestId: 'r', correlationId: 'c', payload: {} });
    const handler = new AgentDecisionHandler(agentRepo as any, eventPublisher as any, undefined, undefined, undefined, undefined, undefined, boundary);

    await handler.handleDecisionSubmit(makeEnvelope(), makePayload());

    expect(invokeAndAwait).not.toHaveBeenCalled();
    expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith('dec-1', expect.objectContaining({ status: 'rejected', code: 'stale_session' }));
  });

  it('direct mode: routes to the boundary and maps success → accepted', async () => {
    const agentRepo = makeAgentRepo();
    const eventPublisher = makeEventPublisher();
    const { boundary, invokeAndAwait } = makeBoundary({ kind: 'success', requestId: 'r', correlationId: 'c', payload: { planId: 'plan-9' } });
    const handler = new AgentDecisionHandler(agentRepo as any, eventPublisher as any, undefined, undefined, undefined, undefined, undefined, boundary);

    await handler.handleDecisionSubmit(makeEnvelope(), makePayload({ limitPrice: '100', confidence: 0.5 }));

    expect(invokeAndAwait).toHaveBeenCalledTimes(1);
    const arg = invokeAndAwait.mock.calls[0]![0];
    expect(arg.toolName).toBe('submit_decision');
    // Injects ownerId + actor ONLY; NO venueAccountId/venue/venueType.
    expect(arg.subject).toEqual({ ownerId: 'user-1', actor: { type: 'agent', id: 'agent-1' } });
    expect(arg.payload).toEqual({ instrumentId: 'BTC', intent: 'go_long', targetSize: '1', rationaleSummary: 'test', limitPrice: '100', confidence: 0.5 });
    expect(arg.payload).not.toHaveProperty('venueAccountId');
    expect(eventPublisher.emitDecisionAccepted).toHaveBeenCalled();
    expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith('dec-1', expect.objectContaining({ status: 'accepted', planId: 'plan-9' }));
  });

  it('maps a boundary failure → rejected preserving code + retryable', async () => {
    const agentRepo = makeAgentRepo();
    const eventPublisher = makeEventPublisher();
    const { boundary } = makeBoundary({ kind: 'failure', requestId: 'r', correlationId: 'c', code: 'risk.exceeded', message: 'over limit', retryable: false });
    const handler = new AgentDecisionHandler(agentRepo as any, eventPublisher as any, undefined, undefined, undefined, undefined, undefined, boundary);

    await handler.handleDecisionSubmit(makeEnvelope(), makePayload());

    // risk.* failures surface as a guardrail event.
    expect(eventPublisher.emitGuardrailTriggered).toHaveBeenCalledWith('agent-1', expect.objectContaining({ code: 'risk.exceeded' }));
    expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith('dec-1', expect.objectContaining({ status: 'rejected', code: 'risk.exceeded' }));
  });

  it('maps a non-risk boundary failure → rejected via emitDecisionRejected', async () => {
    const agentRepo = makeAgentRepo();
    const eventPublisher = makeEventPublisher();
    const { boundary } = makeBoundary({ kind: 'failure', requestId: 'r', correlationId: 'c', code: 'validation.invalid_payload', message: 'bad', retryable: false });
    const handler = new AgentDecisionHandler(agentRepo as any, eventPublisher as any, undefined, undefined, undefined, undefined, undefined, boundary);

    await handler.handleDecisionSubmit(makeEnvelope(), makePayload());

    expect(eventPublisher.emitDecisionRejected).toHaveBeenCalledWith('agent-1', expect.objectContaining({ code: 'validation.invalid_payload', retryable: false }));
  });

  it('maps a transport error → error reply (no engine fallback)', async () => {
    const agentRepo = makeAgentRepo();
    const eventPublisher = makeEventPublisher();
    const { boundary } = makeBoundary({ kind: 'transport_error', requestId: 'r', retryable: true, message: 'unreachable' });
    const handler = new AgentDecisionHandler(agentRepo as any, eventPublisher as any, undefined, undefined, undefined, undefined, undefined, boundary);

    await handler.handleDecisionSubmit(makeEnvelope(), makePayload());

    expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith('dec-1', expect.objectContaining({ status: 'error', code: 'boundary.transport_error' }));
  });

  it('maps an in_progress-after-deadline → error reply', async () => {
    const agentRepo = makeAgentRepo();
    const eventPublisher = makeEventPublisher();
    const { boundary } = makeBoundary({ kind: 'in_progress', requestId: 'r', correlationId: 'c' });
    const handler = new AgentDecisionHandler(agentRepo as any, eventPublisher as any, undefined, undefined, undefined, undefined, undefined, boundary);

    await handler.handleDecisionSubmit(makeEnvelope(), makePayload());

    expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith('dec-1', expect.objectContaining({ status: 'error', code: 'boundary.in_progress' }));
  });

  it('no-fallback: when the boundary is unconfigured, returns precondition.not_ready and does NOT touch the engine', async () => {
    const agentRepo = makeAgentRepo();
    const eventPublisher = makeEventPublisher();
    // No boundary passed.
    const handler = new AgentDecisionHandler(agentRepo as any, eventPublisher as any);

    await handler.handleDecisionSubmit(makeEnvelope(), makePayload());

    expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith('dec-1', expect.objectContaining({ status: 'error', code: 'precondition.not_ready' }));
  });

  describe('approval_required mode — pre-boundary, boundary NOT called', () => {
    function makeApprovalHandler(boundary: TradertonSideEffectBoundary, invokeAndAwait: ReturnType<typeof vi.fn>) {
      const agentRepo = makeAgentRepo({
        getAgent: vi.fn().mockResolvedValue({
          id: 'agent-1', userId: 'user-1', status: 'active',
          unifiedConfig: { authorizationMode: 'approval_required' },
          name: 'Agent',
        }),
      });
      const eventPublisher = makeEventPublisher();
      const approvalRepo = {
        findByUserIdAndShortCode: vi.fn().mockResolvedValue(null),
        createApproval: vi.fn().mockResolvedValue('approval-1'),
      };
      const approvalVenueAccountResolver = vi.fn().mockResolvedValue('va-1');
      const handler = new AgentDecisionHandler(
        agentRepo as any, eventPublisher as any,
        undefined, undefined, approvalRepo as any, 60_000, undefined,
        boundary, 30_000, approvalVenueAccountResolver,
      );
      return { handler, eventPublisher, approvalRepo, approvalVenueAccountResolver, invokeAndAwait };
    }

    it('produces pending_approval and never calls the boundary', async () => {
      const { boundary, invokeAndAwait } = makeBoundary({ kind: 'success', requestId: 'r', correlationId: 'c', payload: {} });
      const { handler, eventPublisher, approvalRepo, approvalVenueAccountResolver } = makeApprovalHandler(boundary, invokeAndAwait);

      await handler.handleDecisionSubmit(makeEnvelope(), makePayload());

      expect(invokeAndAwait).not.toHaveBeenCalled();
      // Snapshot venueAccountId sourced from the connection grant, not the engine.
      expect(approvalVenueAccountResolver).toHaveBeenCalledWith('agent-1');
      expect(approvalRepo.createApproval).toHaveBeenCalledWith(expect.objectContaining({ venueAccountId: 'va-1' }));
      expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith('dec-1', expect.objectContaining({ status: 'pending_approval', approvalId: 'approval-1' }));
    });

    it('rejects the approval when no ready trading connection resolves a venue account', async () => {
      const { boundary, invokeAndAwait } = makeBoundary({ kind: 'success', requestId: 'r', correlationId: 'c', payload: {} });
      const { handler, eventPublisher, approvalRepo } = makeApprovalHandler(boundary, invokeAndAwait);
      // Override the resolver to return null.
      (handler as any).approvalVenueAccountResolver = vi.fn().mockResolvedValue(null);

      await handler.handleDecisionSubmit(makeEnvelope(), makePayload());

      expect(invokeAndAwait).not.toHaveBeenCalled();
      expect(approvalRepo.createApproval).not.toHaveBeenCalled();
      expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith('dec-1', expect.objectContaining({ status: 'rejected', code: 'instance_not_running' }));
    });
  });
});
