import crypto from 'node:crypto';
import { eq, and, desc, inArray } from 'drizzle-orm';
import type { Database } from './index.js';
import { agents, agentInstanceLinks, agentRuntimeSessions, agentMessages, agentArtifacts, agentOutboundMessages, users } from './schema/index.js';

// --- Agent ---

export interface InsertAgent {
  userId: string;
  name: string;
  goal: string;
  toolPolicy?: Record<string, unknown>;
  modelPolicy?: Record<string, unknown>;
}

export interface UpdateAgent {
  name?: string;
  goal?: string;
  status?: string;
  pauseState?: { reason: string; requestedBy: string; pausedAt: string } | null;
  toolPolicy?: Record<string, unknown>;
  modelPolicy?: Record<string, unknown>;
}

// --- Agent Instance Link ---

export interface InsertAgentInstanceLink {
  agentId: string;
  tradingInstanceId: string;
}

// --- Agent Runtime Session ---

export interface InsertAgentRuntimeSession {
  id?: string;
  agentId: string;
  tradingInstanceId: string;
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
  tradingInstanceId: string;
}

// --- Agent Message ---

export interface InsertAgentMessage {
  messageId: string;
  correlationId: string;
  actorType: string;
  actorId: string;
  tradingInstanceId: string;
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
      goal: input.goal,
      status: 'stopped',
      toolPolicy: input.toolPolicy ?? null,
      modelPolicy: input.modelPolicy ?? null,
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

  // --- Agent Instance Links ---

  async createLink(input: InsertAgentInstanceLink): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(agentInstanceLinks).values({
      id,
      agentId: input.agentId,
      tradingInstanceId: input.tradingInstanceId,
      status: 'active',
    });
    return id;
  }

  async getActiveLink(agentId: string) {
    const rows = await this.db.select().from(agentInstanceLinks)
      .where(and(eq(agentInstanceLinks.agentId, agentId), eq(agentInstanceLinks.status, 'active')))
      .limit(1);
    return rows[0] ?? null;
  }

  async getLinksByInstance(tradingInstanceId: string) {
    return this.db.select().from(agentInstanceLinks)
      .where(eq(agentInstanceLinks.tradingInstanceId, tradingInstanceId));
  }

  async revokeLink(id: string): Promise<void> {
    await this.db.update(agentInstanceLinks).set({
      status: 'revoked',
      updatedAt: new Date(),
    }).where(eq(agentInstanceLinks.id, id));
  }

  // --- Agent Runtime Sessions ---

  async createSession(input: InsertAgentRuntimeSession): Promise<string> {
    const id = input.id ?? crypto.randomUUID();
    await this.db.insert(agentRuntimeSessions).values({
      id,
      agentId: input.agentId,
      tradingInstanceId: input.tradingInstanceId,
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

  async getSessionForAgentAndInstance(agentId: string, tradingInstanceId: string) {
    const rows = await this.db.select().from(agentRuntimeSessions)
      .where(and(
        eq(agentRuntimeSessions.agentId, agentId),
        eq(agentRuntimeSessions.tradingInstanceId, tradingInstanceId),
        inArray(agentRuntimeSessions.status, ['starting', 'running', 'unhealthy']),
      ))
      .orderBy(desc(agentRuntimeSessions.startedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async getActiveSessionByInstance(tradingInstanceId: string) {
    const rows = await this.db.select().from(agentRuntimeSessions)
      .where(and(
        eq(agentRuntimeSessions.tradingInstanceId, tradingInstanceId),
        eq(agentRuntimeSessions.status, 'running'),
      ))
      .limit(1);
    return rows[0] ?? null;
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
      tradingInstanceId: agentRuntimeSessions.tradingInstanceId,
    }).from(agentRuntimeSessions)
      .innerJoin(agents, eq(agentRuntimeSessions.agentId, agents.id))
      .innerJoin(agentInstanceLinks, and(
        eq(agentInstanceLinks.agentId, agents.id),
        eq(agentInstanceLinks.tradingInstanceId, agentRuntimeSessions.tradingInstanceId),
        eq(agentInstanceLinks.status, 'active'),
      ))
      .where(and(
        eq(agentRuntimeSessions.status, 'starting'),
        eq(agents.status, 'starting'),
      ))
      .orderBy(desc(agentRuntimeSessions.startedAt));
  }

  async getActiveSessionsByInstance(tradingInstanceId: string) {
    return this.db.select().from(agentRuntimeSessions)
      .where(and(
        eq(agentRuntimeSessions.tradingInstanceId, tradingInstanceId),
        inArray(agentRuntimeSessions.status, ['starting', 'running', 'unhealthy']),
      ))
      .orderBy(desc(agentRuntimeSessions.startedAt));
  }

  /** Retire all non-terminal sessions for an agent (starting/running/unhealthy → stopped). */
  async retireActiveSessions(agentId: string): Promise<void> {
    await this.db.update(agentRuntimeSessions)
      .set({ status: 'stopped', stoppedAt: new Date() })
      .where(and(
        eq(agentRuntimeSessions.agentId, agentId),
        inArray(agentRuntimeSessions.status, ['starting', 'running', 'unhealthy']),
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
      inArray(agentRuntimeSessions.status, ['starting', 'running', 'unhealthy']),
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
      tradingInstanceId: input.tradingInstanceId,
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

  async getRecentMessages(tradingInstanceId: string, limit = 50) {
    return this.db.select().from(agentMessages)
      .where(eq(agentMessages.tradingInstanceId, tradingInstanceId))
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
