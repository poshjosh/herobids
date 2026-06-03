import { pgTable, text, timestamp, boolean, index, unique } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Billing subscriptions — local projection of provider subscription state.
 * Authoritative for knowing what subscription the user has; entitlements are
 * still computed from users.planId (updated transactionally when this changes).
 */
export const billingSubscriptions = pgTable(
  'billing_subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    /** Payment provider that owns this subscription */
    provider: text('provider').notNull().default('stripe'),
    /** External customer ID from the provider */
    externalCustomerId: text('external_customer_id').notNull(),
    /** External subscription ID from the provider */
    externalSubscriptionId: text('external_subscription_id').notNull(),
    /** Internal plan ID this subscription maps to */
    planId: text('plan_id').notNull(),
    /** External price/product ID from the provider */
    externalPriceOrProductId: text('external_price_or_product_id').notNull(),
    /** Provider subscription status: active, past_due, canceled, incomplete, etc. */
    status: text('status').notNull(),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    trialEnd: timestamp('trial_end', { withTimezone: true }),
    /** Timestamp of the last webhook event that mutated this row */
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_billing_subscriptions_user_id').on(t.userId),
    index('idx_billing_subscriptions_external_subscription_id').on(t.externalSubscriptionId),
    index('idx_billing_subscriptions_status').on(t.status),
    index('idx_billing_subscriptions_provider').on(t.provider),
    unique('uq_billing_subscriptions_provider_external_id').on(t.provider, t.externalSubscriptionId),
  ],
);
