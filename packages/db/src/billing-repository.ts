import crypto from 'node:crypto';
import { eq, and, sql, desc } from 'drizzle-orm';
import type { Database } from './index.js';
import { billingCustomers } from './schema/billing-customers.js';
import { billingSubscriptions } from './schema/billing-subscriptions.js';
import { billingWebhookEvents } from './schema/billing-webhook-events.js';
import { users } from './schema/users.js';
import { userPlans } from './schema/user-plans.js';

// --- Types ---

export interface UpsertSubscription {
  userId: string;
  provider: string;
  externalCustomerId: string;
  externalSubscriptionId: string;
  planId: string;
  externalPriceOrProductId: string;
  status: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  trialEnd: Date | null;
  lastEventAt: Date;
}

export interface BillingCustomerRow {
  id: string;
  userId: string;
  provider: string;
  externalCustomerId: string;
  createdAt: Date;
}

export interface BillingSubscriptionRow {
  id: string;
  userId: string;
  provider: string;
  externalCustomerId: string;
  externalSubscriptionId: string;
  planId: string;
  externalPriceOrProductId: string;
  status: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  trialEnd: Date | null;
  lastEventAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Repository for billing persistence.
 * Manages customer links, subscription projections, and webhook deduplication.
 */
export class BillingRepository {
  constructor(private readonly db: Database) {}

  // --- Customer ---

  /** Look up a billing customer by Herobids user ID (first match). */
  async findCustomerByUserId(userId: string): Promise<BillingCustomerRow | null> {
    const [row] = await this.db
      .select()
      .from(billingCustomers)
      .where(eq(billingCustomers.userId, userId))
      .limit(1);
    return row ?? null;
  }

  /** Look up a billing customer by Herobids user ID and provider. */
  async findCustomerByUserIdAndProvider(userId: string, provider: string): Promise<BillingCustomerRow | null> {
    const [row] = await this.db
      .select()
      .from(billingCustomers)
      .where(and(eq(billingCustomers.userId, userId), eq(billingCustomers.provider, provider)))
      .limit(1);
    return row ?? null;
  }

  /** Look up a billing customer by external customer ID scoped to a provider. */
  async findCustomerByExternalId(externalCustomerId: string, provider: string): Promise<BillingCustomerRow | null> {
    const [row] = await this.db
      .select()
      .from(billingCustomers)
      .where(and(
        eq(billingCustomers.externalCustomerId, externalCustomerId),
        eq(billingCustomers.provider, provider),
      ))
      .limit(1);
    return row ?? null;
  }

  /** Create or get the billing customer link. Returns the row. */
  async getOrCreateCustomer(userId: string, externalCustomerId: string, provider: string): Promise<BillingCustomerRow> {
    const existing = await this.findCustomerByUserIdAndProvider(userId, provider);
    if (existing) return existing;

    const id = crypto.randomUUID();
    const now = new Date();
    // Use onConflictDoNothing so concurrent first-seen webhook deliveries for the
    // same customer don't race to a unique-constraint violation.
    const inserted = await this.db
      .insert(billingCustomers)
      .values({ id, userId, provider, externalCustomerId, createdAt: now })
      .onConflictDoNothing()
      .returning();

    if (inserted[0]) return inserted[0];

    // A concurrent insert won the race — re-read to get the winning row.
    const row = await this.findCustomerByUserIdAndProvider(userId, provider);
    if (!row) throw new Error(`Failed to create billing customer for user ${userId} provider ${provider}`);
    return row;
  }

  // --- Subscription ---

  /** Find the active subscription for a user (most-recently updated, active/trialing preferred). */
  async findSubscriptionByUserId(userId: string): Promise<BillingSubscriptionRow | null> {
    const [row] = await this.db
      .select()
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.userId, userId))
      .orderBy(
        sql`case when ${billingSubscriptions.status} in ('active', 'trialing') then 0 else 1 end`,
        desc(billingSubscriptions.updatedAt),
      )
      .limit(1);
    return row ?? null;
  }

  /** Find a subscription by its external subscription ID scoped to a provider. */
  async findSubscriptionByExternalId(externalSubscriptionId: string, provider: string): Promise<BillingSubscriptionRow | null> {
    const [row] = await this.db
      .select()
      .from(billingSubscriptions)
      .where(and(
        eq(billingSubscriptions.externalSubscriptionId, externalSubscriptionId),
        eq(billingSubscriptions.provider, provider),
      ))
      .limit(1);
    return row ?? null;
  }

  /**
   * Upsert a subscription row and apply a plan transition (updating users.planId
   * and inserting a user_plans history row) in one transaction.
   */
  async upsertSubscriptionAndSyncPlan(sub: UpsertSubscription, targetPlanId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: billingSubscriptions.id })
        .from(billingSubscriptions)
        .where(and(
          eq(billingSubscriptions.externalSubscriptionId, sub.externalSubscriptionId),
          eq(billingSubscriptions.provider, sub.provider),
        ))
        .limit(1);

      const now = new Date();

      if (existing[0]) {
        await tx.update(billingSubscriptions)
          .set({
            planId: sub.planId,
            externalPriceOrProductId: sub.externalPriceOrProductId,
            status: sub.status,
            currentPeriodStart: sub.currentPeriodStart,
            currentPeriodEnd: sub.currentPeriodEnd,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            canceledAt: sub.canceledAt,
            trialEnd: sub.trialEnd,
            lastEventAt: sub.lastEventAt,
            updatedAt: now,
          })
          .where(and(
            eq(billingSubscriptions.externalSubscriptionId, sub.externalSubscriptionId),
            eq(billingSubscriptions.provider, sub.provider),
          ));
      } else {
        const id = crypto.randomUUID();
        await tx.insert(billingSubscriptions).values({
          id,
          userId: sub.userId,
          provider: sub.provider,
          externalCustomerId: sub.externalCustomerId,
          externalSubscriptionId: sub.externalSubscriptionId,
          planId: sub.planId,
          externalPriceOrProductId: sub.externalPriceOrProductId,
          status: sub.status,
          currentPeriodStart: sub.currentPeriodStart,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          canceledAt: sub.canceledAt,
          trialEnd: sub.trialEnd,
          lastEventAt: sub.lastEventAt,
          createdAt: now,
          updatedAt: now,
        });
      }

      // Only write a plan transition when the effective plan actually changes —
      // renewal and status-only events must not create spurious user_plans rows.
      const [currentUser] = await tx
        .select({ planId: users.planId })
        .from(users)
        .where(eq(users.id, sub.userId))
        .limit(1);

      if (!currentUser || currentUser.planId !== targetPlanId) {
        await tx.update(users)
          .set({ planId: targetPlanId, updatedAt: now })
          .where(eq(users.id, sub.userId));

        const planHistoryId = crypto.randomUUID();
        await tx.insert(userPlans).values({
          id: planHistoryId,
          userId: sub.userId,
          planId: targetPlanId,
          validFrom: now,
          createdAt: now,
        });
      }
    });
  }

  // --- Webhook Events ---

  /** Check if a webhook event has already been successfully processed. */
  async isEventProcessed(eventId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: billingWebhookEvents.id })
      .from(billingWebhookEvents)
      .where(and(
        eq(billingWebhookEvents.id, eventId),
        eq(billingWebhookEvents.status, 'processed'),
      ))
      .limit(1);
    return !!row;
  }

  /** Record a successfully processed webhook event. Overwrites a prior failed row so retries can succeed. */
  async recordEventProcessed(eventId: string, eventType: string): Promise<void> {
    await this.db
      .insert(billingWebhookEvents)
      .values({ id: eventId, eventType, status: 'processed', processedAt: new Date() })
      .onConflictDoUpdate({
        target: billingWebhookEvents.id,
        set: { status: 'processed', error: null, processedAt: new Date() },
      });
  }

  /** Record a failed webhook event for operator follow-up. */
  async recordEventFailed(eventId: string, eventType: string, error: string): Promise<void> {
    await this.db.insert(billingWebhookEvents).values({
      id: eventId,
      eventType,
      status: 'failed',
      error,
      processedAt: new Date(),
    }).onConflictDoNothing();
  }
}
