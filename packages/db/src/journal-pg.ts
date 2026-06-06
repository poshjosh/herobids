import crypto from 'node:crypto';
import { eq, desc, asc, and, inArray, gte, gt, notInArray, like, sql, type SQL } from 'drizzle-orm';
import type { Database } from './index.js';
import { journalEvents } from './schema/index.js';

/** Journal entry shape — structurally compatible with @herobids/engine Journal port */
export interface JournalEntryInput {
  actorType?: string;
  actorId?: string;
  backtestRunId?: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Journal port shape — structurally compatible with @herobids/engine Journal.
 * Uses structural typing to avoid circular dependency (db ← engine).
 */
export interface JournalPort {
  append(entry: JournalEntryInput): Promise<void>;
  appendBatch(entries: JournalEntryInput[]): Promise<void>;
}

/**
 * Postgres-backed journal — writes events to the journal_events table.
 * Implements the engine Journal port via structural typing.
 */
export class PgJournal implements JournalPort {
  constructor(private readonly db: Database) {}

  async append(entry: JournalEntryInput): Promise<void> {
    await this.db.insert(journalEvents).values({
      id: crypto.randomUUID(),
      actorType: entry.actorType ?? null,
      actorId: entry.actorId ?? null,
      backtestRunId: entry.backtestRunId ?? null,
      type: entry.type,
      payload: entry.payload,
    });
  }

  async appendBatch(entries: JournalEntryInput[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db.insert(journalEvents).values(
      entries.map((entry) => ({
        id: crypto.randomUUID(),
        actorType: entry.actorType ?? null,
        actorId: entry.actorId ?? null,
        backtestRunId: entry.backtestRunId ?? null,
        type: entry.type,
        payload: entry.payload,
      })),
    );
  }

  /** Query journal events with optional filters */
  async query(filters: {
    actorId?: string;
    backtestRunId?: string;
    type?: string;
    limit?: number;
    offset?: number;
  }): Promise<Array<typeof journalEvents.$inferSelect>> {
    const conditions: SQL[] = [];
    if (filters.actorId) {
      conditions.push(eq(journalEvents.actorId, filters.actorId));
    }
    if (filters.backtestRunId) {
      conditions.push(eq(journalEvents.backtestRunId, filters.backtestRunId));
    }
    if (filters.type) {
      conditions.push(eq(journalEvents.type, filters.type));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return this.db
      .select()
      .from(journalEvents)
      .where(where)
      .orderBy(desc(journalEvents.createdAt))
      .limit(filters.limit ?? 100)
      .offset(filters.offset ?? 0);
  }

  /** Query journal events matching multiple types for an actor */
  async queryByTypes(filters: {
    actorId?: string;
    botId?: string;
    types: string[];
    since?: Date;
    limit?: number;
  }): Promise<Array<typeof journalEvents.$inferSelect>> {
    const effectiveActorId = filters.actorId ?? filters.botId;
    const conditions: SQL[] = [];
    if (effectiveActorId) {
      conditions.push(eq(journalEvents.actorId, effectiveActorId));
    }
    if (filters.types.length > 0) {
      conditions.push(inArray(journalEvents.type, filters.types));
    }
    if (filters.since) {
      conditions.push(gte(journalEvents.createdAt, filters.since));
    }

    return this.db
      .select()
      .from(journalEvents)
      .where(and(...conditions))
      .orderBy(desc(journalEvents.createdAt))
      .limit(filters.limit ?? 100);
  }

  /** Query journal events matching a type prefix for an actor */
  async queryByTypePrefix(filters: {
    actorId: string;
    typePrefix: string;
    since?: Date;
    limit?: number;
  }): Promise<Array<typeof journalEvents.$inferSelect>> {
    const conditions: SQL[] = [
      eq(journalEvents.actorId, filters.actorId),
      like(journalEvents.type, `${filters.typePrefix}%`),
    ];
    if (filters.since) {
      conditions.push(gte(journalEvents.createdAt, filters.since));
    }

    return this.db
      .select()
      .from(journalEvents)
      .where(and(...conditions))
      .orderBy(desc(journalEvents.createdAt))
      .limit(filters.limit ?? 100);
  }

  /** Get a single journal event by its ID. */
  async getById(id: string): Promise<typeof journalEvents.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(journalEvents)
      .where(eq(journalEvents.id, id))
      .limit(1);
    return row ?? null;
  }

  /** Get multiple journal events by their IDs. */
  async getByIds(ids: string[]): Promise<Array<typeof journalEvents.$inferSelect>> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(journalEvents)
      .where(inArray(journalEvents.id, ids));
  }

  /**
   * Cursor-based global scan with a stable (createdAt, id) cursor pair.
   * Returns events strictly after the cursor, ordered ascending (oldest first).
   * The caller should advance the cursor to the last returned row's (createdAt, id).
   *
   * Using (createdAt, id) is stable under timestamp ties: events with the same
   * createdAt are disambiguated by id, so no events are missed or replayed.
   */
  async scanAfter(opts: {
    /**
     * Cursor as (createdAt, seenIds) pair — omit to start from the beginning.
     *
     * seenIds holds every event ID already processed at the boundary timestamp.
     * Using a seen-ID set instead of a single id makes the cursor stable under
     * timestamp ties: `appendBatch` inserts rows in one statement so all rows in
     * a batch share the same `created_at` (PostgreSQL transaction time). With a
     * single-id tiebreak, any row whose random UUID sorts before the saved id
     * would be permanently skipped on the next scan.
     */
    cursor?: { createdAt: Date; seenIds: string[] };
    typePrefixes?: string[];
    limit: number;
  }): Promise<Array<typeof journalEvents.$inferSelect>> {
    const conditions: SQL[] = [];

    if (opts.cursor) {
      if (opts.cursor.seenIds.length > 0) {
        // Include events at or after the cursor timestamp, excluding already-seen IDs.
        // >= (not >) ensures new events at the same timestamp are returned.
        conditions.push(gte(journalEvents.createdAt, opts.cursor.createdAt));
        conditions.push(notInArray(journalEvents.id, opts.cursor.seenIds));
      } else {
        // seenIds empty (defensive fallback): advance strictly past the cursor timestamp.
        conditions.push(gt(journalEvents.createdAt, opts.cursor.createdAt));
      }
    }

    if (opts.typePrefixes && opts.typePrefixes.length > 0) {
      const prefixConditions = opts.typePrefixes.map((p) => like(journalEvents.type, `${p}%`));
      const orCondition = prefixConditions.reduce<SQL | undefined>((acc, cond) => {
        if (!acc) return cond;
        return sql`${acc} OR ${cond}`;
      }, undefined);
      if (orCondition) conditions.push(orCondition);
    }

    return this.db
      .select()
      .from(journalEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(journalEvents.createdAt), asc(journalEvents.id))
      .limit(opts.limit);
  }
}
