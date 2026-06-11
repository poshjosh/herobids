import type { Decision, VenueAccountId, DecisionId, InstrumentId } from '@herobids/domain';
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
 * Keyed by botId.
 */
export interface DecisionIntakeResolver {
  getIntakeDeps(botId: string): DecisionIntakeDeps | undefined;
  getDecisionContext(botId: string): DecisionContext | undefined;
  getPosition(botId: string): PositionState | undefined;
}

/**
 * AgentDecisionHandler — translates `agent.decision.submit` into the engine decision-ingestion path.
 */
export class AgentDecisionHandler {
  constructor(
    private readonly agentRepo: AgentRepository,
    private readonly intakeResolver: DecisionIntakeResolver,
    private readonly eventPublisher: InstanceEventPublisher,
  ) {}

  async handleDecisionSubmit(envelope: MessageEnvelope, payload: DecisionSubmitPayload): Promise<void> {
    const { agentId, botId, initiatorId, initiatorType, tradingInstanceId } = envelope;
    const effectiveAgentId = agentId ?? initiatorId;
    const effectiveBotId = tradingInstanceId ?? botId ?? effectiveAgentId;
    const resolveId = effectiveBotId;

    // 1. Verify agent is not paused
    const agent = await this.agentRepo.getAgent(effectiveAgentId);
    if (!agent || agent.status === 'paused' || agent.status === 'stopped') {
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'agent_paused',
        message: `Agent is ${agent?.status ?? 'unknown'} — cannot accept decisions`,
        retryable: false,
      });
      return;
    }

    // 2. Verify a running session exists
    const session = await this.agentRepo.getSessionForAgentAndInstance(effectiveAgentId, effectiveBotId);
    if (!session || session.status !== 'running') {
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'no_active_session',
        message: 'No running runtime session',
        retryable: true,
      });
      return;
    }

    // 3. Resolve execution deps from the running bot
    const intakeDeps = this.intakeResolver.getIntakeDeps(resolveId);
    if (!intakeDeps) {
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'instance_not_running',
        message: 'Bot is not currently active',
        retryable: true,
      });
      return;
    }

    if (payload.instrumentId !== intakeDeps.symbol) {
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'instrument_mismatch',
        message: 'Decision instrument does not match the bot symbol',
        retryable: false,
        details: {
          expectedInstrumentId: intakeDeps.symbol,
          receivedInstrumentId: payload.instrumentId,
        },
      });
      return;
    }

    const context = this.intakeResolver.getDecisionContext(resolveId);
    if (!context) {
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'no_context',
        message: 'No decision context available — bot may still be initializing',
        retryable: true,
      });
      return;
    }

    const position = this.intakeResolver.getPosition(resolveId);
    if (!position) {
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'no_position_state',
        message: 'Position state not available',
        retryable: true,
      });
      return;
    }

    // 4. Build the Decision from the agent payload
    const decision: Decision = {
      id: payload.decisionId as DecisionId,
      venueAccountId: intakeDeps.venueAccountId as VenueAccountId,
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

    // 5. Submit through the shared decision intake pipeline.
    try {
      const depsWithOverride: DecisionIntakeDeps = payload.safetyOverrideId
        ? { ...intakeDeps, safetyOverrideId: payload.safetyOverrideId }
        : intakeDeps;
      const result = await submitDecisionForExecution(decision, context, position, depsWithOverride);

      // Handle pre-execution rejection (e.g. swap token safety)
      if (result.preExecutionRejection) {
        await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
          decisionId: payload.decisionId,
          code: result.preExecutionRejection.code,
          message: result.preExecutionRejection.message,
          retryable: result.preExecutionRejection.retryable,
          details: result.preExecutionRejection.details,
        });
        return;
      }

      try {
        // 6. Emit accepted — deferred until hash and risk checks pass.
        await this.eventPublisher.emitDecisionAccepted(effectiveBotId, {
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

        // 7. Emit plan status
        if (result.plan) {
          await this.eventPublisher.emitPlanStatus(effectiveBotId, {
            decisionId: payload.decisionId,
            planId: result.plan.id,
            status: result.plan.status as 'created' | 'executing' | 'completed' | 'failed',
            action: result.plan.action,
            venue: result.plan.venue,
            symbol: result.plan.symbol,
            orderCount: result.plan.orders.length,
          });
        }

        // 8. Emit execution result or guardrail
        if (result.riskRejected) {
          await this.eventPublisher.emitGuardrailTriggered(effectiveBotId, {
            scope: 'risk_gate',
            code: 'risk.rejected',
            message: 'Decision rejected by risk gate',
            decisionId: payload.decisionId,
          });
        } else if (result.executionFailed) {
          await this.eventPublisher.emitExecutionResult(effectiveBotId, {
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
          await this.eventPublisher.emitExecutionResult(effectiveBotId, {
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
        await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
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
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'execution_error',
        message: err instanceof Error ? err.message : 'Unknown execution error',
        retryable: false,
      });
    }
  }
}
