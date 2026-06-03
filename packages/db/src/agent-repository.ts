import crypto from 'node:crypto';
import { eq, and, desc, inArray } from 'drizzle-orm';
import type { Database } from './index.js';
import { agents, agentInstanceLinks, agentRuntimeSessions, agentMessages, agentArtifacts } from './schema/index.js';

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
}
