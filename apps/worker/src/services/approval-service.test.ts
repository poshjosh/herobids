import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DecisionApprovalRow } from '@herobids/db';
import type { TradertonClientResult } from '@herobids/domain/traderton';
import { ApprovalService, type ApprovalServiceDeps } from './approval-service.js';
import type { TradertonSideEffectBoundary } from '../traderton/write-adapter.js';

/**
 * L3d-1: executeApproval drives the human-approve → execute path over the
 * Traderton REST boundary (no in-process engine). These tests exercise it
 * against a STUBBED boundary (no network):
 *   - platform gates (ownership / expiry / double-execution / pending-only)
 *   - boundary success  → executed/accepted + recordExecutionResult('accepted') + emitDecisionAccepted
 *   - boundary failure   → executed/rejected + recordExecutionResult('rejected')
 *   - boundary transport → executed/error   + recordExecutionResult('error')
 *   - boundary UNCONFIGURED → typed error, approval NOT consumed, boundary never invoked
 */

const NOW = Date.now();
const FUTURE = new Date(NOW + 60_000).toISOString();
const PAST = new Date(NOW - 60_000).toISOString();

function makeApprovalRow(overrides: Partial<DecisionApprovalRow> = {}): DecisionApprovalRow {
  return {
    id: 'appr-1',
    shortCode: 'ABC123',
    userId: 'user-1',
    agentId: 'agent-1',
    actorType: 'agent',
    actorId: 'agent-1',
    venueAccountId: 'va-1',
    authorizationModeSnapshot: 'approval_required',
    status: 'pending',
    executionStatus: null,
    instrumentId: 'BTC-PERP',
    intent: 'go_long',
    targetSize: '1.5',
    limitPrice: null,
    stopLoss: null,
    takeProfit: null,
    confidence: null,
    rationaleSummary: 'test rationale',
    contextHash: null,
    proposedPayload: {},
    decisionId: null,
    planId: null,
    resolvedByUserId: null,
    resolvedAt: null,
    resolutionSource: null,
    lastResolutionAttemptAt: null,
    lastResolutionErrorCode: null,
    // Fields not asserted on but present on the row shape.
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    expiresAt: new Date(FUTURE),
    lastResolutionErrorMessage: null,
    ...overrides,
  } as unknown as DecisionApprovalRow;
}

function buildDeps(opts: {
  approval?: DecisionApprovalRow | undefined;
  boundary?: TradertonSideEffectBoundary | undefined;
}) {
  const approvalRepo = {
    findById: vi.fn().mockResolvedValue(opts.approval),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    updateExpired: vi.fn().mockResolvedValue(undefined),
    recordExecutionResult: vi.fn().mockResolvedValue(undefined),
    recordResolutionAttempt: vi.fn().mockResolvedValue(undefined),
    findExpiredPending: vi.fn().mockResolvedValue([]),
  };
  const eventPublisher = {
    emitDecisionAccepted: vi.fn().mockResolvedValue(undefined),
    emitPlanStatus: vi.fn().mockResolvedValue(undefined),
    emitExecutionResult: vi.fn().mockResolvedValue(undefined),
  };
  const deps = {
    approvalRepo,
    eventPublisher,
    agentApprovalsTtlMs: 60_000,
    sideEffectBoundary: opts.boundary,
    boundaryDeadlineMs: 30_000,
  } as unknown as ApprovalServiceDeps;
  return { deps, approvalRepo, eventPublisher };
}

function makeBoundary(result: TradertonClientResult) {
  const invokeAndAwait = vi.fn().mockResolvedValue(result);
  const boundary: TradertonSideEffectBoundary = {
    invoke: vi.fn(),
    invokeAndAwait,
  };
  return { boundary, invokeAndAwait };
}

describe('ApprovalService.executeApproval', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes an approved decision through the boundary → accepted', async () => {
    const { boundary, invokeAndAwait } = makeBoundary({
      kind: 'success',
      requestId: 'req-1',
      correlationId: 'corr-1',
      payload: { planId: 'plan-1' },
    });
    const { deps, approvalRepo, eventPublisher } = buildDeps({
      approval: makeApprovalRow({ limitPrice: '30000', confidence: '0.9', contextHash: 'ctx-1' }),
      boundary,
    });
    const svc = new ApprovalService(deps);

    const res = await svc.executeApproval('appr-1', 'user-1', 'web', 'agent-1', 'bot-1');

    expect(res).toMatchObject({ kind: 'executed', status: 'accepted', planId: 'plan-1' });

    // Subject stays ownerId + actor ONLY (D2) — the venue account is NOT in the
    // subject. It rides in the PAYLOAD, sourced from the approval snapshot's
    // stored venueAccountId (va-1), so the boundary resolves it deterministically.
    expect(invokeAndAwait).toHaveBeenCalledTimes(1);
    const call = invokeAndAwait.mock.calls[0]![0];
    expect(call.toolName).toBe('submit_decision');
    expect(call.subject).toEqual({ ownerId: 'user-1', actor: { type: 'agent', id: 'agent-1' } });
    expect(call.subject.venueAccountId).toBeUndefined();
    // Payload built from the stored fields (optional values carried through) plus
    // the snapshot venue account threaded in as a payload arg.
    expect(call.payload).toMatchObject({
      instrumentId: 'BTC-PERP',
      intent: 'go_long',
      targetSize: '1.5',
      rationaleSummary: 'test rationale',
      limitPrice: '30000',
      confidence: 0.9,
      contextHash: 'ctx-1',
      venueAccountId: 'va-1',
    });

    // pending → approved transition + recorded accepted outcome + emitted event.
    expect(approvalRepo.updateStatus).toHaveBeenCalledWith('appr-1', 'approved', expect.objectContaining({ resolvedByUserId: 'user-1' }));
    expect(approvalRepo.recordExecutionResult).toHaveBeenCalledWith('appr-1', expect.any(String), 'plan-1', 'accepted');
    expect(eventPublisher.emitDecisionAccepted).toHaveBeenCalledTimes(1);
  });

  it('maps a boundary failure → executed/rejected and records it', async () => {
    const { boundary } = makeBoundary({
      kind: 'failure',
      requestId: 'req-2',
      correlationId: 'corr-2',
      code: 'risk.exceeded' as never,
      message: 'position cap exceeded',
      retryable: false,
    });
    const { deps, approvalRepo, eventPublisher } = buildDeps({ approval: makeApprovalRow(), boundary });
    const svc = new ApprovalService(deps);

    const res = await svc.executeApproval('appr-1', 'user-1', 'web', 'agent-1', 'bot-1');

    expect(res).toMatchObject({ kind: 'executed', status: 'rejected', message: 'position cap exceeded' });
    expect(approvalRepo.recordExecutionResult).toHaveBeenCalledWith('appr-1', expect.any(String), null, 'rejected');
    expect(eventPublisher.emitDecisionAccepted).not.toHaveBeenCalled();
  });

  it('maps a boundary transport error → executed/error and records it', async () => {
    const { boundary } = makeBoundary({
      kind: 'transport_error',
      requestId: 'req-3',
      retryable: true,
      message: 'boundary unreachable',
    });
    const { deps, approvalRepo } = buildDeps({ approval: makeApprovalRow(), boundary });
    const svc = new ApprovalService(deps);

    const res = await svc.executeApproval('appr-1', 'user-1', 'web', 'agent-1', 'bot-1');

    expect(res).toMatchObject({ kind: 'executed', status: 'error' });
    expect(approvalRepo.recordExecutionResult).toHaveBeenCalledWith('appr-1', expect.any(String), null, 'error');
  });

  it('returns a typed precondition error and NEVER invokes when the boundary is unconfigured', async () => {
    const { deps, approvalRepo } = buildDeps({ approval: makeApprovalRow(), boundary: undefined });
    const svc = new ApprovalService(deps);

    const res = await svc.executeApproval('appr-1', 'user-1', 'web', 'agent-1', 'bot-1');

    expect(res).toEqual({ kind: 'error', code: 'precondition.not_ready', message: expect.any(String) });
    // The approval is NOT consumed — no status transition, no execution result.
    expect(approvalRepo.updateStatus).not.toHaveBeenCalled();
    expect(approvalRepo.recordExecutionResult).not.toHaveBeenCalled();
    // The resolution attempt is recorded so the user sees why.
    expect(approvalRepo.recordResolutionAttempt).toHaveBeenCalledWith('appr-1', 'precondition.not_ready', expect.any(String));
  });

  it('rejects when the caller does not own the approval (never invokes the boundary)', async () => {
    const { boundary, invokeAndAwait } = makeBoundary({ kind: 'success', requestId: 'r', correlationId: 'c', payload: {} });
    const { deps } = buildDeps({ approval: makeApprovalRow({ userId: 'someone-else' }), boundary });
    const svc = new ApprovalService(deps);

    const res = await svc.executeApproval('appr-1', 'user-1', 'web', 'agent-1', 'bot-1');

    expect(res).toEqual({ kind: 'not_owned' });
    expect(invokeAndAwait).not.toHaveBeenCalled();
  });

  it('returns already_resolved when execution was already attempted (double-execution guard)', async () => {
    const { boundary, invokeAndAwait } = makeBoundary({ kind: 'success', requestId: 'r', correlationId: 'c', payload: {} });
    const { deps } = buildDeps({ approval: makeApprovalRow({ executionStatus: 'accepted', status: 'approved' }), boundary });
    const svc = new ApprovalService(deps);

    const res = await svc.executeApproval('appr-1', 'user-1', 'web', 'agent-1', 'bot-1');

    expect(res).toEqual({ kind: 'already_resolved', status: 'approved' });
    expect(invokeAndAwait).not.toHaveBeenCalled();
  });

  it('expires an approval past its expiry (never invokes the boundary)', async () => {
    const { boundary, invokeAndAwait } = makeBoundary({ kind: 'success', requestId: 'r', correlationId: 'c', payload: {} });
    const { deps, approvalRepo } = buildDeps({ approval: makeApprovalRow({ expiresAt: new Date(PAST) as never }), boundary });
    const svc = new ApprovalService(deps);

    const res = await svc.executeApproval('appr-1', 'user-1', 'web', 'agent-1', 'bot-1');

    expect(res).toEqual({ kind: 'expired' });
    expect(approvalRepo.updateExpired).toHaveBeenCalledWith(['appr-1']);
    expect(invokeAndAwait).not.toHaveBeenCalled();
  });

  it('returns not_found when the approval does not exist', async () => {
    const { boundary } = makeBoundary({ kind: 'success', requestId: 'r', correlationId: 'c', payload: {} });
    const { deps } = buildDeps({ approval: undefined, boundary });
    const svc = new ApprovalService(deps);

    const res = await svc.executeApproval('missing', 'user-1', 'web', 'agent-1', 'bot-1');
    expect(res).toEqual({ kind: 'not_found' });
  });
});
