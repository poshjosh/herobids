import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { z } from 'zod';
import { requireDirectChildOfActingAgent, requireUserCaller } from '../plugins/auth.js';
import { consumeTokenBucketToken } from '../services/token-bucket.js';
import { eq, and, asc, isNull } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { AgentRepository, AgentDocumentsRepository, agents, agentConnections, chatAddresses, agentSkills, recordAgentAuditEvent, resolveSkillAssignmentsForUser, setChatAddress, syncAgentSkillAssignmentsInTx, isChatAddressClaimedByOtherUser, clearChatSuppression, users } from '@herobids/db';
import { childAllowanceForNewAssignment } from '../agents/child-allowance-assignment.js';
import { consumeTelegramLinkToken } from '../agents/telegram-link-token.js';
import type { ExternalBackendClient } from '@herobids/domain/external-backend';
import type { InboundChatMessage } from '@herobids/domain';
import { DecisionApprovalRepository } from '@herobids/db';
import { AgentDocumentService, buildDocumentNoticeText, checkUploadable } from '@herobids/documents';
import { LocalDocumentStore } from '@herobids/documents/local-document-store';
import { createDocumentTextExtractor } from '@herobids/documents/document-text-extractors';
import { resolve } from 'node:path';
import type { AgentApprovalsConfig, AgentCreationConfig, AuthConfig, ChatInboundAdapter, ChatWebhookRequest, ModelDefaults, PlanAgentsEntitlements, PlansConfig, ResolvedTelegramChatConfig, UnifiedAgentConfig } from '@herobids/domain';
import { AgentCreationConfigSchema, AgentRuntimePolicyOverridesSchema, AGENT_STREAM_MAXLEN, AuthConfigSchema } from '@herobids/domain';
import type { ConversationMessage, MessageSender } from '@herobids/domain';
import {
  ConversationQuerySchema,
  buildSendMessageSchema,
  conversationErrorResponse,
  createConversationRouteDeps,
  decodeConversationCursor,
  encodeConversationCursor,
  toConversationResponse,
  type ConversationRouteDeps,
} from './conversation-http.js';
import type { LlmCatalogDeps } from '../llm-model-catalog.js';
import { resolvePlanAgentEntitlements, resolvePlanSkillEntitlements } from '../plan-guards.js';
import {
  loadActiveTradingProfileConnections,
} from '../agents/trading-profile-reconciliation-adapter.js';
import { selectExecutionBinding } from '../agents/trading-profile-reconciliation.js';
import type { TradingProfileReconciliationSaga } from '../agents/trading-profile-reconciliation-saga.js';
import { TradingProfileCeilingViolationError, TradingProfileScanValidationError } from '../agents/trading-profile-reconciliation-saga.js';
import { deriveTradingProfileFields } from '../agents/trading-profile-fields.js';
import { withAgentChatAddresses } from '../agents/chat-addresses.js';
import { parseTelegramCommand } from './telegram-command-parser.js';
import { TelegramInboundChannel } from './telegram-channel.js';
import { ChatInboundRouter } from './chat-inbound-router.js';
import { ChatTypingIndicator, createTelegramTypingSender, type ChatTypingSenders, type ChatTypingTiming } from './chat-typing-indicator.js';
import {
  formatCommandHelp,
  formatUnknownCommandResponse,
  formatAmbiguousApprovalResponse,
  formatApprovalCodeNotFound,
} from './telegram-slash-commands.js';
import {
  handleAgents,
  handleInfo,
  handleLog,
  handleConnections,
  handleConnectSetup,
  handleStart,
  handlePause,
  handleResume,
  handleStop,
  handleRestart,
  handleMode,
  handleConnect,
  handleDisconnect,
  handleGoLive,
} from './telegram-command-handlers.js';
import {
  CostPresetSchema,
  decorateAgentResponse,
  hasModelFieldsWithoutProvider,
  mergeModelPolicy,
  nullablePositiveDecimalStringSchema,
  nullablePositiveIntegerSchema,
  resolveExecutionModeForSkills,
  validateDailyLossRequiresCapital,
  validateAgentModelPolicy,
  validateConnectionRequirement,
  hasSkillCapabilityFamily,
} from './agent-config-helpers.js';

// --- Schemas ---

const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(100),
  prompt: z.string().min(1).max(8000),
  skillIds: z.array(z.string().min(1)).optional(),
  toolPolicy: z.record(z.unknown()).optional(),
  modelPolicy: z.record(z.unknown()).optional(),
  provider: z.string().min(1).max(200).nullable().optional(),
  lightModel: z.string().min(1).max(200).nullable().optional(),
  heavyModel: z.string().min(1).max(200).nullable().optional(),
  costPreset: CostPresetSchema.nullable().optional(),
  dailySpendBudgetUsd: z.number().positive().nullable().optional(),
  dexWatchlistSymbols: z.array(z.string().min(1).max(64)).max(25).nullable().optional(),
  executionMode: z.enum(['paper', 'shadow', 'live']).nullable().optional(),
  dailyLossLimit: nullablePositiveDecimalStringSchema,
  maxDrawdownPct: z.number().min(0).max(100).nullable().optional(),
  maxBots: nullablePositiveIntegerSchema(),
  maxSlippageBps: nullablePositiveIntegerSchema(0),
  tickIntervalMs: nullablePositiveIntegerSchema(1000),
  capital: nullablePositiveDecimalStringSchema,
  style: z.enum(['careful', 'balanced', 'bold']).nullable().optional(),
  runtimePolicyOverrides: AgentRuntimePolicyOverridesSchema.nullable().optional(),
});


interface WebChatAttachment {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

function documentErrorStatus(code: string): number {
  switch (code) {
    case 'agent_document.unsupported_type': return 400;
    case 'agent_document.too_large': return 413;
    case 'agent_document.not_found': return 404;
    default: return 500;
  }
}

// --- Route module ---

export async function agentInteractivityRoutes(
  app: FastifyInstance,
  db: Database,
  redisClient: Redis,
  telegram?: ResolvedTelegramChatConfig,
  llmCatalogDeps?: LlmCatalogDeps,
  plansConfig?: PlansConfig,
  profileReconciliationSaga?: TradingProfileReconciliationSaga,
  agentCreation: AgentCreationConfig = AgentCreationConfigSchema.parse({}),
  conversations: ConversationRouteDeps = createConversationRouteDeps(db),
): Promise<void> {
  const SendMessageSchema = buildSendMessageSchema(conversations.limits.userMessageMaxChars);
  const webChatDocumentRepo = new AgentDocumentsRepository(db);
  const webChatDocumentService = new AgentDocumentService(
    new LocalDocumentStore(process.env['AGENT_DOCUMENTS_DIR'] ?? resolve(process.cwd(), 'data/agent-documents')),
    createDocumentTextExtractor(),
    webChatDocumentRepo,
  );

  /**
   * Stores a web chat attachment once per message id. A retry of a message whose publish failed sends the file
   * again; the existing document is reused so the agent does not get a duplicate.
   */
  async function stageWebChatAttachment(params: {
    agentId: string;
    userId: string;
    messageId: string;
    caption: string;
    file: WebChatAttachment;
  }) {
    const existing = (await webChatDocumentRepo.listByAgent(params.agentId))
      .find((doc) => doc.source === 'web_chat' && doc.sourceRef === params.messageId);
    if (existing) {
      return { ok: true as const, data: {
        id: existing.id,
        originalFilename: existing.originalFilename,
        extractionStatus: existing.extractionStatus,
      } };
    }
    return webChatDocumentService.uploadDocument({
      agentId: params.agentId,
      userId: params.userId,
      source: 'web_chat',
      originalFilename: params.file.filename,
      mimeType: params.file.mimeType,
      body: params.file.buffer,
      sourceRef: params.messageId,
      captionOrPrompt: params.caption,
    });
  }

  function resolveAgentPlanPolicy(planId: string, isAdmin: boolean): PlanAgentsEntitlements {
    if (!plansConfig) {
      return { canViewOwnPrompts: true };
    }
    return resolvePlanAgentEntitlements(plansConfig, planId, isAdmin);
  }

  function resolveSkillPlanPolicy(planId: string, isAdmin: boolean): { canViewMarketplaceSkills: boolean } {
    if (!plansConfig) {
      return { canViewMarketplaceSkills: true };
    }
    const plan = resolvePlanSkillEntitlements(plansConfig, planId, isAdmin);
    return { canViewMarketplaceSkills: plan.canViewMarketplaceSkills };
  }


  async function listSkillIdsForAgent(agentId: string): Promise<string[]> {
    const rows = await db.select({ skillId: agentSkills.skillId })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agentId))
      .orderBy(asc(agentSkills.orderIndex), asc(agentSkills.skillId));
    return rows.map((row) => row.skillId);
  }

  const telegramToken = telegram?.botToken ?? '';

  // PUT /agents/:id — full replacement update (agent must be stopped or crashed)
  app.put<{ Params: { id: string }; Body: unknown }>('/agents/:id', { preHandler: requireUserCaller }, async (request, reply) => {
    const { id } = request.params;
    const parsed = UpdateAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    if (hasModelFieldsWithoutProvider(parsed.data)) {
      return reply.status(400).send({
        error: 'validation_error',
        details: [{ code: 'custom', path: ['provider'], message: 'Provider is required when economy or premium model fields are set' }],
      });
    }

    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    if (agent.status !== 'stopped') {
      return reply.status(409).send({
        error: 'agent_not_editable',
        message: `Agent config can only be updated when stopped (current status: ${agent.status}).`,
      });
    }

    if (!profileReconciliationSaga) {
      return reply.status(503).send({ error: 'precondition.not_ready', message: 'Trading service is unavailable — the agent was not updated.' });
    }
    const priorProfileConnections = await loadActiveTradingProfileConnections(db, id);
    const profiles = await profileReconciliationSaga.readCurrentProfiles(request.userId, id, priorProfileConnections);
    const selectedBinding = selectExecutionBinding(priorProfileConnections);
    const selectedProfile = selectedBinding
      ? profiles.get(selectedBinding.venueAccountId)
      : undefined;

    const capitalIssues = validateDailyLossRequiresCapital({
      dailyMaxLossPct: selectedProfile?.riskPosture?.dailyMaxLossPct,
      maxDrawdownPct: parsed.data.maxDrawdownPct !== undefined
        ? parsed.data.maxDrawdownPct
        : selectedProfile?.riskPosture?.maxDrawdownPct,
      capital: parsed.data.capital !== undefined ? parsed.data.capital : selectedProfile?.capital,
    });
    if (capitalIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: capitalIssues });
    }

    const existingSkillIds = await listSkillIdsForAgent(id);
    const mergedSkillIds = parsed.data.skillIds ?? existingSkillIds;
    // Newly assigning the children skill sets the child limit to the plan ceiling, in the assignment's transaction.
    const childAllowance = childAllowanceForNewAssignment({
      plansConfig,
      planId: request.userPlanId || 'free',
      isAdmin: request.isAdmin,
      previousSkillIds: existingSkillIds,
      nextSkillIds: mergedSkillIds,
    });
    const basePolicy: Record<string, unknown> = parsed.data.toolPolicy !== undefined
      ? { ...parsed.data.toolPolicy }
      : { ...((agent.toolPolicy as Record<string, unknown> | null) ?? {}) };
    const mergedIsTradingCapable = hasSkillCapabilityFamily(mergedSkillIds, 'trading');
    if (mergedIsTradingCapable && !basePolicy['manage_bot']) {
      basePolicy['manage_bot'] = {
        capability: 'manage_bot',
        tier: 'brokered',
        enabled: true,
        limits: { maxPerMinute: 5, maxConcurrent: 1, timeoutMs: 30_000 },
      };
    } else if (!mergedIsTradingCapable && !(parsed.data.toolPolicy && 'manage_bot' in parsed.data.toolPolicy)) {
      delete basePolicy['manage_bot'];
    }
    const effectiveToolPolicy = Object.keys(basePolicy).length > 0 ? basePolicy : null;

    const effectiveModelPolicy = mergeModelPolicy(
      (agent.modelPolicy as Record<string, unknown> | null | undefined) ?? null,
      {
        modelPolicy: parsed.data.modelPolicy,
        provider: parsed.data.provider,
        lightModel: parsed.data.lightModel,
        heavyModel: parsed.data.heavyModel,
        costPreset: parsed.data.costPreset,
        dailySpendBudgetUsd: parsed.data.dailySpendBudgetUsd,
        dexWatchlistSymbols: parsed.data.dexWatchlistSymbols,
      },
    );
    const modelIssues = await validateAgentModelPolicy(effectiveModelPolicy, llmCatalogDeps);
    if (modelIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: modelIssues });
    }

    // Determine whether the agent has trading connections — used to validate
    // connection requirements for shadow/live modes.
    const [existingActiveConn] = await db.select({ id: agentConnections.id })
      .from(agentConnections)
      .where(and(eq(agentConnections.agentId, id), eq(agentConnections.status, 'active')))
      .limit(1);
    const hasAgentConnections = !!existingActiveConn;

    // Resolution B: fall back to the unifiedConfig snapshot for an unbound trading
    // agent (no venue → no profile) so the test↔live immutability guard fires.
    const ucSnapshot = agent.unifiedConfig as Record<string, unknown> | null;
    const unboundMode = (ucSnapshot?.['execution'] as Record<string, unknown> | undefined)?.['mode'] as string | undefined;
    const executionMode = resolveExecutionModeForSkills({
      skillIds: mergedSkillIds,
      submittedExecutionMode: parsed.data.executionMode,
      executionModeProvided: parsed.data.executionMode !== undefined,
      currentExecutionMode: selectedProfile?.executionDefaults?.mode ?? unboundMode,
      hasConnections: hasAgentConnections,
    });
    if (executionMode.issue) {
      return reply.status(400).send({ error: 'validation_error', details: [executionMode.issue] });
    }

    const connectionRequirementIssue = validateConnectionRequirement(executionMode.value, hasAgentConnections);
    if (connectionRequirementIssue) {
      return reply.status(400).send({ error: 'validation_error', details: [connectionRequirementIssue] });
    }

    const assignmentResolution = parsed.data.skillIds !== undefined
      ? await resolveSkillAssignmentsForUser(
        db,
        request.userId,
        parsed.data.skillIds,
        new Set(existingSkillIds),
        resolveSkillPlanPolicy(request.userPlanId || 'free', request.isAdmin).canViewMarketplaceSkills,
      )
      : null;
    if (assignmentResolution?.error) {
      return reply.status(400).send({ error: assignmentResolution.error.code, details: assignmentResolution.error.details ?? [], message: assignmentResolution.error.message });
    }

    const {
      executionMode: _executionMode,
      provider: _provider,
      lightModel: _lightModel,
      heavyModel: _heavyModel,
      costPreset: _costPreset,
      dailySpendBudgetUsd: _dailySpendBudgetUsd,
      dexWatchlistSymbols: _dexWatchlistSymbols,
      modelPolicy: _modelPolicy,
      skillIds: _skillIds,
      runtimePolicyOverrides: _runtimePolicyOverrides,
      maxDrawdownPct: rawMaxDrawdownPct,
      ...agentUpdates
    } = parsed.data;
    void _skillIds;

    const updateValues = {
      ...agentUpdates,
      ...(rawMaxDrawdownPct !== undefined
        ? { risk: { ...(selectedProfile?.riskPosture ?? {}), maxDrawdownPct: rawMaxDrawdownPct != null ? Number(rawMaxDrawdownPct) : null } }
        : {}),
      ...(parsed.data.runtimePolicyOverrides !== undefined ? { runtimePolicyOverrides: parsed.data.runtimePolicyOverrides } : {}),
      ...(childAllowance ? { childAgentLimit: childAllowance.childAgentLimit } : {}),
      toolPolicy: effectiveToolPolicy,
      modelPolicy: effectiveModelPolicy,
      updatedAt: new Date(),
    };
    try {
      await profileReconciliationSaga.executeStaged({
        ownerId: request.userId,
        actorId: id,
        localMutationId: crypto.randomUUID(),
        preparePlannerInput: async () => {
          // This PUT surface does not change capabilityMode/hybridMode/technical/
          // style, so the scan config is the agent's current one — derive it and
          // re-assert it (herobids is the source of truth) rather than trusting
          // whatever traderton returned.
          const proposedProfiles = new Map([...profiles].map(([venueAccountId, profile]) => {
            const { changes, scanConfig } = deriveTradingProfileFields({
              unifiedConfig: (agent.unifiedConfig as UnifiedAgentConfig | null) ?? null,
              style: agent.style ?? null,
              preserveUnspecified: true,
              overrides: {
                capital: agentUpdates.capital,
                riskPosture: rawMaxDrawdownPct !== undefined
                  ? { ...(profile.riskPosture ?? {}), maxDrawdownPct: rawMaxDrawdownPct != null ? Number(rawMaxDrawdownPct) : null }
                  : undefined,
                executionDefaults: executionMode.value !== null
                  ? { ...(profile.executionDefaults ?? {}), mode: executionMode.value }
                  : undefined,
              },
            });
            return [venueAccountId, {
              ...profile,
              ...changes,
              scanMode: scanConfig.scanMode,
              creatorStrategy: scanConfig.creatorStrategy,
              presetPolicy: scanConfig.presetPolicy,
            }];
          }));
          return {
            prior: { profiles, connections: priorProfileConnections },
            proposed: { profiles: proposedProfiles, connections: priorProfileConnections },
          };
        },
        commitLocal: async (tx, markLocalCommitted) => {
          await tx.update(agents).set(updateValues).where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
          if (childAllowance) {
            await recordAgentAuditEvent(tx, {
              userId: request.userId,
              actorType: 'user',
              actorId: request.userId,
              action: 'agent.child_limit_set',
              targetId: id,
              detail: { childAgentLimit: childAllowance.childAgentLimit, source: 'skill_assigned' },
            });
          }
          if (assignmentResolution) {
            await syncAgentSkillAssignmentsInTx(tx, id, request.userId, assignmentResolution.assignments ?? []);
          }
          await markLocalCommitted();
        },
      });
    } catch (error) {
      if (error instanceof TradingProfileCeilingViolationError) {
        return reply.status(400).send({ error: 'validation_error', message: error.message });
      }
      if (error instanceof TradingProfileScanValidationError) {
        return reply.status(400).send({ error: 'validation_error', message: error.message });
      }
      throw error;
    }

    const [updated] = await db.select().from(agents).where(eq(agents.id, id));
    const skillIds = await listSkillIdsForAgent(id);
    const [updatedOut] = await withAgentChatAddresses(db, request.userId, [decorateAgentResponse({ ...updated!, skillIds })]);
    return reply.send({ ...updatedOut, ...(childAllowance?.notice ? { childAgentLimitNotice: childAllowance.notice } : {}) });
  });

  // POST /agents/:id/message — deliver a message to a running agent.
  // A user is rate-limited to 10/min across their agents. A creator agent key may message a direct child,
  // limited per creator-child pair (creatorMessageRatePerMinute, 001-agent-creating-agents §7).
  app.post<{ Params: { id: string }; Body: unknown }>('/agents/:id/message', {
    config: { agentAccess: 'creator' },
    preHandler: requireDirectChildOfActingAgent(db),
  }, async (request, reply) => {
    const { id } = request.params;
    let rawBody: unknown = request.body;
    let attachment: WebChatAttachment | null = null;
    if (request.headers['content-type']?.startsWith('multipart/form-data')) {
      const fields: Record<string, string> = {};
      try {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            if (attachment) {
              return reply.status(400).send({ error: 'validation_error', message: 'Send one attachment per message.' });
            }
            attachment = { filename: part.filename, mimeType: part.mimetype, buffer: await part.toBuffer() };
          } else {
            fields[part.fieldname] = String(part.value);
          }
        }
      } catch (error) {
        if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.status(413).send({ error: 'agent_document.too_large', message: 'File exceeds the upload size limit.' });
        }
        throw error;
      }
      rawBody = fields;
    }
    const parsed = SendMessageSchema.safeParse(rawBody);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const [agent] = await db.select({ id: agents.id, userId: agents.userId, status: agents.status })
      .from(agents).where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const { message: body, clientMessageId } = parsed.data;
    const actingAgentId = request.actingAgentId ?? null;
    const sender: MessageSender = actingAgentId !== null ? { type: 'agent', agentId: actingAgentId } : { type: 'user' };
    if (attachment) {
      if (actingAgentId !== null) {
        return reply.status(400).send({ error: 'validation_error', message: 'Agents cannot attach documents to messages.' });
      }
      const rejected = checkUploadable({ mimeType: attachment.mimeType, sizeBytes: attachment.buffer.byteLength, filename: attachment.filename });
      if (rejected) {
        return reply.status(documentErrorStatus(rejected.code)).send({ error: rejected.code, message: rejected.message });
      }
    }
    const respondWith = (message: ConversationMessage) =>
      toConversationResponse(message, conversations.service.isStuckQueued(message));

    // A repeat of a message that needs no publish (sent, in flight, refused) returns the stored row before the
    // running-state gate and the rate limits: the retry must not be refused because the agent has since stopped,
    // and an idempotent repeat is not a new publish.
    if (clientMessageId) {
      const existing = await conversations.service.findMessage({ ownerUserId: request.userId, agentId: id, messageId: clientMessageId, sender });
      if (!existing.ok) {
        const failure = conversationErrorResponse(existing.error);
        return reply.status(failure.status).send(failure.body);
      }
      if (existing.data && !conversations.service.needsRepublish(existing.data)) {
        return reply.status(202).send({ delivered: true, message: respondWith(existing.data) });
      }
    }

    if (actingAgentId === null) {
      // Rate limit: 10 new publishes per user per minute
      const rateLimitKey = `ratelimit:agent:message:${request.userId}`;
      const count = await redisClient.incr(rateLimitKey);
      if (count === 1) await redisClient.expire(rateLimitKey, 60);
      if (count > 10) {
        return reply.status(429).send({ error: 'rate_limited', message: 'Maximum 10 messages per minute' });
      }
    }

    if (agent.status === 'stopped' || agent.status === 'crashed') {
      return reply.status(409).send({ error: 'agent_not_running', message: 'Agent is not running' });
    }

    // Checked after the running-state gate so a message that cannot be delivered does not spend a token.
    if (request.actingAgentId) {
      const pairBucket = await consumeTokenBucketToken(redisClient, {
        key: `ratelimit:creator-message:${request.actingAgentId}:${id}`,
        capacity: agentCreation.creatorMessageRatePerMinute,
        refillPerMinute: agentCreation.creatorMessageRatePerMinute,
      });
      if (!pairBucket.ok) {
        request.log.warn({ err: pairBucket.error }, 'creator message rate limiter unavailable');
        return reply.status(503).send({ error: 'rate_limiter_unavailable', message: 'Message delivery is temporarily unavailable. Retry shortly.' });
      }
      if (!pairBucket.data) {
        return reply.status(429).send({ error: 'rate_limited', message: 'Creator message limit reached for this agent. Retry later.' });
      }
    }

    const isCreatorMessage = actingAgentId !== null;

    // The conversation row is written first (002 D6). Its id is the envelope messageId, so a repeated
    // clientMessageId is recognised and the runtime's tick events can name this message. A creator
    // agent's message is stored under its own authorship, never as the user's.
    const recorded = actingAgentId !== null
      ? await conversations.service.recordAgentMessage({
        ...(clientMessageId ? { id: clientMessageId } : {}),
        ownerUserId: request.userId,
        agentId: id,
        senderAgentId: actingAgentId,
        channel: 'web',
        body,
      })
      : await conversations.service.recordUserMessage({
        ...(clientMessageId ? { id: clientMessageId } : {}),
        ownerUserId: request.userId,
        agentId: id,
        channel: 'web',
        body,
      });
    if (!recorded.ok) {
      if (recorded.error.code === 'conversation.store_failed') {
        request.log.error({ err: recorded.error }, 'conversation store failed on message send');
      }
      const failure = conversationErrorResponse(recorded.error);
      return reply.status(failure.status).send(failure.body);
    }

    let stored = recorded.data.message;
    let shouldPublish = recorded.data.created;
    // A retry of a failed (or stuck queued) send reuses its id (002 D5, D6): one retry wins the claim and publishes
    // again. A creator agent's message is claimed under its own authorship, like the user's.
    if (!shouldPublish && conversations.service.needsRepublish(stored)) {
      const claimed = await conversations.service.retryUndeliveredMessage({ ownerUserId: request.userId, agentId: id, messageId: stored.id, sender });
      if (!claimed.ok) {
        const failure = conversationErrorResponse(claimed.error);
        return reply.status(failure.status).send(failure.body);
      }
      if (claimed.data) {
        stored = claimed.data;
        shouldPublish = true;
      }
    }
    // Any other repeat is a retry of a message already published (or being published): return the row, send nothing.
    if (!shouldPublish) {
      return reply.status(202).send({ delivered: true, message: respondWith(stored) });
    }

    let payloadMessage = body;
    if (attachment) {
      const staged = await stageWebChatAttachment({ agentId: id, userId: request.userId, messageId: stored.id, caption: body, file: attachment });
      if (!staged.ok) {
        const marked = await conversations.service.markDelivery({ messageId: stored.id, status: 'failed', detail: 'attachment_failed' });
        if (!marked.ok) request.log.warn({ code: marked.error.code }, 'could not mark message as failed');
        return reply.status(documentErrorStatus(staged.error.code)).send({ error: staged.error.code, message: staged.error.message, messageId: stored.id });
      }
      payloadMessage = `${body}\n\n${buildDocumentNoticeText({
        documentId: staged.data.id,
        filename: staged.data.originalFilename,
        extracted: staged.data.extractionStatus === 'ready',
        caption: body,
      })}`;
    }

    // Publish to agent:outbound:{agentId} — the platform→agent channel
    const envelope = {
      schemaVersion: 'v1',
      messageId: stored.id,
      correlationId: crypto.randomUUID(),
      initiatorType: actingAgentId !== null ? 'agent' : 'user',
      initiatorId: actingAgentId ?? request.userId,
      agentId: id,
      type: isCreatorMessage ? 'agent.user.message' : 'user.message',
      createdAt: new Date().toISOString(),
      payload: { message: payloadMessage },
    };
    try {
      await redisClient.xadd(`agent:outbound:${id}`, 'MAXLEN', '~', AGENT_STREAM_MAXLEN, '*', 'envelope', JSON.stringify(envelope));
    } catch (error) {
      request.log.error({ err: error instanceof Error ? error.name : 'NonError' }, 'message publish failed');
      // The row stays as failed so the user can retry the same id.
      const marked = await conversations.service.markDelivery({ messageId: stored.id, status: 'failed', detail: 'publish_failed' });
      if (!marked.ok) request.log.warn({ code: marked.error.code }, 'could not mark message as failed');
      return reply.status(503).send({
        error: 'message_delivery_unavailable',
        message: 'Message delivery is temporarily unavailable. Retry the same message shortly.',
        messageId: stored.id,
      });
    }
    const sent = await conversations.service.markDelivery({ messageId: stored.id, status: 'sent' });
    if (!sent.ok) request.log.warn({ code: sent.error.code }, 'could not mark message as sent');

    if (actingAgentId !== null) {
      await recordAgentAuditEvent(db, {
        userId: request.userId,
        actorType: 'agent',
        actorId: actingAgentId,
        action: 'agent.creator_messaged_child',
        targetId: id,
      });
    }

    return reply.status(202).send({ delivered: true, message: respondWith(sent.ok ? sent.data : stored) });
  });

  // GET /agents/:id/conversation — the user-agent thread, oldest first. The cursor is opaque: the
  // (createdAt, id) of the oldest returned row; pass it as `before` for the next older page.
  app.get<{ Params: { id: string }; Querystring: unknown }>('/agents/:id/conversation', async (request, reply) => {
    const { id } = request.params;
    const query = ConversationQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: 'validation_error', details: query.error.issues });
    }
    const cursor = query.data.before === undefined ? null : decodeConversationCursor(query.data.before);
    if (query.data.before !== undefined && !cursor) {
      return reply.status(400).send({ error: 'validation_error', message: 'invalid_cursor' });
    }

    const [agent] = await db.select({ id: agents.id })
      .from(agents).where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const requested = query.data.limit ?? conversations.limits.threadDefaultPageSize;
    const pageSize = Math.min(requested, conversations.limits.threadMaxPageSize);
    const thread = await conversations.service.listThread({
      ownerUserId: request.userId,
      agentId: id,
      limit: pageSize,
      ...(cursor ? { before: cursor.before, beforeId: cursor.beforeId } : {}),
    });
    if (!thread.ok) {
      if (thread.error.code === 'conversation.store_failed') {
        request.log.error({ err: thread.error }, 'conversation store failed on thread read');
      }
      const failure = conversationErrorResponse(thread.error);
      return reply.status(failure.status).send(failure.body);
    }
    const oldest = thread.data[0];
    return reply.send({
      messages: thread.data.map((message) => toConversationResponse(message, conversations.service.isStuckQueued(message))),
      // A full page may have older rows behind it; a short page is the start of the thread.
      nextCursor: oldest && thread.data.length >= pageSize ? encodeConversationCursor(oldest) : null,
      maxMessageChars: conversations.limits.userMessageMaxChars,
    });
  });

  // GET /agents/:id/memory — agent memory entries
  app.get<{ Params: { id: string }; Querystring: { prefix?: string; limit?: string; keysOnly?: string } }>(
    '/agents/:id/memory', async (request, reply) => {
      const { id } = request.params;
      const limit = Math.min(parseInt(request.query.limit ?? '100', 10), 500);
      const { prefix, keysOnly } = request.query;
      const onlyKeys = keysOnly === 'true' || keysOnly === '1';

      const [agent] = await db.select({ id: agents.id }).from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });

      // Memory is stored as a Redis hash under agent:memory:{agentId}
      const rawEntries = await redisClient.hgetall(`agent:memory:${id}`);
      if (!rawEntries) {
        return reply.send({ agentId: id, entries: [] });
      }

        const entries = Object.entries(rawEntries)
          .filter(([k]) => !prefix || k.startsWith(prefix))
          .slice(0, limit)
          .map(([key, rawVal]) => {
            if (onlyKeys) return { key };
            let value: unknown;
            try { value = JSON.parse(rawVal); } catch { value = rawVal; }
            return { key, value };
          });

      return reply.send({ agentId: id, entries });
    },
  );

  // GET /agents/:id/prompt — last compiled system prompt (in-memory Redis, 404 if not running)
  app.get<{ Params: { id: string } }>('/agents/:id/prompt', async (request, reply) => {
    const { id } = request.params;

    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const planPolicy = resolveAgentPlanPolicy(request.userPlanId || 'free', request.isAdmin);
    if (!planPolicy.canViewOwnPrompts) {
      return reply.status(403).send({
        error: 'plan_limit',
        code: 'plan.agents_prompt_visibility_disabled',
        message: 'Your plan does not include prompt visibility',
      });
    }

    const [judgeSystem, scoutSystem, userContext, judgeUserContext, hybridSystem] = await Promise.all([
      redisClient.get(`agent:prompt:${id}`),
      redisClient.get(`agent:prompt:scout:${id}`),
      redisClient.get(`agent:prompt:user-context:${id}`),
      redisClient.get(`agent:prompt:judge-user-context:${id}`),
      redisClient.get(`agent:prompt:hybrid:${id}`),
    ]);

    if (!judgeSystem && !scoutSystem && !userContext && !judgeUserContext && !hybridSystem) {
      return reply.status(404).send({ error: 'prompt_not_available', message: 'No compiled prompt available. Agent may not be running.' });
    }

    return reply.send({
      agentId: id,
      judgeSystem,
      scoutSystem,
      userContext,
      judgeUserContext,
      hybridSystem,
    });
  });

  // GET /agents/telegram-bot — platform Telegram bot username (501 if not configured)
  // Must be registered before /agents/:id to avoid param capture
  app.get('/agents/telegram-bot', async (_request, reply) => {
    if (!telegramToken) {
      return reply.status(501).send({ error: 'not_configured', message: 'Telegram is not configured on this platform' });
    }

    const response = await fetch(`https://api.telegram.org/bot${telegramToken}/getMe`);
    if (!response.ok) {
      return reply.status(502).send({ error: 'telegram_error', message: 'Could not reach Telegram API' });
    }
    const data = await response.json() as { ok: boolean; result?: { username?: string } };
    if (!data.ok || !data.result?.username) {
      return reply.status(502).send({ error: 'telegram_error', message: 'Unexpected Telegram API response' });
    }

    return reply.send({ username: `@${data.result.username}` });
  });
}

interface TelegramInlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; url: string }>>;
}

// Telegram webhook handler — registered as a public (unauthenticated) route
export async function telegramWebhookHandler(
  app: FastifyInstance,
  db: Database,
  redisClient: Redis,
  telegram?: ResolvedTelegramChatConfig,
  authConfig?: AuthConfig,
  agentApprovalsConfig?: AgentApprovalsConfig,
  plansConfig?: PlansConfig,
  llmCatalogDeps?: LlmCatalogDeps,
  operatorModelDefaults?: ModelDefaults,
  tradertonReadClient?: ExternalBackendClient,
  tradertonReadTimeoutMs?: number,
  profileReconciliationSaga?: TradingProfileReconciliationSaga,
  typingTiming?: ChatTypingTiming,
  conversations: ConversationRouteDeps = createConversationRouteDeps(db),
): Promise<void> {
  const botToken = telegram?.botToken ?? '';
  const webhookSecret = telegram?.webhookSecret ?? '';
  const telegramChannel = new TelegramInboundChannel(webhookSecret);
  const chatRouter = new ChatInboundRouter();
  const resolveRateLimit = agentApprovalsConfig?.resolveRateLimitPerMinute ?? 20;

  const approvalRepo = new DecisionApprovalRepository(db);

  const typingSenders: ChatTypingSenders = new Map([['telegram', createTelegramTypingSender(botToken)]]);
  const typing = typingTiming && botToken ? new ChatTypingIndicator(typingSenders, typingTiming, redisClient, app.log) : undefined;
  if (typing) app.addHook('onClose', async () => { typing.dispose(); });

  const frontendOrigin = AuthConfigSchema.shape.frontendOrigin.parse(authConfig?.frontendOrigin);

  async function sendTelegramText(chatId: string, text: string, replyMarkup?: TelegramInlineKeyboardMarkup): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    }).catch(() => undefined);
    // Telegram rejects some button URLs (for example localhost in development). Resend the text alone so the reply still arrives.
    if (replyMarkup && response?.ok === false) await sendTelegramText(chatId, text);
  }

  /** Button that opens the web app at the page the user connected from. `returnTo` is already validated, so resolving it against the origin cannot leave the origin. */
  function openAppMarkup(returnTo: string): TelegramInlineKeyboardMarkup {
    return { inline_keyboard: [[{ text: 'Return to OpenAIdom', url: new URL(returnTo, frontendOrigin).href }]] };
  }

  function agentCanReceiveTelegram(status: string): boolean {
    return status !== 'stopped' && status !== 'crashed';
  }

  async function deliverTelegramMessage(agentId: string, userId: string, messageText: string): Promise<void> {
    await chatRouter.deliver(agentId, userId, messageText, redisClient);
  }

  const agentRepo = new AgentRepository(db);
  const commandProfileReconciliationSaga = profileReconciliationSaga;

  /**
   * Resolve a pending approval via Telegram slash command.
   * For approve: marks the approval as approved and publishes to Redis
   * for worker-side execution (mirrors the web API approve endpoint).
   * For reject: marks the approval as rejected directly.
   */
  async function resolveApprovalViaTelegram(
    chatId: string,
    userId: string,
    approvalId: string,
    action: 'approve' | 'reject',
    agentId: string,
  ): Promise<void> {
    // Legacy telegram_yes/telegram_no stay for existing readers; resolutionProvider carries the channel.
    const resolutionSource = action === 'approve' ? 'telegram_yes' : 'telegram_no';
    const resolutionProvider = 'telegram';

    if (action === 'reject') {
      const updated = await approvalRepo.updateStatus(approvalId, 'rejected', {
        resolvedByUserId: userId,
        resolutionSource,
        resolutionProvider,
      });
      if (updated === 0) {
        await sendTelegramText(chatId, formatApprovalCodeNotFound());
        return;
      }
      await sendTelegramText(chatId, 'Trade proposal rejected.');
      return;
    }

    // Approve: publish to Redis for worker-side execution. The worker will
    // transition status to 'approved' only after successful execution context
    // resolution. Ownership, expiry, and pending status are already validated
    // by the caller.
    // Publish to Redis to trigger worker-side execution (same channel as web API).
    try {
      const message = JSON.stringify({
        userId,
        resolutionSource,
        resolutionProvider,
        effectiveAgentId: agentId,
        effectiveBotId: agentId,
      });
      await redisClient.publish(`approval:execute:${approvalId}`, message);
    } catch (err) {
      // Execution dispatch is best-effort; approval remains pending.
      const errorMessage = err instanceof Error ? err.message : String(err);
      await approvalRepo.recordResolutionAttempt(approvalId, 'redis.publish_failed', errorMessage);
      await sendTelegramText(chatId, 'Approval submitted but execution dispatch failed. The approval remains pending and can be retried.');
      return;
    }
    await sendTelegramText(chatId, 'Approval submitted for execution.');
  }

  /**
   * The user whose user-level active Telegram address is this chat. A suppressed address binds
   * nobody. A suppression lookup error propagates, so the update is not processed (fail closed).
   */
  async function findUserByTelegramChatId(
    chatId: string,
  ): Promise<{ userId: string; planId: string; isAdmin: boolean } | null> {
    if (await agentRepo.isChatAddressSuppressed('telegram', chatId)) return null;
    const rows = await db.select({ userId: users.id, planId: users.planId, isAdmin: users.isAdmin })
      .from(chatAddresses)
      .innerJoin(users, eq(chatAddresses.userId, users.id))
      .where(and(
        eq(chatAddresses.provider, 'telegram'),
        eq(chatAddresses.address, chatId),
        isNull(chatAddresses.agentId),
        eq(chatAddresses.status, 'active'),
      ))
      .orderBy(asc(chatAddresses.createdAt), asc(chatAddresses.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Checks ownership and writes the binding in one transaction. The shared chat-address lock serialises concurrent
   * link attempts, and every telegram writer takes the same lock (see applyChatAddresses).
   */
  async function bindTelegramChat(chatId: string, userId: string): Promise<'connected' | 'bound_to_other_user'> {
    return db.transaction(async (tx) => {
      if (await isChatAddressClaimedByOtherUser(tx, 'telegram', chatId, userId)) return 'bound_to_other_user';
      // A valid link is explicit consent, so it lifts a revoked (disconnected) suppression for this chat.
      await clearChatSuppression(tx, 'telegram', chatId);
      // Re-linking replaces the user's address. Linking the same chat again writes the same row, so it is a no-op.
      await setChatAddress(tx, { userId, agentId: null }, 'telegram', chatId);
      return 'connected';
    });
  }

  /**
   * Handles `/start link_<token>`. It runs before the suppression check. A suppressed chat stays silent unless
   * the token is valid, because an invalid link must not produce replies on an opted-out chat.
   */
  async function linkTelegramChat(chatId: string, message: InboundChatMessage, token: string): Promise<void> {
    const suppressed = await agentRepo.isChatAddressSuppressed(message.from.provider, chatId);
    const reply = async (text: string, replyMarkup?: TelegramInlineKeyboardMarkup) => {
      if (!suppressed) await sendTelegramText(chatId, text, replyMarkup);
    };

    // Link tokens are only redeemed from a private chat, so a token shared into a group cannot bind the group.
    // The check runs before the token is consumed, so the user can retry from a private chat.
    if (message.chatType !== 'private') {
      await reply('Connect Telegram from a private chat with the bot.');
      return;
    }

    const link = await consumeTelegramLinkToken(redisClient, token);
    if (!link) {
      await reply('This link has expired. Generate a new one in the web app.');
      return;
    }
    const returnMarkup = openAppMarkup(link.returnTo);
    // The token is spent before the ownership check, so a rejected link cannot be retried.
    if (await bindTelegramChat(chatId, link.userId) === 'bound_to_other_user') {
      await reply('This Telegram account is already connected to another OpenAIdom account.', returnMarkup);
      return;
    }
    await sendTelegramText(chatId, 'Connected ✅', returnMarkup);
  }

  async function processWebhookUpdate(
    chatId: string,
    message: InboundChatMessage,
  ): Promise<void> {
    // Matched before the suppression check and slash routing. The reserved link_ payload never reaches the
    // /start <agent> lifecycle command, and a valid link can reconnect a suppressed chat.
    const linkStart = /^\/start link_([A-Za-z0-9_-]+)$/.exec(message.text?.trim() ?? '');
    if (linkStart) {
      await linkTelegramChat(chatId, message, linkStart[1]!);
      return;
    }

    // A suppressed address gets no reply at all, not even help or "bind first": an opt-out blocks inbound as well as
    // outbound. A lookup error propagates, so the update is dropped unprocessed (fail closed, I4).
    if (await agentRepo.isChatAddressSuppressed(message.from.provider, chatId)) return;

    const boundUser = await findUserByTelegramChatId(chatId);

    const userId = boundUser?.userId;
    const userPlanId = boundUser?.planId ?? 'free';
    const userIsAdmin = boundUser?.isAdmin ?? false;

    // ── Slash-command routing ──────────────────────────────────────────
    // Detect and dispatch explicit slash commands before falling through
    // to the existing /to parser and plain-text routing.
    const route = chatRouter.route(message);
    const slashCmd = route.kind === 'slash' ? route.command : null;
    if (slashCmd) {
      // /to is handled by the existing parseTelegramCommand logic below.
      if (slashCmd.command !== 'to') {
        if (slashCmd.command === 'unknown') {
          await sendTelegramText(chatId, formatUnknownCommandResponse(slashCmd.args[0] ?? ''));
          return;
        }
        if (slashCmd.command === 'help') {
          const helpText = formatCommandHelp(slashCmd.args[0]);
          await sendTelegramText(chatId, `Your chat ID: ${chatId}\n\n${helpText}`);
          return;
        }
        if (slashCmd.command === 'start' && slashCmd.args.length === 0) {
          // Exact bare /start → onboarding/help, not lifecycle.
          await sendTelegramText(chatId, `Your chat ID: ${chatId}\n\n${formatCommandHelp()}`);
          return;
        }
        // Require user binding for all other commands
        if (!userId) {
          await sendTelegramText(chatId, 'Please bind your Telegram account first. Use /start to begin.');
          return;
        }

        // ── Read commands (Slice 3) ────────────────────────────────
        if (slashCmd.command === 'agents') {
          const response = await handleAgents(db, userId);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'info') {
          const response = await handleInfo(db, userId, slashCmd.args, commandProfileReconciliationSaga);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'log') {
          const response = await handleLog(db, conversations.service, userId, slashCmd.args, tradertonReadClient, tradertonReadTimeoutMs);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'connections') {
          const response = await handleConnections(db, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }

        // ── /connect <agent> (no connection id) — connect entrypoint flow ──
        if (slashCmd.command === 'connect' && slashCmd.args.length === 1) {
          const response = await handleConnectSetup(db, redisClient, authConfig, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }

        // Lifecycle commands (Slice 4)
        if (slashCmd.command === 'start') {
          const response = await handleStart(db, userId, slashCmd.args, operatorModelDefaults);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'pause') {
          const response = await handlePause(db, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'resume') {
          const response = await handleResume(db, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'stop') {
          const response = await handleStop(db, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'restart') {
          const response = await handleRestart(db, userId, slashCmd.args, operatorModelDefaults);
          await sendTelegramText(chatId, response);
          return;
        }

        // Config commands (Slice 5)
        if (slashCmd.command === 'mode') {
          const response = await handleMode(db, userId, slashCmd.args, commandProfileReconciliationSaga);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'golive') {
          const response = await handleGoLive({
            db,
            userId,
            args: slashCmd.args,
            plansConfig,
            userPlanId,
            isAdmin: userIsAdmin,
            llmCatalogDeps,
            operatorModelDefaults,
            profileReconciliationSaga: commandProfileReconciliationSaga,
          });
          await sendTelegramText(chatId, response);
          return;
        }
        // /connect <agent> <id> (with-id form — Slice 5)
        // /connect <agent> (no-id form) is handled above by handleConnectSetup
        // /connect (zero args) — show usage
        if (slashCmd.command === 'connect' && slashCmd.args.length === 0) {
          await sendTelegramText(chatId, 'Usage: /connect <agent> [connection-id|label]');
          return;
        }
        if (slashCmd.command === 'connect' && slashCmd.args.length >= 2) {
          const response = await handleConnect(db, userId, slashCmd.args, commandProfileReconciliationSaga);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'disconnect') {
          const response = await handleDisconnect(db, userId, slashCmd.args, commandProfileReconciliationSaga);
          await sendTelegramText(chatId, response);
          return;
        }

        // Approval resolution commands
        if (slashCmd.command === 'yes' || slashCmd.command === 'no') {
          const action = slashCmd.command === 'yes' ? 'approve' : 'reject' as const;
          const code = slashCmd.args[0] ?? null;

          // Rate-limit approval resolution attempts
          const rateLimitKey = `ratelimit:approval:resolve:${userId}`;
          const rateCount = await redisClient.incr(rateLimitKey);
          if (rateCount === 1) await redisClient.expire(rateLimitKey, 60);
          if (rateCount > resolveRateLimit) {
            await sendTelegramText(chatId, 'Too many approval requests. Please wait a moment and try again.');
            return;
          }

          // No code provided — check pending count
          if (!code) {
            const pendingCount = await approvalRepo.countPendingByUserId(userId);
            if (pendingCount === 1) {
              // Exactly one — resolve it
              const pendingApprovals = await approvalRepo.findPendingByUserId(userId);
              const approval = pendingApprovals[0]!;
              await resolveApprovalViaTelegram(chatId, userId, approval.id, action, approval.agentId);
            } else {
              await sendTelegramText(chatId, formatAmbiguousApprovalResponse(action, pendingCount));
            }
            return;
          }

          // Code provided — look up by (userId, shortCode)
          const approval = await approvalRepo.findByUserIdAndShortCode(userId, code);
          if (!approval) {
            await sendTelegramText(chatId, formatApprovalCodeNotFound());
            return;
          }
          if (approval.status !== 'pending') {
            // Already resolved or expired — safe generic message
            await sendTelegramText(chatId, formatApprovalCodeNotFound());
            return;
          }
          if (new Date() > new Date(approval.expiresAt)) {
            await approvalRepo.updateExpired([approval.id]);
            await sendTelegramText(chatId, 'This approval has expired and is no longer valid.');
            return;
          }

          await resolveApprovalViaTelegram(chatId, userId, approval.id, action, approval.agentId);
          return;
        }

        await sendTelegramText(chatId, `Command /${slashCmd.command} will be available soon.`);
        return;
      }
    }

    await chatRouter.dispatch(message, userId, {
      redis: redisClient,
      conversations: conversations.service,
      log: app.log,
      resolveReply: (providerMessageId, address) => agentRepo.resolveAgentForChatReply(address.provider, address.address, providerMessageId),
      listAgents: (ownerId) => db.select({
        agentId: agents.id,
        agentName: agents.name,
        status: agents.status,
      }).from(agents).where(eq(agents.userId, ownerId)),
      sendText: (address, text) => sendTelegramText(address.address, text),
      startTyping: (address) => typing?.start(address),
    });
  }

  // ── Document helpers ────────────────────────────────────────────────────

  /** Download a file from Telegram's servers via the Bot API. */
  async function downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; filename: string; mimeType: string } | null> {
    try {
      const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
      const fileRes = await fetch(getFileUrl);
      const fileData = await fileRes.json() as { ok: boolean; result?: { file_path?: string } };
      if (!fileData.ok || !fileData.result?.file_path) return null;

      const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
      const downloadRes = await fetch(downloadUrl);
      if (!downloadRes.ok) return null;

      const buffer = Buffer.from(await downloadRes.arrayBuffer());
      return { buffer, filename: '', mimeType: '' };
    } catch {
      return null;
    }
  }

  /** Lazily-initialised {@link AgentDocumentService} singleton scoped to this webhook handler. */
  let _documentService: AgentDocumentService | null = null;
  function getDocumentService(): AgentDocumentService {
    if (!_documentService) {
      const store = new LocalDocumentStore(process.env['AGENT_DOCUMENTS_DIR'] ?? resolve(process.cwd(), 'data/agent-documents'));
      const extractor = createDocumentTextExtractor();
      const repo = new AgentDocumentsRepository(db);
      _documentService = new AgentDocumentService(store, extractor, repo);
    }
    return _documentService;
  }

  /**
   * Handle a Telegram document message:
   * 1. Resolve target agent(s) from chat binding and optional caption {@code /to} command.
   * 2. Download the file from Telegram.
   * 3. Ingest through {@link AgentDocumentService}.
   * 4. Publish a text notification to each target agent.
   *
   * Targets only running agents in v1 — stopped/crashed agents are rejected.
   */
  async function processWebhookDocument(
    chatId: string,
    message: InboundChatMessage,
  ): Promise<void> {
    const document = message.document!; // guaranteed present by caller

    if (await agentRepo.isChatAddressSuppressed(message.from.provider, chatId)) return; // opt-out: silent drop, fail closed

    // ── 1. Resolve user ──────────────────────────────────────────────────

    const userId = (await findUserByTelegramChatId(chatId))?.userId;
    if (!userId) return; // no chat binding — silent drop

    // ── 2. Find running agents for this user ─────────────────────────────

    const userAgents = await db.select({
      agentId: agents.id,
      agentName: agents.name,
      status: agents.status,
    })
      .from(agents)
      .where(eq(agents.userId, userId));

    const runningAgents = userAgents.filter((row) => agentCanReceiveTelegram(row.status));

    // ── 3. Resolve target agent(s) from caption /to command ──────────────

    const caption = message.caption?.trim();
    const parsedCommand = caption ? parseTelegramCommand(caption) : null;

    let targetAgents: typeof runningAgents;

    if (parsedCommand?.targets.length) {
      targetAgents = [];
      for (const target of parsedCommand.targets) {
        const isBroadcast = target === '*' || target.toLowerCase() === 'all';
        const matches = isBroadcast
          ? runningAgents
          : runningAgents.filter((row) => row.agentName.toLowerCase() === target.toLowerCase());
        for (const match of matches) {
          if (!targetAgents.some((a) => a.agentId === match.agentId)) {
            targetAgents.push(match);
          }
        }
      }
      if (targetAgents.length === 0) {
        await sendTelegramText(chatId, 'No running agents found matching the target. Start an agent first to send documents.');
        return;
      }
    } else if (runningAgents.length === 1) {
      targetAgents = [runningAgents[0]!];
    } else if (runningAgents.length === 0) {
      await sendTelegramText(chatId, 'No running agents found. Start an agent first to send documents.');
      return;
    } else {
      await sendTelegramText(chatId, 'Multiple running agents found. Use /to <agent name> in the caption to choose a target.');
      return;
    }

    // ── 4. Download the file from Telegram ───────────────────────────────

    const fileData = await downloadTelegramFile(document.id);
    if (!fileData) {
      await sendTelegramText(chatId, 'Failed to download the document from Telegram. Please try again.');
      return;
    }

    // ── 5. Ingest through AgentDocumentService for each target agent ─────

    const filename = document.filename ?? 'document';
    const mimeType = document.mimeType ?? 'application/octet-stream';
    const docService = getDocumentService();

    for (const targetAgent of targetAgents) {
      const result = await docService.uploadDocument({
        agentId: targetAgent.agentId,
        userId,
        source: 'telegram',
        originalFilename: filename,
        mimeType,
        body: fileData.buffer,
        sourceRef: document.id,
        captionOrPrompt: caption ?? null,
      });

      if (!result.ok) {
        await sendTelegramText(chatId, `Document upload failed for ${targetAgent.agentName}: ${result.error.message}`);
        continue;
      }

      // ── 6. Publish text notification to the agent ─────────────────────

      const docResult = result.data;
      const notificationText = buildDocumentNoticeText({
        documentId: docResult.id,
        filename,
        extracted: docResult.extractionStatus === 'ready',
        caption,
      });

      await deliverTelegramMessage(targetAgent.agentId, userId, notificationText);
      await sendTelegramText(chatId, `Document delivered to ${targetAgent.agentName}.`);
    }
  }

  interface ChatWebhookChannel {
    adapter: ChatInboundAdapter;
    configured: boolean;
    processText: (message: InboundChatMessage) => Promise<void>;
    processDocument: (message: InboundChatMessage) => Promise<void>;
  }

  const chatWebhookChannels = new Map<string, ChatWebhookChannel>([
    ['telegram', {
      adapter: telegramChannel,
      configured: Boolean(botToken && webhookSecret),
      processText: (message) => processWebhookUpdate(message.from.address, message),
      processDocument: (message) => processWebhookDocument(message.from.address, message),
    }],
  ]);

  async function handleChatWebhook(provider: string, webhookRequest: ChatWebhookRequest, reply: FastifyReply) {
    const channel = chatWebhookChannels.get(provider);
    if (!channel) {
      return reply.status(404).send({ error: 'not_found' });
    }
    if (!channel.configured) {
      return reply.status(501).send({ error: 'not_configured' });
    }

    if (!channel.adapter.verify(webhookRequest).ok) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const parsed = channel.adapter.parse(webhookRequest);
    if (!parsed.ok || !parsed.data.length) {
      return reply.status(200).send({ ok: true });
    }

    const message = parsed.data[0]!;

    // Handle document messages — download, ingest, and notify the agent
    if (message.document) {
      reply.status(200).send({ ok: true });
      void channel.processDocument(message).catch((err) => {
        app.log.warn({ err, provider }, 'Chat webhook document processing failed');
      });
      return;
    }

    // Drop other non-text messages
    if (!message.text || message.text.trim().length === 0) {
      return reply.status(200).send({ ok: true });
    }

    // Acknowledge the provider immediately — routing and delivery happen asynchronously
    // to avoid slow-DB or slow-API latency causing provider retries.
    reply.status(200).send({ ok: true });
    void channel.processText(message).catch((err) => {
      app.log.warn({ err, provider }, 'Chat webhook async processing failed');
    });
  }

  app.post<{ Params: { provider: string }; Body: unknown }>('/messaging/chat/:provider/webhook', async (request, reply) =>
    handleChatWebhook(request.params.provider, { headers: request.headers, body: request.body }, reply));

  // Verify handshake for providers that need one (none registered yet); unknown providers are 404.
  app.get<{ Params: { provider: string } }>('/messaging/chat/:provider/webhook', async (request, reply) => {
    if (!chatWebhookChannels.has(request.params.provider)) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return reply.status(405).send({ error: 'method_not_allowed' });
  });

  // Telegram alias of the neutral route; behaviour is identical.
  app.post<{ Body: unknown }>('/telegram/webhook', async (request, reply) =>
    handleChatWebhook('telegram', { headers: request.headers, body: request.body }, reply));
}
