import crypto from 'node:crypto';
import { eq, desc, and, type SQL } from 'drizzle-orm';
import type { Database } from './index.js';
import { journalEvents } from './schema/index.js';

/** Journal entry shape — structurally compatible with @herobids/engine Journal port */
export interface JournalEntryInput {
  tradingInstanceId?: string;
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
      tradingInstanceId: entry.tradingInstanceId ?? null,
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
        tradingInstanceId: entry.tradingInstanceId ?? null,
        backtestRunId: entry.backtestRunId ?? null,
        type: entry.type,
        payload: entry.payload,
      })),
    );
  }

  /** Query journal events with optional filters */
  async query(filters: {
    tradingInstanceId?: string;
    backtestRunId?: string;
    type?: string;
    limit?: number;
    offset?: number;
  }): Promise<Array<typeof journalEvents.$inferSelect>> {
    const conditions: SQL[] = [];
    if (filters.tradingInstanceId) {
      conditions.push(eq(journalEvents.tradingInstanceId, filters.tradingInstanceId));
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
}
