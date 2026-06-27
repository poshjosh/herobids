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
  BotQueryPayload,
} from '@herobids/domain';
import {
  Decimal,
  MessageEnvelopeSchema,
  MESSAGE_PAYLOAD_SCHEMAS,
  AGENT_MESSAGE_TYPES,
  AGENT_RUNTIME_ACTIVITY_TYPES,
  BotConfigSchema,
  venueTypeFromProvider,
  deriveStrategyPreset,
  extractStrategyFromConfig,
} from '@herobids/domain';
import type { AgentRepository, BotRepository } from '@herobids/db';
import { forceReply, type TelegramClient } from '../alerting/telegram-client.js';
import type { EmailClient } from '../alerting/email-client.js';
import type { AgentDecisionHandler } from './agent-decision-handler.js';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import { CapabilityPolicyEngine, DEFAULT_CAPABILITY_GRANTS } from './capability-policy.js';
import type { CapabilityGrant } from './capability-policy.js';
import pino from 'pino';

const logger = pino({ name: 'agent-message-broker' });

/** Brokered send_message rate limit: max messages per agent per minute. */
const SEND_MESSAGE_MAX_PER_MINUTE = 10;
/** Stricter secondary rate limit for email fanout per agent per minute. */
const EMAIL_FANOUT_MAX_PER_MINUTE = 3;
/** Max body length enforced server-side (matches domain schema). */
const SEND_MESSAGE_MAX_BODY_LENGTH = 2000;

/**
 * Callback the broker uses to enqueue a bot start job on the runtime queue.
 * Decouples the broker from BullMQ — the caller wires this to queue.add().
 * tradingBindingId is explicit so the type system enforces the binding-first routing contract.
 */
export type BotStartCallback = (botId: string, userId: string, tradingBindingId: string, config: Record<string, unknown>) => Promise<void>;

/** Callback used to enqueue a bot stop job on the runtime queue. */
export type BotStopCallback = (botId: string, userId: string) => Promise<void>;

/** Callback used to enqueue a bot restart job on the runtime queue. */
export type BotRestartCallback = (botId: string, userId: string, tradingBindingId: string, config: Record<string, unknown>) => Promise<void>;

/**
 * Optional callback for enforcing a subscription-level bot cap before create.
 * Should throw with a user-facing message if the limit is exceeded.
 * Keeps the broker decoupled from plan config (which lives in the API layer).
 */
export type BotLimitCheckCallback = (userId: string) => Promise<void>;

/**
 * Optional callback for enforcing plan-level live execution eligibility.
 * Should throw with a user-facing message if live mode is not allowed for the user's plan.
 * Called before creating a bot with execution.mode = 'live'.
 */
export type BotLiveCheckCallback = (userId: string) => Promise<void>;

/**
 * AgentMessageBroker — validates envelopes, enforces capability grants,
 * handles dedupe and correlation, and routes messages to the appropriate handler.
 *
 * This is the platform's inbound message gateway for agent protocol messages.
 */
export class AgentMessageBroker {
  /** Per-agent send_message rate tracking: agentId → { count, windowStart } */
  private readonly sendMessageCounters = new Map<string, { count: number; windowStart: number }>();
  /** Per-agent email fanout rate tracking: agentId → { count, windowStart } */
  private readonly emailFanoutCounters = new Map<string, { count: number; windowStart: number }>();
  /**
   * Per-agent capability policy cache: agentId → { engine, policySig }.
   * policySig is the JSON fingerprint of the agent's toolPolicy at build time.
   * When toolPolicy changes (e.g. PATCH /agents/:id updates skillIds), the sig
   * differs and the engine is rebuilt so the new grants take effect immediately.
   */
  private readonly capabilityEngines = new Map<string, { engine: CapabilityPolicyEngine; policySig: string }>();

  constructor(
    _redis: Redis,
    private readonly agentRepo: AgentRepository,
    private readonly decisionHandler: AgentDecisionHandler,
    private readonly sessionManager: AgentSessionManager,
    private readonly eventPublisher: InstanceEventPublisher,
    private readonly telegram?: TelegramClient,
    private readonly botRepo?: BotRepository,
    private readonly botStart?: BotStartCallback,
    private readonly botLimitCheck?: BotLimitCheckCallback,
    private readonly botLiveCheck?: BotLiveCheckCallback,
    private readonly botStop?: BotStopCallback,
    private readonly botRestart?: BotRestartCallback,
    private readonly emailClient?: EmailClient,
    readonly onAgentConfigUpdate?: (agentId: string, config: Record<string, unknown> | null) => void,
  ) {}

  private getCapabilityEngine(agentId: string, perAgentGrants?: CapabilityGrant[], policySig = ''): CapabilityPolicyEngine {
    const cached = this.capabilityEngines.get(agentId);
    if (cached && cached.policySig === policySig) return cached.engine;

    const grants = perAgentGrants
      ? [...DEFAULT_CAPABILITY_GRANTS, ...perAgentGrants]
      : DEFAULT_CAPABILITY_GRANTS;
    const engine = new CapabilityPolicyEngine(grants);
    this.capabilityEngines.set(agentId, { engine, policySig });
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
    // Resolve effective agentId — may be absent when initiatorType is 'agent'
    const effectiveAgentId = envelope.agentId ?? envelope.initiatorId;

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

    // 3. Deduplicate by messageId — must run before session-ownership gate so
    // that already-processed messages get idempotent success even after the
    // session that sent them has been superseded.
    const isDuplicate = await this.agentRepo.isMessageDuplicate(envelope.messageId);
    if (isDuplicate) {
      logger.debug({ messageId: envelope.messageId }, 'Duplicate message — skipping');
      return { accepted: true }; // Idempotent success
    }

    // 4. Centralized session-ownership gate
    // All agent-originated messages (except heartbeat and session_ended) must
    // prove they come from the currently active session. Fail-closed: stale
    // containers are rejected here rather than requiring each handler to verify.
    if (envelope.initiatorType === 'agent'
      && envelope.type !== AGENT_MESSAGE_TYPES.RUNTIME_HEARTBEAT
      && envelope.type !== AGENT_MESSAGE_TYPES.RUNTIME_SESSION_ENDED
    ) {
      const runtimeSessionId = envelope.correlationId;
      if (!runtimeSessionId) {
        logger.warn({ agentId: effectiveAgentId, type: envelope.type }, 'Agent message missing correlationId — rejected');
        return { accepted: false, error: 'missing_session_id' };
      }
      const isActive = await this.agentRepo.isActiveSession(effectiveAgentId, runtimeSessionId);
      if (!isActive) {
        logger.warn(
          { agentId: effectiveAgentId, sessionId: runtimeSessionId, type: envelope.type },
          'Stale session message rejected at broker boundary',
        );
        return { accepted: false, error: 'stale_session' };
      }
    }

    // 5. Enforce capability policy for brokered tool calls
    const capabilityByType: Record<string, string> = {
      [AGENT_MESSAGE_TYPES.DECISION_SUBMIT]: 'submit_decision',
      [AGENT_MESSAGE_TYPES.PUBLISH_ARTIFACT]: 'publish_artifact',
      [AGENT_MESSAGE_TYPES.SEND_MESSAGE]: 'send_message',
      [AGENT_MESSAGE_TYPES.MANAGE_BOT]: 'manage_bot',
      [AGENT_MESSAGE_TYPES.BOT_QUERY]: 'bot_query',
    };
    const capabilityName = capabilityByType[envelope.type];
    // Saved so recordEnd can be called in the finally block on every exit path.
    let policyEngine: CapabilityPolicyEngine | undefined;
    let policySessionId: string | undefined;
    let policyStartMs: number | undefined;
    if (capabilityName) {
      const agent = await this.agentRepo.getAgent(effectiveAgentId);
      const perAgentGrants = agent?.toolPolicy
        ? (Object.values(agent.toolPolicy) as CapabilityGrant[])
        : undefined;
      // Compute a policy fingerprint so the cache is invalidated when toolPolicy changes.
      const policySig = agent?.toolPolicy ? JSON.stringify(agent.toolPolicy) : '';
      const engine = this.getCapabilityEngine(effectiveAgentId, perAgentGrants, policySig);
      const activeSession = await this.agentRepo.getActiveSession(effectiveAgentId);
      const sessionId = activeSession?.id ?? effectiveAgentId;
      const denied = engine.checkAccess(capabilityName, effectiveAgentId, sessionId);
      if (denied) {
        logger.warn({ agentId: effectiveAgentId, capability: capabilityName, reason: denied }, 'Capability policy denied');
        return { accepted: false, error: `capability_denied:${denied}` };
      }
      engine.recordStart(capabilityName, sessionId);
      policyEngine = engine;
      policySessionId = sessionId;
      policyStartMs = Date.now();
    }

    // 6. Persist message envelope for audit/replay
    await this.agentRepo.insertMessage({
      messageId: envelope.messageId,
      correlationId: envelope.correlationId,
      actorType: envelope.initiatorType,
      actorId: envelope.initiatorId,
      agentId: effectiveAgentId,
      botId: envelope.botId,
      type: envelope.type,
      direction: 'inbound',
      schemaVersion: envelope.schemaVersion,
      sequence: envelope.sequence,
      traceId: envelope.traceId,
      payload: envelope.payload,
    });

    // 7. Route to appropriate handler
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

        case AGENT_MESSAGE_TYPES.PUBLISH_ARTIFACT:
          await this.handleArtifactPublish(
            effectiveAgentId,
            envelope,
            envelope.payload as unknown as ArtifactPublishPayload,
          );
          break;

        case AGENT_MESSAGE_TYPES.SEND_MESSAGE:
          await this.handleSendMessage(
            effectiveAgentId,
            envelope,
            envelope.payload as unknown as SendMessagePayload,
          );
          break;

        case AGENT_MESSAGE_TYPES.MANAGE_BOT:
          await this.handleManageBot(
            effectiveAgentId,
            envelope,
            envelope.payload as unknown as ManageBotPayload,
          );
          break;

        case AGENT_MESSAGE_TYPES.BOT_QUERY:
          await this.handleBotQuery(
            effectiveAgentId,
            envelope,
            envelope.payload as unknown as BotQueryPayload,
          );
          break;

        case AGENT_MESSAGE_TYPES.RUNTIME_SESSION_ENDED: {
          // The agent container sends this before exiting. Route through session
          // manager which is session-aware: verifies the farewell belongs to the
          // currently active session, preserves the runtime-reported terminal
          // status, and retires the matching session. Stale farewells from
          // superseded containers are no-ops. This also triggers in-memory actor
          // cleanup (AgentTradingActor stop + deregister).
          const payload = envelope.payload as { reasonCode?: string; sessionId?: string };
          const plannedReasonCodes = new Set(['wall_clock_expired', 'stop_requested', 'pause_requested', 'SIGTERM', 'SIGINT']);
          const status = plannedReasonCodes.has(payload.reasonCode ?? '') ? 'stopped' : 'crashed';
          const sessionId = envelope.correlationId ?? payload.sessionId;
          if (!sessionId) {
            logger.warn({ agentId: effectiveAgentId }, 'session_ended missing session identifier — cannot route');
            break;
          }
          await this.sessionManager.handleRuntimeSessionEnd(sessionId, effectiveAgentId, status);
          break;
        }

        case AGENT_RUNTIME_ACTIVITY_TYPES.TICK_STARTED:
        case AGENT_RUNTIME_ACTIVITY_TYPES.TICK_SKIPPED:
        case AGENT_RUNTIME_ACTIVITY_TYPES.SCOUT_HELD:
        case AGENT_RUNTIME_ACTIVITY_TYPES.SCOUT_ESCALATED:
        case AGENT_RUNTIME_ACTIVITY_TYPES.LLM_DISPATCH:
        case AGENT_RUNTIME_ACTIVITY_TYPES.LLM_COMPLETED:
        case AGENT_RUNTIME_ACTIVITY_TYPES.TOOL_CALL:
        case AGENT_RUNTIME_ACTIVITY_TYPES.TOOL_RESULT:
          // Audit-only events — persisted with payload, no business side effects.
          break;

        case AGENT_MESSAGE_TYPES.CONFIG_UPDATE: {
          // Agent updated its own config — notify the actor to apply changes.
          const configPayload = envelope.payload as { config: Record<string, unknown> | null };
          this.onAgentConfigUpdate?.(effectiveAgentId, configPayload.config ?? null);
          break;
        }

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
          agentId: effectiveAgentId,
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

  /**
   * Derive the strategyPreset display label from a bot's stored config.
   * Delegates to the shared deriveStrategyPreset utility in @herobids/domain.
   */
  private deriveStrategyPresetFromBotConfig(config: Record<string, unknown>): string | undefined {
    const strategy = extractStrategyFromConfig(config);
    return strategy ? (deriveStrategyPreset(strategy.type) ?? undefined) : undefined;
  }

  private async handleArtifactPublish(agentId: string, _envelope: MessageEnvelope, payload: ArtifactPublishPayload): Promise<void> {
    const agent = await this.agentRepo.getAgent(agentId);
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
  private async handleSendMessage(agentId: string, _envelope: MessageEnvelope, payload: SendMessagePayload): Promise<void> {
    const agent = await this.agentRepo.getAgent(agentId);
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
    const messageClass = payload.messageClass ?? 'routine';

    // Persist to audit trail first (inbox is always the primary path)
    const msgId = await this.agentRepo.insertOutboundMessage({
      agentId: agent.id,
      sessionId: activeSession.id,
      authoredBy: 'agent',
      subject: payload.subject,
      body,
      contextRef: payload.contextRef,
      messageClass,
    });

    // Resolve effective Telegram destination (agent-level override > user-level default)
    const telegramChatId = await this.agentRepo.getEffectiveTelegramChatId(agent.id);
    if (!telegramChatId) {
      logger.info({ agentId: agent.id }, 'send_message persisted but no Telegram chat ID available — skipping delivery');
      await this.agentRepo.markOutboundMessageFailed(msgId, 'no_telegram_chat_id');
    } else if (!this.telegram) {
      logger.debug({ agentId: agent.id }, 'send_message persisted but Telegram not configured — skipping delivery');
      await this.agentRepo.markOutboundMessageFailed(msgId, 'telegram_not_configured');
    } else {
      const text = formatAgentMessage(agent.name, payload.subject, body);
      const result = await this.telegram.sendText(telegramChatId, text, forceReply());

      if (!result.ok) {
        logger.warn({ agentId: agent.id, error: result.error }, 'send_message Telegram delivery failed');
        await this.agentRepo.markOutboundMessageFailed(msgId, result.error.message);
      } else {
        await this.agentRepo.markOutboundMessageSent(msgId, String(result.data.messageId), telegramChatId);
        logger.info({ agentId: agent.id, msgId }, 'Agent send_message delivered via Telegram');
      }
    }

    // --- Email fanout (secondary, policy-gated) ---
    await this.handleEmailFanout(agent.id, msgId, payload, body, messageClass, now);
  }

  /**
   * Evaluate email fanout eligibility and send if all rules pass.
   * Implements the broker enforcement algorithm from 001-send-message-email-policy.md.
   */
  private async handleEmailFanout(
    agentId: string,
    msgId: string,
    payload: SendMessagePayload,
    body: string,
    messageClass: string,
    now: number,
  ): Promise<void> {
    // Rule 4: email requires explicit per-message request
    if (payload.emailDelivery !== 'if_allowed') {
      await this.agentRepo.markOutboundMessageEmailSkipped(msgId, 'feed_only');
      return;
    }

    // Rule 5: only alert and reminder classes are email-eligible
    if (messageClass !== 'alert' && messageClass !== 'reminder') {
      logger.debug({ agentId, messageClass }, 'Email fanout suppressed: routine message class');
      await this.agentRepo.markOutboundMessageEmailSkipped(msgId, 'email_skipped_policy');
      return;
    }

    // Rule 7: operator email infrastructure required
    if (!this.emailClient) {
      logger.debug({ agentId }, 'Email fanout skipped: email client not configured');
      await this.agentRepo.markOutboundMessageEmailSkipped(msgId, 'email_skipped_not_configured');
      return;
    }

    // Rule 2: agent must have email enabled in notificationPolicy
    const agent = await this.agentRepo.getAgent(agentId);
    const notifPolicy = agent?.notificationPolicy as {
      sendMessage?: { email?: { enabled?: boolean } };
    } | null | undefined;
    if (!notifPolicy?.sendMessage?.email?.enabled) {
      logger.debug({ agentId }, 'Email fanout suppressed: notificationPolicy.sendMessage.email.enabled is false');
      await this.agentRepo.markOutboundMessageEmailSkipped(msgId, 'email_skipped_policy');
      return;
    }

    // Rule 6: recipient is fixed to owning user's verified account email
    const recipientEmail = await this.agentRepo.getUserEmailByAgentId(agentId);
    if (!recipientEmail) {
      logger.warn({ agentId }, 'Email fanout skipped: no verified account email for owning user');
      await this.agentRepo.markOutboundMessageEmailSkipped(msgId, 'email_skipped_no_verified_recipient');
      return;
    }

    // Rule 8: secondary stricter rate limit for email fanout
    const emailCounter = this.emailFanoutCounters.get(agentId);
    if (emailCounter && now - emailCounter.windowStart < 60_000) {
      if (emailCounter.count >= EMAIL_FANOUT_MAX_PER_MINUTE) {
        logger.warn({ agentId }, 'Email fanout suppressed: secondary rate limit exceeded');
        await this.agentRepo.markOutboundMessageEmailSkipped(msgId, 'email_skipped_policy');
        return;
      }
      emailCounter.count++;
    } else {
      this.emailFanoutCounters.set(agentId, { count: 1, windowStart: now });
    }

    // All rules passed — send email
    const subject = payload.subject ?? (messageClass === 'reminder' ? 'Reminder from your agent' : 'Alert from your agent');
    const result = await this.emailClient.send({ to: recipientEmail, subject, text: body });

    if (!result.ok) {
      logger.warn({ agentId, error: result.error }, 'Email fanout delivery failed');
      await this.agentRepo.markOutboundMessageEmailFailed(msgId, result.error.message);
      return;
    }

    await this.agentRepo.markOutboundMessageEmailSent(msgId, result.data.messageId);
    logger.info({ agentId, msgId, messageId: result.data.messageId }, 'Agent send_message email fanout sent');
  }

  private async handleManageBot(agentId: string, _envelope: MessageEnvelope, payload: ManageBotPayload): Promise<void> {
    const agent = await this.agentRepo.getAgent(agentId);
    if (!agent) throw new Error('Agent not found');

    const activeSession = await this.agentRepo.getActiveSession(agent.id);
    if (!activeSession || activeSession.status !== 'running') {
      throw new Error('No running session for agent');
    }

    if (payload.action === 'create_and_start') {
      if (!payload.config) throw new Error('config is required for create_and_start');
      if (!this.botRepo) throw new Error('BotRepository not wired — manage_bot unavailable');

      // Resolve the binding using the same runtime descriptor the agent sees in its prompt.
      // Primary path: bindingId (the agent sees this in its readiness summary).
      // Fallback: venueAccountId (legacy — deprecated).
      const capabilityDescriptor = await this.agentRepo.getRuntimeCapabilityDescriptor(agent.id);
      const grantedTradingBindings = capabilityDescriptor.grantedBindingsByFamily['trading'] ?? [];
      const defaultBindingId = capabilityDescriptor.defaultBindingByFamily['trading'];

      let binding: (typeof grantedTradingBindings)[number] | undefined;

      if (payload.bindingId) {
        // Primary: resolve by bindingId — what the agent sees in readiness
        const byBindingId = grantedTradingBindings.filter(
          (candidate) => candidate.bindingId === payload.bindingId,
        );
        if (byBindingId.length === 0) {
          throw new Error(`No trading capability binding found with bindingId ${payload.bindingId}`);
        }
        if (byBindingId.length > 1) {
          throw new Error(`Multiple trading capability bindings found with bindingId ${payload.bindingId}`);
        }
        binding = byBindingId[0];
      } else if (payload.venueAccountId) {
        // Legacy fallback: resolve by sourceVenueAccountId
        const byVenueAccountId = grantedTradingBindings.filter(
          (candidate) => candidate.sourceVenueAccountId === payload.venueAccountId,
        );
        if (byVenueAccountId.length === 0) {
          throw new Error(`No trading capability binding found for venue account ${payload.venueAccountId}`);
        }
        if (byVenueAccountId.length > 1) {
          throw new Error(`Multiple trading capability bindings found for venue account ${payload.venueAccountId}`);
        }
        binding = byVenueAccountId[0];
      } else {
        // Default: use the agent's default trading binding
        binding = grantedTradingBindings.find((candidate) => candidate.bindingId === defaultBindingId);
      }
      if (!binding || !binding.readiness.effectiveReady) {
        throw new Error('No ready trading capability binding found for this agent — cannot create bot');
      }
      if (!binding.sourceVenueAccountId) {
        throw new Error(`Trading binding ${binding.bindingId} is missing sourceVenueAccountId — cannot create bot until the binding migration is completed`);
      }

      // Security: verify the binding belongs to the agent's own user before creating the bot.
      const owned = await this.botRepo.isTradingBindingOwnedBy(binding.bindingId, agent.userId);
      if (!owned) {
        throw new Error(`Trading binding ${binding.bindingId} not found or not owned by this agent's user`);
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

      // Resolve venue account from the binding and stamp venue/venueType unconditionally
      const venueAccount = await this.botRepo.getVenueAccountById(binding.sourceVenueAccountId);
      if (!venueAccount) {
        throw new Error(`Cannot resolve venue account ${binding.sourceVenueAccountId} from trading binding — cannot create bot`);
      }
      const venueType = venueTypeFromProvider(venueAccount.venue);
      if (!venueType) {
        throw new Error(`Unsupported venue "${venueAccount.venue}" resolved from trading binding — cannot create bot`);
      }
      const rawConfig = applyAgentCapitalLimit(payload.config, agent.capital ?? null);
      // Stamp venue/venueType unconditionally — agent-provided values are discarded
      rawConfig['venue'] = venueAccount.venue;
      rawConfig['venueType'] = venueType;

      // Validate the full config against BotConfigSchema before persisting
      const validation = BotConfigSchema.safeParse(rawConfig);
      if (!validation.success) {
        const issues = validation.error.issues.map((i) =>
          `${i.path.join('.') || 'root'}: ${i.message}`
        ).join('; ');
        throw new Error(`Bot config is invalid: ${issues}`);
      }

      const validatedConfig = validation.data;

      // Safety gate: agent execution mode must not be exceeded by bot execution mode.
      // Paper agents can only create paper bots; shadow agents can create paper or shadow;
      // live agents can create any mode.
      const agentMode = agent.executionMode ?? 'paper';
      const botMode = validatedConfig.execution.mode ?? 'paper';
      const MODE_RANK: Record<string, number> = { paper: 0, shadow: 1, live: 2 };
      if ((MODE_RANK[botMode] ?? 0) > (MODE_RANK[agentMode] ?? 0)) {
        const permitted = Object.keys(MODE_RANK).filter((m) => (MODE_RANK[m] ?? 0) <= (MODE_RANK[agentMode] ?? 0));
        throw new Error(
          `Cannot create a bot with execution mode "${botMode}". ` +
          `Permitted execution modes: ${permitted.join(', ')}.`,
        );
      }

      // Safety gate: plan-level live execution eligibility.
      // Mirrors the API-level check that the agent broker path previously bypassed.
      if (botMode === 'live' && this.botLiveCheck) {
        await this.botLiveCheck(agent.userId);
      }

      // Safety gate: swap-venue symbol validation.
      // Each swap-venue binding maps to a specific chain (e.g. Base, Solana).
      // Reject bot creation when the symbol format is wrong or when the symbol
      // parts look like raw addresses instead of human-readable tickers.
      // Per-token network validity is enforced downstream by token safety.
      if (venueType === 'swap' && payload.config.symbol) {
        const symbol = payload.config.symbol;
        const parts = symbol.split('/');
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          throw new Error(
            `Invalid symbol format "${symbol}". ` +
            `Swap venues require BASE/QUOTE format (e.g. "ETH/USDC" for 1inch on Base).`,
          );
        }
        // Reject raw addresses — agents must use human-readable symbols.
        const looksLikeAddress = (s: string) => s.startsWith('0x') || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
        if (looksLikeAddress(parts[0]!) || looksLikeAddress(parts[1]!)) {
          throw new Error(
            `Symbol "${symbol}" looks like a raw token address. ` +
            `Use a human-readable symbol (e.g. "ETH/USDC"), not a contract address.`,
          );
        }
      }

      const botId = await this.botRepo.createBot({
        userId: agent.userId,
        tradingBindingId: binding.bindingId,
        venueAccountId: binding.sourceVenueAccountId,
        config: validatedConfig,
        creatorType: 'agent',
        creatorId: agent.id,
      });

      logger.info({ agentId: agent.id, botId }, 'Agent created bot via manage_bot');

      if (this.botStart) {
        // Mark running before queuing — matches the API start-bot path so the worker sees status='running'.
        await this.botRepo.markBotRunning(botId);
        await this.botStart(botId, agent.userId, binding.bindingId, {
          ...validatedConfig,
          venueAccountId: binding.sourceVenueAccountId,
        });
        logger.info({ agentId: agent.id, botId }, 'Agent-created bot marked running and enqueued for start');
      }

      // Notify the agent of the updated bot list so it can reflect current state in its next tick.
      const agentBots = await this.botRepo!.getBotsByCreator('agent', agent.id);
      await this.eventPublisher.emitInstanceStatus(agent.id, {
        status: 'running',
        reason: 'bot_created',
        updatedAt: new Date().toISOString(),
        managedBots: agentBots.map((b) => ({
          id: b.id,
          status: b.status,
          strategyPreset: this.deriveStrategyPresetFromBotConfig(b.config as Record<string, unknown>),
          symbol: (b.config as Record<string, unknown>)?.['symbol'] as string | undefined,
        })),
      });
      return;
    }

    if (payload.action === 'start') {
      if (!payload.botId) throw new Error('botId is required for start');
      if (!this.botRepo) throw new Error('BotRepository not wired — manage_bot unavailable');

      const bot = await this.botRepo.getBotById(payload.botId);
      if (!bot || bot.userId !== agent.userId) {
        throw new Error(`Bot ${payload.botId} not found or not owned by this agent's user`);
      }

      const persistedConfig = bot.config as Record<string, unknown>;
      const effectiveConfig = applyAgentCapitalLimit(persistedConfig, agent.capital ?? null);
      if (!configsEqual(persistedConfig, effectiveConfig)) {
        await this.botRepo.updateBotConfig(payload.botId, effectiveConfig);
      }

      // Consistency model: we mark the bot running in DB then enqueue the
      // lifecycle start job.  If the process crashes between these two steps
      // the bot will be marked 'running' with no active actor — the worker's
      // periodic reclaim sweep (WorkerRuntime.reclaimOrphans) detects this and
      // re-starts the actor, converging DB and runtime without manual intervention.
      if (this.botStart) {
        await this.botRepo.markBotRunning(payload.botId);
        try {
          // venueAccountId is resolved via startupContext.sourceVenueAccountId at job processing
          // time — no longer passed in the config payload to avoid stale/dual sources of truth.
          await this.botStart(payload.botId, agent.userId, bot.tradingBindingId, {
            ...effectiveConfig,
          });
        } catch (err) {
          logger.error({ botId: payload.botId, err }, 'Failed to enqueue start job during start action');
          try {
            await this.botRepo.restoreBotRuntimeState({
              botId: payload.botId,
              status: bot.status,
              startedAt: bot.startedAt,
              stoppedAt: bot.stoppedAt,
            });
          } catch (rollbackErr) {
            logger.error({ botId: payload.botId, rollbackErr }, 'CRITICAL: rollback after start enqueue failure also failed — bot may be marked running without an actor until reclaim sweep');
          }
          throw new Error('Bot start failed: unable to enqueue lifecycle start. Please try again.');
        }
      } else {
        await this.botRepo.markBotRunning(payload.botId);
      }

      const agentBots = await this.botRepo.getBotsByCreator('agent', agent.id);
      await this.eventPublisher.emitInstanceStatus(agent.id, {
        status: 'running',
        reason: 'bot_started',
        updatedAt: new Date().toISOString(),
        managedBots: agentBots.map((b) => ({
          id: b.id,
          status: b.status,
          strategyPreset: this.deriveStrategyPresetFromBotConfig(b.config as Record<string, unknown>),
          symbol: (b.config as Record<string, unknown>)?.['symbol'] as string | undefined,
        })),
      });
      return;
    }

    if (payload.action === 'stop') {
      if (!payload.botId) throw new Error('botId is required for stop');
      if (!this.botRepo) throw new Error('BotRepository not wired — manage_bot unavailable');

      const bot = await this.botRepo.getBotById(payload.botId);
      if (!bot || bot.userId !== agent.userId) {
        throw new Error(`Bot ${payload.botId} not found or not owned by this agent's user`);
      }

      if (this.botStop) {
        await this.botStop(payload.botId, agent.userId);
      } else {
        await this.botRepo.markBotStopped(payload.botId);
      }
      return;
    }

    if (payload.action === 'adjust_config') {
      if (!payload.botId) throw new Error('botId is required for adjust_config');
      if (!payload.config) throw new Error('config is required for adjust_config');
      if (!this.botRepo) throw new Error('BotRepository not wired — manage_bot unavailable');

      const bot = await this.botRepo.getBotById(payload.botId);
      if (!bot || bot.userId !== agent.userId) {
        throw new Error(`Bot ${payload.botId} not found or not owned by this agent's user`);
      }

      const mergedConfig = applyAgentCapitalLimit(
        mergeBotConfig(bot.config as Record<string, unknown>, payload.config),
        agent.capital ?? null,
      );

      // Validate the merged config against BotConfigSchema before persisting
      const validation = BotConfigSchema.safeParse(mergedConfig);
      if (!validation.success) {
        const issues = validation.error.issues.map((i) =>
          `${i.path.join('.') || 'root'}: ${i.message}`
        ).join('; ');
        throw new Error(`Bot config is invalid after merge: ${issues}`);
      }

      // Safety gate: agent execution mode must not be exceeded by bot execution mode after merge.
      // Mirrors the create_and_start guard — prevents escalation via adjust_config.
      const adjustedBotMode = validation.data.execution.mode ?? 'paper';
      const agentModeForAdjust = agent.executionMode ?? 'paper';
      const MODE_RANK_ADJUST: Record<string, number> = { paper: 0, shadow: 1, live: 2 };
      if ((MODE_RANK_ADJUST[adjustedBotMode] ?? 0) > (MODE_RANK_ADJUST[agentModeForAdjust] ?? 0)) {
        const permitted = Object.keys(MODE_RANK_ADJUST).filter((m) => (MODE_RANK_ADJUST[m] ?? 0) <= (MODE_RANK_ADJUST[agentModeForAdjust] ?? 0));
        throw new Error(
          `Cannot adjust a bot to execution mode "${adjustedBotMode}". ` +
          `Permitted execution modes: ${permitted.join(', ')}.`,
        );
      }

      // Consistency model: we persist the merged config then enqueue a restart.
      // If the process crashes between these steps the bot keeps running with
      // the old in-memory config while DB holds the new config.  On the next
      // restart (manual, crash recovery, or deploy) the new config is picked up
      // from DB, converging without manual intervention.
      await this.botRepo.updateBotConfig(payload.botId, mergedConfig);

      if (bot.status === 'running' && this.botRestart) {
        try {
          // venueAccountId is resolved via startupContext.sourceVenueAccountId at job processing
          // time — no longer passed in the config payload to avoid stale/dual sources of truth.
          await this.botRestart(payload.botId, agent.userId, bot.tradingBindingId, {
            ...mergedConfig,
          });
        } catch (err) {
          logger.error(
            { botId: payload.botId, err },
            'Failed to enqueue restart job during adjust_config',
          );
          try {
            await this.botRepo.restoreBotConfig(payload.botId, bot.config as Record<string, unknown>);
          } catch (rollbackErr) {
            logger.error({ botId: payload.botId, rollbackErr }, 'CRITICAL: config rollback after restart enqueue failure also failed — DB holds new config but running actor has old config until next restart');
          }
          throw new Error(
            'Config adjustment failed: unable to enqueue restart. Please try again.',
          );
        }
      }

      return;
    }

    throw new Error(`Unknown manage_bot action: ${(payload as { action: string }).action}`);
  }

  private async handleBotQuery(agentId: string, _envelope: MessageEnvelope, payload: BotQueryPayload): Promise<void> {
    const agent = await this.agentRepo.getAgent(agentId);
    if (!agent) throw new Error('Agent not found');

    const activeSession = await this.agentRepo.getActiveSession(agent.id);
    if (!activeSession || activeSession.status !== 'running') {
      throw new Error('No running session for agent');
    }

    if (!this.botRepo) throw new Error('BotRepository not wired — bot query unavailable');

    if (payload.action === 'list_bots') {
      const since = payload.days ? new Date(Date.now() - payload.days * 24 * 60 * 60 * 1000) : undefined;
      const bots = await this.botRepo.getBotsByCreator('agent', agent.id, since);
      await this.eventPublisher.emitToolResult(agent.id, {
        tool: 'list_bots',
        status: 'ok',
        message: `Found ${bots.length} bot(s)`,
        data: bots.map((bot) => ({
          id: bot.id,
          status: bot.status,
          strategyPreset: this.deriveStrategyPresetFromBotConfig(bot.config as Record<string, unknown>),
          symbol: (bot.config as Record<string, unknown>)?.['symbol'] as string | undefined,
        })),
      });
      return;
    }

    if (payload.action === 'get_bot_status') {
      if (!payload.botId) {
        await this.eventPublisher.emitToolResult(agent.id, {
          tool: 'get_bot_status',
          status: 'error',
          message: 'botId is required for get_bot_status',
        });
        return;
      }

      const bot = await this.botRepo.getBotById(payload.botId);
      if (!bot || bot.userId !== agent.userId) {
        await this.eventPublisher.emitToolResult(agent.id, {
          tool: 'get_bot_status',
          status: 'error',
          message: `Bot ${payload.botId} not found or not owned by this agent's user`,
          botId: payload.botId,
        });
        return;
      }

      await this.eventPublisher.emitToolResult(agent.id, {
        tool: 'get_bot_status',
        status: 'ok',
        message: `Bot ${bot.id} is ${bot.status}`,
        botId: bot.id,
        data: {
          id: bot.id,
          status: bot.status,
          venueAccountId: bot.venueAccountId,
          config: bot.config,
          createdAt: bot.createdAt?.toISOString?.() ?? undefined,
          updatedAt: bot.updatedAt?.toISOString?.() ?? undefined,
        },
      });
      return;
    }

    if (payload.action === 'get_analytics') {
      const days = payload.days ?? 7;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      let analytics: {
        botCount: number;
        openPositions: number;
        closedPositions: number;
        winningPositions: number;
        realizedPnlUsd: string;
        totalFeesUsd: string;
        recentFills: number;
        avgHoldTimeHours: number | null;
        byBot: Array<{ botId: string; status: string; recentFills: number; realizedPnlUsd: string }>;
        agentDirect: { recentFills: number; realizedPnlUsd: string } | null;
      };
      try {
        analytics = await this.botRepo.getAnalyticsByCreator('agent', agent.id, since, payload.botId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error fetching analytics';
        await this.eventPublisher.emitToolResult(agent.id, {
          tool: 'get_analytics',
          status: 'error',
          message: msg,
          botId: payload.botId,
        });
        return;
      }
      const winRate = analytics.closedPositions > 0
        ? (analytics.winningPositions / analytics.closedPositions) * 100
        : 0;
      await this.eventPublisher.emitToolResult(agent.id, {
        tool: 'get_analytics',
        status: 'ok',
        message: 'Analytics summary ready',
        data: {
          ok: true,
          totalTrades: analytics.recentFills,
          winRate: Math.round(winRate * 100) / 100,
          realizedPnlUsd: analytics.realizedPnlUsd,
          totalFeesUsd: analytics.totalFeesUsd,
          openPositions: analytics.openPositions,
          botCount: analytics.botCount,
          avgHoldTimeHours: analytics.avgHoldTimeHours,
          byBot: analytics.byBot,
          agentDirect: analytics.agentDirect,
          days,
        },
      });
      return;
    }

    if (payload.action === 'list_positions') {
      let positions: Array<{
        actorType: string;
        actorId: string | null;
        symbol: string;
        side: string;
        size: string;
        entryPrice: string;
        openedAt: Date;
      }>;
      try {
        positions = await this.botRepo.getOpenPositionsByCreator('agent', agent.id, payload.botId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error fetching positions';
        await this.eventPublisher.emitToolResult(agent.id, {
          tool: 'list_positions',
          status: 'error',
          message: msg,
          botId: payload.botId,
        });
        return;
      }
      await this.eventPublisher.emitToolResult(agent.id, {
        tool: 'list_positions',
        status: 'ok',
        message: `Found ${positions.length} open position(s)`,
        data: {
          ok: true,
          note: 'unrealizedPnl not available — mark prices are not cached in the agent process',
          positions: positions.map((position) => ({
            actorType: position.actorType,
            actorId: position.actorId,
            botId: position.actorType === 'bot' ? position.actorId : null,
            instrumentId: position.symbol,
            side: position.side,
            size: position.size,
            entryPrice: position.entryPrice,
            openedAt: position.openedAt.toISOString(),
          })),
        },
      });
      return;
    }

    throw new Error(`Unknown bot query action: ${(payload as { action: string }).action}`);
  }
}

function mergeBotConfig(baseConfig: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...baseConfig };

  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      merged[key] = mergeBotConfig(current, value);
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

function configsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyAgentCapitalLimit(config: Record<string, unknown>, capital: string | number | null | undefined): Record<string, unknown> {
  const capitalLimit = parsePositiveDecimal(capital);
  if (!capitalLimit) {
    return config;
  }

  const riskConfig = isPlainObject(config['risk']) ? { ...config['risk'] } : {};
  const configuredMaxOrderNotional = parsePositiveDecimal(riskConfig['maxOrderNotional']);

  riskConfig['maxOrderNotional'] = configuredMaxOrderNotional && configuredMaxOrderNotional.lte(capitalLimit)
    ? configuredMaxOrderNotional.toString()
    : capitalLimit.toString();

  return {
    ...config,
    risk: riskConfig,
  };
}

function parsePositiveDecimal(value: unknown): Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const rawValue = String(value).trim();
  if (!rawValue) {
    return null;
  }

  try {
    const decimalValue = new Decimal(rawValue);
    return decimalValue.isFinite() && decimalValue.gt(0) ? decimalValue : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
