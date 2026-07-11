import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { createLogger } from './logger.js';
import type { PlatformEventEnvelope } from '@herobids/domain';

const logger = createLogger('user-event-publisher');

/**
 * UserEventPublisher — publishes real-time UI events to per-user Redis pub/sub channels.
 *
 * Channel naming: `events:<userId>`
 *
 * Every event is wrapped in the shared PlatformEventEnvelope so the WebSocket
 * stream has one canonical message shape across all capability families.
 *
 * This is explicitly NOT the canonical agent protocol path (which uses Redis Streams
 * at `agent:outbound:<agentId>`). These events are low-value, non-durable, and
 * intended for real-time UI updates via the WebSocket event stream at /events.
 */
export class UserEventPublisher {
  constructor(private readonly redis: Redis) {}

  async publish(userId: string, event: UserEvent): Promise<void> {
    const channel = `events:${userId}`;
    const envelope: PlatformEventEnvelope = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      actorType: 'platform',
      actorId: userId,
      eventType: event.type,
      payload: event as unknown as Record<string, unknown>,
    };
    const message = JSON.stringify(envelope);
    try {
      await this.redis.publish(channel, message);
    } catch (err) {
      logger.error({ channel, type: event.type, err }, 'Failed to publish user event');
    }
  }

  async publishBotStatus(userId: string, botId: string, status: string): Promise<void> {
    await this.publish(userId, { type: 'bot.status', botId, status, timestamp: new Date().toISOString() });
  }

  async publishAgentStatus(userId: string, agentId: string, status: string): Promise<void> {
    await this.publish(userId, { type: 'agent.status', agentId, status, timestamp: new Date().toISOString() });
  }

  async publishOrderFilled(userId: string, botId: string, payload: {
    orderId: string; symbol: string; side: string; quantity: string; price: string; fee?: string;
  }): Promise<void> {
    await this.publish(userId, { type: 'order.filled', botId, ...payload, timestamp: new Date().toISOString() });
  }

  async publishDecisionAccepted(userId: string, agentId: string, decisionId: string): Promise<void> {
    await this.publish(userId, { type: 'decision.accepted', agentId, decisionId, timestamp: new Date().toISOString() });
  }

  async publishDecisionRejected(userId: string, agentId: string, decisionId: string, reason: string): Promise<void> {
    await this.publish(userId, { type: 'decision.rejected', agentId, decisionId, reason, timestamp: new Date().toISOString() });
  }

  async publishRiskGuardrail(userId: string, botId: string, rule: string, detail: string): Promise<void> {
    await this.publish(userId, { type: 'risk.guardrail', botId, rule, detail, timestamp: new Date().toISOString() });
  }

  async publishPlatformAlert(userId: string, message: string, severity: 'info' | 'warn' | 'critical'): Promise<void> {
    await this.publish(userId, { type: 'platform.alert', message, severity, timestamp: new Date().toISOString() });
  }
}

export type UserEvent =
  | { type: 'bot.status'; botId: string; status: string; timestamp: string }
  | { type: 'agent.status'; agentId: string; status: string; timestamp: string }
  | { type: 'order.filled'; botId: string; orderId: string; symbol: string; side: string; quantity: string; price: string; fee?: string; timestamp: string }
  | { type: 'decision.accepted'; agentId: string; decisionId: string; timestamp: string }
  | { type: 'decision.rejected'; agentId: string; decisionId: string; reason: string; timestamp: string }
  | { type: 'risk.guardrail'; botId: string; rule: string; detail: string; timestamp: string }
  | { type: 'platform.alert'; message: string; severity: 'info' | 'warn' | 'critical'; timestamp: string };
