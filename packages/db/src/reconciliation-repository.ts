import crypto from 'node:crypto';
import { eq, and, desc, gte, type SQL } from 'drizzle-orm';
import type { Database } from './index.js';
import { reconciliationEvents } from './schema/index.js';
import { venueAccounts } from './schema/index.js';

export interface InsertReconciliationEvent {
  /** Accepted for call-site compatibility; not stored (reconciliation is venue-account-scoped) */
  botId?: string;
  venueAccountId: string;
  result: 'match' | 'observed_variance' | 'drift_detected' | 'drift_within_threshold' | 'repaired';
  localState: Record<string, unknown>;
  venueState: Record<string, unknown>;
  diff: Array<Record<string, unknown>>;
}

export interface ReconciliationEventQuery {
  venueAccountId?: string;
  result?: string;
  since?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Repository for reconciliation event persistence and queries.
 */
export class ReconciliationEventRepository {
  constructor(private readonly db: Database) {}

  /** Insert a reconciliation event and update the cursor */
  async insert(event: InsertReconciliationEvent): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date();

    await this.db.insert(reconciliationEvents).values({
      id,
      venueAccountId: event.venueAccountId,
      result: event.result,
      localState: event.localState,
      venueState: event.venueState,
      diff: event.diff,
      createdAt: now,
    });

    // Update the reconciliation cursor on venue_accounts
    await this.db
      .update(venueAccounts)
      .set({ lastReconciledAt: now, updatedAt: now })
      .where(eq(venueAccounts.id, event.venueAccountId));

    return id;
  }

  /** Query reconciliation events by venue account (primary query method) */
  async getByInstance(venueAccountId: string, opts?: { limit?: number; offset?: number; since?: Date; result?: string }) {
    // 'getByInstance' kept for call-site compatibility; scoped to venueAccountId now
    return this.getByVenueAccount(venueAccountId, opts);
  }

  /** Query reconciliation events by venue account */
  async getByVenueAccount(venueAccountId: string, opts?: { limit?: number; offset?: number; since?: Date }) {
    const conditions: SQL[] = [eq(reconciliationEvents.venueAccountId, venueAccountId)];
    if (opts?.since) {
      conditions.push(gte(reconciliationEvents.createdAt, opts.since));
    }

    return this.db
      .select()
      .from(reconciliationEvents)
      .where(and(...conditions))
      .orderBy(desc(reconciliationEvents.createdAt))
      .limit(opts?.limit ?? 100)
      .offset(opts?.offset ?? 0);
  }

  /** Query with flexible filters */
  async query(filters: ReconciliationEventQuery) {
    const conditions: SQL[] = [];
    if (filters.venueAccountId) {
      conditions.push(eq(reconciliationEvents.venueAccountId, filters.venueAccountId));
    }
    if (filters.result) {
      conditions.push(eq(reconciliationEvents.result, filters.result));
    }
    if (filters.since) {
      conditions.push(gte(reconciliationEvents.createdAt, filters.since));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return this.db
      .select()
      .from(reconciliationEvents)
      .where(where)
      .orderBy(desc(reconciliationEvents.createdAt))
      .limit(filters.limit ?? 100)
      .offset(filters.offset ?? 0);
  }

  /** Get the last reconciled timestamp for a venue account (shared cursor) */
  async getLastReconciledAt(venueAccountId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ lastReconciledAt: venueAccounts.lastReconciledAt })
      .from(venueAccounts)
      .where(eq(venueAccounts.id, venueAccountId))
      .limit(1);

    return row?.lastReconciledAt ?? null;
  }

  /**
   * Get the last reconciled timestamp for a specific venue account.
   * Queries reconciliation_events directly for accurate per-account cursor.
   */
  async getLastReconciledAtForInstance(venueAccountId: string): Promise<Date | null> {
    // Renamed: was getLastReconciledAtForInstance(tradingInstanceId)
    // Now delegates to getLastReconciledAt since reconciliation is venue-account-scoped.
    return this.getLastReconciledAt(venueAccountId);
  }
}
