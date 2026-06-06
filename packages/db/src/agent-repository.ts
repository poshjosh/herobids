import crypto from 'node:crypto';
import { eq, and, desc, inArray } from 'drizzle-orm';
import type { Database } from './index.js';
import { agents, agentRuntimeSessions, agentMessages, agentArtifacts, agentOutboundMessages, users } from './schema/index.js';

// --- Agent ---

export interface InsertAgent {
  userId: string;
  name: string;
  prompt: string;
  skillIds?: string[];
  toolPolicy?: Record<string, unknown>;
  modelPolicy?: Record<string, unknown>;
  telegramChatId?: string;
  executionMode?: string;
  dailyTokenBudget?: number;
  dailyLossLimit?: string;
  maxBots?: number;
  maxSlippageBps?: number;
}

export interface UpdateAgent {
  name?: string;
  prompt?: string;
  skillIds?: string[];
  status?: string;
  pauseState?: { reason: string; requestedBy: string; pausedAt: string } | null;
  toolPolicy?: Record<string, unknown>;
  modelPolicy?: Record<string, unknown>;
  telegramChatId?: string;
  executionMode?: string;
  dailyTokenBudget?: number;
  dailyLossLimit?: string;
  maxBots?: number;
  maxSlippageBps?: number;
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
}

// --- Agent Artifact ---

export interface InsertAgentArtifact {
  agentId: string;
  sessionId: string;
  artifactType: string;
  contentType: string;
  summary: string;
  location?: { bucket?: string; key?: string; url?: string } | null;
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
}

/**
 * Repository for agent-related persistence.
 */
export class AgentRepository {
  constructor(private readonly db: Database) {}

  // --- Agents ---

  async createAgent(input: InsertAgent): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(agents).values({
      id,
      userId: input.userId,
      name: input.name,
      prompt: input.prompt,
      skillIds: input.skillIds ?? [],
      status: 'stopped',
      toolPolicy: input.toolPolicy ?? null,
      modelPolicy: input.modelPolicy ?? null,
      telegramChatId: input.telegramChatId ?? null,
      executionMode: input.executionMode ?? null,
      dailyTokenBudget: input.dailyTokenBudget ?? null,
      dailyLossLimit: input.dailyLossLimit ?? null,
      maxBots: input.maxBots ?? null,
      maxSlippageBps: input.maxSlippageBps ?? null,
    });
    return id;
  }

  async getAgent(id: string) {
    const rows = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return rows[0] ?? null;
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

  async deleteAgent(id: string): Promise<void> {
    await this.db.delete(agents).where(eq(agents.id, id));
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

  async getSessionForAgentAndInstance(agentId: string, _botId: string) {
    // tradingInstanceId no longer stored on sessions — use getActiveSession(agentId) instead.
    return this.getActiveSession(agentId);
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

  /** Retire all non-terminal sessions for an agent (starting/launching/running/unhealthy → stopped). */
  async retireActiveSessions(agentId: string): Promise<void> {
    await this.db.update(agentRuntimeSessions)
      .set({ status: 'stopped', stoppedAt: new Date() })
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
    const updated = await this.db.update(agentRuntimeSessions).set({
      status: 'stopped',
      stoppedAt,
    }).where(and(
      eq(agentRuntimeSessions.id, sessionId),
      inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
    )).returning({ id: agentRuntimeSessions.id });

    return updated.length > 0;
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
      deliveryStatus: 'pending',
    });
    return id;
  }

  async markOutboundMessageSent(id: string, telegramMessageId: string, telegramChatId: string): Promise<void> {
    await this.db.update(agentOutboundMessages).set({
      deliveryStatus: 'sent',
      telegramMessageId,
      telegramChatId,
    }).where(eq(agentOutboundMessages.id, id));
  }

  async markOutboundMessageFailed(id: string, error: string): Promise<void> {
    await this.db.update(agentOutboundMessages).set({
      deliveryStatus: 'failed',
      deliveryError: error,
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

  // --- User Telegram ---

  /** Look up the Telegram chat ID for the user that owns the given agent. */
  async getUserTelegramChatId(agentId: string): Promise<string | null> {
    const rows = await this.db
      .select({ telegramChatId: users.telegramChatId })
      .from(agents)
      .innerJoin(users, eq(agents.userId, users.id))
      .where(eq(agents.id, agentId))
      .limit(1);
    return rows[0]?.telegramChatId ?? null;
  }
}
