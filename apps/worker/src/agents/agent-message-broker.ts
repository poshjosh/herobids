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
  AgentRiskDefaultsConfig,
  ToolPositionRecord,
  AssessStrategyPresetRequestPayload,
  ChangeStrategyPresetRequestPayload,
  ToolContext,
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
  checkModeEscalation,
  resolveEffectiveLlmSelection,
  renderEmail,
} from '@herobids/domain';
import type { AgentRepository, BotRepository, Database } from '@herobids/db';
import { PgJournal } from '@herobids/db';
import { forceReply, type TelegramClient } from '../alerting/telegram-client.js';
import type { EmailClient } from '../alerting/email-client.js';
import type { AgentDecisionHandler } from './agent-decision-handler.js';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import { CapabilityPolicyEngine, DEFAULT_CAPABILITY_GRANTS } from './capability-policy.js';
import type { CapabilityGrant } from './capability-policy.js';
import { assessStrategyPresetTool } from '../tools/assess-strategy-preset.js';
import { changeStrategyPresetTool } from '../tools/change-strategy-preset.js';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-message-broker');

/** Brokered send_message rate limit: max messages per agent per minute. */
const SEND_MESSAGE_MAX_PER_MINUTE = 10;
/** Max body length enforced server-side (matches domain schema). */
const SEND_MESSAGE_MAX_BODY_LENGTH = 2000;

/**
 * Callback the broker uses to enqueue a bot start job on the runtime queue.
 * Decouples the broker from BullMQ — the caller wires this to queue.add().
 * connectionId is explicit so the type system enforces the connection-first routing contract.
 */
export type BotStartCallback = (botId: string, userId: string, connectionId: string, config: Record<string, unknown>) => Promise<void>;

/** Callback used to enqueue a bot stop job on the runtime queue. */
export type BotStopCallback = (botId: string, userId: string) => Promise<void>;

/** Callback used to enqueue a bot restart job on the runtime queue. */
export type BotRestartCallback = (botId: string, userId: string, connectionId: string, config: Record<string, unknown>) => Promise<void>;

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
  /**
   * Per-agent capability policy cache: agentId → { engine, policySig }.
   * policySig is the JSON fingerprint of the agent's toolPolicy at build time.
   * When toolPolicy changes (e.g. PATCH /agents/:id updates skillIds), the sig
   * differs and the engine is rebuilt so the new grants take effect immediately.
   */
  private readonly capabilityEngines = new Map<string, { engine: CapabilityPolicyEngine; policySig: string }>();

  constructor(
    private readonly redis: Redis,
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
    private readonly agentRiskDefaults?: AgentRiskDefaultsConfig,
    private readonly brandImageUrl?: string,
    private readonly db?: Database,
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
      [AGENT_MESSAGE_TYPES.TOOL_ASSESS_STRATEGY_PRESET]: 'assess_strategy_preset',
      [AGENT_MESSAGE_TYPES.TOOL_CHANGE_STRATEGY_PRESET]: 'change_strategy_preset',
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

        case AGENT_RUNTIME_ACTIVITY_TYPES.TICK_SKIPPED:
          // Billing events trigger user notification
          if (envelope.payload.reason === 'billing.soft_limit_reached'
              || envelope.payload.reason === 'billing.limit_exceeded') {
            await this.handleBillingNotification(effectiveAgentId, envelope.payload);
          }
          // Audit-only otherwise — persisted with payload, no other business side effects.
          break;

        case AGENT_RUNTIME_ACTIVITY_TYPES.TICK_STARTED:
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

        case AGENT_MESSAGE_TYPES.TOOL_ASSESS_STRATEGY_PRESET:
          await this.handleAssessStrategyPreset(effectiveAgentId, envelope);
          break;

        case AGENT_MESSAGE_TYPES.TOOL_CHANGE_STRATEGY_PRESET:
          await this.handleChangeStrategyPreset(effectiveAgentId, envelope);
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
      location: payload.body
        ? { ...(payload.location ?? {}), body: payload.body }
        : payload.location,
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

    // Email fanout from send_message has been removed (Item 5).
    // Agents should use the dedicated send_email tool for email delivery.
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

      // Resolve the connection using the same runtime descriptor the agent sees in its prompt.
      // Primary path: connectionId (the agent sees this in its readiness summary).
      // Fallback: default trading connection for the agent.
      const capabilityDescriptor = await this.agentRepo.getRuntimeCapabilityDescriptor(agent.id);
      const grantedTradingConnections = capabilityDescriptor.grantedConnectionsByFamily['trading'] ?? [];
      const defaultConnectionId = capabilityDescriptor.defaultConnectionByFamily['trading'];

      let connection: (typeof grantedTradingConnections)[number] | undefined;

      if (payload.connectionId) {
        // Primary: resolve by connectionId — what the agent sees in readiness
        const byConnectionId = grantedTradingConnections.filter(
          (candidate) => candidate.connectionId === payload.connectionId,
        );
        if (byConnectionId.length === 0) {
          throw new Error(`No trading capability connection found with connectionId ${payload.connectionId}`);
        }
        if (byConnectionId.length > 1) {
          throw new Error(`Multiple trading capability connections found with connectionId ${payload.connectionId}`);
        }
        connection = byConnectionId[0];
      } else {
        // Default: use the agent's default trading connection
        connection = grantedTradingConnections.find((candidate) => candidate.connectionId === defaultConnectionId);
      }
      if (!connection || !connection.readiness.effectiveReady) {
        throw new Error('No ready trading capability connection found for this agent — cannot create bot');
      }

      // Resolve venue account from the connection's resolvedVenueAccountId directly.
      const connRow = await this.botRepo!.getResolvedVenueAccount(connection.connectionId);
      if (!connRow || !connRow.resolvedVenueAccountId) {
        throw new Error(`Connection ${connection.connectionId} has no resolved venue account — cannot create bot`);
      }

      // Security: verify the connection belongs to the agent's own user before creating the bot.
      const owned = await this.botRepo!.isConnectionOwnedBy(connection.connectionId, agent.userId);
      if (!owned) {
        throw new Error(`Trading connection ${connection.connectionId} not found or not owned by this agent's user`);
      }

      // Enforce subscription-wide plan bot cap (same limit the API enforces for direct bot creation).
      if (this.botLimitCheck) {
        await this.botLimitCheck(agent.userId);
      }

      // Stamp venue/venueType unconditionally — agent-provided values are discarded
      const venueType = venueTypeFromProvider(connRow.venue);
      if (!venueType) {
        throw new Error(`Unsupported venue "${connRow.venue}" resolved from trading connection — cannot create bot`);
      }
      const rawConfig = applyAgentCapitalLimit(payload.config, agent.capital ?? null);
      rawConfig['venue'] = connRow.venue;
      rawConfig['venueType'] = venueType;

      // Stamp agent-resolved LLM provider/model into strategy.params for llm/hybrid bots.
      // Agent-created bots must inherit the creator's LLM selection so they don't silently
      // fall back to hardcoded defaults that may have no credentials configured.
      // Priority: agent.unifiedConfig.intelligence (agent self-config) > modelPolicy (API-set) > user AI defaults.
      const strategyType = (payload.config?.strategy as Record<string, unknown> | undefined)?.type as string | undefined;
      const decisionMode = (payload.config?.strategy as Record<string, unknown> | undefined)?.decisionMode as string | undefined;
      if (strategyType !== 'dca' && (decisionMode === 'llm' || decisionMode === 'hybrid')) {
        const userAiModelConfig = await this.agentRepo.getUserAiModelConfig(agent.userId);
        const modelPolicy = (agent.modelPolicy as Record<string, unknown> | null | undefined) ?? null;
        const resolved = resolveEffectiveLlmSelection({
          agentConfig: {
            // Agent self-config (set at runtime) takes priority over API-set modelPolicy
            provider: (agent.unifiedConfig?.intelligence?.provider as string | undefined)
              ?? (typeof modelPolicy?.['provider'] === 'string' ? modelPolicy['provider'] : undefined),
            lightModel: (agent.unifiedConfig?.intelligence?.lightModel as string | undefined)
              ?? (typeof modelPolicy?.['lightModel'] === 'string' ? modelPolicy['lightModel'] : undefined),
            heavyModel: (agent.unifiedConfig?.intelligence?.heavyModel as string | undefined)
              ?? (typeof modelPolicy?.['heavyModel'] === 'string' ? modelPolicy['heavyModel'] : undefined),
            userModelDefaults: userAiModelConfig ? {
              provider: userAiModelConfig.provider,
              lightModel: userAiModelConfig.lightModel,
              heavyModel: userAiModelConfig.heavyModel,
            } : null,
          },
        });
        // Use heavy model for bot decisions; fall back to light model.
        const botProvider = resolved.provider;
        const botModel = resolved.heavyModel ?? resolved.lightModel;
        if (botProvider && botModel) {
          const strategyParams = (rawConfig['strategy'] as Record<string, unknown>) ?? {};
          strategyParams['params'] = {
            ...(strategyParams['params'] as Record<string, unknown> ?? {}),
            provider: botProvider,
            model: botModel,
          };
          rawConfig['strategy'] = strategyParams;
        }
      }

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
      // Read execution mode from canonical executionDefaults.mode (no legacy column fallback)
      const agentMode = agent.executionDefaults?.mode ?? 'paper';
      const botMode = validatedConfig.execution.mode ?? 'paper';
      const modeCheck = checkModeEscalation(botMode, agentMode, 'create');
      if (!modeCheck.allowed) {
        throw new Error(modeCheck.error);
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
        if (typeof symbol !== 'string') {
          throw new Error(
            `Invalid symbol type. Expected a string BASE/QUOTE format (e.g. "ETH/USDC"), got ${typeof symbol}.`,
          );
        }
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

      // Atomically check agent-level maxBots limit and create the bot.
      // The count + insert happen inside a single transaction so two concurrent
      // creates cannot both see "under limit" and both create.
      const maxBots = agent.maxBots ?? this.agentRiskDefaults?.maxBots ?? 5;
      const createResult = await this.botRepo!.tryCreateBotWithLimit({
        userId: agent.userId,
        connectionId: connection.connectionId,
        venueAccountId: connRow.resolvedVenueAccountId,
        config: validatedConfig,
        creatorType: 'agent',
        creatorId: agent.id,
        maxBots,
      });

      if (!createResult.created) {
        throw new Error(`Agent has reached its max concurrent bots limit (${maxBots}). Stop a bot before creating a new one.`);
      }

      const botId = createResult.botId!;

      logger.info({ agentId: agent.id, botId }, 'Agent created bot via manage_bot');

      if (this.botStart) {
        // Atomically claim a running slot for the newly created bot.
        const claimed = await this.botRepo!.tryMarkBotRunningWithLimit(
          botId, 'agent', agent.id, maxBots,
        );
        if (!claimed) {
          // Shouldn't happen since we just created under the limit, but defend against races.
          throw new Error(`Agent has reached its max concurrent bots limit (${maxBots}). Stop a bot before creating a new one.`);
        }
        await this.botStart(botId, agent.userId, connection.connectionId, {
          ...validatedConfig,
          venueAccountId: connRow.resolvedVenueAccountId,
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

      // Preflight: validate persisted config before marking running.
      // A persisted invalid config (legacy, corrupted, etc.) must not be pushed
      // through start → fail → retry cycles.
      const configValidation = BotConfigSchema.safeParse(effectiveConfig);
      if (!configValidation.success) {
        const details = configValidation.error.issues.map((i) =>
          `${i.path.join('.') || 'root'}: ${i.message}`
        ).join('; ');
        throw new Error(`Bot config is invalid — cannot start. Fix the config before retrying: ${details}`);
      }

      // Enforce agent-level maxBots limit for new starts.
      // Reclaim (bot already running) is exempt — the bot already holds a slot.
      const maxBots = agent.maxBots ?? this.agentRiskDefaults?.maxBots ?? 5;
      const isReclaim = bot.status === 'running';

      // Consistency model: we mark the bot running in DB then enqueue the
      // lifecycle start job.  If the process crashes between these two steps
      // the bot will be marked 'running' with no active actor — the worker's
      // periodic reclaim sweep (WorkerRuntime.reclaimOrphans) detects this and
      // re-starts the actor, converging DB and runtime without manual intervention.
      if (this.botStart) {
        if (isReclaim) {
          // Reclaim: bot already running, just remark it (preserve startedAt) and enqueue.
          await this.botRepo.markBotRunning(payload.botId);
        } else {
          // New start: atomically check limit and claim a slot.
          const claimed = await this.botRepo.tryMarkBotRunningWithLimit(
            payload.botId, bot.creatorType, bot.creatorId ?? '', maxBots,
          );
          if (!claimed) {
            throw new Error(
              `Agent has reached its max concurrent bots limit (${maxBots}). Stop a bot before starting a new one.`,
            );
          }
        }
        try {
          // venueAccountId is resolved via startupContext at job processing
          // time — no longer passed in the config payload to avoid stale/dual sources of truth.
          await this.botStart(payload.botId, agent.userId, bot.connectionId, {
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
        if (isReclaim) {
          await this.botRepo.markBotRunning(payload.botId);
        } else {
          const claimed = await this.botRepo.tryMarkBotRunningWithLimit(
            payload.botId, bot.creatorType, bot.creatorId ?? '', maxBots,
          );
          if (!claimed) {
            throw new Error(
              `Agent has reached its max concurrent bots limit (${maxBots}). Stop a bot before starting a new one.`,
            );
          }
        }
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

      const baseConfig = bot.config as Record<string, unknown>;
      const mergedConfig = applyAgentCapitalLimit(
        mergeBotConfig(baseConfig, payload.config),
        agent.capital ?? null,
      );

      // Preserve previously stamped LLM provider/model for agent-created llm/hybrid bots.
      // The agent tool contract does not expose provider/model, so the merge should not
      // accidentally drop them from strategy.params.
      if (bot.creatorType === 'agent') {
        const baseStrategy = extractStrategyFromConfig(baseConfig);
        const mergedStrategy = extractStrategyFromConfig(mergedConfig);
        if (
          baseStrategy && mergedStrategy &&
          baseStrategy.type !== 'dca' &&
          (baseStrategy.decisionMode === 'llm' || baseStrategy.decisionMode === 'hybrid')
        ) {
          const baseParams = (baseStrategy.params ?? {}) as Record<string, unknown>;
          const mergedParams = (mergedStrategy.params ?? {}) as Record<string, unknown>;
          const preservedProvider = baseParams['provider'] as string | undefined;
          const preservedModel = baseParams['model'] as string | undefined;
          if (preservedProvider && !mergedParams['provider']) {
            (mergedConfig['strategy'] as Record<string, unknown>)['params'] = {
              ...mergedParams,
              provider: preservedProvider,
            };
          }
          if (preservedModel && !mergedParams['model']) {
            (mergedConfig['strategy'] as Record<string, unknown>)['params'] = {
              ...((mergedConfig['strategy'] as Record<string, unknown>)?.['params'] as Record<string, unknown> ?? {}),
              model: preservedModel,
            };
          }
        }
      }

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
      const agentModeForAdjust = agent.executionDefaults?.mode ?? 'paper';
      const modeCheck = checkModeEscalation(adjustedBotMode, agentModeForAdjust, 'adjust');
      if (!modeCheck.allowed) {
        throw new Error(modeCheck.error);
      }

      // Consistency model: we persist the merged config then enqueue a restart.
      // If the process crashes between these steps the bot keeps running with
      // the old in-memory config while DB holds the new config.  On the next
      // restart (manual, crash recovery, or deploy) the new config is picked up
      // from DB, converging without manual intervention.
      await this.botRepo.updateBotConfig(payload.botId, mergedConfig);

      if (bot.status === 'running' && this.botRestart) {
        try {
          // venueAccountId is resolved via startupContext at job processing
          // time — no longer passed in the config payload to avoid stale/dual sources of truth.
          await this.botRestart(payload.botId, agent.userId, bot.connectionId, {
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
        data: {
          ok: true,
          bots: bots.map((bot) => ({
            id: bot.id,
            status: bot.status,
            strategyPreset: this.deriveStrategyPresetFromBotConfig(bot.config as Record<string, unknown>),
            symbol: (bot.config as Record<string, unknown>)?.['symbol'] as string | undefined,
          })),
        },
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
      let positions: ToolPositionRecord[];
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
            symbol: position.symbol,
            instrumentId: position.instrumentId ?? null,
            venue: position.venue,
            side: position.side,
            size: position.size,
            entryPrice: position.entryPrice,
            stopLoss: position.stopLoss ?? null,
            takeProfit: position.takeProfit ?? null,
            openedAt: position.openedAt.toISOString(),
          })),
        },
      });
      return;
    }

    throw new Error(`Unknown bot query action: ${(payload as { action: string }).action}`);
  }

  /**
   * Handle a brokered assess_strategy_preset request from an agent container.
   * Builds a minimal ToolContext and delegates to the tool's execute function.
   * The ports are already wired in the worker process.
   */
  private async handleAssessStrategyPreset(agentId: string, envelope: MessageEnvelope): Promise<void> {
    const payload = envelope.payload as AssessStrategyPresetRequestPayload;
    try {
      const toolCtx = this.buildPresetToolContext(agentId, envelope.correlationId ?? payload.sessionId);

      const toolResult = await assessStrategyPresetTool.execute(payload, toolCtx);

      const resultPayload = {
        requestMessageId: envelope.messageId,
        correlationId: envelope.correlationId,
        result: toolResult,
      };
      await this.eventPublisher.emitAssessStrategyPresetResult(agentId, resultPayload);

      // Also publish to reply list for synchronous tool response when requestMessageId is set
      if (payload.requestMessageId) {
        await this.eventPublisher.publishPresetToolReply(payload.requestMessageId, toolResult as unknown as Record<string, unknown>);
      }
    } catch (err) {
      logger.error({ agentId, err }, 'Assess strategy preset handler failed');
      const errorResult = {
        success: false,
        error: err instanceof Error ? err.message : 'Unexpected broker error',
        errorCode: 'broker.internal_error',
        fault: true,
      };
      const errorPayload = {
        requestMessageId: envelope.messageId,
        correlationId: envelope.correlationId,
        result: errorResult,
      };
      await this.eventPublisher.emitAssessStrategyPresetResult(agentId, errorPayload);

      if (payload.requestMessageId) {
        await this.eventPublisher.publishPresetToolReply(payload.requestMessageId, errorResult as unknown as Record<string, unknown>);
      }
      return;
    }
  }

  /**
   * Handle a brokered change_strategy_preset request from an agent container.
   * Builds a minimal ToolContext with db access and delegates to the tool's execute function.
   * The ports are already wired in the worker process.
   */
  private async handleChangeStrategyPreset(agentId: string, envelope: MessageEnvelope): Promise<void> {
    const payload = envelope.payload as ChangeStrategyPresetRequestPayload;
    try {
      const toolCtx = this.buildPresetToolContext(agentId, envelope.correlationId ?? payload.sessionId);

      const toolResult = await changeStrategyPresetTool.execute(payload, toolCtx);

      const resultPayload = {
        requestMessageId: envelope.messageId,
        correlationId: envelope.correlationId,
        result: toolResult,
      };
      await this.eventPublisher.emitChangeStrategyPresetResult(agentId, resultPayload);

      // Also publish to reply list for synchronous tool response when requestMessageId is set
      if (payload.requestMessageId) {
        await this.eventPublisher.publishPresetToolReply(payload.requestMessageId, toolResult as unknown as Record<string, unknown>);
      }
    } catch (err) {
      logger.error({ agentId, err }, 'Change strategy preset handler failed');
      const errorResult = {
        success: false,
        error: err instanceof Error ? err.message : 'Unexpected broker error',
        errorCode: 'broker.internal_error',
        fault: true,
      };
      const errorPayload = {
        requestMessageId: envelope.messageId,
        correlationId: envelope.correlationId,
        result: errorResult,
      };
      await this.eventPublisher.emitChangeStrategyPresetResult(agentId, errorPayload);

      if (payload.requestMessageId) {
        await this.eventPublisher.publishPresetToolReply(payload.requestMessageId, errorResult as unknown as Record<string, unknown>);
      }
      return;
    }
  }

  /**
   * Build a minimal ToolContext for preset tool execution in the broker.
   * Only provides the fields that the preset tools actually use:
   * - agentId, agentConfigOps (getCurrentConfig, appendJournal), db
   * All other ToolContext fields are stubbed since the preset tools don't access them.
   */
  private buildPresetToolContext(agentId: string, sessionId: string): ToolContext {
    const db = this.db;
    const journal = db ? new PgJournal(db) : null;

    const agentConfigOps: ToolContext['agentConfigOps'] = {
      getCurrentConfig: () => this.agentRepo.getUnifiedConfig(agentId),
      persistConfig: async () => {},
      appendJournal: (type, payload) => {
        if (!journal) {
          logger.warn({ agentId, type }, 'Journal append skipped — db not wired to broker');
          return Promise.resolve();
        }
        return journal.append({ actorType: 'agent', actorId: agentId, type, payload });
      },
      notifyActorConfigUpdate: async () => {},
      getLlmTickCount: () => 0,
    };

    return {
      agentId,
      sessionId,
      phase: 'judge',
      executionMode: 'paper',
      authorizationMode: 'direct',
      redis: {
        hset: async () => 0,
        hget: async () => null,
        hgetall: async () => null,
        hdel: async () => 0,
        publish: async () => 0,
        blpop: async () => null,
        smembers: async () => [],
        sadd: async () => 0,
        srem: async () => 0,
        expire: async () => 0,
      },
      publishToInbound: async () => {},
      agentConfigOps,
      db: db as unknown,
    };
  }

  /**
   * Dispatch billing notifications (Telegram + email) for soft-cap and hard-cap events.
   * Deduplicates via Redis so the user is only notified on status transition.
   */
  private async handleBillingNotification(
    agentId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const reason = payload.reason as string;
    const openPositions = payload.openPositions as string[] | undefined;

    // 1. Look up the agent for notification routing
    const agent = await this.agentRepo.getAgent(agentId);
    if (!agent) return;

    // 2. Deduplicate — only notify on status transition, not every tick
    const DEDUP_STATUS: Record<string, string> = {
      'billing.soft_limit_reached': 'soft_limited',
      'billing.limit_exceeded': 'hard_limited',
    };
    const dedupStatus = DEDUP_STATUS[reason];
    if (!dedupStatus) {
      logger.warn({ agentId, reason }, 'Unknown billing reason — skipping notification');
      return;
    }
    const dedupKey = `agent:billing:notified:${agentId}`;
    const cachedStatus = await this.redis.get(dedupKey);
    if (cachedStatus === dedupStatus) {
      logger.debug({ agentId, reason }, 'Billing notification suppressed — status unchanged');
      return;
    }

    // 3. Build the message text
    const isHard = reason === 'billing.limit_exceeded';
    const message = isHard
      ? this.buildHardLimitMessage(agent.name, openPositions)
      : this.buildSoftLimitMessage(agent.name);

    let anyDelivered = false;

    // 4. Send Telegram notification
    const chatId = await this.agentRepo.getEffectiveTelegramChatId(agentId);
    if (chatId && this.telegram) {
      const result = await this.telegram.sendText(chatId, message);
      if (result.ok) {
        logger.info({ agentId, reason, chatId }, 'Billing notification sent via Telegram');
        anyDelivered = true;
      } else {
        logger.warn({ agentId, reason, error: result.error }, 'Billing notification Telegram delivery failed');
      }
    }

    // 5. Send email notification (if configured)
    if (this.emailClient) {
      const recipientEmail = await this.agentRepo.getUserEmailByAgentId(agentId);
      if (recipientEmail) {
        const emailContent = isHard
          ? this.buildHardLimitEmailContent(agent.name, openPositions)
          : this.buildSoftLimitEmailContent(agent.name);
        const rendered = renderEmail({
          ...emailContent,
          ...(this.brandImageUrl ? { brandImageUrl: this.brandImageUrl } : {}),
        });
        const result = await this.emailClient.send({
          to: recipientEmail,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        });
        if (result.ok) {
          logger.info({ agentId, reason, email: recipientEmail }, 'Billing notification sent via email');
          anyDelivered = true;
        } else {
          logger.warn({ agentId, reason, error: result.error }, 'Billing notification email delivery failed');
        }
      }
    }

    if (!anyDelivered) {
      logger.error({ agentId, reason }, 'Billing notification failed on all channels — user not notified');
    }

    // 6. Update dedup cache after dispatch attempt (even if delivery partially failed,
    //    we mark as notified to avoid spamming on every tick).
    try {
      await this.redis.set(dedupKey, dedupStatus, 'EX', 86400); // 24h TTL
    } catch (err) {
      logger.warn({ agentId, dedupKey, err }, 'Failed to write billing dedup cache — duplicate notification possible on next tick');
    }
  }

  /** Build the soft-cap notification message (HTML for Telegram). */
  private buildSoftLimitMessage(agentName: string): string {
    return [
      `ℹ️ Agent "<b>${escapeHtml(agentName)}</b>" has reached its soft spending cap.`,
      '',
      'Your agent is still running and trading normally. No behavior has changed.',
      '',
      'To raise or remove the cap, visit Billing → Spend Controls.',
    ].join('\n');
  }

  /** Build the hard-cap notification message (HTML for Telegram). */
  private buildHardLimitMessage(agentName: string, openPositions?: string[]): string {
    const lines: string[] = [
      `⚠️ Agent "<b>${escapeHtml(agentName)}</b>" has stopped — hard spending cap reached.`,
      '',
    ];

    if (openPositions && openPositions.length > 0) {
      lines.push(
        `Open positions are no longer monitored: ${openPositions.map((p) => escapeHtml(p)).join(', ')}`,
        '',
        'These positions will remain unmanaged until you take action. The agent will not close them automatically.',
        '',
      );
    } else {
      lines.push(
        'No further LLM calls will be made until you top up or raise the cap.',
        '',
      );
    }

    lines.push('Visit Billing → Spend Controls to top up or raise the cap.');
    return lines.join('\n');
  }

  /** Build branded email content for soft-cap notification. */
  private buildSoftLimitEmailContent(agentName: string) {
    return {
      subject: `ℹ️ ${agentName} approaching spending cap`,
      preheader: 'Your agent is approaching its spending cap',
      title: 'Spending Cap Notice',
      body: [
        `Agent <strong>${escapeHtml(agentName)}</strong> has reached its soft spending cap.`,
        '',
        'Your agent is still running and trading normally. No behavior has changed.',
        '',
        'To raise or remove the cap, visit <strong>Billing → Spend Controls</strong>.',
      ].join('\n'),
      footerNote: 'This is an automated notification from your agent platform.',
    };
  }

  /** Build branded email content for hard-cap notification. */
  private buildHardLimitEmailContent(agentName: string, openPositions?: string[]) {
    const bodyLines: string[] = [
      `Agent <strong>${escapeHtml(agentName)}</strong> has stopped because it reached its hard spending cap.`,
    ];

    if (openPositions && openPositions.length > 0) {
      bodyLines.push(
        '',
        `<strong>Open positions are no longer monitored:</strong> ${openPositions.map((p) => escapeHtml(p)).join(', ')}`,
        '',
        'These positions will remain unmanaged until you take action. The agent will not close them automatically.',
      );
    } else {
      bodyLines.push(
        '',
        'No further LLM calls will be made until you top up or raise the cap.',
      );
    }

    bodyLines.push(
      '',
      'Visit <strong>Billing → Spend Controls</strong> to top up or raise the cap.',
    );

    return {
      subject: `⚠️ ${agentName} stopped — spending cap reached`,
      preheader: 'Your agent has reached its hard spending cap',
      title: 'Agent Stopped',
      body: bodyLines.join('\n'),
      footerNote: 'This is an automated notification from your agent platform.',
    };
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
    ? configuredMaxOrderNotional.toNumber()
    : capitalLimit.toNumber();

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
