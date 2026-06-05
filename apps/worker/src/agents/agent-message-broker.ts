import type { Redis } from 'ioredis';
import type {
  MessageEnvelope,
  DecisionSubmitPayload,
  HeartbeatPayload,
  ArtifactPublishPayload,
  PauseRequestPayload,
  StopRequestPayload,
  SendMessagePayload,
  ManageBotPayload,
} from '@herobids/domain';
import {
  MessageEnvelopeSchema,
  MESSAGE_PAYLOAD_SCHEMAS,
  AGENT_MESSAGE_TYPES,
} from '@herobids/domain';
import type { AgentRepository, BotRepository } from '@herobids/db';
import type { TelegramClient } from '../alerting/telegram-client.js';
import type { AgentDecisionHandler } from './agent-decision-handler.js';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import { CapabilityPolicyEngine, DEFAULT_CAPABILITY_GRANTS } from './capability-policy.js';
import type { CapabilityGrant } from './capability-policy.js';
import pino from 'pino';

const logger = pino({ name: 'agent-message-broker' });

/** Brokered send_message rate limit: max messages per agent per minute. */
const SEND_MESSAGE_MAX_PER_MINUTE = 10;
/** Max body length enforced server-side (matches domain schema). */
const SEND_MESSAGE_MAX_BODY_LENGTH = 2000;

/**
 * Callback the broker uses to enqueue a bot start job on the runtime queue.
 * Decouples the broker from BullMQ — the caller wires this to queue.add().
 */
export type BotStartCallback = (botId: string, userId: string, config: Record<string, unknown>) => Promise<void>;

/**
 * Optional callback for enforcing a subscription-level bot cap before create.
 * Should throw with a user-facing message if the limit is exceeded.
 * Keeps the broker decoupled from plan config (which lives in the API layer).
 */
export type BotLimitCheckCallback = (userId: string) => Promise<void>;

/**
 * AgentMessageBroker — validates envelopes, enforces capability grants,
 * handles dedupe and correlation, and routes messages to the appropriate handler.
 *
 * This is the platform's inbound message gateway for agent protocol messages.
 */
export class AgentMessageBroker {
  /** Per-agent send_message rate tracking: agentId → { count, windowStart } */
  private readonly sendMessageCounters = new Map<string, { count: number; windowStart: number }>();
  /** Per-agent capability policy engine. Instantiated on first use per agent. */
  private readonly capabilityEngines = new Map<string, CapabilityPolicyEngine>();

  constructor(
    _redis: Redis,
    private readonly agentRepo: AgentRepository,
    private readonly decisionHandler: AgentDecisionHandler,
    private readonly sessionManager: AgentSessionManager,
    _eventPublisher: InstanceEventPublisher,
    private readonly telegram?: TelegramClient,
    private readonly botRepo?: BotRepository,
    private readonly botStart?: BotStartCallback,
    private readonly botLimitCheck?: BotLimitCheckCallback,
  ) {}

  private getCapabilityEngine(agentId: string, perAgentGrants?: CapabilityGrant[]): CapabilityPolicyEngine {
    const existing = this.capabilityEngines.get(agentId);
    if (existing) return existing;

    const grants = perAgentGrants
      ? [...DEFAULT_CAPABILITY_GRANTS, ...perAgentGrants]
      : DEFAULT_CAPABILITY_GRANTS;
    const engine = new CapabilityPolicyEngine(grants);
    this.capabilityEngines.set(agentId, engine);
    return engine;
  }

  /**
   * Process a raw inbound message from the agent runtime.
   * Validates envelope, deduplicates, enforces capability policy, and routes.
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

    // 3. Enforce capability policy for brokered tool calls
    const capabilityByType: Record<string, string> = {
      [AGENT_MESSAGE_TYPES.DECISION_SUBMIT]: 'decision_submit',
      [AGENT_MESSAGE_TYPES.ARTIFACT_PUBLISH]: 'artifact_publish',
      [AGENT_MESSAGE_TYPES.SEND_MESSAGE]: 'send_message',
      [AGENT_MESSAGE_TYPES.MANAGE_BOT]: 'manage_bot',
    };
    const capabilityName = capabilityByType[envelope.type];
    // Saved so recordEnd can be called in the finally block on every exit path.
    let policyEngine: CapabilityPolicyEngine | undefined;
    let policySessionId: string | undefined;
    let policyStartMs: number | undefined;
    if (capabilityName) {
      const agent = await this.agentRepo.getAgent(envelope.agentId);
      const perAgentGrants = agent?.toolPolicy
        ? (Object.values(agent.toolPolicy) as CapabilityGrant[])
        : undefined;
      const engine = this.getCapabilityEngine(envelope.agentId, perAgentGrants);
      const activeSession = await this.agentRepo.getActiveSession(envelope.agentId);
      const sessionId = activeSession?.id ?? envelope.agentId;
      const denied = engine.checkAccess(capabilityName, envelope.agentId, sessionId);
      if (denied) {
        logger.warn({ agentId: envelope.agentId, capability: capabilityName, reason: denied }, 'Capability policy denied');
        return { accepted: false, error: `capability_denied:${denied}` };
      }
      engine.recordStart(capabilityName, sessionId);
      policyEngine = engine;
      policySessionId = sessionId;
      policyStartMs = Date.now();
    }

    // 4. Deduplicate by messageId
    const isDuplicate = await this.agentRepo.isMessageDuplicate(envelope.messageId);
    if (isDuplicate) {
      logger.debug({ messageId: envelope.messageId }, 'Duplicate message — skipping');
      // Release the concurrency slot acquired above so subsequent calls are not blocked.
      if (policyEngine && capabilityName && policySessionId) {
        policyEngine.recordEnd(capabilityName, policySessionId, {
          capability: capabilityName,
          agentId: envelope.agentId,
          sessionId: policySessionId,
          timestamp: new Date().toISOString(),
          durationMs: 0,
          inputSummary: 'duplicate',
          outputSummary: '',
          success: true,
        });
      }
      return { accepted: true }; // Idempotent success
    }

    // 4. Persist message envelope for audit/replay
    await this.agentRepo.insertMessage({
      messageId: envelope.messageId,
      correlationId: envelope.correlationId,
      actorType: envelope.initiatorType,
      actorId: envelope.initiatorId,
      agentId: envelope.agentId,
      botId: envelope.botId,
      type: envelope.type,
      direction: 'inbound',
      schemaVersion: envelope.schemaVersion,
      sequence: envelope.sequence,
      traceId: envelope.traceId,
    });

    // 5. Route to appropriate handler
    let processingSuccess = false;
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

        case AGENT_MESSAGE_TYPES.MANAGE_BOT:
          await this.handleManageBot(
            envelope,
            envelope.payload as unknown as ManageBotPayload,
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
      processingSuccess = true;
      return { accepted: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ messageId: envelope.messageId, err }, 'Message processing failed');
      await this.agentRepo.markMessageProcessed(envelope.messageId, 'failed', {
        code: 'processing_error',
        message,
      });
      return { accepted: false, error: message };
    } finally {
      // Always release the concurrency slot — prevents capability lock-up after single use.
      if (policyEngine && capabilityName && policySessionId) {
        policyEngine.recordEnd(capabilityName, policySessionId, {
          capability: capabilityName,
          agentId: envelope.agentId,
          sessionId: policySessionId,
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - (policyStartMs ?? Date.now()),
          inputSummary: '',
          outputSummary: '',
          success: processingSuccess,
        });
      }
    }
  }

  private async handleArtifactPublish(envelope: MessageEnvelope, payload: ArtifactPublishPayload): Promise<void> {
    // Resolve agent from initiator
    const agent = await this.agentRepo.getAgent(envelope.initiatorId);
    if (!agent) {
      throw new Error('Agent not found');
    }

    // Require a running session
    const activeSession = await this.agentRepo.getActiveSession(agent.id);
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

    const activeSession = await this.agentRepo.getActiveSession(agent.id);
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

  private async handleManageBot(envelope: MessageEnvelope, payload: ManageBotPayload): Promise<void> {
    const agent = await this.agentRepo.getAgent(envelope.initiatorId);
    if (!agent) throw new Error('Agent not found');

    const activeSession = await this.agentRepo.getActiveSession(agent.id);
    if (!activeSession || activeSession.status !== 'running') {
      throw new Error('No running session for agent');
    }

    if (payload.action === 'create_and_start') {
      if (!payload.venueAccountId) throw new Error('venueAccountId is required for create_and_start');
      if (!payload.config) throw new Error('config is required for create_and_start');
      if (!this.botRepo) throw new Error('BotRepository not wired — manage_bot unavailable');

      // Security: verify the venue account belongs to the agent's own user before creating the bot.
      const owned = await this.botRepo.isVenueAccountOwnedBy(payload.venueAccountId, agent.userId);
      if (!owned) {
        throw new Error(`Venue account ${payload.venueAccountId} not found or not owned by this agent's user`);
      }

      // Enforce subscription-wide plan bot cap (same limit the API enforces for direct bot creation).
      if (this.botLimitCheck) {
        await this.botLimitCheck(agent.userId);
      }

      // Enforce agent-level maxBots limit (additional per-agent guardrail on top of the plan cap).
      const maxBots = agent.maxBots ?? 5;
      const runningBots = await this.botRepo.countRunningBotsByCreator('agent', agent.id);
      if (runningBots >= maxBots) {
        throw new Error(`Agent has reached its max concurrent bots limit (${maxBots}). Stop a bot before creating a new one.`);
      }

      const botId = await this.botRepo.createBot({
        userId: agent.userId,
        venueAccountId: payload.venueAccountId,
        config: payload.config,
        creatorType: 'agent',
        creatorId: agent.id,
      });

      logger.info({ agentId: agent.id, botId }, 'Agent created bot via manage_bot');

      if (this.botStart) {
        // Mark running before queuing — matches the API start-bot path so the worker sees status='running'.
        await this.botRepo.markBotRunning(botId);
        // Include venueAccountId in the job config so the worker can resolve credentials.
        await this.botStart(botId, agent.userId, { ...payload.config, venueAccountId: payload.venueAccountId });
        logger.info({ agentId: agent.id, botId }, 'Agent-created bot marked running and enqueued for start');
      }
      return;
    }

    if (payload.action === 'stop') {
      if (!payload.botId) throw new Error('botId is required for stop');
      // Stopping is handled by the existing lifecycle queue — not implemented here yet
      throw new Error('stop action for manage_bot is not yet implemented');
    }

    throw new Error(`Unknown manage_bot action: ${(payload as { action: string }).action}`);
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
