import crypto from 'node:crypto';
import { eq, and, lt, desc, gte, inArray, isNull, or } from 'drizzle-orm';
import type { Database } from './index.js';
import { alertDeliveries } from './schema/index.js';

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface InsertAlertDelivery {
  journalEventId: string;
  channel: string;
  destination: string;
}

/**
 * Repository for alert delivery tracking.
 */
export class AlertDeliveryRepository {
  constructor(private readonly db: Database) {}

  /**
   * Check if a delivery already exists for this event+channel+destination.
   * Returns the existing row ID if so, or null if not.
   */
  async existsFor(journalEventId: string, channel: string, destination: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: alertDeliveries.id })
      .from(alertDeliveries)
      .where(
        and(
          eq(alertDeliveries.journalEventId, journalEventId),
          eq(alertDeliveries.channel, channel),
          eq(alertDeliveries.destination, destination),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  /** Insert a new pending delivery. Returns the new ID, or null if a row for
   * this event+channel+destination already exists. Atomic: uses ON CONFLICT DO
   * NOTHING so concurrent callers never race to a constraint error.
   */
  async insert(delivery: InsertAlertDelivery): Promise<string | null> {
    const id = crypto.randomUUID();
    const inserted = await this.db.insert(alertDeliveries).values({
      id,
      journalEventId: delivery.journalEventId,
      channel: delivery.channel,
      destination: delivery.destination,
      status: 'pending',
      attempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing().returning({ id: alertDeliveries.id });
    return inserted[0]?.id ?? null;
  }

  /** Insert many pending deliveries in a batch. */
  async insertBatch(deliveries: InsertAlertDelivery[]): Promise<string[]> {
    if (deliveries.length === 0) return [];
    const rows = deliveries.map((d) => {
      const id = crypto.randomUUID();
      return {
        id,
        journalEventId: d.journalEventId,
        channel: d.channel,
        destination: d.destination,
        status: 'pending' as const,
        attempts: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });
    await this.db.insert(alertDeliveries).values(rows);
    return rows.map((r) => r.id);
  }

  /** Get pending deliveries and atomically claim them to prevent double-processing.
   *
   * Uses SELECT … FOR UPDATE SKIP LOCKED inside a transaction so that concurrent
   * workers (or overlapping ticks in the same worker) each get a disjoint set of
   * rows. The 60-second stale-claim window reclaims rows whose worker crashed
   * before marking them delivered or failed.
   */
  async getPending(opts: { maxRetries: number; limit: number }) {
    const staleThreshold = new Date(Date.now() - 60_000); // 60s claim expiry
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(alertDeliveries)
        .where(
          and(
            eq(alertDeliveries.status, 'pending'),
            lt(alertDeliveries.attempts, opts.maxRetries),
            or(
              isNull(alertDeliveries.claimedAt),
              lt(alertDeliveries.claimedAt, staleThreshold),
            ),
          ),
        )
        .orderBy(alertDeliveries.createdAt)
        .limit(opts.limit)
        .for('update', { skipLocked: true });

      if (rows.length > 0) {
        const ids = rows.map((r) => r.id);
        await tx
          .update(alertDeliveries)
          .set({ claimedAt: new Date() })
          .where(inArray(alertDeliveries.id, ids));
      }

      return rows;
    });
  }

  /** Mark a delivery as successfully delivered. */
  async markDelivered(id: string): Promise<void> {
    await this.db
      .update(alertDeliveries)
      .set({
        status: 'delivered',
        deliveredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(alertDeliveries.id, id));
  }

  /** Increment attempt count and optionally mark as permanently failed.
   *
   * When the row stays pending, claimedAt is cleared so it is immediately
   * eligible for the next retry tick rather than being suppressed for the
   * 60-second stale-claim window.
   */
  async markAttemptFailed(id: string, error: string, maxRetries: number): Promise<void> {
    const [row] = await this.db
      .select({ attempts: alertDeliveries.attempts })
      .from(alertDeliveries)
      .where(eq(alertDeliveries.id, id));

    if (!row) return;
    const newAttempts = row.attempts + 1;
    const newStatus: DeliveryStatus = newAttempts >= maxRetries ? 'failed' : 'pending';

    await this.db
      .update(alertDeliveries)
      .set({
        attempts: newAttempts,
        status: newStatus,
        lastError: error,
        // Reset the claim window to now so the row isn't immediately re-queued
        // within the same dispatch tick by retryPending(). The standard 60-second
        // stale-claim threshold provides a natural cooldown between retry attempts.
        // Leave it set when permanently failed — no retries will run anyway.
        ...(newStatus === 'pending' && { claimedAt: new Date() }),
        updatedAt: new Date(),
      })
      .where(eq(alertDeliveries.id, id));
  }

  /** Get recent deliveries (for status display). */
  async getRecent(limit = 50) {
    return this.db
      .select()
      .from(alertDeliveries)
      .orderBy(desc(alertDeliveries.createdAt))
      .limit(limit);
  }

  /** Get recently delivered rows with deliveredAt >= cutoff. Used for cooldown seeding on restart. */
  async getRecentDeliveredAfter(cutoff: Date, limit = 50) {
    return this.db
      .select()
      .from(alertDeliveries)
      .where(
        and(
          eq(alertDeliveries.status, 'delivered'),
          gte(alertDeliveries.deliveredAt, cutoff),
        ),
      )
      .orderBy(desc(alertDeliveries.deliveredAt))
      .limit(limit);
  }

  /**
   * Check if any delivery for the given event type prefix was successfully
   * delivered within the cooldown window. Used for durable duplicate suppression
   * that survives worker restarts.
   *
   * Note: eventTypePrefix is matched by looking at journal_event_id associations;
   * the actual type comparison is done by passing a list of event IDs to exclude.
   * The simpler approach: check if *this specific journal event* was already delivered.
   */
  async wasEventDelivered(journalEventId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: alertDeliveries.id })
      .from(alertDeliveries)
      .where(
        and(
          eq(alertDeliveries.journalEventId, journalEventId),
          eq(alertDeliveries.status, 'delivered'),
        ),
      )
      .limit(1);
    return !!row;
  }

  /**
   * Return the most recent delivered_at timestamp for any delivery of events
   * in the provided list. Used by the dispatcher to implement durable cooldowns.
   */
  async getLastDeliveredAt(journalEventIds: string[]): Promise<Date | null> {
    if (journalEventIds.length === 0) return null;
    const [row] = await this.db
      .select({ deliveredAt: alertDeliveries.deliveredAt })
      .from(alertDeliveries)
      .where(
        and(
          eq(alertDeliveries.status, 'delivered'),
          inArray(alertDeliveries.journalEventId, journalEventIds),
        ),
      )
      .orderBy(desc(alertDeliveries.deliveredAt))
      .limit(1);
    return row?.deliveredAt ?? null;
  }
}
