import { pgTable, text, timestamp, integer, index, unique } from 'drizzle-orm/pg-core';

export const billingRateCards = pgTable(
  'billing_rate_cards',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    currency: text('currency').notNull().default('USD'),
    /** draft | active | retired */
    status: text('status').notNull().default('draft'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_billing_rate_cards_name_version').on(t.name, t.version),
    index('idx_billing_rate_cards_status_effective').on(t.status, t.effectiveFrom),
  ],
);
