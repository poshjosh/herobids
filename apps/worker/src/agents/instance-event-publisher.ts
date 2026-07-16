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
  AgentWakePayload,
} from '@herobids/domain';
import { INSTANCE_MESSAGE_TYPES, MARKET_MONITOR_MESSAGE_TYPES, AGENT_STREAM_MAXLEN } from '@herobids/domain';
import type { TechnicalScanState } from '../runtime-composition.js';
import crypto from 'node:crypto';
import { createLogger } from '../logger.js';

const logger = createLogger('instance-event-publisher');

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

  async emitAgentWake(agentId: string, payload: AgentWakePayload): Promise<void> {
    await this.publish(agentId, MARKET_MONITOR_MESSAGE_TYPES.AGENT_WAKE, payload);
  }

  async emitTechnicalScanCompleted(agentId: string, payload: TechnicalScanState): Promise<void> {
    await this.publish(agentId, 'agent.technical.scan_completed', payload as unknown as Record<string, unknown>);
  }

  async emitJournalEvent(agentId: string, payload: { journalType: string; timestamp?: string; detail?: string }): Promise<void> {
    await this.publish(agentId, INSTANCE_MESSAGE_TYPES.JOURNAL_EVENT, payload);
  }

  /**
   * Publish a synchronous decision reply to a Redis list so the agent's
   * submit_decision tool can BLPOP it and get immediate feedback.
   * Errors propagate to the caller — it is the caller's responsibility to log and continue.
   */
  async publishDecisionReply(decisionId: string, reply: { status: 'accepted' | 'rejected' | 'error'; code?: string; message?: string; planId?: string }): Promise<void> {
    const replyKey = `agent:decision:reply:${decisionId}`;
    await this.redis.lpush(replyKey, JSON.stringify(reply));
    // Expire after 60s to prevent leaking keys if the agent never reads
    await this.redis.expire(replyKey, 60);
  }

  /**
   * Write the actor's current equity snapshot to a Redis hash so the agent's
   * get_risk_limits tool can read live drawdown data. Written after every
   * decision (accepted or rejected). The value is at most one decision stale.
   * Key: equity:{actorId}
   */
  async publishEquitySnapshot(actorId: string, snapshot: {
    startingCapital?: string;
    realizedPnl: string;
    unrealizedPnl: string;
    peakEquity?: string;
    currentDrawdown: string;
    equity: string;
    timestamp: string;
  }): Promise<void> {
    try {
      const key = `equity:${actorId}`;
      await this.redis.hset(key, 'startingCapital', snapshot.startingCapital ?? '0');
      await this.redis.hset(key, 'realizedPnl', snapshot.realizedPnl);
      await this.redis.hset(key, 'unrealizedPnl', snapshot.unrealizedPnl);
      if (snapshot.peakEquity) await this.redis.hset(key, 'peakEquity', snapshot.peakEquity);
      await this.redis.hset(key, 'currentDrawdown', snapshot.currentDrawdown);
      await this.redis.hset(key, 'equity', snapshot.equity);
      await this.redis.hset(key, 'timestamp', snapshot.timestamp);
      // Expire after 1 hour — if the agent stops, stale equity data should not persist
      await this.redis.expire(key, 3600);
    } catch (err) {
      logger.warn({ actorId, err }, 'Failed to publish equity snapshot — agent drawdown visibility may be stale');
    }
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
        'MAXLEN', '~', AGENT_STREAM_MAXLEN,
        '*',
        'envelope',
        JSON.stringify(envelope),
      );
    } catch (err) {
      logger.error({ streamKey, type, err }, 'Failed to publish to Redis Stream');
    }
  }
}
