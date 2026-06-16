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
  ToolResultPayload,
  MarketWatchTriggeredPayload,
  MarketDiscoveryDetectedPayload,
  MarketRegimeChangedPayload,
  AgentMarketWakePayload,
} from '@herobids/domain';
import { INSTANCE_MESSAGE_TYPES, MARKET_MONITOR_MESSAGE_TYPES } from '@herobids/domain';
import type { TechnicalScanState } from '../runtime-composition.js';
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

  async emitContextSnapshot(agentId: string, payload: ContextSnapshotPayload): Promise<void> {
    await this.publish(agentId, INSTANCE_MESSAGE_TYPES.CONTEXT_SNAPSHOT, payload);
  }

  async emitDecisionAccepted(agentId: string, payload: DecisionAcceptedPayload): Promise<void> {
    await this.publish(agentId, INSTANCE_MESSAGE_TYPES.DECISION_ACCEPTED, payload);
  }

  async emitDecisionRejected(agentId: string, payload: DecisionRejectedPayload): Promise<void> {
    await this.publish(agentId, INSTANCE_MESSAGE_TYPES.DECISION_REJECTED, payload);
  }

  async emitPlanStatus(agentId: string, payload: PlanStatusPayload): Promise<void> {
    await this.publish(agentId, INSTANCE_MESSAGE_TYPES.PLAN_STATUS, payload);
  }

  async emitExecutionResult(agentId: string, payload: ExecutionResultPayload): Promise<void> {
    await this.publish(agentId, INSTANCE_MESSAGE_TYPES.EXECUTION_RESULT, payload);
  }

  async emitGuardrailTriggered(agentId: string, payload: GuardrailTriggeredPayload): Promise<void> {
    await this.publish(agentId, INSTANCE_MESSAGE_TYPES.GUARDRAIL_TRIGGERED, payload);
  }

  async emitReconciliationNotice(agentId: string, payload: ReconciliationNoticePayload): Promise<void> {
    await this.publish(agentId, INSTANCE_MESSAGE_TYPES.RECONCILIATION_NOTICE, payload);
  }

  async emitInstanceStatus(agentId: string, payload: InstanceStatusPayload): Promise<void> {
    await this.publish(agentId, INSTANCE_MESSAGE_TYPES.STATUS, payload);
  }

  async emitToolResult(agentId: string, payload: ToolResultPayload): Promise<void> {
    await this.publish(agentId, INSTANCE_MESSAGE_TYPES.TOOL_RESULT, payload);
  }

  async emitMarketWatchTriggered(agentId: string, payload: MarketWatchTriggeredPayload): Promise<void> {
    await this.publish(agentId, MARKET_MONITOR_MESSAGE_TYPES.WATCH_TRIGGERED, payload);
  }

  async emitMarketDiscoveryDetected(agentId: string, payload: MarketDiscoveryDetectedPayload): Promise<void> {
    await this.publish(agentId, MARKET_MONITOR_MESSAGE_TYPES.DISCOVERY_DETECTED, payload);
  }

  async emitMarketRegimeChanged(agentId: string, payload: MarketRegimeChangedPayload): Promise<void> {
    await this.publish(agentId, MARKET_MONITOR_MESSAGE_TYPES.REGIME_CHANGED, payload);
  }

  async emitAgentMarketWake(agentId: string, payload: AgentMarketWakePayload): Promise<void> {
    await this.publish(agentId, MARKET_MONITOR_MESSAGE_TYPES.AGENT_WAKE, payload);
  }

  async emitTechnicalScanCompleted(agentId: string, payload: TechnicalScanState): Promise<void> {
    await this.publish(agentId, 'agent.technical.scan_completed', payload as unknown as Record<string, unknown>);
  }

  /**
   * Publish a protocol message to the instance's outbound Redis Stream.
   * Stream key: `agent:outbound:{agentId}`
   */
  private async publish(agentId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    const streamKey = `agent:outbound:${agentId}`;
    const envelope = {
      schemaVersion: 'v1',
      messageId: crypto.randomUUID(),
      correlationId: (payload as { decisionId?: string }).decisionId ?? crypto.randomUUID(),
      initiatorType: 'system',
      initiatorId: agentId,
      agentId,
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
