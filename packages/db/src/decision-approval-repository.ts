import crypto from 'node:crypto';
import { eq, and, desc, inArray, lt } from 'drizzle-orm';
import type { Database } from './index.js';
import { decisionApprovals } from './schema/index.js';

export interface InsertDecisionApproval {
  shortCode: string;
  userId: string;
  agentId: string;
  actorType: string;
  actorId: string;
  venueAccountId: string;
  authorizationModeSnapshot: string;
  status: string;
  instrumentId: string;
  intent: string;
  targetSize: string;
  limitPrice?: string | null;
  stopLoss?: string | null;
  takeProfit?: string | null;
  confidence?: string | null;
  rationaleSummary: string;
  contextHash?: string | null;
  proposedPayload: Record<string, unknown>;
  decisionId?: string | null;
  planId?: string | null;
  expiresAt: Date;
}

export interface ResolutionInfo {
  resolvedByUserId: string;
  resolutionSource: string;
}

export type DecisionApprovalRow = typeof decisionApprovals.$inferSelect;

export class DecisionApprovalRepository {
  constructor(private readonly db: Database) {}

  async createApproval(data: InsertDecisionApproval): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date();
    await this.db.insert(decisionApprovals).values({
      id,
      shortCode: data.shortCode,
      userId: data.userId,
      agentId: data.agentId,
      actorType: data.actorType,
      actorId: data.actorId,
      venueAccountId: data.venueAccountId,
      authorizationModeSnapshot: data.authorizationModeSnapshot,
      status: data.status,
      instrumentId: data.instrumentId,
      intent: data.intent,
      targetSize: data.targetSize,
      limitPrice: data.limitPrice ?? null,
      stopLoss: data.stopLoss ?? null,
      takeProfit: data.takeProfit ?? null,
      confidence: data.confidence ?? null,
      rationaleSummary: data.rationaleSummary,
      contextHash: data.contextHash ?? null,
      proposedPayload: data.proposedPayload,
      decisionId: data.decisionId ?? null,
      planId: data.planId ?? null,
      expiresAt: data.expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async findById(id: string): Promise<DecisionApprovalRow | undefined> {
    const [row] = await this.db
      .select()
      .from(decisionApprovals)
      .where(eq(decisionApprovals.id, id));
    return row;
  }

  async findByUserIdAndShortCode(
    userId: string,
    shortCode: string,
  ): Promise<DecisionApprovalRow | undefined> {
    const [row] = await this.db
      .select()
      .from(decisionApprovals)
      .where(
        and(
          eq(decisionApprovals.userId, userId),
          eq(decisionApprovals.shortCode, shortCode),
        ),
      );
    return row;
  }

  async findPendingByUserId(userId: string): Promise<DecisionApprovalRow[]> {
    return this.db
      .select()
      .from(decisionApprovals)
      .where(
        and(
          eq(decisionApprovals.userId, userId),
          eq(decisionApprovals.status, 'pending'),
        ),
      )
      .orderBy(desc(decisionApprovals.createdAt));
  }

  async findPendingByAgentId(agentId: string): Promise<DecisionApprovalRow[]> {
    return this.db
      .select()
      .from(decisionApprovals)
      .where(
        and(
          eq(decisionApprovals.agentId, agentId),
          eq(decisionApprovals.status, 'pending'),
        ),
      )
      .orderBy(desc(decisionApprovals.createdAt));
  }

  async updateStatus(
    id: string,
    status: string,
    resolutionInfo: ResolutionInfo,
  ): Promise<number> {
    const now = new Date();
    const result = await this.db
      .update(decisionApprovals)
      .set({
        status,
        resolvedByUserId: resolutionInfo.resolvedByUserId,
        resolutionSource: resolutionInfo.resolutionSource,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(decisionApprovals.id, id),
          eq(decisionApprovals.status, 'pending'),
        ),
      )
      .returning({ id: decisionApprovals.id });
    return result.length;
  }

  async updateExpired(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const now = new Date();
    await this.db
      .update(decisionApprovals)
      .set({
        status: 'expired',
        updatedAt: now,
      })
      .where(inArray(decisionApprovals.id, ids));
  }

  async recordExecutionResult(
    id: string,
    decisionId: string,
    planId: string | null,
    executionStatus: string,
  ): Promise<void> {
    await this.db
      .update(decisionApprovals)
      .set({
        executionStatus,
        decisionId,
        planId: planId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(decisionApprovals.id, id));
  }

  async recordResolutionAttempt(
    id: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .update(decisionApprovals)
      .set({
        lastResolutionAttemptAt: now,
        lastResolutionErrorCode: errorCode,
        lastResolutionErrorMessage: errorMessage,
        updatedAt: now,
      })
      .where(eq(decisionApprovals.id, id));
  }

  async countPendingByUserId(userId: string): Promise<number> {
    const rows = await this.db
      .select()
      .from(decisionApprovals)
      .where(
        and(
          eq(decisionApprovals.userId, userId),
          eq(decisionApprovals.status, 'pending'),
        ),
      );
    return rows.length;
  }

  /** Find all pending approvals past their expiry time. */
  async findExpiredPending(): Promise<DecisionApprovalRow[]> {
    const now = new Date();
    return this.db
      .select()
      .from(decisionApprovals)
      .where(
        and(
          eq(decisionApprovals.status, 'pending'),
          lt(decisionApprovals.expiresAt, now),
        ),
      );
  }
}
