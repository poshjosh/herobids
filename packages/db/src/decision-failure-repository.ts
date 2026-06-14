import crypto from 'node:crypto';
import { eq, and, desc, gte } from 'drizzle-orm';
import type { Database } from './index.js';
import { decisionFailures } from './schema/index.js';

export interface InsertDecisionFailure {
  actorType: string;
  actorId: string;
  decisionId?: string;
  instrumentId?: string;
  venue?: string;
  venueAccountId?: string;
  failureCode: string;
  failureMessage: string;
  failureClass: 'rejection' | 'error';
  retryable: boolean;
  details?: Record<string, unknown> | null;
  failedAt?: Date;
}

export interface DecisionFailureQuery {
  actorType?: string;
  actorId?: string;
  since?: Date;
  limit?: number;
}

export class DecisionFailureRepository {
  constructor(private readonly db: Database) {}

  async insert(failure: InsertDecisionFailure): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date();
    await this.db.insert(decisionFailures).values({
      id,
      actorType: failure.actorType,
      actorId: failure.actorId,
      decisionId: failure.decisionId ?? null,
      instrumentId: failure.instrumentId ?? null,
      venue: failure.venue ?? null,
      venueAccountId: failure.venueAccountId ?? null,
      failureCode: failure.failureCode,
      failureMessage: failure.failureMessage,
      failureClass: failure.failureClass,
      retryable: failure.retryable,
      details: failure.details ?? null,
      failedAt: failure.failedAt ?? now,
      createdAt: now,
    });
    return id;
  }

  async query(filter: DecisionFailureQuery): Promise<(typeof decisionFailures.$inferSelect)[]> {
    const conditions = [];
    if (filter.actorType) conditions.push(eq(decisionFailures.actorType, filter.actorType));
    if (filter.actorId) conditions.push(eq(decisionFailures.actorId, filter.actorId));
    if (filter.since) conditions.push(gte(decisionFailures.failedAt, filter.since));

    const query = this.db.select().from(decisionFailures);
    const withWhere = conditions.length > 0
      ? query.where(and(...conditions))
      : query;

    return withWhere
      .orderBy(desc(decisionFailures.failedAt))
      .limit(filter.limit ?? 100);
  }

  async getLatestForActor(actorType: string, actorId: string): Promise<(typeof decisionFailures.$inferSelect) | undefined> {
    const [row] = await this.db.select()
      .from(decisionFailures)
      .where(and(eq(decisionFailures.actorType, actorType), eq(decisionFailures.actorId, actorId)))
      .orderBy(desc(decisionFailures.failedAt))
      .limit(1);
    return row;
  }
}
