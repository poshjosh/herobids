import type { Decision, TradingInstanceId, DecisionId, InstrumentId } from '@herobids/domain';
import type { MessageEnvelope, DecisionSubmitPayload } from '@herobids/domain';
import { Decimal } from '@herobids/domain';
import type { AgentRepository } from '@herobids/db';
import { submitDecisionForExecution, DecisionContextHashMismatchError } from '@herobids/engine';
import type { DecisionIntakeDeps, DecisionContext, PositionState } from '@herobids/engine';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import pino from 'pino';

const logger = pino({ name: 'agent-decision-handler' });

/**
 * Resolves the execution context needed by the decision intake pipeline.
 * This is provided by the trading actor / instance runtime.
 */
export interface DecisionIntakeResolver {
  getIntakeDeps(tradingInstanceId: string): DecisionIntakeDeps | undefined;
  getDecisionContext(tradingInstanceId: string): DecisionContext | undefined;
  getPosition(tradingInstanceId: string): PositionState | undefined;
}

/**
 * AgentDecisionHandler — translates `agent.decision.submit` into the engine decision-ingestion path.
 *
 * Validates authorization, resolves context, builds a Decision, and submits it through
 * the shared `submitDecisionForExecution` pipeline.
 */
export class AgentDecisionHandler {
  constructor(
    private readonly agentRepo: AgentRepository,
    private readonly intakeResolver: DecisionIntakeResolver,
    private readonly eventPublisher: InstanceEventPublisher,
  ) {}

  async handleDecisionSubmit(envelope: MessageEnvelope, payload: DecisionSubmitPayload): Promise<void> {
    const { tradingInstanceId, initiatorId, initiatorType } = envelope;

    // 1. Verify agent has active link to this instance
    const link = await this.agentRepo.getActiveLink(initiatorId);
    if (!link || link.tradingInstanceId !== tradingInstanceId) {
      logger.warn({ agentId: initiatorId, tradingInstanceId }, 'No active link for decision');
      await this.eventPublisher.emitDecisionRejected(tradingInstanceId, {
        decisionId: payload.decisionId,
        code: 'unauthorized_link',
        message: 'Agent does not have an active link to this trading instance',
        retryable: false,
      });
      return;
    }

    // 2. Verify agent is not paused
    const agent = await this.agentRepo.getAgent(initiatorId);
    if (!agent || agent.status === 'paused' || agent.status === 'stopped') {
      await this.eventPublisher.emitDecisionRejected(tradingInstanceId, {
        decisionId: payload.decisionId,
        code: 'agent_paused',
        message: `Agent is ${agent?.status ?? 'unknown'} — cannot accept decisions`,
        retryable: false,
      });
      return;
    }

    // 3. Verify a running session exists for this specific agent-instance pair.
    // starting/unhealthy sessions are not trusted — the runtime has not yet
    // proven liveness (starting) or has missed heartbeats (unhealthy).
    const session = await this.agentRepo.getSessionForAgentAndInstance(initiatorId, tradingInstanceId);
    if (!session || session.status !== 'running') {
      await this.eventPublisher.emitDecisionRejected(tradingInstanceId, {
        decisionId: payload.decisionId,
        code: 'no_active_session',
        message: 'No running runtime session',
        retryable: true,
      });
      return;
    }

    // 4. Resolve execution deps from the running instance
    const intakeDeps = this.intakeResolver.getIntakeDeps(tradingInstanceId);
    if (!intakeDeps) {
      await this.eventPublisher.emitDecisionRejected(tradingInstanceId, {
        decisionId: payload.decisionId,
        code: 'instance_not_running',
        message: 'Trading instance is not currently active',
        retryable: true,
      });
      return;
    }

    if (payload.instrumentId !== intakeDeps.symbol) {
      await this.eventPublisher.emitDecisionRejected(tradingInstanceId, {
        decisionId: payload.decisionId,
        code: 'instrument_mismatch',
        message: 'Decision instrument does not match the linked trading instance symbol',
        retryable: false,
        details: {
          expectedInstrumentId: intakeDeps.symbol,
          receivedInstrumentId: payload.instrumentId,
        },
      });
      return;
    }

    const context = this.intakeResolver.getDecisionContext(tradingInstanceId);
    if (!context) {
      await this.eventPublisher.emitDecisionRejected(tradingInstanceId, {
        decisionId: payload.decisionId,
        code: 'no_context',
        message: 'No decision context available — instance may still be initializing',
        retryable: true,
      });
      return;
    }

    const position = this.intakeResolver.getPosition(tradingInstanceId);
    if (!position) {
      await this.eventPublisher.emitDecisionRejected(tradingInstanceId, {
        decisionId: payload.decisionId,
        code: 'no_position_state',
        message: 'Position state not available',
        retryable: true,
      });
      return;
    }

    // 5. Build the Decision from the agent payload
    const decision: Decision = {
      id: payload.decisionId as DecisionId,
      tradingInstanceId: tradingInstanceId as TradingInstanceId,
      instrumentId: payload.instrumentId as InstrumentId,
      intent: payload.intent,
      targetSize: new Decimal(payload.targetSize),
      limitPrice: payload.limitPrice ? new Decimal(payload.limitPrice) : undefined,
      timestamp: envelope.createdAt,
      contextHash: payload.contextHash,
      metadata: {
        ...payload.metadata,
        rationaleSummary: payload.rationaleSummary,
        confidence: payload.confidence,
      },
      actorType: initiatorType,
      actorId: initiatorId,
    };

    // 6. Submit through the shared decision intake pipeline.
    // The handler forwards the exact context it resolved for the agent so the
    // payload hash and server hash are computed over the same data.
    // Acceptance is emitted after successful intake so we never send accepted
    // followed by rejected for the same decision (e.g. on hash mismatch).
    try {
      const result = await submitDecisionForExecution(decision, context, position, intakeDeps);

      try {
        // 7. Emit accepted — deferred until hash and risk checks pass.
        await this.eventPublisher.emitDecisionAccepted(tradingInstanceId, {
          decisionId: payload.decisionId,
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

        // 8. Emit plan status
        if (result.plan) {
          await this.eventPublisher.emitPlanStatus(tradingInstanceId, {
            decisionId: payload.decisionId,
            planId: result.plan.id,
            status: result.plan.status as 'created' | 'executing' | 'completed' | 'failed',
            action: result.plan.action,
            venue: result.plan.venue,
            symbol: result.plan.symbol,
            orderCount: result.plan.orders.length,
          });
        }

        // 9. Emit execution result or guardrail
        if (result.riskRejected) {
          await this.eventPublisher.emitGuardrailTriggered(tradingInstanceId, {
            scope: 'risk_gate',
            code: 'risk.rejected',
            message: 'Decision rejected by risk gate',
            decisionId: payload.decisionId,
          });
        } else if (result.executionFailed) {
          await this.eventPublisher.emitExecutionResult(tradingInstanceId, {
            decisionId: payload.decisionId,
            planId: result.plan?.id ?? '',
            orders: [],
            fills: [],
            positionAfter: {
              side: result.position.side,
              size: result.position.size.toString(),
              entryPrice: result.position.entryPrice.toString(),
            },
            executionFailed: true,
            completedAt: new Date().toISOString(),
          });
        } else if (result.executionResult) {
          await this.eventPublisher.emitExecutionResult(tradingInstanceId, {
            decisionId: payload.decisionId,
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
      } catch (publishErr) {
        logger.error({ decisionId: payload.decisionId, err: publishErr }, 'Failed to publish decision outcome');
      }
    } catch (err) {
      if (err instanceof DecisionContextHashMismatchError) {
        await this.eventPublisher.emitDecisionRejected(tradingInstanceId, {
          decisionId: payload.decisionId,
          code: 'context_hash_mismatch',
          message: 'Decision context hash does not match the server-resolved context',
          retryable: false,
          details: {
            expectedHash: err.expectedHash,
            suppliedHash: err.suppliedHash,
          },
        });
        return;
      }

      logger.error({ decisionId: payload.decisionId, err }, 'Decision execution failed');
      await this.eventPublisher.emitDecisionRejected(tradingInstanceId, {
        decisionId: payload.decisionId,
        code: 'execution_error',
        message: err instanceof Error ? err.message : 'Unknown execution error',
        retryable: false,
      });
    }
  }
}
