import crypto from 'node:crypto';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from './index.js';
import {
  tradingProfileReconciliationOutbox,
  type TradingProfileOutboxAction,
  type TradingProfileOutboxState,
} from './schema/index.js';

export type TradingProfileReconciliationOutboxRow = typeof tradingProfileReconciliationOutbox.$inferSelect;
export type DatabaseTransaction = Parameters<Database['transaction']>[0] extends (tx: infer Transaction) => unknown ? Transaction : never;

export class TradingProfileReconciliationOutboxRepository {
  constructor(private readonly db: Database) {}

  async inTransaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(callback);
  }

  async createOrLoad(input: {
    operationId: string;
    localMutationId: string;
    ownerId: string;
    actorId: string;
    actions: TradingProfileOutboxAction[];
  }): Promise<TradingProfileReconciliationOutboxRow> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(71, hashtext(${input.localMutationId}))`);
      const [existing] = await tx.select().from(tradingProfileReconciliationOutbox)
        .where(eq(tradingProfileReconciliationOutbox.localMutationId, input.localMutationId)).limit(1);
      if (existing) return existing;
      await tx.execute(sql`select pg_advisory_xact_lock(72, hashtext(${input.actorId}))`);
      const [activeForAgent] = await tx.select({ operationId: tradingProfileReconciliationOutbox.operationId })
        .from(tradingProfileReconciliationOutbox)
        .where(and(
          eq(tradingProfileReconciliationOutbox.actorId, input.actorId),
          inArray(tradingProfileReconciliationOutbox.state, [
            'pending_remote', 'remote_applied', 'local_committed', 'finalizing', 'rollback_pending',
          ]),
        ))
        .limit(1);
      if (activeForAgent) {
        throw new Error(`trading-profile reconciliation already in progress for agent ${input.actorId}`);
      }
      const [created] = await tx.insert(tradingProfileReconciliationOutbox).values({
        id: crypto.randomUUID(),
        ...input,
        state: 'pending_remote',
        lastError: null,
        claimToken: null,
        claimExpiresAt: null,
        updatedAt: new Date(),
      }).returning();
      if (!created) throw new Error('failed to persist trading-profile reconciliation intent');
      return created;
    });
  }

  async markLocalCommitted(tx: DatabaseTransaction, operationId: string): Promise<void> {
    await tx.update(tradingProfileReconciliationOutbox).set({
      state: 'local_committed',
      updatedAt: new Date(),
    }).where(eq(tradingProfileReconciliationOutbox.operationId, operationId));
  }

  async claimRecoverable(limit: number, leaseMs: number): Promise<TradingProfileReconciliationOutboxRow[]> {
    const now = new Date();
    const claimExpiresAt = new Date(now.getTime() + leaseMs);
    const claimToken = crypto.randomUUID();
    return this.db.transaction(async (tx) => {
      const candidates = await tx.select().from(tradingProfileReconciliationOutbox)
        .where(and(
          inArray(tradingProfileReconciliationOutbox.state, [
            'pending_remote', 'remote_applied', 'local_committed', 'finalizing', 'rollback_pending',
          ]),
          or(isNull(tradingProfileReconciliationOutbox.claimExpiresAt), lt(tradingProfileReconciliationOutbox.claimExpiresAt, now)),
        ))
        .orderBy(tradingProfileReconciliationOutbox.updatedAt)
        .limit(limit)
        .for('update', { skipLocked: true });
      if (candidates.length === 0) return [];
      const ids = candidates.map((candidate) => candidate.id);
      await tx.update(tradingProfileReconciliationOutbox).set({ claimToken, claimExpiresAt, updatedAt: now })
        .where(inArray(tradingProfileReconciliationOutbox.id, ids));
      return candidates.map((candidate) => ({ ...candidate, claimToken, claimExpiresAt, updatedAt: now }));
    });
  }

  async claimLive(operationId: string, leaseMs: number): Promise<string | null> {
    const now = new Date();
    const claimExpiresAt = new Date(now.getTime() + leaseMs);
    const claimToken = crypto.randomUUID();
    const [claimed] = await this.db.update(tradingProfileReconciliationOutbox).set({ claimToken, claimExpiresAt, updatedAt: now })
      .where(and(
        eq(tradingProfileReconciliationOutbox.operationId, operationId),
        or(isNull(tradingProfileReconciliationOutbox.claimExpiresAt), lt(tradingProfileReconciliationOutbox.claimExpiresAt, now)),
      )).returning({ id: tradingProfileReconciliationOutbox.id });
    return claimed ? claimToken : null;
  }

  async releaseClaim(operationId: string, claimToken: string): Promise<void> {
    await this.db.update(tradingProfileReconciliationOutbox).set({ claimToken: null, claimExpiresAt: null, updatedAt: new Date() })
      .where(and(
        eq(tradingProfileReconciliationOutbox.operationId, operationId),
        eq(tradingProfileReconciliationOutbox.claimToken, claimToken),
      ));
  }

  async update(id: string, state: TradingProfileOutboxState, actions: TradingProfileOutboxAction[], lastError: string | null = null): Promise<void> {
    await this.db.update(tradingProfileReconciliationOutbox).set({
      state,
      actions,
      lastError,
      updatedAt: new Date(),
    }).where(eq(tradingProfileReconciliationOutbox.id, id));
  }

  async updateByOperationId(operationId: string, state: TradingProfileOutboxState, lastError: string | null = null): Promise<void> {
    await this.db.update(tradingProfileReconciliationOutbox).set({
      state,
      lastError,
      updatedAt: new Date(),
    }).where(eq(tradingProfileReconciliationOutbox.operationId, operationId));
  }
}