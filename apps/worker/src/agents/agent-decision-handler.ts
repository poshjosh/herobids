import type { Decision, VenueAccountId, DecisionId, InstrumentId } from '@herobids/domain';
import type { MessageEnvelope, DecisionSubmitPayload } from '@herobids/domain';
import { Decimal } from '@herobids/domain';
import type { AgentRepository } from '@herobids/db';
import type { DecisionFailureRepository } from '@herobids/db';
import { submitDecisionForExecution, DecisionContextHashMismatchError } from '@herobids/engine';
import type { DecisionIntakeDeps, DecisionContext, PositionState } from '@herobids/engine';
import type { IntakeResult } from '../execution-actor.js';
import { isIntakeRejection } from '../execution-actor.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import pino from 'pino';

const logger = pino({ name: 'agent-decision-handler' });

/**
 * Resolves the execution context needed by the decision intake pipeline.
 * Keyed by actorId (botId or agentId). Methods may be sync or async.
 */
export interface DecisionIntakeResolver {
  getIntakeDeps(instanceId: string, instrumentId?: string): IntakeResult | Promise<IntakeResult>;
  getDecisionContext(instanceId: string, instrumentId?: string): DecisionContext | undefined | Promise<DecisionContext | undefined>;
  getPosition(instanceId: string, instrumentId?: string): PositionState | undefined | Promise<PositionState | undefined>;
  recordExecutionOutcome?(instanceId: string, success: boolean): void;
}

/**
 * AgentDecisionHandler — translates `agent.decision.submit` into the engine decision-ingestion path.
 */
export class AgentDecisionHandler {
  constructor(
    private readonly agentRepo: AgentRepository,
    private readonly intakeResolver: DecisionIntakeResolver,
    private readonly eventPublisher: InstanceEventPublisher,
    private readonly decisionFailureRepo?: DecisionFailureRepository,
  ) {}

  private recordFailure(input: {
    actorType: string;
    actorId: string;
    decisionId?: string;
    instrumentId?: string;
    venue?: string;
    venueAccountId?: string;
    failureCode: string;
    failureMessage: string;
    failureClass: 'rejection' | 'error';
    retryable: boolean;
    details?: Record<string, unknown> | null;
  }): void {
    if (!this.decisionFailureRepo) return;
    this.decisionFailureRepo.insert({
      actorType: input.actorType,
      actorId: input.actorId,
      decisionId: input.decisionId,
      instrumentId: input.instrumentId,
      venue: input.venue,
      venueAccountId: input.venueAccountId,
      failureCode: input.failureCode,
      failureMessage: input.failureMessage,
      failureClass: input.failureClass,
      retryable: input.retryable,
      details: input.details,
    }).catch((err) => {
      logger.error({ err, failureCode: input.failureCode }, 'Failed to persist decision failure');
    });
  }

  async handleDecisionSubmit(envelope: MessageEnvelope, payload: DecisionSubmitPayload): Promise<void> {
    const { agentId, botId, initiatorId, initiatorType, tradingInstanceId } = envelope;
    const effectiveAgentId = agentId ?? initiatorId;
    const effectiveBotId = tradingInstanceId ?? botId ?? effectiveAgentId;
    const resolveId = effectiveAgentId;

    // 1. Verify agent is not paused.
    // A missing agents row is NOT treated as paused — it likely means the agent was
    // launched directly (e.g. via docker run) without going through the API provisioning
    // flow, or the agents table was transiently truncated while the container kept
    // running. The active-session check below is the real liveness gate.
    const agent = await this.agentRepo.getAgent(effectiveAgentId);
    if (agent && (agent.status === 'paused' || agent.status === 'stopped')) {
      const msg = `Agent is ${agent.status} — cannot accept decisions`;
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'agent_paused',
        message: msg,
        retryable: false,
      });
      this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: 'agent_paused', failureMessage: msg, failureClass: 'rejection', retryable: false });
      return;
    }

    // 2. Verify the submitting runtime owns the current active session.
    // Defense-in-depth: also checked at broker boundary (processInbound step 3).
    // This prevents superseded containers from trading after a restart/relink.
    const runtimeSessionId = envelope.correlationId;
    const isActiveSession = await this.agentRepo.isActiveSession(effectiveAgentId, runtimeSessionId);
    if (!isActiveSession) {
      const msg = 'Decision rejected — runtime session is no longer the active session';
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'stale_session',
        message: msg,
        retryable: false,
      });
      this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: 'stale_session', failureMessage: msg, failureClass: 'rejection', retryable: false });
      return;
    }

    // 3. Resolve execution deps — try bot registry first, then agent grants
    const intakeResult = await this.intakeResolver.getIntakeDeps(resolveId, payload.instrumentId);
    if (!intakeResult) {
      const msg = 'No execution context — ensure the bot is active or the agent has an active trading grant';
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'instance_not_running',
        message: msg,
        retryable: true,
      });
      this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: 'instance_not_running', failureMessage: msg, failureClass: 'rejection', retryable: true });
      return;
    }
    if (isIntakeRejection(intakeResult)) {
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: intakeResult.code,
        message: intakeResult.message,
        retryable: intakeResult.retryable,
      });
      this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: intakeResult.code, failureMessage: intakeResult.message, failureClass: 'rejection', retryable: intakeResult.retryable });
      return;
    }
    const intakeDeps = intakeResult;

    // Instrument mismatch check — skip for agents (multi-symbol)
    if (intakeDeps.actorType !== 'agent' && payload.instrumentId !== intakeDeps.symbol) {
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

    const context = await this.intakeResolver.getDecisionContext(resolveId, payload.instrumentId);
    if (!context) {
      const msg = 'No decision context available — bot may still be initializing or mark price unavailable';
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'no_context',
        message: msg,
        retryable: true,
      });
      this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: 'no_context', failureMessage: msg, failureClass: 'rejection', retryable: true });
      return;
    }

    const position = await this.intakeResolver.getPosition(resolveId, payload.instrumentId);
    if (!position) {
      const msg = 'Position state not available';
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'no_position_state',
        message: msg,
        retryable: true,
      });
      this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: 'no_position_state', failureMessage: msg, failureClass: 'rejection', retryable: true });
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

      // Track execution outcome for circuit breaker
      if (result.executionFailed) {
        this.intakeResolver.recordExecutionOutcome?.(resolveId, false);
      } else if (result.executionResult) {
        this.intakeResolver.recordExecutionOutcome?.(resolveId, true);
      }

      // Handle pre-execution rejection (e.g. swap token safety)
      if (result.preExecutionRejection) {
        await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
          decisionId: payload.decisionId,
          code: result.preExecutionRejection.code,
          message: result.preExecutionRejection.message,
          retryable: result.preExecutionRejection.retryable,
          details: result.preExecutionRejection.details,
        });
        this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, venueAccountId: intakeDeps.venueAccountId, failureCode: result.preExecutionRejection.code, failureMessage: result.preExecutionRejection.message, failureClass: 'rejection', retryable: result.preExecutionRejection.retryable, details: (result.preExecutionRejection.details as Record<string, unknown> | undefined) ?? null });
        return;
      }

      try {
        if (result.riskRejected) {
          const riskCode = result.riskError?.code ?? 'risk.rejected';
          const riskMsg = result.riskError?.message ?? 'Decision rejected by risk gate';
          await this.eventPublisher.emitGuardrailTriggered(effectiveBotId, {
            scope: 'risk_gate',
            code: riskCode,
            message: riskMsg,
            decisionId: payload.decisionId,
            details: result.riskError?.context,
          });
          this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, venueAccountId: intakeDeps.venueAccountId, failureCode: riskCode, failureMessage: riskMsg, failureClass: 'rejection', retryable: false });
          return;
        }

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

        // 8. Emit execution result
        if (result.executionFailed) {
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
        this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: 'context_hash_mismatch', failureMessage: 'Decision context hash does not match the server-resolved context', failureClass: 'rejection', retryable: false });
        return;
      }

      logger.error({ decisionId: payload.decisionId, err }, 'Decision execution failed');
      const errMsg = err instanceof Error ? err.message : 'Unknown execution error';
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'execution_error',
        message: errMsg,
        retryable: false,
      });
      this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: 'execution_error', failureMessage: errMsg, failureClass: 'error', retryable: false });
    }
  }
}
