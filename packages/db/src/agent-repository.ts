import crypto from 'node:crypto';
import { eq, and, desc, inArray, asc, ne, isNull, or, sql } from 'drizzle-orm';
import type { Database } from './index.js';
import {
  agentArtifacts,
  agentMessages,
  agentOutboundMessages,
  agentRuntimeSessions,
  agentSkills,
  agents,
  chatAddresses,
  skillUsageEvents,
  users,
} from './schema/index.js';
import { resolveRuntimeCapabilityDescriptor } from './agent-runtime-descriptor.js';
import { normalizePersistedAiModelConfig, type PersistedAiModelConfig, type UnifiedAgentConfig, type ProvidersYaml, TechnicalConfigSchema, IntelligenceConfigSchema, type ChatAddress, type ChatAddressValue, type ChatProvider } from '@herobids/domain';

// --- Helpers ---

/**
 * 004: Canonical location for stamping `capabilityMode` (and `hybridMode` for
 * hybrid agents) on raw unifiedConfig JSONB blobs read from the database.
 * The SQL migration (0040_stamp_capability_mode) handles this at rest, but
 * this guards in-flight reads before the migration runs or if it was skipped.
 *
 * This is also the authoritative default for `hybridMode: 'mixed'` — because
 * the Zod schema cannot express `.default('mixed')` without breaking
 * intelligence agents (`.default()` runs before `.superRefine()`, which
 * discriminates between hybrid and intelligence shapes).
 *
 * - Agents with `technical` config → `capabilityMode: 'hybrid'`, `hybridMode: 'mixed'`
 * - Agents without `technical` config → `capabilityMode: 'intelligence'`
 * - Idempotent when `capabilityMode` is present:
 *   - intelligence agents → returned unchanged
 *   - hybrid agents → still stamps `hybridMode: 'mixed'` if missing
 */
function applyCapabilityModeMigrationDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  if ('capabilityMode' in raw) {
    // Still need to stamp hybridMode for hybrid agents missing it
    if (raw.capabilityMode === 'hybrid' && !('hybridMode' in raw)) {
      return { ...raw, hybridMode: 'mixed' };
    }
    return raw;
  }
  const config = { ...raw };
  if ('technical' in config && config.technical != null) {
    config.capabilityMode = 'hybrid';
    config.hybridMode = 'mixed';
  } else {
    config.capabilityMode = 'intelligence';
  }
  return config;
}

/**
 * Apply Zod schema defaults to technical and intelligence config blocks
 * at the DB read boundary. Without this, fields like scanBatchSize,
 * scanIntervalMs, candles, signalBias, and autonomousExit return undefined
 * when absent from the stored JSONB, even though they have .default()
 * in TechnicalConfigSchema.
 *
 * - If the technical block exists, parse it through TechnicalConfigSchema
 *   to inject all Zod-level defaults.
 * - If the intelligence block exists, parse it through IntelligenceConfigSchema.
 *   (Currently all fields are .optional(), so no defaults are injected yet,
 *   but this future-proofs the read path.)
 * - On parse failure, leave the block as-is — callers handle invalid config
 *   elsewhere.
 */
function applyConfigDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  const result = { ...raw };
  const capabilityMode = result['capabilityMode'] as string | undefined;

  if (result['technical'] && typeof result['technical'] === 'object') {
    try {
      result['technical'] = TechnicalConfigSchema.parse(result['technical']);
    } catch {
      // Leave as-is on parse failure.
    }
  } else if (capabilityMode === 'hybrid' && !result['technical']) {
    // Hybrid agents need a technical block to operate. If it's missing
    // (e.g. from a pre-fix agent created before defaults were applied at
    // write time), inject an empty object through the schema so the worker
    // gets all Zod defaults (scanBatchSize, autonomousExit, etc.).
    // Filters will be populated separately by the worker from connections.
    try {
      result['technical'] = TechnicalConfigSchema.parse({});
    } catch {
      // TechnicalConfigSchema requires filters.venue/venueType — if missing,
      // the worker's Fix 2 guard handles it gracefully.
    }
  }

  if (result['intelligence'] && typeof result['intelligence'] === 'object') {
    try {
      result['intelligence'] = IntelligenceConfigSchema.parse(result['intelligence']);
    } catch {
      // Leave as-is on parse failure.
    }
  }

  return result;
}

// --- Agent ---

export interface InsertAgent {
  userId: string;
  name: string;
  prompt: string;
  toolPolicy?: Record<string, unknown>;
  modelPolicy?: Record<string, unknown>;
  telegramChatId?: string;
  notificationPolicy?: {
    sendMessage?: {
      email?: { enabled: boolean; source: 'explicit_prompt' | 'explicit_update'; enabledAt?: string };
    };
  } | null;
  maxBots?: number;
  openPositionEscalationToJudgePolicy?: string;
}

export interface UpdateAgent {
  name?: string;
  prompt?: string;
  status?: string;
  pauseState?: { reason: string; requestedBy: string; pausedAt: string } | null;
  toolPolicy?: Record<string, unknown>;
  modelPolicy?: Record<string, unknown>;
  telegramChatId?: string;
  notificationPolicy?: {
    sendMessage?: {
      email?: { enabled: boolean; source: 'explicit_prompt' | 'explicit_update'; enabledAt?: string };
    };
  } | null;
  maxBots?: number;
  openPositionEscalationToJudgePolicy?: string;
}

// agent_instance_links REMOVED — replaced by bots.creatorType/creatorId

// --- Agent Runtime Session ---

export interface InsertAgentRuntimeSession {
  id?: string;
  agentId: string;
  // tradingInstanceId REMOVED — sessions are agent-scoped
}

export interface UpdateAgentRuntimeSession {
  status?: string;
  lastHeartbeatAt?: Date;
  cpuPct?: number;
  memoryBytes?: number;
  stoppedAt?: Date;
}

export interface LaunchableStartingSession {
  id: string;
  agentId: string;
  // tradingInstanceId REMOVED
}

// --- Agent Message ---

export interface InsertAgentMessage {
  messageId: string;
  correlationId: string;
  actorType: string;
  actorId: string;
  agentId: string;    // was tradingInstanceId — primary grouping key
  botId?: string;     // nullable — set when message is bot-scoped
  type: string;
  direction: 'inbound' | 'outbound';
  schemaVersion?: string;
  sequence?: number;
  traceId?: string;
  payload?: Record<string, unknown>;
}

// --- Agent Artifact ---

export interface InsertAgentArtifact {
  agentId: string;
  sessionId: string;
  artifactType: string;
  contentType: string;
  summary: string;
  location?: { bucket?: string; key?: string; url?: string; body?: string } | null;
  metadata?: Record<string, unknown>;
  retentionClass?: string;
  expiresAt?: Date;
}

// --- Agent Outbound Message ---

export interface InsertAgentOutboundMessage {
  agentId: string;
  sessionId?: string;
  /** 'agent' | 'platform' */
  authoredBy: string;
  subject?: string;
  body: string;
  contextRef?: string;
  /** Message class: 'routine' | 'alert' | 'reminder' */
  messageClass?: string;
}

/**
 * Repository for agent-related persistence.
 */
export class AgentRepository {
  constructor(
    private readonly db: Database,
    private readonly providersYaml?: ProvidersYaml,
  ) {}

  async getRuntimeCapabilityDescriptor(agentId: string) {
    return resolveRuntimeCapabilityDescriptor(this.db, agentId);
  }

  // --- Agents ---

  async createAgent(input: InsertAgent): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(agents).values({
      id,
      userId: input.userId,
      name: input.name,
      prompt: input.prompt,
      status: 'stopped',
      toolPolicy: input.toolPolicy ?? null,
      modelPolicy: input.modelPolicy ?? null,
      telegramChatId: input.telegramChatId ?? null,
      notificationPolicy: input.notificationPolicy ?? null,
      maxBots: input.maxBots ?? null,
      openPositionEscalationToJudgePolicy: input.openPositionEscalationToJudgePolicy ?? undefined,
    });
    return id;
  }

  async getAgent(id: string) {
    const rows = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async getUserAiModelConfig(userId: string): Promise<PersistedAiModelConfig | null> {
    const rows = await this.db.select({ aiModelConfig: users.aiModelConfig })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const raw = rows[0]?.aiModelConfig;
    const provider = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['provider']
      : undefined;
    const providerConfig = typeof provider === 'string' && this.providersYaml
      ? this.providersYaml.providers[provider]
      : undefined;
    return normalizePersistedAiModelConfig(raw, providerConfig);
  }

  async getAgentsByUser(userId: string) {
    return this.db.select().from(agents).where(eq(agents.userId, userId)).orderBy(desc(agents.createdAt));
  }

  async updateAgent(id: string, update: UpdateAgent): Promise<void> {
    await this.db.update(agents).set({
      ...update,
      updatedAt: new Date(),
    }).where(eq(agents.id, id));
  }

  /** Narrow status read (no JSONB config). Returns null when the agent row is missing. */
  async getAgentStatus(id: string): Promise<string | null> {
    const rows = await this.db.select({ status: agents.status }).from(agents).where(eq(agents.id, id)).limit(1);
    return rows[0]?.status ?? null;
  }

  /**
   * Atomically mark an agent `active` unless it is `paused`. A pause that lands
   * concurrently is never overwritten because the guard is part of the UPDATE.
   * Returns the resulting status (`'active'`, `'paused'`), or null when the row is missing.
   */
  async activateAgentUnlessPaused(id: string): Promise<string | null> {
    const updated = await this.db.update(agents).set({
      status: 'active',
      updatedAt: new Date(),
    }).where(and(eq(agents.id, id), ne(agents.status, 'paused')))
      .returning({ status: agents.status });
    if (updated.length > 0) return 'active';
    return this.getAgentStatus(id);
  }

  async deleteAgent(id: string): Promise<void> {
    await this.db.delete(agents).where(eq(agents.id, id));
  }

  // --- Unified Agent Config ---

  async getUnifiedConfig(agentId: string): Promise<UnifiedAgentConfig | null> {
    const rows = await this.db.select({ unifiedConfig: agents.unifiedConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    const raw = rows[0]?.unifiedConfig ?? null;
    if (!raw) return null;
    // 004: Defensive migration default — stamp capabilityMode (and hybridMode
    // for hybrid agents) if absent from the stored JSONB. The SQL migration
    // (0040) handles this at rest, but this guards in-flight reads before the
    // migration runs or if the migration was skipped.
    const withCapabilityDefaults = applyCapabilityModeMigrationDefaults(raw as Record<string, unknown>);
    const withAllDefaults = applyConfigDefaults(withCapabilityDefaults);
    return withAllDefaults as UnifiedAgentConfig;
  }

  async updateUnifiedConfig(agentId: string, config: UnifiedAgentConfig | null): Promise<void> {
    // 004: Default hybridMode to 'mixed' for hybrid agents (Zod can't do this
    // because .default() runs before .superRefine(), breaking intelligence agents).
    const toPersist = config && config.capabilityMode === 'hybrid' && !config.hybridMode
      ? { ...config, hybridMode: 'mixed' as const }
      : config;
    await this.db.update(agents).set({
      unifiedConfig: toPersist,
      updatedAt: new Date(),
    }).where(eq(agents.id, agentId));
  }

  // --- Agent Runtime Sessions ---

  async createSession(input: InsertAgentRuntimeSession): Promise<string> {
    const id = input.id ?? crypto.randomUUID();
    await this.db.insert(agentRuntimeSessions).values({
      id,
      agentId: input.agentId,
      // tradingInstanceId REMOVED
      status: 'starting',
    });
    return id;
  }

  async getSession(id: string) {
    const rows = await this.db.select().from(agentRuntimeSessions).where(eq(agentRuntimeSessions.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async getActiveSession(agentId: string) {
    const rows = await this.db.select().from(agentRuntimeSessions)
      .where(and(
        eq(agentRuntimeSessions.agentId, agentId),
        eq(agentRuntimeSessions.status, 'running'),
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  async getCurrentSession(agentId: string) {
    const rows = await this.db.select().from(agentRuntimeSessions)
      .where(and(
        eq(agentRuntimeSessions.agentId, agentId),
        inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  async getSessionForAgentAndInstance(agentId: string, _botId: string) {
    // tradingInstanceId no longer stored on sessions — use getActiveSession(agentId) instead.
    return this.getActiveSession(agentId);
  }

  /**
   * Verify that a given sessionId is the current active (running) session for the agent.
   * Returns true only if the session exists, belongs to the agent, and is in 'running' status.
   * Used to reject messages from superseded containers.
   */
  async isActiveSession(agentId: string, sessionId: string): Promise<boolean> {
    const rows = await this.db.select({ id: agentRuntimeSessions.id })
      .from(agentRuntimeSessions)
      .where(and(
        eq(agentRuntimeSessions.id, sessionId),
        eq(agentRuntimeSessions.agentId, agentId),
        eq(agentRuntimeSessions.status, 'running'),
      ))
      .limit(1);
    return rows.length > 0;
  }

  async getActiveSessionByInstance(_botId: string) {
    // tradingInstanceId no longer stored on sessions. Returns null; callers should migrate.
    return null;
  }

  async getSessionsByStatuses(statuses: string[]) {
    if (statuses.length === 0) return [];

    return this.db.select().from(agentRuntimeSessions)
      .where(inArray(agentRuntimeSessions.status, statuses));
  }

  /** Atomically claim a 'starting' session for launch by transitioning it to 'launching'.
   * Returns true if the claim succeeded (this worker owns the launch); false if another worker
   * already claimed it. Prevents duplicate runtime launches in multi-worker deployments. */
  async claimStartingSession(sessionId: string): Promise<boolean> {
    const updated = await this.db.update(agentRuntimeSessions).set({
      status: 'launching',
    }).where(and(
      eq(agentRuntimeSessions.id, sessionId),
      eq(agentRuntimeSessions.status, 'starting'),
    )).returning({ id: agentRuntimeSessions.id });
    return updated.length > 0;
  }

  async getLaunchableStartingSessions(): Promise<LaunchableStartingSession[]> {
    return this.db.select({
      id: agentRuntimeSessions.id,
      agentId: agentRuntimeSessions.agentId,
    }).from(agentRuntimeSessions)
      .innerJoin(agents, eq(agentRuntimeSessions.agentId, agents.id))
      .where(and(
        eq(agentRuntimeSessions.status, 'starting'),
        eq(agents.status, 'starting'),
      ))
      .orderBy(desc(agentRuntimeSessions.startedAt));
  }

  async getActiveSessionsByInstance(_botId: string) {
    // tradingInstanceId no longer stored on sessions. Callers should migrate to getActiveSession(agentId).
    // This stub preserves the call site signature during the transition period.
    return [];
  }

  /** Mark an active session terminal without collapsing the terminal status.
   * `stopped` is the graceful path; `crashed` preserves abnormal termination. */
  async markSessionEnded(sessionId: string, status: 'stopped' | 'crashed', stoppedAt: Date): Promise<boolean> {
    const updated = await this.db.update(agentRuntimeSessions).set({
      status,
      stoppedAt,
    }).where(and(
      eq(agentRuntimeSessions.id, sessionId),
      inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
    )).returning({ id: agentRuntimeSessions.id });

    return updated.length > 0;
  }

  /** Retire all non-terminal sessions for an agent as stopped (graceful terminal state). */
  async retireActiveSessions(agentId: string): Promise<void> {
    await this.retireActiveSessionsWithStatus(agentId, 'stopped');
  }

  /** Retire all non-terminal sessions for an agent using the requested terminal status.
   * Used by graceful stops (`stopped`) and abnormal terminal exits (`crashed`). */
  async retireActiveSessionsWithStatus(
    agentId: string,
    status: 'stopped' | 'crashed',
    stoppedAt: Date = new Date(),
  ): Promise<void> {
    await this.db.update(agentRuntimeSessions)
      .set({ status, stoppedAt })
      .where(and(
        eq(agentRuntimeSessions.agentId, agentId),
        inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
      ));
  }

  async updateSession(id: string, update: UpdateAgentRuntimeSession): Promise<void> {
    await this.db.update(agentRuntimeSessions).set(update).where(eq(agentRuntimeSessions.id, id));
  }

  async markSessionRunning(sessionId: string, heartbeatAt: Date): Promise<boolean> {
    const updated = await this.db.update(agentRuntimeSessions).set({
      status: 'running',
      lastHeartbeatAt: heartbeatAt,
    }).where(and(
      eq(agentRuntimeSessions.id, sessionId),
      inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
    )).returning({ id: agentRuntimeSessions.id });

    return updated.length > 0;
  }

  async markSessionStopped(sessionId: string, stoppedAt: Date): Promise<boolean> {
    return this.markSessionEnded(sessionId, 'stopped', stoppedAt);
  }

  async markSessionStartTimedOut(sessionId: string, stoppedAt: Date): Promise<boolean> {
    const updated = await this.db.update(agentRuntimeSessions).set({
      status: 'stopped',
      stoppedAt,
    }).where(and(
      eq(agentRuntimeSessions.id, sessionId),
      inArray(agentRuntimeSessions.status, ['starting', 'launching']),
    )).returning({ id: agentRuntimeSessions.id });

    return updated.length > 0;
  }

  async recordSessionStartedSkillUsage(agentId: string, sessionId: string): Promise<void> {
    const [agent] = await this.db.select({ userId: agents.userId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (!agent) {
      return;
    }

    const assignments = await this.db.select({
      skillId: agentSkills.skillId,
      skillRevisionId: agentSkills.skillRevisionId,
    }).from(agentSkills)
      .where(eq(agentSkills.agentId, agentId))
      .orderBy(asc(agentSkills.orderIndex), asc(agentSkills.skillId));

    const now = new Date();
    for (const assignment of assignments) {
      await this.db.insert(skillUsageEvents).values({
        id: crypto.randomUUID(),
        skillId: assignment.skillId,
        skillRevisionId: assignment.skillRevisionId,
        userId: agent.userId,
        agentId,
        sessionId,
        eventType: 'session_started',
        occurredAt: now,
        metadata: { source: 'runtime_heartbeat_transition' },
        createdAt: now,
      });
    }
  }

  // --- Agent Messages ---

  async insertMessage(input: InsertAgentMessage): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(agentMessages).values({
      id,
      messageId: input.messageId,
      correlationId: input.correlationId,
      actorType: input.actorType,
      actorId: input.actorId,
      agentId: input.agentId,
      botId: input.botId ?? null,
      type: input.type,
      direction: input.direction,
      schemaVersion: input.schemaVersion ?? 'v1',
      sequence: input.sequence ?? null,
      traceId: input.traceId ?? null,
      processingStatus: 'received',
      payload: input.payload ?? null,
    });
    return id;
  }

  async isMessageDuplicate(messageId: string): Promise<boolean> {
    const rows = await this.db.select({ id: agentMessages.id })
      .from(agentMessages)
      .where(eq(agentMessages.messageId, messageId))
      .limit(1);
    return rows.length > 0;
  }

  async markMessageProcessed(messageId: string, status: 'processed' | 'rejected' | 'failed', errorDetail?: { code: string; message: string }): Promise<void> {
    await this.db.update(agentMessages).set({
      processingStatus: status,
      errorDetail: errorDetail ?? null,
    }).where(eq(agentMessages.messageId, messageId));
  }

  async getMessagesByCorrelation(correlationId: string) {
    return this.db.select().from(agentMessages)
      .where(eq(agentMessages.correlationId, correlationId))
      .orderBy(agentMessages.createdAt);
  }

  async getRecentMessages(agentId: string, limit = 50) {
    return this.db.select().from(agentMessages)
      .where(eq(agentMessages.agentId, agentId))
      .orderBy(desc(agentMessages.createdAt))
      .limit(limit);
  }

  // --- Agent Artifacts ---

  async insertArtifact(input: InsertAgentArtifact): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(agentArtifacts).values({
      id,
      agentId: input.agentId,
      sessionId: input.sessionId,
      artifactType: input.artifactType,
      contentType: input.contentType,
      summary: input.summary,
      location: input.location ?? null,
      metadata: input.metadata ?? null,
      retentionClass: input.retentionClass ?? 'standard',
      expiresAt: input.expiresAt ?? null,
    });
    return id;
  }

  async getArtifactsBySession(sessionId: string) {
    return this.db.select().from(agentArtifacts)
      .where(eq(agentArtifacts.sessionId, sessionId))
      .orderBy(desc(agentArtifacts.createdAt));
  }

  async getArtifactsByAgent(agentId: string, limit = 50) {
    return this.db.select().from(agentArtifacts)
      .where(eq(agentArtifacts.agentId, agentId))
      .orderBy(desc(agentArtifacts.createdAt))
      .limit(limit);
  }

  // --- Agent Outbound Messages ---

  async insertOutboundMessage(input: InsertAgentOutboundMessage): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(agentOutboundMessages).values({
      id,
      agentId: input.agentId,
      sessionId: input.sessionId ?? null,
      authoredBy: input.authoredBy,
      subject: input.subject ?? null,
      body: input.body,
      contextRef: input.contextRef ?? null,
      messageClass: input.messageClass ?? null,
      deliveryStatus: 'pending',
    });
    return id;
  }

  async markOutboundMessageSent(id: string, telegramMessageId: string, telegramChatId: string): Promise<void> {
    await this.db.update(agentOutboundMessages).set({
      deliveryStatus: 'sent',
      telegramMessageId,
      telegramChatId,
      deliveryProvider: 'telegram',
      deliveryAddress: telegramChatId,
      providerMessageId: telegramMessageId,
    }).where(eq(agentOutboundMessages.id, id));
  }

  async markOutboundMessageFailed(id: string, error: string): Promise<void> {
    await this.db.update(agentOutboundMessages).set({
      deliveryStatus: 'failed',
      deliveryError: error,
    }).where(eq(agentOutboundMessages.id, id));
  }

  /** @deprecated Email fanout from send_message has been removed (2026-07-17). Retained for historical audit. */
  async markOutboundMessageEmailSent(id: string, emailMessageId: string): Promise<void> {
    await this.db.update(agentOutboundMessages).set({
      emailDeliveryStatus: 'email_sent',
      emailMessageId,
    }).where(eq(agentOutboundMessages.id, id));
  }

  /** @deprecated Email fanout from send_message has been removed (2026-07-17). Retained for historical audit. */
  async markOutboundMessageEmailSkipped(id: string, reason: string): Promise<void> {
    await this.db.update(agentOutboundMessages).set({
      emailDeliveryStatus: reason,
    }).where(eq(agentOutboundMessages.id, id));
  }

  /** @deprecated Email fanout from send_message has been removed (2026-07-17). Retained for historical audit. */
  async markOutboundMessageEmailFailed(id: string, error: string): Promise<void> {
    await this.db.update(agentOutboundMessages).set({
      emailDeliveryStatus: 'email_failed_provider',
      emailDeliveryError: error,
    }).where(eq(agentOutboundMessages.id, id));
  }

  async getOutboundMessages(agentId: string, limit = 50) {
    return this.db.select().from(agentOutboundMessages)
      .where(eq(agentOutboundMessages.agentId, agentId))
      .orderBy(desc(agentOutboundMessages.createdAt))
      .limit(limit);
  }

  /** List all agents currently in 'active' status. Used by DockerAgentManager reconciliation. */
  async listActiveAgents() {
    return this.db.select().from(agents).where(eq(agents.status, 'active'));
  }

  // --- Agent Telegram ---

  /**
   * Resolve the effective Telegram chat ID for an agent's outbound messages.
   * Priority: agent-level teleChatId (if configured) > user-level telegramChatId.
   * Returns null when neither the agent nor its owner has a chat ID set.
   */
  async getEffectiveTelegramChatId(agentId: string): Promise<string | null> {
    const rows = await this.db
      .select({
        agentTelegramChatId: agents.telegramChatId,
        userTelegramChatId: users.telegramChatId,
      })
      .from(agents)
      .innerJoin(users, eq(agents.userId, users.id))
      .where(eq(agents.id, agentId))
      .limit(1);
    // Treat empty/whitespace chat IDs as "not set" so a blank stored value
    // does not produce a broken delivery destination.
    const agentChatId = rows[0]?.agentTelegramChatId?.trim();
    const userChatId = rows[0]?.userTelegramChatId?.trim();
    return (agentChatId || null) ?? (userChatId || null);
  }

  /**
   * Neutral chat_addresses row governing one agent's scope on one provider: the agent-level
   * row if one exists, otherwise the user-level row. Blank addresses are unset and ignored.
   * Returns null only when no row applies, which is the only case that may use legacy data.
   * The owner join (chat_addresses.userId = agents.userId) keeps other users' rows out.
   */
  private async getNeutralChatAddressScope(
    agentId: string,
    provider: ChatProvider,
  ): Promise<{ address: string; isActive: boolean } | null> {
    const rows = await this.db
      .select({
        rowAgentId: chatAddresses.agentId,
        address: chatAddresses.address,
        isActive: sql<boolean>`${chatAddresses.status} = ${'active'}`,
      })
      .from(agents)
      .innerJoin(chatAddresses, and(
        eq(chatAddresses.userId, agents.userId),
        eq(chatAddresses.provider, provider),
        or(isNull(chatAddresses.agentId), eq(chatAddresses.agentId, agents.id)),
      ))
      .where(eq(agents.id, agentId));

    const populatedRows = rows.filter((row) => row.address.trim() !== '');
    const scopeRow = populatedRows.find((row) => row.rowAgentId === agentId)
      ?? populatedRows.find((row) => row.rowAgentId === null);
    return scopeRow ? { address: scopeRow.address.trim(), isActive: scopeRow.isActive } : null;
  }

  /**
   * Resolve the effective chat address for an agent's outbound messages on one provider.
   * Precedence: agent-level chat_addresses row > user-level row. Blank addresses are unset.
   * Fails closed: a chosen row that is not active (revoked or pending_optin) yields null
   * and never falls back to another row or to the legacy Telegram columns.
   * Telegram uses the legacy telegram_chat_id columns only when no neutral row exists.
   */
  async getEffectiveChatAddress(agentId: string, provider: ChatProvider): Promise<ChatAddress | null> {
    const scope = await this.getNeutralChatAddressScope(agentId, provider);
    if (scope) {
      return scope.isActive ? { provider, address: scope.address as ChatAddressValue } : null;
    }

    if (provider !== 'telegram') return null;
    const legacyChatId = await this.getEffectiveTelegramChatId(agentId);
    return legacyChatId ? { provider, address: legacyChatId as ChatAddressValue } : null;
  }

  /** Look up the verified account email for the user that owns the given agent. */
  async getUserEmailByAgentId(agentId: string): Promise<string | null> {
    const rows = await this.db
      .select({ email: users.email })
      .from(agents)
      .innerJoin(users, eq(agents.userId, users.id))
      .where(eq(agents.id, agentId))
      .limit(1);
    return rows[0]?.email ?? null;
  }

  /**
   * Resolve whether email fanout is effectively enabled for an agent's send_message calls.
   * Precedence: agent-level explicit override → user-level explicit default → system default (true).
   * @deprecated Email fanout from send_message has been removed (2026-07-17).
   * Agent-initiated email is handled via the dedicated send_email tool.
   * This method is retained for reference but is no longer called in the runtime path.
   */
  async getEffectiveEmailEnabled(agentId: string): Promise<boolean> {
    const rows = await this.db
      .select({
        agentNotificationPolicy: agents.notificationPolicy,
        userNotificationPreferences: users.notificationPreferences,
      })
      .from(agents)
      .innerJoin(users, eq(agents.userId, users.id))
      .where(eq(agents.id, agentId))
      .limit(1);

    const row = rows[0];
    if (!row) return true; // system default: unknown agent → allow (infra gate handles missing agent)

    // 1. Agent-level explicit override
    const agentEnabled = row.agentNotificationPolicy?.sendMessage?.email?.enabled;
    if (agentEnabled !== undefined) {
      return agentEnabled;
    }

    // 2. User-level explicit default
    const userEnabled = row.userNotificationPreferences?.sendMessage?.email?.enabled;
    if (userEnabled !== undefined) {
      return userEnabled;
    }

    // 3. System default: enabled
    return true;
  }

  /**
   * Resolve the agent that owns a given Telegram reply.
   *
   * Telegram message IDs are scoped per chat, not globally.  When a user has
   * multiple Telegram destinations (user-level default + agent-level overrides)
   * we must filter by `chatId` so a reply in chat A does not accidentally
   * resolve to an outbound message sent to chat B that happens to have the
   * same Telegram message ID.
   *
   * The reply is resolved directly from the outbound message record — no
   * pre-resolution of the user via mutable chat bindings is needed.  The
   * returned `userId` (from the agent's owner) is used by the caller for
   * subsequent authorization and delivery routing.
   *
   * Returns `{ agentId, agentName, status, userId }` or `null` when no
   * matching message is found.
   */
  async resolveAgentForTelegramReply(
    telegramMessageId: string,
    chatId: string,
  ): Promise<{ agentId: string; agentName: string; status: string; userId: string } | null> {
    const rows = await this.db.select({
      agentId: agents.id,
      agentName: agents.name,
      status: agents.status,
      userId: agents.userId,
    })
      .from(agentOutboundMessages)
      .innerJoin(agents, eq(agentOutboundMessages.agentId, agents.id))
      .where(and(
        eq(agentOutboundMessages.telegramMessageId, telegramMessageId),
        eq(agentOutboundMessages.telegramChatId, chatId),
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Resolve the agent that owns an inbound chat reply, for any provider.
   *
   * The address is trimmed the same way outbound addresses are; a blank address resolves nothing.
   * With a providerMessageId: the outbound message it identifies (delivery columns, then the
   * legacy Telegram pair for telegram) is checked first. That agent's neutral scope for the
   * provider must not be revoked or pending_optin, otherwise null is returned with no fallback.
   * Then the chat_addresses rows for the address, user-level rows included: any non-active row
   * yields null with no fallback; a single active row naming an agent resolves it. A user-level
   * address names no agent. Without a providerMessageId, an address shared by several agents is
   * not guessed. With one, an ambiguous telegram address falls through to the legacy Telegram
   * pair, which is keyed on that message ID and the chat ID, so it is a specific correlation.
   *
   * Returns `{ agentId, agentName, status, userId }` or `null`.
   */
  async resolveAgentForChatReply(
    provider: ChatProvider,
    address: string,
    providerMessageId?: string,
  ): Promise<{ agentId: string; agentName: string; status: string; userId: string } | null> {
    const normalizedAddress = address.trim();
    if (!normalizedAddress) return null;

    const agentOwner = {
      agentId: agents.id,
      agentName: agents.name,
      status: agents.status,
      userId: agents.userId,
    };

    if (providerMessageId) {
      const outboundRows = await this.db.select(agentOwner)
        .from(agentOutboundMessages)
        .innerJoin(agents, eq(agentOutboundMessages.agentId, agents.id))
        .where(and(
          eq(agentOutboundMessages.deliveryProvider, provider),
          eq(agentOutboundMessages.deliveryAddress, normalizedAddress),
          eq(agentOutboundMessages.providerMessageId, providerMessageId),
        ))
        .limit(1);
      const outboundOwner = outboundRows[0];
      if (outboundOwner) {
        const outboundScope = await this.getNeutralChatAddressScope(outboundOwner.agentId, provider);
        if (outboundScope && !outboundScope.isActive) return null;
        return outboundOwner;
      }
    }

    // Left join: user-level rows (no agent) must still be seen by the blocking check.
    const addressRows = await this.db.select({
      ...agentOwner,
      isAddressActive: sql<boolean>`${chatAddresses.status} = ${'active'}`,
    })
      .from(chatAddresses)
      .leftJoin(agents, and(
        eq(chatAddresses.agentId, agents.id),
        eq(chatAddresses.userId, agents.userId),
      ))
      .where(and(
        eq(chatAddresses.provider, provider),
        eq(chatAddresses.address, normalizedAddress),
      ));
    if (addressRows.some((row) => !row.isAddressActive)) return null;
    // Only rows that name a matched agent can resolve one; user-level rows never do.
    const agentRows = addressRows.flatMap((row) => {
      if (row.agentId === null || row.agentName === null || row.status === null || row.userId === null) return [];
      return [{ agentId: row.agentId, agentName: row.agentName, status: row.status, userId: row.userId }];
    });
    const [onlyAgentRow] = agentRows;
    if (agentRows.length === 1 && onlyAgentRow) return onlyAgentRow;

    // The legacy lookup keys on the message ID, so it cannot run without one.
    if (!providerMessageId || provider !== 'telegram') return null;
    return this.resolveAgentForTelegramReply(providerMessageId, normalizedAddress);
  }
}
