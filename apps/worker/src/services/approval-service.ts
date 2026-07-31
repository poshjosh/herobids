import type { Decision, DecisionId, InstrumentId, VenueAccountId, DecisionIntent, ActorType } from '@herobids/domain';
import { Decimal } from '@herobids/domain';
import type { DecisionApprovalRepository } from '@herobids/db';
import type { DecisionFailureRepository } from '@herobids/db';
import { submitDecisionForExecution, DecisionContextHashMismatchError, validatePerTradeLevels } from '@herobids/engine';
import { isIntakeRejection } from '../execution-actor.js';
import type { DecisionIntakeResolver } from '../agents/agent-decision-handler.js';
import type { InstanceEventPublisher } from '../agents/instance-event-publisher.js';
import { POSITION_GROWING_INTENTS, formatLevelValidationMessage } from '../shared/decision-validation.js';
import { createLogger } from '../logger.js';
import crypto from 'node:crypto';

const logger = createLogger('approval-service');

export interface ApprovalServiceDeps {
  approvalRepo: DecisionApprovalRepository;
  intakeResolver: DecisionIntakeResolver;
  eventPublisher: InstanceEventPublisher;
  decisionFailureRepo?: DecisionFailureRepository;
  agentApprovalsTtlMs: number;
}

export class ApprovalService {
  constructor(private readonly deps: ApprovalServiceDeps) {}

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Execute a pending approval — reconstruct the decision from stored JSONB,
   * run through the normal risk/execution pipeline, and record the outcome.
   *
   * Ownership is validated (userId must match). Expired approvals are rejected.
   * If execution context is unavailable, the error is recorded WITHOUT consuming
   * the approval — the user can fix the issue (start the agent, connect venue)
   * and try again.
   */
  async executeApproval(
    approvalId: string,
    userId: string,
    resolutionSource: string,
    effectiveAgentId: string,
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

    // Resolve execution context for the agent.
    const resolveId = effectiveAgentId;
    const intakeResult = await this.deps.intakeResolver.getIntakeDeps(resolveId, approval.instrumentId);
    if (!intakeResult) {
      const msg = 'No execution context — agent may not be running or has no active trading connection. Start the agent and try again.';
      await this.recordResolutionAttempt(approvalId, 'instance_not_running', msg);
      return { kind: 'error', code: 'instance_not_running', message: msg };
    }
    if (isIntakeRejection(intakeResult)) {
      await this.recordResolutionAttempt(approvalId, intakeResult.code, intakeResult.message);
      return { kind: 'error', code: intakeResult.code, message: intakeResult.message };
    }
    const intakeDeps = intakeResult;

    const context = await this.deps.intakeResolver.getDecisionContext(resolveId, approval.instrumentId);
    if (!context) {
      const msg = 'No decision context available — actor may still be initializing or mark price unavailable';
      await this.recordResolutionAttempt(approvalId, 'no_context', msg);
      return { kind: 'error', code: 'no_context', message: msg };
    }

    const position = await this.deps.intakeResolver.getPosition(resolveId, approval.instrumentId);
    if (!position) {
      const msg = 'Position state not available';
      await this.recordResolutionAttempt(approvalId, 'no_position_state', msg);
      return { kind: 'error', code: 'no_position_state', message: msg };
    }

    // Build the Decision from the stored proposal
    const decision: Decision = {
      id: crypto.randomUUID() as DecisionId,
      venueAccountId: intakeDeps.venueAccountId as VenueAccountId,
      instrumentId: approval.instrumentId as InstrumentId,
      intent: approval.intent as DecisionIntent,
      targetSize: new Decimal(approval.targetSize),
      limitPrice: approval.limitPrice ? new Decimal(approval.limitPrice) : undefined,
      stopLoss: approval.stopLoss ? new Decimal(approval.stopLoss) : undefined,
      takeProfit: approval.takeProfit ? new Decimal(approval.takeProfit) : undefined,
      timestamp: approval.createdAt.toISOString(),
      contextHash: approval.contextHash ?? undefined,
      metadata: {
        rationaleSummary: approval.rationaleSummary,
        confidence: approval.confidence ? Number(approval.confidence) : null,
        approvalId,
        approvalResolutionSource: resolutionSource,
      },
      actorType: approval.actorType as ActorType,
      actorId: approval.actorId,
    };

    // Per-trade level validation
    if (POSITION_GROWING_INTENTS.has(decision.intent) && (decision.stopLoss || decision.takeProfit)) {
      let validationSide: 'long' | 'short' | null = null;
      if (decision.intent === 'go_long') {
        validationSide = 'long';
      } else if (decision.intent === 'go_short') {
        validationSide = 'short';
      } else if (decision.intent === 'increase') {
        if (position.side === 'long' || position.side === 'short') {
          validationSide = position.side;
        }
      }

      if (validationSide) {
        const markPriceStr = context.referenceMark.price;
        let markPrice: Decimal | undefined;
        if (markPriceStr) {
          try {
            markPrice = new Decimal(markPriceStr);
          } catch {
            logger.warn({ approvalId, markPriceStr }, 'Skipping per-trade level validation — malformed mark price');
          }
        }

        if (markPrice) {
          const validationError = validatePerTradeLevels({
            side: validationSide,
            markPrice,
            stopLoss: decision.stopLoss,
            takeProfit: decision.takeProfit,
          });

          if (validationError) {
            const message = formatLevelValidationMessage(validationError);
            const code = `level.${validationError.reason}`;
            await this.recordResolutionAttempt(approvalId, code, message);
            return { kind: 'error', code, message };
          }
        }
      }
    }

    // Transition status to 'approved' at this point — execution context is
    // valid and risk validation is about to proceed. This is the single authority
    // for the pending → approved transition. If the process crashes after this
    // point, the approval is 'approved' with executionStatus reflecting the outcome.
    await this.deps.approvalRepo.updateStatus(approvalId, 'approved', {
      resolvedByUserId: userId,
      resolutionSource,
    });

    // Submit through the shared engine pipeline.
    try {
      const result = await submitDecisionForExecution(decision, context, position, intakeDeps);

      // Record execution outcome
      const planId = result.plan?.id ?? null;
      if (result.preExecutionRejection) {
        await this.deps.approvalRepo.recordExecutionResult(
          approvalId, decision.id, planId, 'rejected',
        );
        return {
          kind: 'executed',
          status: 'rejected',
          decisionId: decision.id,
          planId,
          message: result.preExecutionRejection.message,
        };
      }

      if (result.riskRejected) {
        await this.deps.approvalRepo.recordExecutionResult(
          approvalId, decision.id, planId, 'rejected',
        );
        return {
          kind: 'executed',
          status: 'rejected',
          decisionId: decision.id,
          planId,
          message: result.riskError?.message ?? 'Decision rejected by risk gate',
        };
      }

      if (result.executionFailed) {
        await this.deps.approvalRepo.recordExecutionResult(
          approvalId, decision.id, planId, 'error',
        );
        return {
          kind: 'executed',
          status: 'error',
          decisionId: decision.id,
          planId,
          message: result.executionError?.message ?? 'Execution failed',
        };
      }

      // Success
      const execStatus = 'accepted';
      await this.deps.approvalRepo.recordExecutionResult(
        approvalId, decision.id, planId, execStatus,
      );

      // Emit events for activity feed
      try {
        await this.deps.eventPublisher.emitDecisionAccepted(effectiveBotId, {
          decisionId: decision.id,
          acceptedAt: new Date().toISOString(),
          normalizedDecision: {
            id: decision.id,
            instrumentId: decision.instrumentId,
            intent: decision.intent,
            targetSize: decision.targetSize.toString(),
            limitPrice: decision.limitPrice?.toString(),
            actorType: decision.actorType,
            actorId: decision.actorId,
          },
        });

        if (result.plan) {
          await this.deps.eventPublisher.emitPlanStatus(effectiveBotId, {
            decisionId: decision.id,
            planId: result.plan.id,
            status: result.plan.status as 'created' | 'executing' | 'completed' | 'failed',
            action: result.plan.action,
            venue: result.plan.venue,
            symbol: result.plan.symbol,
            orderCount: result.plan.orders.length,
          });
        }

        if (result.executionResult) {
          await this.deps.eventPublisher.emitExecutionResult(effectiveBotId, {
            decisionId: decision.id,
            planId: result.plan?.id ?? '',
            orders: result.executionResult.orders.map((o) => ({
              id: o.id,
              side: o.side,
              type: o.type,
              quantity: o.quantity.toString(),
              status: o.status,
            })),
            fills: result.executionResult.fills.map((f) => ({
              side: f.side,
              quantity: f.quantity.toString(),
              price: f.price.toString(),
            })),
            positionAfter: {
              side: result.position.side,
              size: result.position.size.toString(),
              entryPrice: result.position.entryPrice.toString(),
            },
            executionFailed: false,
            completedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        logger.error({ approvalId, decisionId: decision.id, err }, 'Failed to publish approval execution events');
      }

      return {
        kind: 'executed',
        status: 'accepted',
        decisionId: decision.id,
        planId,
        message: 'Trade executed successfully',
      };
    } catch (err) {
      const errorMsg = err instanceof DecisionContextHashMismatchError
        ? 'Decision context hash does not match the server-resolved context'
        : err instanceof Error ? err.message : 'Unknown execution error';

      logger.error({ approvalId, err }, 'Approval execution failed');

      // Record the error WITHOUT changing the status from 'approved'.
      // The approval was already marked approved before execution.
      // If execution fails, the executionStatus reflects the error but
      // the approval stays 'approved' (not consumed — already resolved by user).
      await this.deps.approvalRepo.recordExecutionResult(
        approvalId, decision.id, null, 'error',
      );

      return {
        kind: 'executed',
        status: 'error',
        decisionId: decision.id,
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
