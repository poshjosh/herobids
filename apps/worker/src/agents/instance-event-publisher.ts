import type { Redis } from 'ioredis';
import type {
  DecisionAcceptedPayload,
  DecisionRejectedPayload,
  PlanStatusPayload,
  ExecutionResultPayload,
  GuardrailTriggeredPayload,
  ReconciliationNoticePayload,
  InstanceStatusPayload,
  ContextSnapshotPayload,
} from '@herobids/domain';
import { INSTANCE_MESSAGE_TYPES } from '@herobids/domain';
import crypto from 'node:crypto';
import pino from 'pino';

const logger = pino({ name: 'instance-event-publisher' });

/**
 * InstanceEventPublisher — emits instance→agent protocol messages onto Redis Streams.
 *
 * All outbound messages follow the canonical envelope format and are published
 * to per-instance Redis streams for durable replay.
 */
export class InstanceEventPublisher {
  constructor(private readonly redis: Redis) {}

  async emitContextSnapshot(tradingInstanceId: string, payload: ContextSnapshotPayload): Promise<void> {
    await this.publish(tradingInstanceId, INSTANCE_MESSAGE_TYPES.CONTEXT_SNAPSHOT, payload);
  }

  async emitDecisionAccepted(tradingInstanceId: string, payload: DecisionAcceptedPayload): Promise<void> {
    await this.publish(tradingInstanceId, INSTANCE_MESSAGE_TYPES.DECISION_ACCEPTED, payload);
  }

  async emitDecisionRejected(tradingInstanceId: string, payload: DecisionRejectedPayload): Promise<void> {
    await this.publish(tradingInstanceId, INSTANCE_MESSAGE_TYPES.DECISION_REJECTED, payload);
  }

  async emitPlanStatus(tradingInstanceId: string, payload: PlanStatusPayload): Promise<void> {
    await this.publish(tradingInstanceId, INSTANCE_MESSAGE_TYPES.PLAN_STATUS, payload);
  }

  async emitExecutionResult(tradingInstanceId: string, payload: ExecutionResultPayload): Promise<void> {
    await this.publish(tradingInstanceId, INSTANCE_MESSAGE_TYPES.EXECUTION_RESULT, payload);
  }

  async emitGuardrailTriggered(tradingInstanceId: string, payload: GuardrailTriggeredPayload): Promise<void> {
    await this.publish(tradingInstanceId, INSTANCE_MESSAGE_TYPES.GUARDRAIL_TRIGGERED, payload);
  }

  async emitReconciliationNotice(tradingInstanceId: string, payload: ReconciliationNoticePayload): Promise<void> {
    await this.publish(tradingInstanceId, INSTANCE_MESSAGE_TYPES.RECONCILIATION_NOTICE, payload);
  }

  async emitInstanceStatus(tradingInstanceId: string, payload: InstanceStatusPayload): Promise<void> {
    await this.publish(tradingInstanceId, INSTANCE_MESSAGE_TYPES.STATUS, payload);
  }

  /**
   * Publish a protocol message to the instance's outbound Redis Stream.
   * Stream key: `agent:outbound:{tradingInstanceId}`
   */
  private async publish(tradingInstanceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    const streamKey = `agent:outbound:${tradingInstanceId}`;
    const envelope = {
      schemaVersion: 'v1',
      messageId: crypto.randomUUID(),
      correlationId: (payload as { decisionId?: string }).decisionId ?? crypto.randomUUID(),
      initiatorType: 'system',
      initiatorId: tradingInstanceId,
      tradingInstanceId,
      type,
      createdAt: new Date().toISOString(),
      payload,
    };

    try {
      await this.redis.xadd(
        streamKey,
        '*',
        'envelope',
        JSON.stringify(envelope),
      );
    } catch (err) {
      logger.error({ streamKey, type, err }, 'Failed to publish to Redis Stream');
    }
  }
}
