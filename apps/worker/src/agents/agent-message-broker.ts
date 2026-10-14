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
  ManageAgentSkillsPayload,
  ConnectionRequestPayload,
  ConnectionRequestResult,
  OperatorModelDefaults,
  PlansConfig,
} from '@herobids/domain';
import {
  MessageEnvelopeSchema,
  MESSAGE_PAYLOAD_SCHEMAS,
  AGENT_MESSAGE_TYPES,
  AGENT_RUNTIME_ACTIVITY_TYPES,
  resolveEffectiveLlmSelection,
  renderEmail,
  ManageAgentSkillsPayloadSchema,
  ConnectionRequestRecordSchema,
  PROVIDER_DISCOVERY,
  getRuntimeFamiliesForProvider,
  resolvePlanSkillEntitlements,
  AuthConfigSchema,
  ConnectionRequestsConfigSchema,
} from '@herobids/domain';
import type { AgentRepository, ConnectionOwnershipRepository, Database } from '@herobids/db';
import { setupTradingForAgent, loadTestDefaults, type OperatorDefaultsReadBoundary, type SetupTradingDeps, type TradingProfileReconciliationSaga } from '@herobids/db';
import type { ManageTradingSetupPayload, TradingSetupResult, UpdatePromptPayload, UpdatePromptResult } from '@herobids/domain';
import { eq, inArray } from 'drizzle-orm';
import { agentSkills, skills, users, resolveSkillAssignmentsForUser, syncAgentSkillAssignments } from '@herobids/db';
import { randomUUID, randomBytes } from 'node:crypto';
import type { ChatDelivery } from '../alerting/chat-delivery.js';
import type { EmailClient } from '../alerting/email-client.js';
import type { AgentDecisionHandler } from './agent-decision-handler.js';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import { CapabilityPolicyEngine, DEFAULT_CAPABILITY_GRANTS } from './capability-policy.js';
import type { CapabilityGrant } from './capability-policy.js';
import type { ExternalBackendWriteBoundary } from '../external-backend/write-adapter.js';
import type { ExternalBackendClientResult, ExternalBackendSubject } from '@herobids/domain/external-backend';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-message-broker');

/** Brokered send_message rate limit: max messages per agent per minute. */
const SEND_MESSAGE_MAX_PER_MINUTE = 10;
/** Max body length enforced server-side (matches domain schema). */
const SEND_MESSAGE_MAX_BODY_LENGTH = 2000;

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
/** Platform dependencies for `set_trading_setup`. Absent → the broker replies with a typed unavailable error. */
export interface BrokerTradingSetupDeps {
  saga: TradingProfileReconciliationSaga;
  client: SetupTradingDeps['client'];
  readBoundary: OperatorDefaultsReadBoundary;
  plansConfig?: SetupTradingDeps['plansConfig'];
}

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
    private readonly chatDelivery?: ChatDelivery,
    private readonly botRepo?: ConnectionOwnershipRepository,
    private readonly botLiveCheck?: BotLiveCheckCallback,
    private readonly emailClient?: EmailClient,
    readonly onAgentConfigUpdate?: (agentId: string, config: Record<string, unknown> | null) => void,
    private readonly brandImageUrl?: string,
    private readonly db?: Database,
    private readonly operatorModelDefaults?: OperatorModelDefaults,
    readonly plansConfig?: PlansConfig,
    // L3c: the Traderton side-effecting boundary. When present, bot lifecycle
    // (create/start/stop/adjust) routes over REST instead of the in-process
    // lifecycle queue + actor. When absent (unconfigured), lifecycle actions
    // fail with a typed precondition — NEVER a silent fall back to the engine.
    private readonly sideEffectBoundary?: ExternalBackendWriteBoundary,
    private readonly publicBaseUrl?: string,
    private readonly connectionRequests?: { ttlSecs: number; maxPendingPerAgent: number; expiryGraceSecs: number },
    private readonly tradingSetup?: BrokerTradingSetupDeps,
  ) {}

  /** Resolved public base URL for link construction (operator config default when unset). */
  private get resolvedPublicBaseUrl(): string {
    return this.publicBaseUrl ?? AuthConfigSchema.parse({}).publicBaseUrl;
  }

  /** Resolved connection-request limits (operator config defaults when unset). */
  private get resolvedConnectionRequests(): { ttlSecs: number; maxPendingPerAgent: number; expiryGraceSecs: number } {
    return this.connectionRequests ?? ConnectionRequestsConfigSchema.parse({});
  }

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
      [AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS]: 'manage_agent_skills',
      [AGENT_MESSAGE_TYPES.REQUEST_CONNECTION]: 'request_connection',
      [AGENT_MESSAGE_TYPES.MANAGE_TRADING_SETUP]: 'set_trading_setup',
      [AGENT_MESSAGE_TYPES.UPDATE_PROMPT]: 'update_my_prompt',
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
        logger.warn({
          agentId: effectiveAgentId,
          capability: capabilityName,
          reason: denied.reason,
          limit: denied.limit,
          used: denied.used,
          retryAfterMs: denied.retryAfterMs,
        }, 'Capability policy denied');

        // Push a denial reply to the Redis reply key so the tool's blpop doesn't time out.
        const replyKey = this.extractDenialReplyKey(envelope);
        if (replyKey) {
          const replyPayload = JSON.stringify({
            status: 'rejected',
            code: `capability_denied:${denied.reason}`,
            message: denied.message,
            retryAfterMs: denied.retryAfterMs,
            limit: denied.limit,
            used: denied.used,
          });
          await this.redis.lpush(replyKey, replyPayload);
          await this.redis.expire(replyKey, 60);
        }

        return { accepted: false, error: `capability_denied:${denied.reason}` };
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

        // c4.9i: the BOT_QUERY receive path is dead — nothing publishes
        // `agent.bot.query` (agents read bots/analytics/positions over the
        // Traderton boundary via the read tools). The handler + its local
        // trading-table reads were removed. The protocol enum/schema binding
        // remain as the shared contract definition.

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
              || envelope.payload.reason === 'billing.limit_exceeded'
              || envelope.payload.reason === 'billing.insufficient_funds'
              || envelope.payload.reason === 'billing.account_suspended') {
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

        case AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS:
          await this.handleManageAgentSkills(
            effectiveAgentId,
            envelope,
            envelope.payload as unknown as ManageAgentSkillsPayload,
          );
          break;

        case AGENT_MESSAGE_TYPES.UPDATE_PROMPT:
          await this.handleUpdatePrompt(
            effectiveAgentId,
            envelope,
            envelope.payload as unknown as UpdatePromptPayload,
          );
          break;

        case AGENT_MESSAGE_TYPES.MANAGE_TRADING_SETUP:
          await this.handleManageTradingSetup(
            effectiveAgentId,
            envelope,
            envelope.payload as unknown as ManageTradingSetupPayload,
          );
          break;

        case AGENT_MESSAGE_TYPES.REQUEST_CONNECTION:
          await this.handleRequestConnection(
            effectiveAgentId,
            envelope,
            envelope.payload as unknown as ConnectionRequestPayload,
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

    const result = this.chatDelivery
      ? await this.chatDelivery.send(agent.id, {
        agentName: agent.name,
        subject: payload.subject,
        body,
        messageClass,
        replyRequested: true,
      })
      : { ok: false as const, error: { code: 'chat.not_configured', message: 'telegram_not_configured' } };
    if (!result.ok) {
      if (result.error.code === 'chat.address_lookup_failed') throw new Error(result.error.message);
      logger.warn({ agentId: agent.id, error: result.error }, 'send_message chat delivery failed');
      await this.agentRepo.markOutboundMessageFailed(msgId, result.error.message);
    } else {
      await this.agentRepo.markOutboundMessageSent(msgId, result.data.providerMessageId, result.data.address.address);
      logger.info({ agentId: agent.id, msgId }, 'Agent send_message delivered via chat');
    }

    // Email fanout from send_message has been removed (Item 5).
    // Agents should use the dedicated send_email tool for email delivery.
  }

  /**
   * L3c: route a bot-lifecycle side effect to the Traderton boundary, injecting
   * `ownerId` + `actor` only (D2). Throws a descriptive error on any non-success
   * outcome (transport, in_progress, or a typed failure) so `processInbound`'s
   * catch marks the message failed — matching the pre-L3c throw-based error path.
   * NO silent fallback to the in-process engine (L3c posture).
   */
  private async invokeBotLifecycle(
    toolName: 'create_bot' | 'start_bot' | 'stop_bot' | 'adjust_bot_config',
    payload: Record<string, unknown>,
    subject: ExternalBackendSubject,
    // The inbound messageId: persisted (agent_messages) before routing, and one
    // manage_bot message makes exactly one lifecycle write (D18).
    idempotencyKey: string,
  ): Promise<ExternalBackendClientResult> {
    if (!this.sideEffectBoundary) {
      throw new Error('Trading boundary is not configured — bot lifecycle actions are unavailable.');
    }
    const result = await this.sideEffectBoundary.invokeAndAwait({
      toolName,
      payload,
      subject,
      deadlineMs: 30_000,
      idempotencyKey,
    });
    if (result.kind === 'success') {
      return result;
    }
    if (result.kind === 'failure') {
      throw new Error(`Bot ${toolName} rejected by trading boundary: ${result.message} (${result.code})`);
    }
    // Unknown outcome: the requestId lands in agent_messages.errorDetail so the
    // write can be reconciled by requestId.
    logger.warn({ toolName, requestId: result.requestId, idempotencyKey, kind: result.kind }, 'Bot lifecycle outcome unknown');
    if (result.kind === 'transport_error') {
      throw new Error(`Bot ${toolName} outcome unknown — trading boundary did not return a response: ${result.message} (requestId ${result.requestId})`);
    }
    // in_progress: still running at the deadline — it may yet complete.
    throw new Error(`Bot ${toolName} outcome unknown — no terminal outcome within the deadline (requestId ${result.requestId}).`);
  }

  private async handleManageBot(agentId: string, envelope: MessageEnvelope, payload: ManageBotPayload): Promise<void> {
    const agent = await this.agentRepo.getAgent(agentId);
    if (!agent) throw new Error('Agent not found');

    const activeSession = await this.agentRepo.getActiveSession(agent.id);
    if (!activeSession || activeSession.status !== 'running') {
      throw new Error('No running session for agent');
    }

    // L3c: inject ownerId + actor ONLY. Traderton owns bots + resolves the venue
    // account from the subject (D2/#4). herobids stamps nothing else.
    const subject: ExternalBackendSubject = {
      ownerId: agent.userId,
      actor: { type: 'agent', id: agent.id },
    };

    if (payload.action === 'create_and_start') {
      if (!payload.config) throw new Error('config is required for create_and_start');
      if (!this.botRepo) throw new Error('Connection ownership repository not wired — manage_bot unavailable');

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

      // Security: verify the connection belongs to the agent's own user before
      // acting. This is herobids-side platform authz (KEEP) — it gates WHETHER the
      // caller may act; it is NOT injected into the envelope (D2). The venue-account
      // resolution + venue-stamp (getResolvedVenueAccount/venueTypeFromProvider) are
      // REMOVED — Traderton resolves the venue account from the subject (see
      // 004-l3d-plan.md §C).
      const owned = await this.botRepo!.isConnectionOwnedBy(connection.connectionId, agent.userId);
      if (!owned) {
        throw new Error(`Trading connection ${connection.connectionId} not found or not owned by this agent's user`);
      }

      const rawConfig = { ...payload.config };

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
            operatorModelDefaults: this.operatorModelDefaults ?? null,
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

      const botMode = ((rawConfig['execution'] as Record<string, unknown> | undefined)?.['mode'] as string | undefined) ?? 'paper';

      // Safety gate: plan-level live execution eligibility (platform policy — kept).
      if (botMode === 'live' && this.botLiveCheck) {
        await this.botLiveCheck(agent.userId);
      }

      // L3c: create the bot over the boundary — no bots-table write, no maxBots,
      // no venue-stamp (#4/D2). Traderton owns bots + the limit and resolves the
      // venue account from the subject. `create_bot` is no-bot (no botId). herobids
      // owns the connection→account mapping (decision 13: the connection indirection
      // is platform-only), so it resolves the concrete venueAccountId off the chosen
      // binding and forwards it as a signed payload arg for deterministic resolution.
      if (!connection.resolvedVenueAccountId) {
        throw new Error(`Trading connection ${connection.connectionId} has no resolved venue account`);
      }
      await this.invokeBotLifecycle('create_bot', {
        venueAccountId: connection.resolvedVenueAccountId,
        config: rawConfig,
      }, subject, envelope.messageId);

      logger.info({ agentId: agent.id }, 'Agent created bot via manage_bot (boundary)');

      // Notify the agent that a bot was created. The authoritative bot list now
      // lives behind the boundary (list_bots) — herobids no longer reads its own
      // bots table here. Emit a lightweight status so the next tick refreshes.
      await this.eventPublisher.emitInstanceStatus(agent.id, {
        status: 'running',
        reason: 'bot_created',
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if (payload.action === 'start') {
      if (!payload.botId) throw new Error('botId is required for start');

      // L3c: start over the boundary — bot-scoped (payload carries botId). No
      // bots-table read/write, no maxBots, no lifecycle enqueue (#4). Traderton
      // owns the bot + its config + the limit and validates ownership from the
      // subject. See 004-l3d-plan.md §C.
      await this.invokeBotLifecycle('start_bot', { botId: payload.botId }, subject, envelope.messageId);

      await this.eventPublisher.emitInstanceStatus(agent.id, {
        status: 'running',
        reason: 'bot_started',
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if (payload.action === 'stop') {
      if (!payload.botId) throw new Error('botId is required for stop');

      // L3c: stop over the boundary — bot-scoped. No bots-table write. Traderton
      // owns the bot + validates ownership from the subject.
      await this.invokeBotLifecycle('stop_bot', { botId: payload.botId }, subject, envelope.messageId);
      return;
    }

    if (payload.action === 'adjust_config') {
      if (!payload.botId) throw new Error('botId is required for adjust_config');
      if (!payload.config) throw new Error('config is required for adjust_config');

      const partialConfig = { ...payload.config };

      await this.invokeBotLifecycle('adjust_bot_config', {
        botId: payload.botId,
        config: partialConfig,
      }, subject, envelope.messageId);

      return;
    }

    throw new Error(`Unknown manage_bot action: ${(payload as { action: string }).action}`);
  }

  /** Look up slug values for a set of skill IDs. Returns a map of id → slug. Best-effort: returns empty map on failure. */
  private async lookupSlugsForIds(db: Database, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    try {
      const rows = await db
        .select({ id: skills.id, slug: skills.slug })
        .from(skills)
        .where(inArray(skills.id, ids));
      return new Map(rows.map(r => [r.id, r.slug]));
    } catch {
      return new Map();
    }
  }

  /**
   * Handle a brokered manage_agent_skills request (add/remove skills at runtime).
   * Validates the payload, enforces base-skill protection, resolves entitlements,
   * and publishes a synchronous reply via Redis list for the agent tool to BLPOP.
   */
  private async handleManageAgentSkills(
    agentId: string,
    envelope: MessageEnvelope,
    payload: ManageAgentSkillsPayload,
  ): Promise<void> {
    const requestMessageId = (envelope.payload as Record<string, unknown>).requestMessageId as string | undefined;

    const publishReply = async (result: Parameters<InstanceEventPublisher['publishSkillsReply']>[1]) => {
      if (requestMessageId) {
        await this.eventPublisher.publishSkillsReply(requestMessageId, result);
      }
    };

    try {
      // Validate payload (belt-and-suspenders; the broker already validates via schema map)
      const parsed = ManageAgentSkillsPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        await publishReply({
          status: 'error',
          action: payload.action ?? 'add',
          skillIds: [],
          warnings: [],
          error: 'Invalid payload',
          errorCode: 'validation_error',
        });
        return;
      }

      if (!this.db) {
        await publishReply({
          status: 'error',
          action: parsed.data.action,
          skillIds: [],
          warnings: [],
          error: 'Database not available',
          errorCode: 'db_unavailable',
        });
        return;
      }

      // Base skill protection
      if (parsed.data.skillIds.includes('base')) {
        await publishReply({
          status: 'error',
          action: parsed.data.action,
          skillIds: [],
          warnings: [],
          error: 'The base skill cannot be added or removed',
          errorCode: 'base_skill_protected',
        });
        return;
      }

      if (parsed.data.action === 'add') {
        await this.handleSkillAdd(agentId, parsed.data, publishReply);
      } else {
        await this.handleSkillRemove(agentId, parsed.data, publishReply);
      }
    } catch (err) {
      logger.error({ agentId, err }, 'handleManageAgentSkills failed');
      await publishReply({
        status: 'error',
        action: payload.action ?? 'add',
        skillIds: [],
        warnings: [],
        error: err instanceof Error ? err.message : 'Unexpected broker error',
        errorCode: 'broker.internal_error',
      });
    }
  }

  private async handleSkillAdd(
    agentId: string,
    payload: ManageAgentSkillsPayload,
    publishReply: (result: Parameters<InstanceEventPublisher['publishSkillsReply']>[1]) => Promise<void>,
  ): Promise<void> {
    const db = this.db!;

    // 1. Load agent to get userId
    const agent = await this.agentRepo.getAgent(agentId);
    if (!agent) {
      await publishReply({ status: 'error', action: 'add', skillIds: [], warnings: [], error: 'Agent not found', errorCode: 'agent_not_found' });
      return;
    }

    // 2. Load user to get planId and isAdmin
    const [userRow] = await db
      .select({ planId: users.planId, isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, agent.userId))
      .limit(1);
    if (!userRow) {
      await publishReply({ status: 'error', action: 'add', skillIds: [], warnings: [], error: 'User not found', errorCode: 'user_not_found' });
      return;
    }

    // 3. Resolve plan skill entitlements
    const skillEntitlements = this.plansConfig
      ? resolvePlanSkillEntitlements(this.plansConfig, userRow.planId, userRow.isAdmin)
      : { canViewMarketplaceSkills: true };

    // 4. Get currently assigned skillIds
    const existingRows = await db
      .select({ skillId: agentSkills.skillId })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agentId));
    const existingSkillIds = existingRows.map((r) => r.skillId);

    // 5. Resolve assignments for the combined set (existing + new)
    const combined = [...new Set([...existingSkillIds, ...payload.skillIds])];
    const resolution = await resolveSkillAssignmentsForUser(
      db,
      agent.userId,
      combined,
      new Set(existingSkillIds),
      skillEntitlements.canViewMarketplaceSkills,
    );

    // 6. If validation error → publish error reply (enrich IDs with slugs for diagnostics)
    if (resolution.error) {
      let errorMessage = resolution.error.message;
      if (resolution.error.details && Array.isArray(resolution.error.details)) {
        const slugMap = await this.lookupSlugsForIds(db, combined);
        const enrichedDetails = (resolution.error.details as Array<{ message?: string }>).map(d => {
          if (!d.message) return d;
          let msg = d.message;
          for (const [id, slug] of slugMap) {
            msg = msg.replaceAll(id, slug);
          }
          return { ...d, message: msg };
        });
        const firstDetail = enrichedDetails[0] as { message?: string } | undefined;
        if (firstDetail?.message) {
          errorMessage = `${resolution.error.message} — ${firstDetail.message}`;
        }
      }
      await publishReply({
        status: 'error',
        action: 'add',
        skillIds: [],
        warnings: [],
        error: errorMessage,
        errorCode: resolution.error.code,
      });
      return;
    }

    // 7. Sync assignments to DB
    await syncAgentSkillAssignments(db, agentId, agent.userId, resolution.assignments!, 'agent_self');

    // 8. Publish success reply with the added skillIds
    const addedSkillIds = payload.skillIds.filter((id) => !existingSkillIds.includes(id));
    await publishReply({
      status: 'ok',
      action: 'add',
      skillIds: addedSkillIds,
      warnings: [],
    });
  }

  private async handleSkillRemove(
    agentId: string,
    payload: ManageAgentSkillsPayload,
    publishReply: (result: Parameters<InstanceEventPublisher['publishSkillsReply']>[1]) => Promise<void>,
  ): Promise<void> {
    const db = this.db!;

    // 1. Load agent to get userId
    const agent = await this.agentRepo.getAgent(agentId);
    if (!agent) {
      await publishReply({ status: 'error', action: 'remove', skillIds: [], warnings: [], error: 'Agent not found', errorCode: 'agent_not_found' });
      return;
    }

    // 2. Load current agent skill assignments
    const existingRows = await db
      .select({ skillId: agentSkills.skillId })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agentId));
    const existingSkillIds = new Set(existingRows.map((r) => r.skillId));

    // 3. Validate requested skillIds — collect warnings for not-assigned (use slugs for diagnostics)
    const toRemove: string[] = [];
    const warningIds: string[] = [];
    for (const skillId of payload.skillIds) {
      if (existingSkillIds.has(skillId)) {
        toRemove.push(skillId);
      } else {
        warningIds.push(skillId);
      }
    }

    // Resolve warning IDs to slugs for agent-facing messages
    let warnings: string[];
    if (warningIds.length > 0) {
      const slugMap = await this.lookupSlugsForIds(db, warningIds);
      warnings = warningIds.map(id => slugMap.get(id) ?? id);
    } else {
      warnings = [];
    }

    // 4. Compute remaining skills and re-resolve assignments
    const removeSet = new Set(toRemove);
    const remainingSkillIds = [...existingSkillIds].filter((id) => !removeSet.has(id));

    if (remainingSkillIds.length > 0) {
      // Load user for entitlement check
      const [userRow] = await db
        .select({ planId: users.planId, isAdmin: users.isAdmin })
        .from(users)
        .where(eq(users.id, agent.userId))
        .limit(1);
      if (!userRow) {
        await publishReply({ status: 'error', action: 'remove', skillIds: [], warnings: [], error: 'User not found', errorCode: 'user_not_found' });
        return;
      }

      const skillEntitlements = this.plansConfig
        ? resolvePlanSkillEntitlements(this.plansConfig, userRow.planId, userRow.isAdmin)
        : { canViewMarketplaceSkills: true };

      const resolution = await resolveSkillAssignmentsForUser(
        db,
        agent.userId,
        remainingSkillIds,
        new Set(remainingSkillIds),
        skillEntitlements.canViewMarketplaceSkills,
      );

      if (resolution.error) {
        // Enrich error with slugs for agent-facing diagnostics
        let errorMessage = resolution.error.message;
        if (resolution.error.details && Array.isArray(resolution.error.details)) {
          const allIds = [...remainingSkillIds, ...payload.skillIds];
          const slugMap = await this.lookupSlugsForIds(db, allIds);
          const enrichedDetails = (resolution.error.details as Array<{ message?: string }>).map(d => {
            if (!d.message) return d;
            let msg = d.message;
            for (const [id, slug] of slugMap) {
              msg = msg.replaceAll(id, slug);
            }
            return { ...d, message: msg };
          });
          const firstDetail = enrichedDetails[0] as { message?: string } | undefined;
          if (firstDetail?.message) {
            errorMessage = `${resolution.error.message} — ${firstDetail.message}`;
          }
        }
        await publishReply({
          status: 'error',
          action: 'remove',
          skillIds: [],
          warnings: [],
          error: errorMessage,
          errorCode: resolution.error.code,
        });
        return;
      }

      await syncAgentSkillAssignments(db, agentId, agent.userId, resolution.assignments!, 'agent_self');
    } else {
      // All skills removed — sync with empty assignments
      await syncAgentSkillAssignments(db, agentId, agent.userId, [], 'agent_self');
    }

    // 5. Publish success reply
    await publishReply({
      status: 'ok',
      action: 'remove',
      skillIds: toRemove,
      warnings,
    });
  }

  /**
   * Handle a brokered connection request (WP-A A3). Mints a short-lived,
   * single-use link the agent can forward to the user. Writes the pending
   * request record to Redis and replies synchronously via a Redis list.
   */
  private async handleUpdatePrompt(
    agentId: string,
    envelope: MessageEnvelope,
    payload: UpdatePromptPayload,
  ): Promise<void> {
    const requestMessageId = (envelope.payload as Record<string, unknown>).requestMessageId as string | undefined;
    const publishReply = async (result: UpdatePromptResult) => {
      if (requestMessageId) {
        await this.eventPublisher.publishUpdatePromptReply(requestMessageId, result);
      }
    };

    try {
      const agent = await this.agentRepo.getAgent(agentId);
      if (!agent) {
        await publishReply({ status: 'error', error: 'Agent not found', errorCode: 'agent.not_found' });
        return;
      }
      await this.agentRepo.updateAgent(agentId, { prompt: payload.prompt });
      await publishReply({ status: 'ok', promptLength: payload.prompt.length });
    } catch (err) {
      logger.error({ agentId, err }, 'handleUpdatePrompt failed');
      await publishReply({ status: 'error', error: 'Could not update the prompt. Please try again.', errorCode: 'broker.internal_error' });
    }
  }

  private async handleManageTradingSetup(
    agentId: string,
    envelope: MessageEnvelope,
    payload: ManageTradingSetupPayload,
  ): Promise<void> {
    const requestMessageId = (envelope.payload as Record<string, unknown>).requestMessageId as string | undefined;
    const publishReply = async (result: TradingSetupResult) => {
      if (requestMessageId) {
        await this.eventPublisher.publishTradingSetupReply(requestMessageId, result);
      }
    };

    const setup = this.tradingSetup;
    if (!this.db || !setup) {
      await publishReply({ status: 'error', error: 'Trading setup is not available right now.', errorCode: 'trading.setup_unavailable' });
      return;
    }

    try {
      const descriptor = await this.agentRepo.getRuntimeCapabilityDescriptor(agentId);
      const hasTradingCapability = (descriptor?.resolvedSkills ?? []).some(
        (skill) => Array.isArray(skill.capabilityFamilies) && skill.capabilityFamilies.includes('trading'),
      );
      if (!hasTradingCapability) {
        await publishReply({ status: 'error', error: 'Paper trading needs the trading traderton/skills/crypto-trading skill, which this agent does not have.', errorCode: 'trading.not_allowed' });
        return;
      }

      const agent = await this.agentRepo.getAgent(agentId);
      if (!agent) {
        await publishReply({ status: 'error', error: 'Agent not found', errorCode: 'agent.not_found' });
        return;
      }

      const [owner] = await this.db.select({ planId: users.planId, isAdmin: users.isAdmin }).from(users).where(eq(users.id, agent.userId));
      if (!owner) {
        await publishReply({ status: 'error', error: 'Agent owner not found', errorCode: 'agent.not_found' });
        return;
      }

      const defaults = await loadTestDefaults(setup.readBoundary);
      if (!defaults.ok) {
        await publishReply({ status: 'error', error: defaults.error.message, errorCode: defaults.error.code });
        return;
      }

      const result = await setupTradingForAgent(
        { db: this.db, plansConfig: setup.plansConfig, client: setup.client, logger, saga: setup.saga, defaults: defaults.data },
        { userId: agent.userId, agentId, userPlanId: owner.planId, isAdmin: owner.isAdmin, capital: payload.capital },
      );

      if (result.kind === 'ok') {
        await publishReply({
          status: 'ok',
          connectionId: result.connectionId,
          provider: result.provider,
          network: result.network,
          capital: result.capital,
          mode: result.mode,
          reused: result.reused,
          walletAddress: result.wallet?.address ?? null,
        });
        return;
      }
      if (result.kind === 'limit') {
        await publishReply({ status: 'error', error: result.error.message, errorCode: result.error.code });
        return;
      }
      await publishReply({ status: 'error', error: result.message, errorCode: result.code });
    } catch (err) {
      logger.error({ agentId, err }, 'handleManageTradingSetup failed');
      await publishReply({ status: 'error', error: 'Trading setup failed. Please try again.', errorCode: 'broker.internal_error' });
    }
  }

  private async handleRequestConnection(
    agentId: string,
    envelope: MessageEnvelope,
    payload: ConnectionRequestPayload,
  ): Promise<void> {
    const requestMessageId = (envelope.payload as Record<string, unknown>).requestMessageId as string | undefined;

    const publishReply = async (result: ConnectionRequestResult) => {
      if (requestMessageId) {
        await this.eventPublisher.publishConnectionRequestReply(requestMessageId, result);
      }
    };

    const ttlSecs = this.resolvedConnectionRequests.ttlSecs;
    const maxPendingPerAgent = this.resolvedConnectionRequests.maxPendingPerAgent;
    const pendingKey = `connection-request:pending:${agentId}:${payload.provider}`;
    const pendingAgentSetKey = `connection-request:pending-agent:${agentId}`;

    // Release the per-provider pending lock and the per-agent pending-set
    // membership on any downstream failure so a failed mint does not orphan
    // state that would block future requests until TTL expiry.
    const releasePendingState = async () => {
      await this.redis.del(pendingKey);
      await this.redis.srem(pendingAgentSetKey, payload.provider);
    };

    try {
      // (a) Validate provider against the shared catalog.
      if (!(payload.provider in PROVIDER_DISCOVERY)) {
        const validIds = Object.keys(PROVIDER_DISCOVERY).join(', ');
        await publishReply({
          status: 'error',
          error: `Unknown provider "${payload.provider}". Valid providers: ${validIds}.`,
          errorCode: 'connection.unknown_provider',
        });
        return;
      }

      // (b) Reject trading-family providers for agents without trading capability.
      // Mirrors the list_providers filter: a provider whose runtime families
      // include 'trading' is only requestable by an agent with a trading skill.
      const families = getRuntimeFamiliesForProvider(payload.provider);
      if (families.includes('trading')) {
        const descriptor = await this.agentRepo.getRuntimeCapabilityDescriptor(agentId);
        const hasTradingCapability = (descriptor?.resolvedSkills ?? []).some(
          (skill) => Array.isArray(skill.capabilityFamilies) && skill.capabilityFamilies.includes('trading'),
        );
        if (!hasTradingCapability) {
          await publishReply({
            status: 'error',
            error: `Provider "${payload.provider}" requires a trading skill, which this agent does not have.`,
            errorCode: 'connection.trading_not_allowed',
          });
          return;
        }
      }

      const agent = await this.agentRepo.getAgent(agentId);
      if (!agent) {
        await publishReply({
          status: 'error',
          error: 'Agent not found',
          errorCode: 'agent.not_found',
        });
        return;
      }

      // (c) Enforce maxPendingPerAgent via a per-agent pending SET.
      const pendingCount = await this.redis.scard(pendingAgentSetKey);
      if (pendingCount >= maxPendingPerAgent) {
        await publishReply({
          status: 'error',
          error: `This agent already has ${maxPendingPerAgent} pending connection requests.`,
          errorCode: 'connection.max_pending_reached',
        });
        return;
      }

      // (d) Enforce one-pending-per-agent-and-provider via SET NX EX.
      const acquired = await this.redis.set(pendingKey, '1', 'EX', ttlSecs, 'NX');
      if (acquired !== 'OK') {
        await publishReply({
          status: 'error',
          error: `A connection request for "${payload.provider}" is already pending.`,
          errorCode: 'connection.request_pending',
        });
        return;
      }

      // (e) Generate requestId + token.
      const requestId = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSecs * 1000);

      // (f) Write the request record to Redis with TTL.
      const recordResult = ConnectionRequestRecordSchema.safeParse({
        requestId,
        token,
        agentId,
        userId: agent.userId,
        provider: payload.provider,
        mode: payload.mode,
        status: 'pending',
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      if (!recordResult.success) {
        await releasePendingState();
        await publishReply({
          status: 'error',
          error: 'Failed to build connection request record',
          errorCode: 'broker.internal_error',
        });
        return;
      }
      const record = recordResult.data;
      await this.redis.set(
        `connection-request:${requestId}`,
        JSON.stringify(record),
        'EX',
        ttlSecs + this.resolvedConnectionRequests.expiryGraceSecs,
      );

      // (g) Track the provider in the per-agent pending SET (for maxPendingPerAgent).
      await this.redis.sadd(pendingAgentSetKey, payload.provider);

      // (h) Add requestId to the pending sorted set scored by expiresAt epoch ms.
      // NOTE: the A5 completion-hook sweeper removes entries from this sorted set
      // on completion/decline/expiry, so it does not grow unboundedly.
      await this.redis.zadd(
        'connection-requests:pending',
        expiresAt.getTime(),
        requestId,
      );

      // (i) Build the link.
      const link = `${this.resolvedPublicBaseUrl}/auth/connection-request/callback?token=${token}`;

      // (j) Reply.
      await publishReply({
        status: 'ok',
        requestId,
        link,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      logger.error({ agentId, err }, 'handleRequestConnection failed');
      await releasePendingState();
      await publishReply({
        status: 'error',
        error: err instanceof Error ? err.message : 'Unexpected broker error',
        errorCode: 'broker.internal_error',
      });
    }
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
      'billing.insufficient_funds': 'no_available_credit',
      'billing.account_suspended': 'suspended',
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
    const isHard = reason === 'billing.limit_exceeded'
      || reason === 'billing.insufficient_funds'
      || reason === 'billing.account_suspended';
    const message = reason === 'billing.insufficient_funds'
      ? this.buildInsufficientFundsMessage(agent.name)
      : reason === 'billing.account_suspended'
        ? this.buildAccountSuspendedMessage(agent.name)
        : isHard
          ? this.buildHardLimitMessage(agent.name, openPositions)
          : this.buildSoftLimitMessage(agent.name);

    let anyDelivered = false;

    // 4. Send Telegram notification
    if (this.chatDelivery) {
      const result = await this.chatDelivery.send(agentId, { body: message });
      if (result.ok) {
        logger.info({ agentId, reason }, 'Billing notification sent via chat');
        anyDelivered = true;
      } else if (result.error.code === 'chat.address_lookup_failed') {
        throw new Error(result.error.message);
      } else if (result.error.code !== 'chat.no_address') {
        logger.warn({ agentId, reason, error: result.error }, 'Billing notification chat delivery failed');
      }
    }

    // 5. Send email notification (if configured)
    if (this.emailClient) {
      const recipientEmail = await this.agentRepo.getUserEmailByAgentId(agentId);
      if (recipientEmail) {
        const emailContent = reason === 'billing.insufficient_funds'
          ? this.buildInsufficientFundsEmailContent(agent.name)
          : reason === 'billing.account_suspended'
            ? this.buildAccountSuspendedEmailContent(agent.name)
            : isHard
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

  /**
   * Extract the Redis reply key from an envelope, if the message type supports
   * synchronous replies. Returns undefined for fire-and-forget messages.
   */
  private extractDenialReplyKey(envelope: MessageEnvelope): string | undefined {
    const payload = envelope.payload as Record<string, unknown>;

    switch (envelope.type) {
      case AGENT_MESSAGE_TYPES.DECISION_SUBMIT: {
        const decisionId = payload.decisionId as string | undefined;
        return decisionId ? `agent:decision:reply:${decisionId}` : undefined;
      }
      case AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS: {
        const requestMessageId = payload.requestMessageId as string | undefined;
        return requestMessageId ? `agent:skills:reply:${requestMessageId}` : undefined;
      }
      case AGENT_MESSAGE_TYPES.REQUEST_CONNECTION: {
        const requestMessageId = payload.requestMessageId as string | undefined;
        return requestMessageId ? `agent:connection-request:reply:${requestMessageId}` : undefined;
      }
      case AGENT_MESSAGE_TYPES.MANAGE_TRADING_SETUP: {
        const requestMessageId = payload.requestMessageId as string | undefined;
        return requestMessageId ? `agent:trading-setup:reply:${requestMessageId}` : undefined;
      }
      case AGENT_MESSAGE_TYPES.UPDATE_PROMPT: {
        const requestMessageId = payload.requestMessageId as string | undefined;
        return requestMessageId ? `agent:update-prompt:reply:${requestMessageId}` : undefined;
      }
      // Fire-and-forget: no reply channel
      case AGENT_MESSAGE_TYPES.SEND_MESSAGE:
      case AGENT_MESSAGE_TYPES.PUBLISH_ARTIFACT:
      default:
        return undefined;
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

  /** Build the insufficient-funds notification message (HTML for Telegram). */
  private buildInsufficientFundsMessage(agentName: string): string {
    return [
      `⚠️ Agent "<b>${escapeHtml(agentName)}</b>" has stopped — insufficient billing credit.`,
      '',
      'No further LLM calls will be made until you add credit to your account.',
      '',
      'Visit Billing → Spend Controls to add credit and resume your agent.',
    ].join('\n');
  }

  /** Build the account-suspended notification message (HTML for Telegram). */
  private buildAccountSuspendedMessage(agentName: string): string {
    return [
      `🚫 Agent "<b>${escapeHtml(agentName)}</b>" has stopped — account suspended.`,
      '',
      'No further LLM calls will be made until your account is reactivated.',
      '',
      'Please contact support or visit Billing to resolve your account status.',
    ].join('\n');
  }

  /** Build branded email content for insufficient-funds notification. */
  private buildInsufficientFundsEmailContent(agentName: string) {
    return {
      subject: `⚠️ ${agentName} stopped — insufficient billing credit`,
      preheader: 'Your agent needs credit to resume',
      title: 'Agent Stopped',
      body: [
        `Agent <strong>${escapeHtml(agentName)}</strong> has stopped because of insufficient billing credit.`,
        '',
        'No further LLM calls will be made until you add credit to your account.',
        '',
        'Visit <strong>Billing → Spend Controls</strong> to add credit and resume your agent.',
      ].join('\n'),
      footerNote: 'This is an automated notification from your agent platform.',
    };
  }

  /** Build branded email content for account-suspended notification. */
  private buildAccountSuspendedEmailContent(agentName: string) {
    return {
      subject: `🚫 ${agentName} stopped — account suspended`,
      preheader: 'Your account has been suspended',
      title: 'Agent Stopped',
      body: [
        `Agent <strong>${escapeHtml(agentName)}</strong> has stopped because your account is suspended.`,
        '',
        'No further LLM calls will be made until your account is reactivated.',
        '',
        'Please contact support or visit <strong>Billing</strong> to resolve your account status.',
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
