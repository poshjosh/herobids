import crypto from 'node:crypto';
import { and, eq, desc, inArray, isNull } from 'drizzle-orm';
import type { Database } from './index.js';
import { agentDocuments } from './schema/index.js';

// ── TypeScript literal union types for constrained enum columns ──

export type DocumentSource = 'control_plane' | 'telegram';
export type ExtractionStatus = 'not_needed' | 'ready' | 'failed';
export type DocumentLifecycleState = 'staged' | 'materialized' | 'deleted' | 'failed';

export interface InsertAgentDocument {
  /** Optional pre-generated ID. When provided, the repository uses it instead of generating a new one. */
  id?: string;
  agentId: string;
  userId: string;
  source: DocumentSource;
  sourceRef?: string | null;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  originalStoreKey: string;
  extractedTextStoreKey?: string | null;
  extractionStatus?: ExtractionStatus;
  lifecycleState?: DocumentLifecycleState;
  materializedSessionId?: string | null;
  captionOrPrompt?: string | null;
}

/** Only mutable fields — immutable fields (source, originalFilename, mimeType, sizeBytes, originalStoreKey) are excluded. */
export interface UpdateAgentDocument {
  sourceRef?: string | null;
  extractedTextStoreKey?: string | null;
  extractionStatus?: ExtractionStatus;
  lifecycleState?: DocumentLifecycleState;
  materializedSessionId?: string | null;
  captionOrPrompt?: string | null;
}

export class AgentDocumentsRepository {
  constructor(private readonly db: Database) {}

  async create(input: InsertAgentDocument): Promise<string> {
    const id = input.id ?? crypto.randomUUID();
    const now = new Date();
    await this.db.insert(agentDocuments).values({
      id,
      agentId: input.agentId,
      userId: input.userId,
      source: input.source,
      sourceRef: input.sourceRef ?? null,
      originalFilename: input.originalFilename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      originalStoreKey: input.originalStoreKey,
      extractedTextStoreKey: input.extractedTextStoreKey ?? null,
      extractionStatus: input.extractionStatus ?? 'not_needed',
      lifecycleState: input.lifecycleState ?? 'staged',
      materializedSessionId: input.materializedSessionId ?? null,
      captionOrPrompt: input.captionOrPrompt ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async getById(id: string, opts?: { includeDeleted?: boolean }) {
    const conditions = [eq(agentDocuments.id, id)];
    if (!opts?.includeDeleted) {
      conditions.push(isNull(agentDocuments.deletedAt));
    }
    const rows = await this.db.select().from(agentDocuments).where(and(...conditions)).limit(1);
    return rows[0] ?? null;
  }

  async listByAgent(agentId: string, opts?: {
    lifecycleState?: DocumentLifecycleState | DocumentLifecycleState[];
    includeDeleted?: boolean;
  }) {
    const conditions = [eq(agentDocuments.agentId, agentId)];
    if (!opts?.includeDeleted) {
      conditions.push(isNull(agentDocuments.deletedAt));
    }
    if (opts?.lifecycleState !== undefined) {
      const states = Array.isArray(opts.lifecycleState) ? opts.lifecycleState : [opts.lifecycleState];
      conditions.push(inArray(agentDocuments.lifecycleState, states));
    }
    return this.db.select().from(agentDocuments)
      .where(and(...conditions))
      .orderBy(desc(agentDocuments.createdAt));
  }

  async update(id: string, update: UpdateAgentDocument): Promise<void> {
    await this.db.update(agentDocuments).set({
      ...update,
      updatedAt: new Date(),
    }).where(eq(agentDocuments.id, id));
  }

  async delete(id: string): Promise<void> {
    const existing = await this.getById(id, { includeDeleted: true });
    if (!existing) return;
    if (existing.deletedAt) return; // already soft-deleted — idempotent no-op
    await this.db.update(agentDocuments).set({
      lifecycleState: 'deleted' as const,
      deletedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(agentDocuments.id, id));
  }

  async hardDelete(id: string): Promise<void> {
    await this.db.delete(agentDocuments).where(eq(agentDocuments.id, id));
  }
}
