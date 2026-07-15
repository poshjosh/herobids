import { pgTable, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Billing customers — links OpenAIdom users to external provider customer IDs.
 * One row per user per provider; created lazily on first billing interaction.
 */
export const billingCustomers = pgTable(
  'billing_customers',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    /** Payment provider that owns this customer record */
    provider: text('provider').notNull().default('stripe'),
    /** External customer ID from the payment provider */
    externalCustomerId: text('external_customer_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_billing_customers_user_id').on(t.userId),
    index('idx_billing_customers_external_id').on(t.externalCustomerId),
    index('idx_billing_customers_user_provider').on(t.userId, t.provider),
    unique('uq_billing_customers_user_provider').on(t.userId, t.provider),
    unique('uq_billing_customers_provider_external_id').on(t.provider, t.externalCustomerId),
  ],
);
