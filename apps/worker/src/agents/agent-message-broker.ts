import type { Redis } from 'ioredis';
import type {
  MessageEnvelope,
  DecisionSubmitPayload,
  HeartbeatPayload,
  ArtifactPublishPayload,
  PauseRequestPayload,
  StopRequestPayload,
  SendMessagePayload,
} from '@herobids/domain';
import {
  MessageEnvelopeSchema,
  MESSAGE_PAYLOAD_SCHEMAS,
  AGENT_MESSAGE_TYPES,
} from '@herobids/domain';
import type { AgentRepository } from '@herobids/db';
import type { TelegramClient } from '../alerting/telegram-client.js';
import type { AgentDecisionHandler } from './agent-decision-handler.js';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import pino from 'pino';

const logger = pino({ name: 'agent-message-broker' });

/** Brokered send_message rate limit: max messages per agent per minute. */
const SEND_MESSAGE_MAX_PER_MINUTE = 10;
/** Max body length enforced server-side (matches domain schema). */
const SEND_MESSAGE_MAX_BODY_LENGTH = 2000;

/**
 * AgentMessageBroker — validates envelopes, enforces capability grants,
 * handles dedupe and correlation, and routes messages to the appropriate handler.
 *
 * This is the platform's inbound message gateway for agent protocol messages.
 */
export class AgentMessageBroker {
  /** Per-agent send_message rate tracking: agentId → { count, windowStart } */
  private readonly sendMessageCounters = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly redis: Redis,
    private readonly agentRepo: AgentRepository,
    private readonly decisionHandler: AgentDecisionHandler,
    private readonly sessionManager: AgentSessionManager,
    private readonly eventPublisher: InstanceEventPublisher,
    private readonly telegram?: TelegramClient,
  ) {}

  /**
   * Process a raw inbound message from the agent runtime.
   * Validates envelope, deduplicates, and routes to the appropriate handler.
   */
  async processInbound(raw: unknown): Promise<{ accepted: boolean; error?: string }> {
    // 1. Validate envelope
    const envelopeResult = MessageEnvelopeSchema.safeParse(raw);
    if (!envelopeResult.success) {
      logger.warn({ errors: envelopeResult.error.issues }, 'Invalid message envelope');
      return { accepted: false, error: 'invalid_envelope' };
    }

    const envelope = envelopeResult.data as MessageEnvelope;

    // 2. Validate payload against type-specific schema
    const payloadSchema = MESSAGE_PAYLOAD_SCHEMAS[envelope.type];
    if (!payloadSchema) {
      logger.warn({ type: envelope.type }, 'Unknown message type');
      return { accepted: false, error: 'unknown_message_type' };
    }

    const payloadResult = payloadSchema.safeParse(envelope.payload);
    if (!payloadResult.success) {
      logger.warn({ type: envelope.type, errors: payloadResult.error.issues }, 'Invalid payload');
      return { accepted: false, error: 'invalid_payload' };
    }

    // 3. Deduplicate by messageId
    const isDuplicate = await this.agentRepo.isMessageDuplicate(envelope.messageId);
    if (isDuplicate) {
      logger.debug({ messageId: envelope.messageId }, 'Duplicate message — skipping');
      return { accepted: true }; // Idempotent success
    }

    // 4. Persist message envelope for audit/replay
    await this.agentRepo.insertMessage({
      messageId: envelope.messageId,
      correlationId: envelope.correlationId,
      actorType: envelope.initiatorType,
      actorId: envelope.initiatorId,
      tradingInstanceId: envelope.tradingInstanceId,
      type: envelope.type,
      direction: 'inbound',
      schemaVersion: envelope.schemaVersion,
      sequence: envelope.sequence,
      traceId: envelope.traceId,
    });

    // 5. Route to appropriate handler
    try {
      switch (envelope.type) {
        case AGENT_MESSAGE_TYPES.DECISION_SUBMIT:
          await this.decisionHandler.handleDecisionSubmit(
            envelope,
            envelope.payload as unknown as DecisionSubmitPayload,
          );
          break;

        case AGENT_MESSAGE_TYPES.RUNTIME_HEARTBEAT:
          await this.sessionManager.handleHeartbeat(
            envelope,
            envelope.payload as unknown as HeartbeatPayload,
          );
          break;

        case AGENT_MESSAGE_TYPES.LIFECYCLE_PAUSE:
          await this.sessionManager.handlePauseRequest(
            envelope,
            envelope.payload as unknown as PauseRequestPayload,
          );
          break;

        case AGENT_MESSAGE_TYPES.LIFECYCLE_STOP:
          await this.sessionManager.handleStopRequest(
            envelope,
            envelope.payload as unknown as StopRequestPayload,
          );
          break;

        case AGENT_MESSAGE_TYPES.ARTIFACT_PUBLISH:
          await this.handleArtifactPublish(
            envelope,
            envelope.payload as unknown as ArtifactPublishPayload,
          );
          break;

        case AGENT_MESSAGE_TYPES.SEND_MESSAGE:
          await this.handleSendMessage(
            envelope,
            envelope.payload as unknown as SendMessagePayload,
          );
          break;

        default:
          await this.agentRepo.markMessageProcessed(envelope.messageId, 'rejected', {
            code: 'unsupported_type',
            message: `Message type ${envelope.type} is not handled`,
          });
          return { accepted: false, error: 'unsupported_type' };
      }

      await this.agentRepo.markMessageProcessed(envelope.messageId, 'processed');
      return { accepted: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ messageId: envelope.messageId, err }, 'Message processing failed');
      await this.agentRepo.markMessageProcessed(envelope.messageId, 'failed', {
        code: 'processing_error',
        message,
      });
      return { accepted: false, error: message };
    }
  }

  private async handleArtifactPublish(envelope: MessageEnvelope, payload: ArtifactPublishPayload): Promise<void> {
    // Resolve agent from initiator
    const agent = await this.agentRepo.getAgent(envelope.initiatorId);
    if (!agent) {
      throw new Error('Agent not found');
    }

    const activeLink = await this.agentRepo.getActiveLink(agent.id);
    if (!activeLink || activeLink.tradingInstanceId !== envelope.tradingInstanceId) {
      throw new Error("Artifact publish does not match the agent's active link");
    }

    // Require a running session — starting/unhealthy sessions should not publish artifacts.
    const activeSession = await this.agentRepo.getSessionForAgentAndInstance(agent.id, envelope.tradingInstanceId);
    if (!activeSession || activeSession.status !== 'running') {
      throw new Error('No running session for agent');
    }

    await this.agentRepo.insertArtifact({
      agentId: agent.id,
      sessionId: activeSession.id,
      artifactType: payload.artifactType,
      contentType: payload.contentType,
      summary: payload.summary,
      location: payload.location,
      metadata: payload.metadata,
    });
  }

  /**
   * Handle a brokered agent.message.send request.
   *
   * The platform owns recipient resolution — the agent cannot specify a destination.
   * Rate limited per agent. Always available in the MVP (not user-disableable).
   * Persists to agent_outbound_messages with authored_by='agent'.
   */
  private async handleSendMessage(envelope: MessageEnvelope, payload: SendMessagePayload): Promise<void> {
    const agent = await this.agentRepo.getAgent(envelope.initiatorId);
    if (!agent) {
      throw new Error('Agent not found');
    }

    const activeLink = await this.agentRepo.getActiveLink(agent.id);
    if (!activeLink || activeLink.tradingInstanceId !== envelope.tradingInstanceId) {
      throw new Error("send_message does not match the agent's active link");
    }

    const activeSession = await this.agentRepo.getSessionForAgentAndInstance(agent.id, envelope.tradingInstanceId);
    if (!activeSession || activeSession.status !== 'running') {
      throw new Error('No running session for agent — send_message requires an active session');
    }

    // Rate limit: honour per-agent toolPolicy override, fall back to capability default
    const now = Date.now();
    const policyEntry = agent.toolPolicy?.['send_message'];
    const perMinuteOverride =
      policyEntry !== null &&
      typeof policyEntry === 'object' &&
      'maxPerMinute' in policyEntry &&
      typeof (policyEntry as Record<string, unknown>)['maxPerMinute'] === 'number'
        ? (policyEntry as Record<string, unknown>)['maxPerMinute'] as number
        : undefined;
    // Per-agent policy can only reduce the limit below the platform cap, never raise it.
    const effectiveLimit = perMinuteOverride !== undefined
      ? Math.min(perMinuteOverride, SEND_MESSAGE_MAX_PER_MINUTE)
      : SEND_MESSAGE_MAX_PER_MINUTE;
    const counter = this.sendMessageCounters.get(agent.id);
    if (counter && now - counter.windowStart < 60_000) {
      if (counter.count >= effectiveLimit) {
        throw new Error(`send_message rate limit exceeded (max ${effectiveLimit}/min)`);
      }
      counter.count++;
    } else {
      this.sendMessageCounters.set(agent.id, { count: 1, windowStart: now });
    }

    // Body guard — domain schema validates length but be defensive
    const body = payload.body.slice(0, SEND_MESSAGE_MAX_BODY_LENGTH);

    // Persist to audit trail first
    const msgId = await this.agentRepo.insertOutboundMessage({
      agentId: agent.id,
      sessionId: activeSession.id,
      authoredBy: 'agent',
      subject: payload.subject,
      body,
      contextRef: payload.contextRef,
    });

    // Resolve user's Telegram destination
    const telegramChatId = await this.agentRepo.getUserTelegramChatId(agent.id);
    if (!telegramChatId) {
      logger.info({ agentId: agent.id }, 'send_message persisted but user has no Telegram chat ID — skipping delivery');
      await this.agentRepo.markOutboundMessageFailed(msgId, 'no_telegram_chat_id');
      return;
    }

    if (!this.telegram) {
      logger.debug({ agentId: agent.id }, 'send_message persisted but Telegram not configured — skipping delivery');
      await this.agentRepo.markOutboundMessageFailed(msgId, 'telegram_not_configured');
      return;
    }

    const text = formatAgentMessage(agent.name, payload.subject, body);
    const result = await this.telegram.sendText(telegramChatId, text);

    if (!result.ok) {
      logger.warn({ agentId: agent.id, error: result.error }, 'send_message Telegram delivery failed');
      await this.agentRepo.markOutboundMessageFailed(msgId, result.error.message);
      return;
    }

    await this.agentRepo.markOutboundMessageSent(msgId, String(result.data.messageId), telegramChatId);
    logger.info({ agentId: agent.id, msgId }, 'Agent send_message delivered');
  }
}

function formatAgentMessage(agentName: string, subject: string | undefined, body: string): string {
  const subjectLine = subject ? `<b>${escapeHtml(subject)}</b>\n` : '';
  return `💬 <b>[${escapeHtml(agentName)}]</b>\n${subjectLine}${escapeHtml(body)}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
