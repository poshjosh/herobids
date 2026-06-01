import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * User plans — canonical record of which plan a user is on.
 * A user has one active plan at a time (valid_until IS NULL or in the future).
 * The `plan_id` column on `users` is a denormalised cache for quick single-query lookup.
 */
export const userPlans = pgTable(
  'user_plans',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    planId: text('plan_id').notNull().default('free'),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    /** NULL means the plan has no expiry (open-ended) */
    validUntil: timestamp('valid_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_user_plans_user_id').on(t.userId)],
);
