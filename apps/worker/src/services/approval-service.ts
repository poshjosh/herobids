import type { DecisionSubmitPayload, ActorType } from '@herobids/domain';
import type { DecisionApprovalRepository } from '@herobids/db';
import type { InstanceEventPublisher } from '../agents/instance-event-publisher.js';
import type { TradertonSideEffectBoundary } from '../traderton/write-adapter.js';
import { buildSubmitDecisionPayload, mapBoundaryResultToDecisionOutcome } from '../agents/decision-boundary-mapping.js';
import { createLogger } from '../logger.js';
import crypto from 'node:crypto';

const logger = createLogger('approval-service');

export interface ApprovalServiceDeps {
  approvalRepo: DecisionApprovalRepository;
  eventPublisher: InstanceEventPublisher;
  agentApprovalsTtlMs: number;
  // L3d-1: the Traderton side-effecting boundary. The human-approve → execute
  // path routes `submit_decision` over REST (invoke → poll) instead of the
  // in-process engine. When absent (unconfigured), executeApproval returns a
  // typed precondition error — NEVER a silent fall back to the engine.
  sideEffectBoundary?: TradertonSideEffectBoundary;
  // Total budget (ms) for the boundary invoke + poll. Matches the decision
  // handler's 30s deadline so the synchronous feel is preserved.
  boundaryDeadlineMs?: number;
}

export class ApprovalService {
  private readonly boundaryDeadlineMs: number;

  constructor(private readonly deps: ApprovalServiceDeps) {
    this.boundaryDeadlineMs = deps.boundaryDeadlineMs ?? 30_000;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Execute a pending approval — reconstruct the decision from stored JSONB and
   * submit it over the Traderton REST boundary, recording the outcome.
   *
   * Ownership is validated (userId must match). Expired approvals are rejected.
   * The pending → approved transition happens once all platform gates pass and
   * the boundary is about to be invoked. Per-trade level validation is NOT run
   * here — Traderton owns mark-price-dependent validation behind the boundary
   * (004-l3d-plan.md §C). herobids injects ownerId + actor ONLY; Traderton
   * resolves the venue account.
   */
  async executeApproval(
    approvalId: string,
    userId: string,
    resolutionSource: string,
    _effectiveAgentId: string,
    effectiveBotId: string,
  ): Promise<ApprovalResolutionResult> {
    const approval = await this.deps.approvalRepo.findById(approvalId);
    if (!approval) {
      return { kind: 'not_found' };
    }
    if (approval.userId !== userId) {
      return { kind: 'not_owned' };
    }
    // Guard against double-execution: if execution was already attempted, bail.
    if (approval.executionStatus !== null) {
      return { kind: 'already_resolved', status: approval.status };
    }
    // Only accept 'pending' — the API no longer transitions status before
    // publishing the execution request. The worker is now the sole authority
    // for the pending → approved transition.
    if (approval.status !== 'pending') {
      return { kind: 'already_resolved', status: approval.status };
    }
    if (new Date() > new Date(approval.expiresAt)) {
      // Expire it now so the caller gets a clear status
      await this.deps.approvalRepo.updateExpired([approvalId]);
      return { kind: 'expired' };
    }

    // No-fallback posture (L3d-1): if the boundary is unconfigured, the approval
    // cannot be executed — return a typed precondition WITHOUT consuming the
    // approval (executionStatus stays null; the user can retry once the boundary
    // is configured). The in-process engine is NEVER invoked.
    if (!this.deps.sideEffectBoundary) {
      const code = 'precondition.not_ready';
      const msg = 'Trading boundary is not configured — the approved decision cannot be executed.';
      await this.recordResolutionAttempt(approvalId, code, msg);
      return { kind: 'error', code, message: msg };
    }

    const decisionId = crypto.randomUUID();

    // Transition status to 'approved' — all platform gates passed and the
    // boundary invoke is about to proceed. This is the single authority for the
    // pending → approved transition. If the process crashes after this point, the
    // approval is 'approved' with executionStatus reflecting the outcome.
    await this.deps.approvalRepo.updateStatus(approvalId, 'approved', {
      resolvedByUserId: userId,
      resolutionSource,
    });

    // Build the boundary payload from the stored approval fields, reusing the
    // handler's shared payload builder (same wire shape as the direct path).
    const decisionPayload: DecisionSubmitPayload = {
      decisionId,
      instrumentId: approval.instrumentId,
      intent: approval.intent as DecisionSubmitPayload['intent'],
      targetSize: approval.targetSize,
      rationaleSummary: approval.rationaleSummary,
      ...(approval.limitPrice != null ? { limitPrice: approval.limitPrice } : {}),
      ...(approval.stopLoss != null ? { stopLoss: approval.stopLoss } : {}),
      ...(approval.takeProfit != null ? { takeProfit: approval.takeProfit } : {}),
      ...(approval.confidence != null ? { confidence: Number(approval.confidence) } : {}),
      ...(approval.contextHash != null ? { contextHash: approval.contextHash } : {}),
    };
    // Thread the snapshot venue account (resolved off the connection grant at
    // approval-creation time and stored on the approval row) in as a payload arg
    // so the boundary resolves deterministically — matching the direct path.
    const boundaryPayload = buildSubmitDecisionPayload(decisionPayload, approval.venueAccountId);

    try {
      // Subject stays ownerId + actor ONLY (D2). The venue account rides in the
      // payload (threaded above from the approval snapshot), not the subject.
      const result = await this.deps.sideEffectBoundary.invokeAndAwait({
        toolName: 'submit_decision',
        payload: boundaryPayload,
        subject: {
          ownerId: userId,
          actor: { type: approval.actorType as ActorType, id: approval.actorId },
        },
        deadlineMs: this.boundaryDeadlineMs,
      });
      const outcome = mapBoundaryResultToDecisionOutcome(result);
      const planId = outcome.planId ?? null;

      if (outcome.status === 'accepted') {
        await this.deps.approvalRepo.recordExecutionResult(
          approvalId, decisionId, planId, 'accepted',
        );

        // Emit the accepted event for the activity feed. Best-effort — a publish
        // failure must not flip the recorded execution outcome. Only
        // `decision.accepted` is emitted here: the boundary owns the plan /
        // execution lifecycle and does not return order/fill/position detail on
        // the synchronous reply, so plan-status / execution-result events (which
        // require that detail) are emitted by Traderton's own event stream — not
        // fabricated here (mirrors the L3c direct-decision path).
        try {
          await this.deps.eventPublisher.emitDecisionAccepted(effectiveBotId, {
            decisionId,
            acceptedAt: new Date().toISOString(),
            normalizedDecision: {
              id: decisionId,
              instrumentId: approval.instrumentId,
              intent: approval.intent,
              targetSize: approval.targetSize,
              limitPrice: approval.limitPrice ?? undefined,
              actorType: approval.actorType,
              actorId: approval.actorId,
            },
          });
        } catch (err) {
          logger.error({ approvalId, decisionId, err }, 'Failed to publish approval execution events');
        }

        return {
          kind: 'executed',
          status: 'accepted',
          decisionId,
          planId,
          message: 'Trade executed successfully',
        };
      }

      if (outcome.status === 'rejected') {
        await this.deps.approvalRepo.recordExecutionResult(
          approvalId, decisionId, planId, 'rejected',
        );
        return {
          kind: 'executed',
          status: 'rejected',
          decisionId,
          planId,
          message: outcome.message ?? 'Decision rejected by the trading boundary',
        };
      }

      // status === 'error' — in_progress after deadline, or transport error.
      await this.deps.approvalRepo.recordExecutionResult(
        approvalId, decisionId, planId, 'error',
      );
      return {
        kind: 'executed',
        status: 'error',
        decisionId,
        planId,
        message: outcome.message ?? 'Decision could not be processed by the trading boundary',
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown execution error';
      logger.error({ approvalId, err }, 'Approval execution failed');

      // Record the error WITHOUT changing the status from 'approved'.
      await this.deps.approvalRepo.recordExecutionResult(
        approvalId, decisionId, null, 'error',
      );

      return {
        kind: 'executed',
        status: 'error',
        decisionId,
        planId: null,
        message: errorMsg,
      };
    }
  }

  /**
   * Reject a pending approval.
   * Validates ownership, expiry, and that the approval is still pending.
   */
  async rejectApproval(
    approvalId: string,
    userId: string,
    resolutionSource: string,
  ): Promise<ApprovalResolutionResult> {
    const approval = await this.deps.approvalRepo.findById(approvalId);
    if (!approval) {
      return { kind: 'not_found' };
    }
    if (approval.userId !== userId) {
      return { kind: 'not_owned' };
    }
    if (approval.status !== 'pending') {
      return { kind: 'already_resolved', status: approval.status };
    }
    if (new Date() > new Date(approval.expiresAt)) {
      await this.deps.approvalRepo.updateExpired([approvalId]);
      return { kind: 'expired' };
    }

    await this.deps.approvalRepo.updateStatus(approvalId, 'rejected', {
      resolvedByUserId: userId,
      resolutionSource,
    });

    return { kind: 'rejected' };
  }

  /**
   * Expire all pending approvals past their expiresAt.
   * Called periodically by the worker.
   */
  async expireStaleApprovals(): Promise<number> {
    const expiredRows = await this.deps.approvalRepo.findExpiredPending();
    const expiredIds = expiredRows.map((r) => r.id);
    if (expiredIds.length === 0) return 0;
    await this.deps.approvalRepo.updateExpired(expiredIds);
    logger.info({ count: expiredIds.length }, 'Expired stale approvals');
    return expiredIds.length;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private async recordResolutionAttempt(
    approvalId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    try {
      await this.deps.approvalRepo.recordResolutionAttempt(approvalId, errorCode, errorMessage);
    } catch (err) {
      logger.error({ approvalId, errorCode, err }, 'Failed to record resolution attempt');
    }
  }
}

// ── Result types ──────────────────────────────────────────────────────────

export type ApprovalResolutionResult =
  | { kind: 'not_found' }
  | { kind: 'not_owned' }
  | { kind: 'already_resolved'; status: string }
  | { kind: 'expired' }
  | { kind: 'rejected' }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'executed'; status: 'accepted' | 'rejected' | 'error'; decisionId: string; planId: string | null; message?: string };
