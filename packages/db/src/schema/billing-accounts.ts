import { pgTable, text, timestamp, bigint, index, unique } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const billingAccounts = pgTable(
  'billing_accounts',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id),
    /** active | soft_limited | hard_limited | suspended */
    status: text('status').notNull().default('active'),
    currency: text('currency').notNull().default('USD'),
    activePlanId: text('active_plan_id').notNull(),
    softCapMicrousd: bigint('soft_cap_microusd', { mode: 'number' }),
    hardCapMicrousd: bigint('hard_cap_microusd', { mode: 'number' }),
    lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_billing_accounts_owner_user_id').on(t.ownerUserId),
    index('idx_billing_accounts_status').on(t.status),
  ],
);
