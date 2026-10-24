import crypto from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { err, NOTIFICATION_ERROR_CODES, ok, type DomainError, type Result } from '@herobids/domain';
import type { Database } from './index.js';
import { pushSubscriptions } from './schema/index.js';

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: Date;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureCode: string | null;
  revokedAt: Date | null;
}

export interface UpsertPushSubscriptionInput {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}

type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

/** Maps a stored row to the record shape. Lists the fields explicitly so new columns do not leak by default. */
export function toPushSubscriptionRecord(row: PushSubscriptionRow): PushSubscriptionRecord {
  return {
    id: row.id,
    userId: row.userId,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    lastFailureCode: row.lastFailureCode,
    revokedAt: row.revokedAt,
  };
}

export class PushSubscriptionRepository {
  constructor(private readonly db: Database) {}

  /**
   * Store a subscription. A repeat subscribe by the same user refreshes the keys, clears any revocation,
   * and resets the failure state. An endpoint owned by another user is never reassigned (081 W6).
   */
  async upsertForUser(input: UpsertPushSubscriptionInput): Promise<Result<PushSubscriptionRecord, DomainError>> {
    const rows = await this.db
      .insert(pushSubscriptions)
      .values({
        id: crypto.randomUUID(),
        userId: input.userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          p256dh: input.p256dh,
          auth: input.auth,
          userAgent: input.userAgent,
          revokedAt: null,
          lastFailureAt: null,
          lastFailureCode: null,
        },
        setWhere: eq(pushSubscriptions.userId, input.userId),
      })
      .returning();
    const row = rows[0];
    if (!row) {
      return err({ code: NOTIFICATION_ERROR_CODES.endpointOwned, message: 'endpoint_owned' });
    }
    return ok(toPushSubscriptionRecord(row));
  }

  /** Revokes a row only when the user owns it. Returns false for unknown ids and for other users' ids alike. */
  async revokeForUser(userId: string, id: string, at: Date = new Date()): Promise<boolean> {
    const [owned] = await this.db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)))
      .limit(1);
    if (!owned) return false;
    await this.revoke(id, at);
    return true;
  }

  async listActiveForUser(userId: string): Promise<PushSubscriptionRecord[]> {
    const rows = await this.db
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.revokedAt)));
    return rows.map(toPushSubscriptionRecord);
  }

  async markSucceeded(id: string, at: Date = new Date()): Promise<void> {
    await this.db
      .update(pushSubscriptions)
      .set({ lastSuccessAt: at })
      .where(eq(pushSubscriptions.id, id));
  }

  async markFailed(id: string, code: string, at: Date = new Date()): Promise<void> {
    await this.db
      .update(pushSubscriptions)
      .set({ lastFailureAt: at, lastFailureCode: code })
      .where(eq(pushSubscriptions.id, id));
  }

  /** Idempotent: an already revoked row keeps its original revocation time. */
  async revoke(id: string, at: Date = new Date()): Promise<void> {
    await this.db
      .update(pushSubscriptions)
      .set({ revokedAt: at })
      .where(and(eq(pushSubscriptions.id, id), isNull(pushSubscriptions.revokedAt)));
  }
}
