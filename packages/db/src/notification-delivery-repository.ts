import crypto from 'node:crypto';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from './index.js';
import { notificationDeliveries } from './schema/index.js';
import type { NotificationDeliveryChannel, NotificationDeliveryStatus } from './schema/notification-deliveries.js';

/**
 * Statuses that count toward the per-user daily email cap (082 E-D5). A 'pending' row may already have reached the
 * inbox (the send can crash after the row is written), so it counts. A 'failed' row never reached the inbox.
 */
export const EMAIL_CAP_COUNTED_STATUSES: readonly NotificationDeliveryStatus[] = ['pending', 'sent'];

export interface RecordNotificationDeliveryInput {
  userId: string;
  agentId: string;
  eventKey: string;
  channel: NotificationDeliveryChannel;
  reason: string;
}

export interface ReserveEmailDeliveryInput extends RecordNotificationDeliveryInput {
  /** Start of the rolling window the daily cap counts over. */
  since: Date;
  maxPerUserPerDay: number;
}

export type ReserveEmailDeliveryResult =
  | { outcome: 'reserved'; id: string }
  | { outcome: 'duplicate' }
  | { outcome: 'rate_limited' };

type DatabaseExecutor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

async function insertPendingDelivery(
  executor: DatabaseExecutor,
  input: RecordNotificationDeliveryInput,
): Promise<string | null> {
  const rows = await executor
    .insert(notificationDeliveries)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      agentId: input.agentId,
      eventKey: input.eventKey,
      channel: input.channel,
      status: 'pending',
      reason: input.reason,
    })
    .onConflictDoNothing({
      target: [notificationDeliveries.eventKey, notificationDeliveries.channel],
    })
    .returning({ id: notificationDeliveries.id });
  return rows[0]?.id ?? null;
}

async function countEmailRows(executor: DatabaseExecutor, userId: string, since: Date): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)` })
    .from(notificationDeliveries)
    .where(and(
      eq(notificationDeliveries.userId, userId),
      eq(notificationDeliveries.channel, 'email'),
      inArray(notificationDeliveries.status, [...EMAIL_CAP_COUNTED_STATUSES]),
      gte(notificationDeliveries.createdAt, since),
    ));
  return Number(row?.count ?? 0);
}

export class NotificationDeliveryRepository {
  constructor(private readonly db: Database) {}

  /**
   * Inserts a 'pending' row unless the event key already has one for this channel.
   * Returns the new row id, or null when the event was already recorded (the duplicate guard, 082 E4).
   */
  async recordIfAbsent(input: RecordNotificationDeliveryInput): Promise<string | null> {
    return insertPendingDelivery(this.db, input);
  }

  /**
   * Checks the duplicate guard and the daily email cap, then inserts the 'pending' row, in one transaction.
   * A per-user transaction-scoped advisory lock serialises concurrent reservations for the same user, so two
   * decisions cannot both count the same last slot. The lock is released at commit or rollback.
   */
  async reserveEmailIfUnderCap(input: ReserveEmailDeliveryInput): Promise<ReserveEmailDeliveryResult> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.userId}))`);

      const [existing] = await tx
        .select({ id: notificationDeliveries.id })
        .from(notificationDeliveries)
        .where(and(
          eq(notificationDeliveries.eventKey, input.eventKey),
          eq(notificationDeliveries.channel, input.channel),
        ))
        .limit(1);
      if (existing) return { outcome: 'duplicate' };

      const count = await countEmailRows(tx, input.userId, input.since);
      if (count >= input.maxPerUserPerDay) return { outcome: 'rate_limited' };

      const id = await insertPendingDelivery(tx, input);
      return id ? { outcome: 'reserved', id } : { outcome: 'duplicate' };
    });
  }

  async countEmailSince(userId: string, since: Date): Promise<number> {
    return countEmailRows(this.db, userId, since);
  }

  async updateStatus(id: string, status: NotificationDeliveryStatus, reason: string | null): Promise<void> {
    await this.db
      .update(notificationDeliveries)
      .set({ status, reason })
      .where(eq(notificationDeliveries.id, id));
  }
}
