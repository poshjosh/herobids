import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Portfolios — logical grouping of positions across venues.
 * Used for cross-venue P&L aggregation.
 */
export const portfolios = pgTable('portfolios', {
  id: text('id').primaryKey(),               // UUIDv7
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_portfolios_user_id').on(t.userId),
]);
